/** Session tags: a single JSON file in SAVED_DATA_DIR (atomic writes). Keys are `agent:id`. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shortId } from './sessions/ids.ts';

const DIR = process.env.SAVED_DATA_DIR || join(homedir(), '.local', 'share', 'banana-pi-saved');
const FILE = join(DIR, 'tags.json');

type Tagged = { agent: string; id: string; tags: string[]; title?: string; project?: string; timestamp?: string };

/** Legacy base64url path ids -> short ids, so one session never has two entries. */
const canonId = (id: string) => {
  if (id.startsWith('L')) {
    try {
      const p = Buffer.from(id, 'base64url').toString('utf8');
      if (p.startsWith('/') && p.endsWith('.jsonl')) return shortId(p);
    } catch {}
  }
  return id;
};
function load(): Tagged[] {
  let raw: Tagged[] = [];
  try { raw = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []; } catch {}
  const m = new Map<string, Tagged>();
  for (const t of raw) {
    const id = canonId(t.id);
    const prev = m.get(t.agent + ':' + id);
    m.set(t.agent + ':' + id, { ...prev, ...t, id, tags: [...new Set([...(prev?.tags || []), ...t.tags])] });
  }
  return [...m.values()];
}
function store(list: Tagged[]) {
  mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, FILE);
}

export const listTags = () => load();

export function setTags(p: Partial<Tagged>) {
  if (!p.agent || !p.id) throw Object.assign(new Error('agent and id required'), { status: 400 });
  p.id = canonId(p.id);
  const tags = [...new Set((p.tags || []).map((t) => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean))];
  const list = load().filter((s) => !(s.agent === p.agent && s.id === p.id));
  if (tags.length) list.push({ agent: p.agent, id: p.id, tags, title: p.title, project: p.project, timestamp: p.timestamp });
  store(list);
  return { ok: true, tags };
}

export function renameTagged(agent: string, id: string, title: string) {
  id = canonId(id);
  const list = load();
  let changed = false;
  for (const t of list) if (t.agent === agent && t.id === id) { t.title = title; changed = true; }
  if (changed) store(list);
}

// ── Tag notes: one note per tag name (key = tag) ──
const NOTES = join(DIR, 'tag-notes.json');
function loadNotes(): Record<string, string> {
  try { return existsSync(NOTES) ? JSON.parse(readFileSync(NOTES, 'utf8')) : {}; } catch { return {}; }
}
const normTag = (t: string) => String(t || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
export const getTagNote = (tag: string) => ({ tag: normTag(tag), note: loadNotes()[normTag(tag)] ?? '' });
export function setTagNote(p: { tag?: string; note?: string }) {
  const tag = normTag(p.tag || '');
  if (!tag) throw Object.assign(new Error('tag required'), { status: 400 });
  const all = loadNotes();
  if (p.note && p.note.trim()) all[tag] = p.note.trim(); else delete all[tag];
  mkdirSync(DIR, { recursive: true });
  const tmp = NOTES + '.tmp';
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, NOTES);
  return { ok: true };
}
