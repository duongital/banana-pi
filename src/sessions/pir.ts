/**
 * pir.js
 * Agent adapter for the `pir` CLI (a pi-like agent).
 *
 * pir stores sessions as JSONL files under a per-project directory:
 *   <root>/<encoded-cwd>/<id>.jsonl
 *
 * The first line of every file is a `meta` header:
 *   {"type":"meta","id":"..","cwd":"/abs/path","createdAt":<ms>,
 *    "updatedAt":<ms>,"current":"<leaf-node-id>"}
 *
 * Subsequent lines are `node` entries forming a tree via parentId:
 *   {"type":"node","id":"..","parentId":"..|null","timestamp":<ms>,
 *    "message":{"role":"user|assistant|tool","content":[...blocks]}}
 *
 * The active branch is the path from `meta.current` back to the root (falling
 * back to leaf detection if `current` is missing).
 *
 * Differences from pi that this adapter normalizes for the shared UI:
 *   - header type is `meta` (not `session`)
 *   - entries are `node` (not `message`) → mapped to `{type:'message', ...}`
 *   - timestamps are epoch-ms numbers → converted to ISO strings
 *   - project dir names are not `--`-wrapped; the real cwd comes from meta.cwd
 *
 * Session directory resolution order:
 *   1. PIR_SESSIONS_DIR env var (used by the Docker mount)
 *   2. ~/.pir/sessions
 */

import { resolveId, shortId } from './ids.ts';
import { readdirSync, existsSync, readFileSync, statSync, unlinkSync, appendFileSync, accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentAdapter } from './base.ts';

const SESSIONS_DIR =
  process.env.PIR_SESSIONS_DIR || join(homedir(), '.pir', 'sessions');

export class PirAdapter extends AgentAdapter {
  id = 'pir';
  name = 'Pir';
  root: string;

  constructor(sessionsDir = SESSIONS_DIR) {
    super();
    this.root = sessionsDir;
  }

  isAvailable() {
    return existsSync(this.root);
  }

  listProjects() {
    if (!existsSync(this.root)) return [];

    const entries = readdirSync(this.root, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );

    const projects = entries
      .map((d) => {
        const dirPath = join(this.root, d.name);
        let sessionCount = 0;
        let latestTimestamp;
        let label = decodeDirName(d.name);
        try {
          const files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
          sessionCount = files.length;
          for (const f of files) {
            const meta = parseSessionMeta(join(dirPath, f));
            if (!meta) continue;
            if (meta.header.cwd) label = meta.header.cwd;
            const ts = meta.header.timestamp;
            if (ts && (!latestTimestamp || ts > latestTimestamp)) latestTimestamp = ts;
          }
        } catch {}
        return { id: d.name, label, sessionCount, latestTimestamp };
      })
      .filter((p) => p.sessionCount > 0);

    projects.sort((a, b) =>
      (b.latestTimestamp ?? '').localeCompare(a.latestTimestamp ?? ''),
    );
    return projects;
  }

  listSessions(projectId) {
    assertSafeSegment(projectId);
    const dirPath = join(this.root, projectId);
    if (!existsSync(dirPath)) return [];

    const files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));

    const sessions = files.flatMap((f) => {
      const filePath = join(dirPath, f);
      const meta = parseSessionMeta(filePath);
      if (!meta) return [];
      return [
        {
          id: encodeId(filePath),
          fileName: f,
          timestamp: meta.header.timestamp,
          sessionId: meta.header.id,
          sessionName: meta.sessionName,
          firstMessage: meta.firstMessage,
          entryCount: meta.entryCount,
          fileSize: meta.fileSize,
        },
      ];
    });

    // newest first (IDs aren't time-sortable, so sort by header timestamp)
    sessions.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    return sessions;
  }

  getSession(sessionId) {
    const filePath = this._resolve(resolveId(this.root, sessionId));
    this._assertInRoot(filePath);
    return parseSessionFull(filePath);
  }

  search(query, scope) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q || !existsSync(this.root)) return [];
    const grepContent = scope === 'content';

    const projectDirs = readdirSync(this.root, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );

    const results: any[] = [];
    for (const d of projectDirs) {
      const dirPath = join(this.root, d.name);
      let files;
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const f of files) {
        const filePath = join(dirPath, f);
        const meta = parseSessionMeta(filePath);
        if (!meta) continue;

        const name = (meta.sessionName ?? '').toLowerCase();
        const first = (meta.firstMessage ?? '').toLowerCase();

        let matchField: any = null;
        if (name.includes(q)) matchField = 'name';
        else if (first.includes(q)) matchField = 'message';
        else if (grepContent) {
          try {
            if (readFileSync(filePath, 'utf8').toLowerCase().includes(q))
              matchField = 'content';
          } catch {}
        }
        if (!matchField) continue;

        results.push({
          id: encodeId(filePath),
          fileName: f,
          projectId: d.name,
          projectLabel: meta.header.cwd || decodeDirName(d.name),
          matchField,
          timestamp: meta.header.timestamp,
          sessionName: meta.sessionName,
          firstMessage: meta.firstMessage,
        });
      }
    }

    results.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    return results;
  }

  /** Remap ids made on another host/container (different root) onto this root: <root>/<project>/<file>. */
  _resolve(filePath) {
    if (filePath.startsWith(this.root + "/")) return filePath;
    const parts = filePath.split("/");
    if (parts.length < 2 || parts.includes("..")) return filePath;
    return this.root + "/" + parts.slice(-2).join("/");
  }

  _assertInRoot(filePath) {
    if (!filePath.startsWith(this.root + '/')) {
      const err = new Error('Access denied');
      err.status = 403;
      throw err;
    }
  }

  /** Whether session files can be modified (root mounted read-write). */
  canModify() {
    try {
      accessSync(this.root, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  deleteSession(sessionId) {
    const filePath = this._resolve(resolveId(this.root, sessionId));
    this._assertInRoot(filePath);
    if (!existsSync(filePath)) {
      const err = new Error('File not found');
      err.status = 404;
      throw err;
    }
    unlinkSync(filePath);
    return { ok: true };
  }

  /**
   * Rename a session by appending a viewer-only `session_info` entry attached to
   * the current leaf (non-destructive, append-only). pir ignores unknown entry
   * types, so this does not interfere with the agent itself.
   */
  renameSession(sessionId, rawName) {
    const filePath = this._resolve(resolveId(this.root, sessionId));
    this._assertInRoot(filePath);
    if (!existsSync(filePath)) {
      const err = new Error('File not found');
      err.status = 404;
      throw err;
    }
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      const err = new Error('Missing or empty "name"');
      err.status = 400;
      throw err;
    }
    if (name.length > 200) {
      const err = new Error('Name too long (max 200 chars)');
      err.status = 400;
      throw err;
    }

    // Attach to the current leaf so the rename lands on the active branch.
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    let meta: any = null;
    const entries: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (obj.type === 'meta') meta = obj;
      else entries.push(obj);
    }

    let leafId = meta?.current;
    if (!leafId) {
      const hasChildren = new Set();
      for (const e of entries) if (e.parentId) hasChildren.add(e.parentId);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.id && !hasChildren.has(e.id)) {
          leafId = e.id;
          break;
        }
      }
    }

    const entry = {
      type: 'session_info',
      id: randomBytes(4).toString('hex'),
      parentId: leafId ?? null,
      timestamp: new Date().toISOString(),
      name,
    };
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
    return { ok: true, name };
  }
}

