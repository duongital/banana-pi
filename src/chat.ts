// Minimal chat backend: proxies to the HRS LiteLLM gateway (OpenAI-compatible).
// Stateless — the browser sends the full message history on every request.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.LITELLM_BASE_URL || 'https://aigateway.pec.hrs.cc/v1';
const KEY_FILE = process.env.LITELLM_KEY_FILE || join(homedir(), '.pi', 'agent', '.litellm.key');

export function apiKey() {
  if (process.env.LITELLM_API_KEY) return process.env.LITELLM_API_KEY;
  try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

export async function chatModels(res) {
  try {
    const key = apiKey();
    if (!key) return json(res, { error: 'No LiteLLM API key configured' }, 500);
    const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return json(res, { error: `Gateway ${r.status}` }, 502);
    const d = await r.json();
    json(res, ((d as any).data || []).map((m: any) => m.id).sort());
  } catch (e: any) {
    json(res, { error: e.message }, 502);
  }
}

export async function modelDetails(res) {
  try {
    const key = apiKey();
    if (!key) return json(res, { error: 'No LiteLLM API key configured' }, 500);
    const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return json(res, { error: `Gateway ${r.status}` }, 502);
    const d = await r.json();
    const list = ((d as any).data || []).map((m: any) => ({
      id: m.id,
      owned_by: m.owned_by ?? null,
      mode: m.mode ?? null,
      created: m.created ?? null,
      max_input_tokens: m.max_input_tokens ?? null,
      max_output_tokens: m.max_output_tokens ?? null,
    })).sort((a: any, b: any) => a.id.localeCompare(b.id));
    json(res, list);
  } catch (e: any) {
    json(res, { error: e.message }, 502);
  }
}

export async function chatCompletion(req, res) {
  let body = '';
  for await (const c of req) body += c;
  let payload;
  try { payload = JSON.parse(body); } catch { return json(res, { error: 'Invalid JSON' }, 400); }
  const key = apiKey();
  if (!key) return json(res, { error: 'No LiteLLM API key configured' }, 500);

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const r = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: payload.model, messages: payload.messages, stream: true, stream_options: { include_usage: true } }),
    });
    if (!r.ok) return json(res, { error: (await r.text()).slice(0, 500) }, r.status);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for await (const chunk of r.body as any) res.write(chunk);
    res.end();
  } catch (e: any) {
    if (!res.headersSent) json(res, { error: e.message }, 502);
    else res.end();
  }
}

// ── Persisted chat sessions: one JSON file per chat in CHAT_DATA_DIR ──────────
const DATA_DIR = process.env.CHAT_DATA_DIR || join(homedir(), '.local', 'share', 'banana-pi-chat');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const file = (id) => join(DATA_DIR, id + '.json');

/** Handle /api/chat/sessions[/:id]. Returns true if the request was handled. */
export async function chatSessions(req, res, pathname) {
  const m = pathname.match(/^\/api\/chat\/sessions(?:\/([^/]+))?$/);
  if (!m) return false;
  const id = m[1];
  try {
    if (!id) {
      if (req.method !== 'GET') return json(res, { error: 'Method not allowed' }, 405), true;
      mkdirSync(DATA_DIR, { recursive: true });
      const list = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => {
        try {
          const { id, title, model, updated } = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
          return { id, title, model, updated };
        } catch { return null; }
      }).filter(Boolean).sort((a: any, b: any) => b.updated - a.updated);
      return json(res, list), true;
    }
    if (!ID_RE.test(id)) return json(res, { error: 'Invalid id' }, 400), true;
    if (req.method === 'GET') {
      if (!existsSync(file(id))) return json(res, { error: 'Not found' }, 404), true;
      return json(res, JSON.parse(readFileSync(file(id), 'utf8'))), true;
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const c of req) body += c;
      const p = JSON.parse(body);
      if (!Array.isArray(p.messages)) return json(res, { error: 'messages required' }, 400), true;
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(file(id), JSON.stringify({
        id, title: String(p.title || 'New chat').slice(0, 100), model: p.model || '',
        messages: p.messages, updated: Date.now(),
      }));
      return json(res, { ok: true }), true;
    }
    if (req.method === 'DELETE') {
      if (existsSync(file(id))) unlinkSync(file(id));
      return json(res, { ok: true }), true;
    }
    return json(res, { error: 'Method not allowed' }, 405), true;
  } catch (e: any) {
    return json(res, { error: e.message }, 500), true;
  }
}
