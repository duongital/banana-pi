/** Saved sessions: a single JSON file in SAVED_DATA_DIR (atomic writes). */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.SAVED_DATA_DIR || join(homedir(), '.local', 'share', 'banana-pi-saved');
const FILE = join(DIR, 'saved.json');

type Saved = {
  agent: string; id: string; title: string; project?: string; savedAt: number;
  /** Set for a saved single assistant response (kind 'message'). */
  entryId?: string; text?: string;
  /** Optional user note shown under the item. */
  note?: string;
  /** User tags (lowercase, no #). */
  tags?: string[];
};
const same = (s: Saved, agent: string, id: string, entryId?: string) =>
  s.agent === agent && s.id === id && (s.entryId || '') === (entryId || '');

function load(): Saved[] {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
  } catch { return []; }
}
function store(list: Saved[]) {
  mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, FILE);
}

export const listSaved = () => load().sort((a, b) => b.savedAt - a.savedAt);

export function addSaved(p: Partial<Saved>) {
  if (!p.agent || !p.id) throw Object.assign(new Error('agent and id required'), { status: 400 });
  const list = load().filter((s) => !same(s, p.agent!, p.id!, p.entryId));
  const item: Saved = { agent: p.agent, id: p.id, title: p.title || p.id, project: p.project || '', savedAt: Date.now() };
  if (p.entryId) { item.entryId = p.entryId; item.text = p.text || ''; }
  list.push(item);
  store(list);
  return { ok: true };
}

export function removeSaved(agent: string, id: string, entryId?: string) {
  store(load().filter((s) => !same(s, agent, id, entryId)));
  return { ok: true };
}

export function updateSaved(agent: string, id: string, entryId: string | undefined, patch: { title?: string; note?: string; tags?: string[] }) {
  const list = load();
  const item = list.find((s) => same(s, agent, id, entryId));
  if (!item) throw Object.assign(new Error('Not found'), { status: 404 });
  if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim();
  if (typeof patch.note === 'string') {
    if (patch.note.trim()) item.note = patch.note.trim(); else delete item.note;
  }
  if (Array.isArray(patch.tags)) {
    const tags = [...new Set(patch.tags.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
    if (tags.length) item.tags = tags; else delete item.tags;
  }
  store(list);
  return item;
}
