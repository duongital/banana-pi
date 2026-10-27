import '../styles.css';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../sessions/Markdown.tsx';
import './scheduler.css';

type Trigger = { type: 'manual' } | { type: 'cron'; expr: string; timezone: string };
type RunSum = { id: string; jobId: string; jobName: string; agentName: string; model: string; source: string; status: string; startedAt: number; endedAt?: number; error?: string; output?: string; prompt: string; usage?: { input: number; output: number; calls: number } };
type Run = RunSum & { messages: any[] };
type Job = { id: string; name: string; description?: string; agentId: string; prompt: string; trigger: Trigger; enabled: boolean; overlap: 'skip' | 'allow'; timeoutSec: number; notify: boolean; nextRunAt?: number; running: number; lastRun?: RunSum };
type Agent = { id: string; name: string; tools: string[] };
type Form = { name: string; description: string; agentId: string; prompt: string; mode: 'manual' | 'cron'; expr: string; timezone: string; enabled: boolean; overlap: 'skip' | 'allow'; timeoutSec: number; notify: boolean };

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const EMPTY: Form = { name: '', description: '', agentId: '', prompt: '', mode: 'manual', expr: '0 9 * * 1-5', timezone: TZ, enabled: true, overlap: 'skip', timeoutSec: 600, notify: true };
const PRESETS: [string, string][] = [['Every 15 min', '*/15 * * * *'], ['Hourly', '0 * * * *'], ['Daily 09:00', '0 9 * * *'], ['Weekdays 09:00', '0 9 * * 1-5'], ['Weekly Mon 09:00', '0 9 * * 1']];
const toForm = (j: Job): Form => ({ name: j.name, description: j.description || '', agentId: j.agentId, prompt: j.prompt, mode: j.trigger.type, expr: j.trigger.type === 'cron' ? j.trigger.expr : EMPTY.expr, timezone: j.trigger.type === 'cron' ? j.trigger.timezone : TZ, enabled: j.enabled, overlap: j.overlap, timeoutSec: j.timeoutSec, notify: j.notify });
const toBody = (f: Form) => ({ name: f.name, description: f.description, agentId: f.agentId, prompt: f.prompt, enabled: f.enabled, overlap: f.overlap, timeoutSec: f.timeoutSec, notify: f.notify, trigger: f.mode === 'cron' ? { type: 'cron', expr: f.expr, timezone: f.timezone } : { type: 'manual' } });
const pathIds = () => { const m = location.pathname.match(/^\/scheduler\/([^/]+)/); return { job: m?.[1] || null, run: new URLSearchParams(location.search).get('run') }; };
const dur = (r: { startedAt: number; endedAt?: number }) => { const s = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const when = (t?: number) => (t ? new Date(t).toLocaleString() : '—');
const trig = (j: Job) => (j.trigger.type === 'cron' ? `${j.trigger.expr} (${j.trigger.timezone})` : 'Manual');

async function api(url: string, method = 'GET', body?: unknown) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const Badge = ({ s }: { s?: string }) => <span><span className={'dot ' + (s || '')} />{s || 'never run'}</span>;

function RunView({ id, onClose }: { id: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false, t: any;
    const load = () => api(`/api/scheduler/runs/${id}`).then((r: Run) => { if (stop) return; setRun(r); if (r.status === 'running') t = setTimeout(load, 2000); }).catch((e) => setErr(e.message));
    load();
    return () => { stop = true; clearTimeout(t); };
  }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return (
    <div className="modal modal-open" role="dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box f" style={{ maxWidth: 900 }}>
        {err && <p className="e">{err}</p>}
        {!run && !err && <span className="loading loading-spinner" />}
        {run && <>
          <h3 style={{ margin: 0 }}><Badge s={run.status} /> {run.jobName}</h3>
          <small className="sp">{when(run.startedAt)} · {dur(run)} · {run.source} · {run.agentName} ({run.model}){run.usage ? ` · ${run.usage.input} in / ${run.usage.output} out · ${run.usage.calls} calls` : ''}</small>
          {run.error && <p className="e" style={{ margin: 0 }}>{run.error}</p>}
          <details><summary>Prompt</summary><pre className="sbody">{run.prompt}</pre></details>
          {run.output && <div><label className="l">Output</label><div className="panel"><Markdown text={run.output} /></div></div>}
          <details><summary>Transcript ({run.messages.length} messages)</summary>
            {run.messages.map((m, i) => (
              <div key={i} className={'msg ' + m.role}>
                <div className="role">{m.role}{m.name ? ` · ${m.name}` : ''}</div>
                {m.thinking && <pre style={{ opacity: .6 }}>{m.thinking}</pre>}
                {m.content && <pre>{String(m.content)}</pre>}
                {m.tool_calls?.map((c: any) => <pre key={c.id}>🔧 {c.function.name}({c.function.arguments})</pre>)}
              </div>
            ))}
          </details>
        </>}
        <div className="modal-action" style={{ margin: 0 }}><button className="btn btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function JobForm({ job, agents, onDone }: { job: Job | null; agents: Agent[]; onDone: (j?: Job) => void }) {
  const [form, setForm] = useState<Form>(job ? toForm(job) : { ...EMPTY, agentId: agents[0]?.id || '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<number[]>([]);
  const [cronErr, setCronErr] = useState('');
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const agent = agents.find((a) => a.id === form.agentId);
  const risky = agent?.tools.filter((t) => ['bash', 'write', 'edit'].includes(t)) || [];

  useEffect(() => {
    if (form.mode !== 'cron') return;
    const t = setTimeout(() => api('/api/scheduler/preview', 'POST', { expr: form.expr, timezone: form.timezone }).then((d) => { setNext(d.next); setCronErr(''); }).catch((e) => { setNext([]); setCronErr(e.message); }), 300);
    return () => clearTimeout(t);
  }, [form.mode, form.expr, form.timezone]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onDone(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try { onDone(job ? await api(`/api/scheduler/jobs/${job.id}`, 'PUT', toBody(form)) : await api('/api/scheduler/jobs', 'POST', toBody(form))); }
    catch (e: any) { setError(e.message); setBusy(false); }
  };
  const tzs: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : [];
  return (
    <div className="modal modal-open" role="dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <form className="modal-box f" style={{ maxWidth: 680 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h3 style={{ margin: 0 }}>{job ? 'Edit job' : 'New job'}</h3>
        <div><label className="l">Name *</label><input autoFocus value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></div>
        <div><label className="l">Description</label><input value={form.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} /></div>
        <div>
          <label className="l">Agent *</label>
          <select value={form.agentId} onChange={(e) => set({ agentId: e.target.value })}>
            <option value="">Select an agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {!agents.length && <div className="w">No agents yet — create one on <a href="/agents" className="link">/agents</a>.</div>}
          {risky.length > 0 && <div className="w">This agent runs unattended with: {risky.join(', ')}.</div>}
        </div>
        <div><label className="l">Prompt *</label><textarea style={{ minHeight: 120 }} value={form.prompt} maxLength={20000} onChange={(e) => set({ prompt: e.target.value })} /></div>
        <div>
          <label className="l">Trigger</label>
          <div className="row">
            <label className="inl"><input type="radio" checked={form.mode === 'manual'} onChange={() => set({ mode: 'manual' })} />Manual only</label>
            <label className="inl"><input type="radio" checked={form.mode === 'cron'} onChange={() => set({ mode: 'cron' })} />Scheduled (cron)</label>
          </div>
        </div>
        {form.mode === 'cron' && <>
          <div className="row">{PRESETS.map(([l, e]) => <button key={e} type="button" className="btn btn-xs" onClick={() => set({ expr: e })}>{l}</button>)}</div>
          <div className="row">
            <div style={{ flex: 1 }}><label className="l">Cron (min hour day month weekday)</label><input value={form.expr} onChange={(e) => set({ expr: e.target.value })} style={{ fontFamily: 'monospace' }} /></div>
            <div style={{ flex: 1 }}><label className="l">Timezone</label>
              <select value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>{[...new Set([form.timezone, ...tzs])].map((z) => <option key={z}>{z}</option>)}</select></div>
          </div>
          {cronErr ? <div className="e">{cronErr}</div> : next.length > 0 && <div className="sp">Next: {next.map((t) => new Date(t).toLocaleString()).join(' · ')}</div>}
          <label className="inl"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Schedule enabled</label>
        </>}
        <div className="row">
          <div><label className="l">If previous run still running</label>
            <select value={form.overlap} onChange={(e) => set({ overlap: e.target.value as any })}><option value="skip">Skip</option><option value="allow">Run anyway</option></select></div>
          <div><label className="l">Timeout (sec)</label><input type="number" min={10} max={86400} value={form.timeoutSec} onChange={(e) => set({ timeoutSec: Number(e.target.value) })} /></div>
          <label className="inl"><input type="checkbox" checked={form.notify} onChange={(e) => set({ notify: e.target.checked })} />Browser notification</label>
        </div>
        {error && <p className="e" style={{ margin: 0 }}>{error}</p>}
        <div className="modal-action row" style={{ margin: 0 }}>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-sm" onClick={() => onDone()}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !form.name.trim() || !form.agentId || !form.prompt.trim() || (form.mode === 'cron' && !!cronErr)}>{job ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function Scheduler() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selId, setSelId] = useState<string | null>(pathIds().job);
  const [runs, setRuns] = useState<RunSum[]>([]);
  const [viewRun, setViewRun] = useState<string | null>(pathIds().run);
  const [edit, setEdit] = useState<Job | 'new' | null>(null);
  const [error, setError] = useState('');
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const selRef = useRef(selId); selRef.current = selId;

  const reload = () => api('/api/scheduler/jobs').then((d: Job[]) => { setJobs(d); return d; }).catch((e) => setError(e.message));
  const reloadRuns = () => selRef.current ? api(`/api/scheduler/jobs/${selRef.current}/runs`).then(setRuns).catch(() => setRuns([])) : setRuns([]);
  const select = (id: string | null) => { setSelId(id); setViewRun(null); history.pushState(null, '', id ? `/scheduler/${id}` : '/scheduler'); };
  const openRun = (id: string | null) => { setViewRun(id); history.replaceState(null, '', `/scheduler/${selId}${id ? '?run=' + id : ''}`); };

  useEffect(() => { reload(); api('/api/agent-defs').then(setAgents).catch(() => {}); }, []);
  useEffect(() => { reloadRuns(); }, [selId]);
  // live updates from server events; poll as a fallback while something is running
  useEffect(() => {
    const es = new EventSource('/api/scheduler/events');
    es.onmessage = () => { reload(); reloadRuns(); };
    return () => es.close();
  }, []);
  const job = jobs?.find((j) => j.id === selId) || null;
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const t = setInterval(() => { reload(); reloadRuns(); }, 3000);
    return () => clearInterval(t);
  }, [runs]);

  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e: any) { setError(e.message); } await reload(); await reloadRuns(); };
  const runNow = () => act(() => api(`/api/scheduler/jobs/${job!.id}/run`, 'POST'));
  const toggle = (j: Job) => act(() => api(`/api/scheduler/jobs/${j.id}`, 'PUT', { ...toBody(toForm(j)), enabled: !j.enabled }));
  const del = () => { if (confirm(`Delete job "${job!.name}" and its run history?`)) act(async () => { await api(`/api/scheduler/jobs/${job!.id}`, 'DELETE'); select(null); }); };
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name;
  const enableNotif = async () => { setPerm(await Notification.requestPermission()); if (Notification.permission === 'granted') location.reload(); };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Scheduler {jobs && <small>({jobs.length})</small>}</h2>
        <div className="row">
          {perm === 'default' && <button className="btn btn-sm" onClick={enableNotif}>🔔 Enable notifications</button>}
          {perm === 'denied' && <span className="w">Notifications blocked in browser settings</span>}
          {perm === 'granted' && <span className="sp">🔔 notifications on</span>}
          <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}>+ New job</button>
        </div>
      </div>
      {error && <p className="e">{error}</p>}
      {!jobs && !error && <div style={{ textAlign: 'center', padding: '2rem' }}><span className="loading loading-spinner loading-lg" /></div>}
      {jobs && !jobs.length && <p className="hint">No jobs yet. Click “New job” to create one.</p>}
      {jobs && jobs.length > 0 && (
        <div className="split">
          <div className="jl">
            {jobs.map((j) => (
              <button key={j.id} className={'card-a' + (j.id === selId ? ' on' : '')} onClick={() => select(j.id)}>
                <b><span className={'dot ' + (j.running ? 'running' : j.lastRun?.status || '')} />{j.name}</b>
                <span className="sp">{agentName(j.agentId) || '⚠ agent missing'}</span>
                <span className="sp">{trig(j)}{j.trigger.type === 'cron' && !j.enabled ? ' · paused' : ''}</span>
                {j.nextRunAt && <span className="sp">next: {when(j.nextRunAt)}</span>}
              </button>
            ))}
          </div>
          <div>
            {!job && <p className="hint">Select a job to see details and history.</p>}
            {job && (
              <div className="f">
                <div className="panel">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h3 style={{ margin: 0 }}>{job.name}</h3>
                    <div className="row">
                      <button className="btn btn-primary btn-sm" onClick={runNow} disabled={job.running > 0 && job.overlap === 'skip'}>▶ Run now</button>
                      {job.trigger.type === 'cron' && <button className="btn btn-sm" onClick={() => toggle(job)}>{job.enabled ? 'Pause' : 'Resume'}</button>}
                      <button className="btn btn-sm" onClick={() => setEdit(job)}>Edit</button>
                      <button className="btn btn-error btn-outline btn-sm" onClick={del}>Delete</button>
                    </div>
                  </div>
                  {job.description && <div>{job.description}</div>}
                  <div className="sp">Agent: {agentName(job.agentId) || '⚠ missing'} · Trigger: {trig(job)}{job.trigger.type === 'cron' && !job.enabled ? ' (paused)' : ''} · Next: {when(job.nextRunAt)} · Timeout {job.timeoutSec}s · Overlap: {job.overlap} · Notify: {job.notify ? 'on' : 'off'}</div>
                  <pre className="sbody">{job.prompt}</pre>
                </div>
                <h3 style={{ margin: '8px 0 0' }}>History <small>({runs.length})</small></h3>
                {!runs.length && <p className="hint">No runs yet.</p>}
                {runs.length > 0 && (
                  <table className="tbl">
                    <thead><tr><th>Started</th><th>Source</th><th>Status</th><th>Duration</th><th>Tokens in/out</th><th /></tr></thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id} className="clk" onClick={() => openRun(r.id)} title={r.error}>
                          <td>{when(r.startedAt)}</td><td>{r.source}</td><td><Badge s={r.status} /></td><td>{dur(r)}</td>
                          <td>{r.usage ? `${r.usage.input}/${r.usage.output}` : '—'}</td>
                          <td>{r.status === 'running'
                            ? <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); act(() => api(`/api/scheduler/runs/${r.id}/cancel`, 'POST')); }}>Cancel</button>
                            : <button className="btn btn-xs btn-ghost" title="Delete run" onClick={(e) => { e.stopPropagation(); act(() => api(`/api/scheduler/runs/${r.id}`, 'DELETE')); }}>✕</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {edit && <JobForm job={edit === 'new' ? null : edit} agents={agents} onDone={(j) => { setEdit(null); if (j) { reload(); select(j.id); } }} />}
      {viewRun && selId && <RunView id={viewRun} onClose={() => openRun(null)} />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Scheduler />);
