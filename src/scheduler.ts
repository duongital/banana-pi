/** Agent scheduler: jobs (agent + prompt + trigger) and their run history. See specs/003-agent-scheduler.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { getAgentDef } from './agent-defs.ts';
import { runAgent } from './agent-loop.ts';
import { apiKey } from './chat.ts';

const DIR = process.env.SCHEDULER_DATA_DIR || join(homedir(), '.local', 'share', 'banana-pi-scheduler');
const MAX_RUNS = Number(process.env.SCHEDULER_MAX_RUNS) || 200;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const jobFile = (id: string) => join(DIR, 'jobs', id + '.json');
const runsDir = (jobId: string) => join(DIR, 'runs', jobId);
const runFile = (jobId: string, id: string) => join(runsDir(jobId), id + '.json');

export type Trigger = { type: 'manual' } | { type: 'cron'; expr: string; timezone: string };
export type ScheduledJob = {
  id: string; name: string; description?: string; agentId: string; prompt: string;
  trigger: Trigger; enabled: boolean; overlap: 'skip' | 'allow'; timeoutSec: number; notify: boolean;
  created: number; updated: number;
};
export type RunStatus = 'running' | 'success' | 'error' | 'timeout' | 'cancelled' | 'skipped';
export type JobRun = {
  id: string; jobId: string; jobName: string; agentId: string; agentName: string; model: string; prompt: string;
  source: 'manual' | 'schedule'; status: RunStatus; scheduledFor?: number; startedAt: number; endedAt?: number;
  error?: string; output?: string; messages: any[]; usage?: { input: number; output: number; calls: number };
};

const err = (message: string, status: number) => Object.assign(new Error(message), { status });
const checkId = (id: string) => { if (!ID_RE.test(id)) throw err('Invalid id', 400); };
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
function writeJson(f: string, d: unknown) {
  mkdirSync(join(f, '..'), { recursive: true });
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(d, null, 2));
  renameSync(tmp, f);
}

// ---------- jobs ----------
function loadJobs(): ScheduledJob[] {
  const d = join(DIR, 'jobs');
  if (!existsSync(d)) return [];
  const out: ScheduledJob[] = [];
  for (const f of readdirSync(d)) if (f.endsWith('.json')) { try { out.push(readJson(join(d, f))); } catch {} }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getJob(id: string): ScheduledJob {
  checkId(id);
  if (!existsSync(jobFile(id))) throw err('Not found', 404);
  return readJson(jobFile(id));
}

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

function makeCron(expr: string, timezone: string, fn?: () => void) {
  if (typeof expr !== 'string' || !expr.trim() || expr.length > 100) throw err('cron expression required', 400);
  if (expr.trim().split(/\s+/).length !== 5) throw err('cron expression must have 5 fields (min hour day month weekday)', 400);
  if (!validTz(timezone)) throw err('Invalid timezone', 400);
  try { return new Cron(expr.trim(), { timezone, paused: !fn, protect: true }, fn); }
  catch (e: any) { throw err('Invalid cron expression: ' + e.message, 400); }
}

function validate(p: any, selfId?: string) {
  if (!p || typeof p !== 'object') throw err('Invalid body', 400);
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || name.length > 80) throw err('name required (1-80 chars)', 400);
  if (loadJobs().some((j) => j.id !== selfId && j.name.toLowerCase() === name.toLowerCase())) throw err('A job with this name already exists', 409);
  if (typeof p.agentId !== 'string') throw err('agentId required', 400);
  getAgentDef(p.agentId); // 400/404 if invalid
  const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : '';
  if (!prompt || prompt.length > 20000) throw err('prompt required (max 20000 chars)', 400);
  let trigger: Trigger = { type: 'manual' };
  if (p.trigger?.type === 'cron') {
    const expr = String(p.trigger.expr ?? '').trim();
    const timezone = String(p.trigger.timezone || 'UTC');
    makeCron(expr, timezone);
    trigger = { type: 'cron', expr, timezone };
  } else if (p.trigger && p.trigger.type !== 'manual') throw err('trigger.type must be manual or cron', 400);
  const timeoutSec = p.timeoutSec == null ? 600 : Number(p.timeoutSec);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 10 || timeoutSec > 86400) throw err('timeoutSec must be 10-86400', 400);
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 500) : '';
  return {
    name, description: description || undefined, agentId: p.agentId, prompt, trigger,
    enabled: p.enabled !== false, overlap: p.overlap === 'allow' ? 'allow' as const : 'skip' as const,
    timeoutSec: Math.round(timeoutSec), notify: p.notify !== false,
  };
}

// ---------- cron engine ----------
const crons = new Map<string, Cron>();
const active = new Map<string, Map<string, AbortController>>(); // jobId -> runId -> controller

function schedule(job: ScheduledJob) {
  crons.get(job.id)?.stop();
  crons.delete(job.id);
  if (!job.enabled || job.trigger.type !== 'cron') return;
  try {
    const c = makeCron(job.trigger.expr, job.trigger.timezone, () => {
      let j: ScheduledJob;
      try { j = getJob(job.id); } catch { return; }
      startRun(j, 'schedule', Date.now()).catch((e) => console.error('[scheduler]', e));
    });
    crons.set(job.id, c);
  } catch (e: any) { console.error(`[scheduler] cannot schedule ${job.name}: ${e.message}`); }
}

const nextRunAt = (id: string) => crons.get(id)?.nextRun()?.getTime();

export function startScheduler() {
  // runs left in 'running' by a previous process can never finish
  const root = join(DIR, 'runs');
  if (existsSync(root)) for (const jid of readdirSync(root)) {
    for (const f of readdirSync(join(root, jid))) {
      if (!f.endsWith('.json')) continue;
      try {
        const r: JobRun = readJson(join(root, jid, f));
        if (r.status === 'running') { r.status = 'error'; r.error = 'server restarted'; r.endedAt = Date.now(); writeJson(join(root, jid, f), r); }
      } catch {}
    }
  }
  for (const j of loadJobs()) schedule(j);
  console.log(`[scheduler] ${crons.size} scheduled job(s)`);
}

// ---------- events (SSE → browser notifications) ----------
const clients = new Set<any>();
const broadcast = (ev: unknown) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };

// ---------- runs ----------
const summary = (r: JobRun) => { const { messages, ...rest } = r; return rest; };

export function listRuns(jobId: string, limit = 50): Omit<JobRun, 'messages'>[] {
  checkId(jobId);
  const d = runsDir(jobId);
  if (!existsSync(d)) return [];
  const out: JobRun[] = [];
  for (const f of readdirSync(d)) if (f.endsWith('.json')) { try { out.push(readJson(join(d, f))); } catch {} }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map(summary);
}

function findRun(runId: string): JobRun {
  checkId(runId);
  const root = join(DIR, 'runs');
  if (existsSync(root)) for (const jid of readdirSync(root)) if (existsSync(runFile(jid, runId))) return readJson(runFile(jid, runId));
  throw err('Not found', 404);
}

function prune(jobId: string) {
  const d = runsDir(jobId);
  const all = listRuns(jobId, Infinity);
  for (const r of all.slice(MAX_RUNS)) { try { unlinkSync(runFile(jobId, r.id)); } catch {} }
}

async function startRun(job: ScheduledJob, source: 'manual' | 'schedule', scheduledFor?: number): Promise<JobRun> {
  const running = active.get(job.id);
  const base = { id: randomUUID(), jobId: job.id, jobName: job.name, agentId: job.agentId, agentName: '', model: '', prompt: job.prompt, source, scheduledFor, startedAt: Date.now(), messages: [] as any[] };
  const finish = (r: JobRun) => { writeJson(runFile(job.id, r.id), r); broadcast({ type: 'run', run: summary(r), notify: job.notify }); };

  let def;
  try { def = getAgentDef(job.agentId); }
  catch { const r: JobRun = { ...base, status: 'error', error: 'agent not found', endedAt: Date.now() }; finish(r); return r; }
  base.agentName = def.name; base.model = def.model;

  if (running?.size && job.overlap === 'skip') {
    const r: JobRun = { ...base, status: 'skipped', error: 'previous run still running', endedAt: Date.now() };
    finish(r); return r;
  }
  const key = apiKey();
  if (!key) { const r: JobRun = { ...base, status: 'error', error: 'No LiteLLM API key configured', endedAt: Date.now() }; finish(r); return r; }

  const run: JobRun = { ...base, status: 'running' };
  writeJson(runFile(job.id, run.id), run);
  broadcast({ type: 'run', run: summary(run), notify: false });
  const ac = new AbortController();
  if (!active.has(job.id)) active.set(job.id, new Map());
  active.get(job.id)!.set(run.id, ac);

  let timedOut = false, lastText = '';
  const usage = { input: 0, output: 0, calls: 0 };
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, job.timeoutSec * 1000);
  // run in background; caller gets the 'running' record immediately
  (async () => {
    await runAgent({
      def, apiKey: key, signal: ac.signal, messages: [{ role: 'user', content: job.prompt }],
      onEvent: (ev) => {
        if (ev.type === 'message') {
          run.messages.push(ev.message);
          if (ev.message.role === 'assistant') {
            usage.calls++;
            usage.input += ev.message.usage?.prompt_tokens || 0;
            usage.output += ev.message.usage?.completion_tokens || 0;
            if (ev.message.content) lastText = ev.message.content;
          }
        } else if (ev.type === 'error') run.error = ev.error;
      },
    });
    clearTimeout(timer);
    active.get(job.id)?.delete(run.id);
    run.endedAt = Date.now(); run.usage = usage; run.output = lastText;
    if (ac.signal.aborted && timedOut) { run.status = 'timeout'; run.error = `timed out after ${job.timeoutSec}s`; }
    else if (ac.signal.aborted) run.status = 'cancelled';
    else run.status = run.error ? 'error' : 'success';
    finish(run);
    prune(job.id);
  })().catch((e) => { run.status = 'error'; run.error = e.message; run.endedAt = Date.now(); finish(run); });
  return run;
}

export function cancelRun(runId: string) {
  const r = findRun(runId);
  const ac = active.get(r.jobId)?.get(runId);
  if (!ac) throw err('Run is not running', 409);
  ac.abort();
  return { ok: true };
}

// ---------- API ----------
const withInfo = (j: ScheduledJob) => ({ ...j, nextRunAt: nextRunAt(j.id), running: active.get(j.id)?.size || 0, lastRun: listRuns(j.id, 1)[0] });

export async function schedulerApi(req: any, res: any, pathname: string, readBody: (r: any) => Promise<unknown>) {
  const send = (data: any, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const url = new URL(req.url, 'http://x');
  const method = req.method;
  try {
    const json = async () => { try { return JSON.parse((await readBody(req) as string) || '{}'); } catch { throw err('Invalid JSON body', 400); } };
    let m: RegExpMatchArray | null;

    if (pathname === '/api/scheduler/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return true;
    }
    if (pathname === '/api/scheduler/preview' && method === 'POST') {
      const p = await json();
      const c = makeCron(String(p.expr ?? ''), String(p.timezone || 'UTC'));
      return send({ next: c.nextRuns(5).map((d) => d.getTime()) }), true;
    }
    if (pathname === '/api/scheduler/jobs') {
      if (method === 'GET') return send(loadJobs().map(withInfo)), true;
      if (method === 'POST') {
        const now = Date.now();
        const j: ScheduledJob = { id: randomUUID(), ...validate(await json()), created: now, updated: now };
        writeJson(jobFile(j.id), j); schedule(j);
        return send(withInfo(j), 201), true;
      }
    }
    if ((m = pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)$/))) {
      const id = m[1];
      if (method === 'GET') return send(withInfo(getJob(id))), true;
      if (method === 'PUT') {
        const old = getJob(id);
        const j: ScheduledJob = { ...old, ...validate(await json(), id), id, updated: Date.now() };
        if (!j.description) delete j.description;
        writeJson(jobFile(id), j); schedule(j);
        return send(withInfo(j)), true;
      }
      if (method === 'DELETE') {
        checkId(id);
        active.get(id)?.forEach((ac) => ac.abort());
        crons.get(id)?.stop(); crons.delete(id);
        if (existsSync(jobFile(id))) unlinkSync(jobFile(id));
        rmSync(runsDir(id), { recursive: true, force: true });
        return send({ ok: true }), true;
      }
    }
    if ((m = pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)\/run$/)) && method === 'POST') {
      const r = await startRun(getJob(m[1]), 'manual');
      return send({ runId: r.id, status: r.status }, 202), true;
    }
    if ((m = pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)\/runs$/)) && method === 'GET') {
      return send(listRuns(m[1], Math.min(Number(url.searchParams.get('limit')) || 50, 500))), true;
    }
    if ((m = pathname.match(/^\/api\/scheduler\/runs\/([^/]+)$/))) {
      if (method === 'GET') return send(findRun(m[1])), true;
      if (method === 'DELETE') {
        const r = findRun(m[1]);
        if (r.status === 'running') throw err('Cancel the run first', 409);
        unlinkSync(runFile(r.jobId, r.id));
        return send({ ok: true }), true;
      }
    }
    if ((m = pathname.match(/^\/api\/scheduler\/runs\/([^/]+)\/cancel$/)) && method === 'POST') return send(cancelRun(m[1])), true;
    return send({ error: 'Not found' }, 404), true;
  } catch (e: any) {
    send({ error: e.message }, e.status || 500);
  }
  return true;
}
