/**
 * pi.js
 * Agent adapter for the `pi` CLI.
 *
 * pi stores sessions as JSONL files under a per-project directory:
 *   <root>/--<encoded-cwd>--/<timestamp>_<id>.jsonl
 *
 * The first line of every file is a `session` header; subsequent lines are
 * entries (messages, tool calls, session_info, ...) forming a tree via
 * parentId. The active branch is reconstructed by walking leaf -> root.
 *
 * Session directory resolution order:
 *   1. PI_SESSIONS_DIR env var (used by the Docker mount)
 *   2. ~/.pi/agent/sessions
 */

import { resolveId, shortId } from './ids.ts';
import { openSync, readSync, closeSync, readdirSync, existsSync, readFileSync, statSync, unlinkSync, appendFileSync, accessSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentAdapter } from './base.ts';

const SESSIONS_DIR =
  process.env.PI_SESSIONS_DIR || join(homedir(), '.pi', 'agent', 'sessions');

export class PiAdapter extends AgentAdapter {
  id = 'pi';
  name = 'Pi';
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
          const files = readdirSync(dirPath)
            .filter((f) => f.endsWith('.jsonl'))
            .sort();
          sessionCount = files.length;
          if (files.length) latestTimestamp = files[files.length - 1].split('_')[0];
          if (files.length) label = readHeaderCwd(join(dirPath, files[files.length - 1])) || label;
        } catch {}
        return {
          id: d.name,
          label,
          sessionCount,
          latestTimestamp,
        };
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

    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first

    return files.flatMap((f) => {
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
   * Rename a session by appending a `session_info` entry attached to the current
   * leaf, matching how pi records renames (non-destructive, append-only).
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

    // Find the current leaf so the rename attaches to the active branch.
    let leafId;
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {}
    }
    const hasChildren = new Set();
    for (const e of entries) if (e.parentId) hasChildren.add(e.parentId);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.id && !hasChildren.has(e.id)) {
        leafId = e.id;
        break;
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

// ── parsing (ported from the session-viewer pi extension) ─────────────────────

const metaCache = new Map<string, { key: string; meta: any }>();

function parseSessionMeta(filePath) {
  let stat;
  try { stat = statSync(filePath); } catch { return null; }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = metaCache.get(filePath);
  if (hit && hit.key === key) return hit.meta;
  const meta = parseSessionMetaUncached(filePath, stat);
  metaCache.set(filePath, { key, meta });
  return meta;
}

function parseSessionMetaUncached(filePath, stat) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;

    const header = JSON.parse(lines[0]);
    if (header.type !== 'session') return null;

    const entryCount = lines.length - 1;
    let sessionName;
    let firstMessage;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Only fully parse lines that can affect the metadata.
      const isInfo = line.includes('"session_info"');
      const maybeUser = !firstMessage && line.includes('"user"');
      if (!isInfo && !maybeUser) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
        if (!firstMessage && entry.type === 'message' && entry.message?.role === 'user') {
          const c = entry.message.content;
          if (typeof c === 'string') firstMessage = c.slice(0, 120).trim();
          else if (Array.isArray(c))
            firstMessage = (c.find((b) => b.type === 'text')?.text ?? '').slice(0, 120).trim();
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

  const header = JSON.parse(lines[0]);
  const allEntries: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      allEntries.push(JSON.parse(lines[i]));
    } catch {}
  }

  const byId = new Map();
  for (const e of allEntries) if (e.id) byId.set(e.id, e);

  const hasChildren = new Set();
  for (const e of allEntries) if (e.parentId) hasChildren.add(e.parentId);

  let leaf: any = null;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const e = allEntries[i];
    if (e.id && !hasChildren.has(e.id)) {
      leaf = e;
      break;
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

  let sessionName;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    if (allEntries[i].type === 'session_info' && allEntries[i].name) {
      sessionName = allEntries[i].name;
      break;
    }
  }

  return { header, sessionName, branch, allEntries, leafId: leaf?.id };
}

// ── path decoding ─────────────────────────────────────────────────────────────

/** "--home-dng52-.pi-agent--" -> "/home/dng52/.pi/agent" (lossy for dashes). */
function decodeDirName(dirName) {
  const inner = dirName.replace(/^--/, '').replace(/--$/, '');
  return '/' + inner.replace(/-/g, '/');
}

/** Real working directory from the session header (first line); '' if unavailable. */
function readHeaderCwd(filePath) {
  try {
    const fd = openSync(filePath, 'r');
    let first;
    try {
      const buf = Buffer.alloc(8192);
      first = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0)).split('\n', 1)[0];
    } finally {
      closeSync(fd);
    }
    const o = JSON.parse(first);
    return typeof o?.cwd === 'string' ? o.cwd : '';
  } catch {
    return '';
  }
}