// ── id helpers (base64url of the absolute file path) ──────────────────────────

function encodeId(filePath) {
  return shortId(filePath);
}

function assertSafeSegment(seg) {
  if (!seg || seg.includes('..') || seg.includes('/') || seg.includes('\\')) {
    const err = new Error('Invalid project id');
    err.status = 400;
    throw err;
  }
}

// ── parsing ───────────────────────────────────────────────────────────────────

/** Epoch-ms (or anything Date accepts) → ISO string, for consistent sorting. */
function toIso(t) {
  if (t == null) return undefined;
  const d = new Date(t);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Extract the first text block from a message's content. */
function firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.find((b) => b.type === 'text')?.text ?? '';
  return '';
}

/** Normalize a pir `node` into the `{type:'message', ...}` shape the UI wants. */
function normalizeNode(n) {
  return {
    type: 'message',
    id: n.id,
    parentId: n.parentId ?? null,
    timestamp: toIso(n.timestamp),
    message: n.message,
  };
}

function parseSessionMeta(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const raw = JSON.parse(lines[0]);
    if (raw.type !== 'meta') return null;
    const header = {
      ...raw,
      timestamp: toIso(raw.updatedAt ?? raw.createdAt),
    };

    const stat = statSync(filePath);
    let entryCount = 0;
    let sessionName;
    let firstMessage;

    for (let i = 1; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'session_info' && entry.name) {
          sessionName = entry.name;
          continue;
        }
        if (entry.type !== 'node') continue;
        entryCount++;
        if (!firstMessage && entry.message?.role === 'user') {
          firstMessage = firstText(entry.message.content).slice(0, 120).trim();
        }
      } catch {}
    }
    return { filePath, header, sessionName, firstMessage, entryCount, fileSize: stat.size };
  } catch {
    return null;
  }
}

function parseSessionFull(filePath) {
  if (!existsSync(filePath)) {
    const err = new Error(`File not found: ${filePath}`);
    err.status = 404;
    throw err;
  }
  const content = readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) throw new Error('Empty session file');

  let meta: any = null;
  const nodes: any[] = [];
  let renameName;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'meta') meta = obj;
    else if (obj.type === 'node') nodes.push(normalizeNode(obj));
    else if (obj.type === 'session_info' && obj.name) renameName = obj.name;
  }

  const header = meta
    ? { ...meta, timestamp: toIso(meta.updatedAt ?? meta.createdAt) }
    : {};

  const byId = new Map();
  for (const e of nodes) if (e.id) byId.set(e.id, e);

  // Prefer the explicit leaf from meta.current; fall back to leaf detection.
  let leaf = meta?.current ? byId.get(meta.current) : null;
  if (!leaf) {
    const hasChildren = new Set();
    for (const e of nodes) if (e.parentId) hasChildren.add(e.parentId);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const e = nodes[i];
      if (e.id && !hasChildren.has(e.id)) {
        leaf = e;
        break;
      }
    }
  }

  const reversed: any[] = [];
  const seen = new Set();
  let cur = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    reversed.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  const branch = reversed.reverse();

  return {
    header,
    sessionName: renameName,
    branch,
    allEntries: nodes,
    leafId: leaf?.id,
  };
}

// ── path decoding ─────────────────────────────────────────────────────────────

/** "home-dng52-rust-pir" -> "/home/dng52/rust/pir" (lossy; meta.cwd preferred). */
function decodeDirName(dirName) {
  const inner = dirName.replace(/^-+/, '').replace(/-+$/, '');
  return '/' + inner.replace(/-/g, '/');
}
