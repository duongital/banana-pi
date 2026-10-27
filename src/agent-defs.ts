/** Agent definitions (model + system prompt + tools): one JSON file per agent in AGENTS_DATA_DIR. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DIR = process.env.AGENTS_DATA_DIR || join(homedir(), '.local', 'share', 'banana-pi-agents');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const file = (id: string) => join(DIR, id + '.json');

export type AgentDef = {
  id: string; name: string; description?: string; model: string;
  systemPrompt: string; tools: string[]; skills?: string[]; created: number; updated: number;
};

export const TOOLS = [
  { id: 'read', label: 'read', description: 'Read file contents' },
  { id: 'write', label: 'write', description: 'Create or overwrite files' },
  { id: 'edit', label: 'edit', description: 'Edit files via exact text replacement' },
  { id: 'bash', label: 'bash', description: 'Execute shell commands' },
  { id: 'grep', label: 'grep', description: 'Search file contents' },
  { id: 'find', label: 'find', description: 'Find files by name/pattern' },
  { id: 'ls', label: 'ls', description: 'List directory contents' },
  { id: 'web_search', label: 'web_search', description: 'Search the web' },
  { id: 'web_fetch', label: 'web_fetch', description: 'Fetch the content of a URL' },
];

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

function loadAll(): AgentDef[] {
  if (!existsSync(DIR)) return [];
  const out: AgentDef[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(DIR, f), 'utf8'))); } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function save(a: AgentDef) {
  mkdirSync(DIR, { recursive: true });
  const tmp = file(a.id) + '.tmp';
  writeFileSync(tmp, JSON.stringify(a, null, 2));
  renameSync(tmp, file(a.id));
}

function validate(p: any, selfId?: string) {
  if (!p || typeof p !== 'object') throw err('Invalid body', 400);
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || name.length > 80) throw err('name required (1-80 chars)', 400);
  if (typeof p.model !== 'string' || !p.model.trim()) throw err('model required', 400);
  const systemPrompt = p.systemPrompt ?? '';
  if (typeof systemPrompt !== 'string' || systemPrompt.length > 20000) throw err('systemPrompt must be a string (max 20000 chars)', 400);
  const tools = p.tools ?? [];
  if (!Array.isArray(tools)) throw err('tools must be an array', 400);
  const bad = tools.filter((t: any) => !TOOLS.some((x) => x.id === t));
  if (bad.length) throw err('Unknown tools: ' + bad.join(', '), 400);
  if (loadAll().some((a) => a.id !== selfId && a.name.toLowerCase() === name.toLowerCase())) throw err('An agent with this name already exists', 409);
  const skills = p.skills ?? [];
  if (!Array.isArray(skills) || skills.some((s: any) => typeof s !== 'string' || !s || s.length > 200)) throw err('skills must be an array of skill names', 400);
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 500) : '';
  return { name, description: description || undefined, model: p.model.trim(), systemPrompt, tools: [...new Set<string>(tools)], skills: [...new Set<string>(skills)] };
}

export const listAgentDefs = () => loadAll();

export function getAgentDef(id: string): AgentDef {
  if (!ID_RE.test(id)) throw err('Invalid id', 400);
  if (!existsSync(file(id))) throw err('Not found', 404);
  return JSON.parse(readFileSync(file(id), 'utf8'));
}

export function createAgentDef(p: any): AgentDef {
  const now = Date.now();
  const a: AgentDef = { id: randomUUID(), ...validate(p), created: now, updated: now };
  save(a);
  return a;
}

export function updateAgentDef(id: string, p: any): AgentDef {
  const old = getAgentDef(id);
  const a: AgentDef = { ...old, ...validate(p, id), id, updated: Date.now() };
  if (!a.description) delete a.description;
  save(a);
  return a;
}

export function deleteAgentDef(id: string) {
  if (!ID_RE.test(id)) throw err('Invalid id', 400);
  if (existsSync(file(id))) unlinkSync(file(id));
  return { ok: true };
}

/** Handle /api/agent-defs[/:id] and /api/agent-tools. Returns true if handled. */
export async function agentDefsApi(req: any, res: any, pathname: string, readBody: (r: any) => Promise<unknown>) {
  const send = (data: any, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  if (pathname === '/api/agent-tools') {
    if (req.method !== 'GET') return send({ error: 'Method not allowed' }, 405), true;
    return send(TOOLS), true;
  }
  const m = pathname.match(/^\/api\/agent-defs(?:\/([^/]+))?$/);
  if (!m) return false;
  const id = m[1];
  try {
    const json = async () => { try { return JSON.parse((await readBody(req) as string) || '{}'); } catch { throw err('Invalid JSON body', 400); } };
    if (!id) {
      if (req.method === 'GET') return send(listAgentDefs()), true;
      if (req.method === 'POST') return send(createAgentDef(await json()), 201), true;
    } else {
      if (req.method === 'GET') return send(getAgentDef(id)), true;
      if (req.method === 'PUT') return send(updateAgentDef(id, await json())), true;
      if (req.method === 'DELETE') return send(deleteAgentDef(id)), true;
    }
    send({ error: 'Method not allowed' }, 405);
  } catch (e: any) {
    send({ error: e.message }, e.status || 500);
  }
  return true;
}
