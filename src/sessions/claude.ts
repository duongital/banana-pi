/**
 * claude.js
 * Agent adapter for Anthropic's `claude` CLI (Claude Code).
 *
 * Claude Code stores each session as a JSONL file under a per-project directory
 * keyed by the (lossily) encoded working directory:
 *   <root>/<encoded-cwd>/<session-uuid>.jsonl
 *
 * where <root> defaults to ~/.claude/projects. Subdirectories inside a project
 * (e.g. `subagents/`, `memory/`) are ignored — only the top-level `<uuid>.jsonl`
 * files are treated as sessions.
 *
 * File format (one JSON object per line, see amplifier's claude-code-sessions
 * spec):
 *   - Records form a DAG via `uuid` / `parentUuid` (parents precede children).
 *   - Renderable turns are `type:"user"` and `type:"assistant"` records whose
 *     payload lives under `.message` ({ role, content }). `content` is either a
 *     string or an array of blocks (text / thinking / tool_use / tool_result /
 *     image).
 *   - Tool results come back as `type:"user"` records whose content is an array
 *     of `tool_result` blocks; we relabel their role to `tool` so the shared UI
 *     styles them as results rather than user turns.
 *   - Control frames (mode, permission-mode, last-prompt, file-history-snapshot,
 *     attachment, queue-operation, system/local_command, isMeta reminders, …)
 *     are kept for DAG traversal but not rendered.
 *   - The session title, when present, comes from an `ai-title` (`aiTitle`),
 *     `agent-name` (`agentName`), or `summary` (`summary`) record.
 *
 * The active branch is reconstructed by finding the last leaf (a uuid with no
 * children, by file order) and walking parentUuid pointers back to the root,
 * matching how Claude Code resolves forks (latest child wins).
 *
 * This adapter is read-only: Claude Code owns this data and manages titles via
 * its own `ai-title` records, so we never mutate the files (rename/delete are
 * intentionally unsupported).
 *
 * Session directory resolution order:
 *   1. CLAUDE_SESSIONS_DIR env var (used by the Docker mount)
 *   2. ~/.claude/projects
 */

import { resolveId, shortId } from './ids.ts';
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentAdapter } from './base.ts';

const SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR || join(homedir(), '.claude', 'projects');

export class ClaudeAdapter extends AgentAdapter {
  id = 'claude';
  name = 'Claude';
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
          const files = sessionFiles(dirPath);
          sessionCount = files.length;
          for (const f of files) {
            const stat = statSync(join(dirPath, f));
            const ts = stat.mtime.toISOString();
            if (!latestTimestamp || ts > latestTimestamp) latestTimestamp = ts;
          }
          // Prefer the real cwd recorded inside the newest session file.
          const cwd = firstCwd(join(dirPath, newestFile(dirPath, files)));
          if (cwd) label = cwd;
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

    const sessions = sessionFiles(dirPath).flatMap((f) => {
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

    // newest first (uuids aren't time-sortable, so sort by header timestamp)
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
        files = sessionFiles(dirPath);
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
          projectLabel: meta.cwd || decodeDirName(d.name),
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

  /** Read-only viewer: Claude Code owns and manages this data itself. */
  canModify() {
    return false;
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

// ── directory helpers ─────────────────────────────────────────────────────────

/** Top-level `<uuid>.jsonl` files only (skips subagents/, memory/, …). */
function sessionFiles(dirPath) {
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name);
}

/** The most-recently-modified session file name in a project dir. */
function newestFile(dirPath, files) {
  let best = files[0];
  let bestMtime = 0;
  for (const f of files) {
    try {
      const m = statSync(join(dirPath, f)).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    } catch {}
  }
  return best;
}

/** Scan a session file for the first `cwd` field (real working directory). */
function firstCwd(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.cwd === 'string') return o.cwd;
      } catch {}
    }
  } catch {}
  return undefined;
}

// ── content normalization ─────────────────────────────────────────────────────

/** Extract a plain-text preview from a message's `content`. */
function firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((b) => b && b.type === 'text');
    if (t) return t.text ?? '';
  }
  return '';
}

/** True if a user message is purely tool results (a synthetic "tool" turn). */
function isToolResultMessage(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b && b.type === 'tool_result')
  );
}

/** True for slash-command wrappers we don't want as a session's first message. */
function isCommandText(text) {
  return /^\s*<(command-|local-command-)/.test(text);
}

/**
 * Normalize a Claude `user`/`assistant` record into the shared UI shape
 * `{ type:'message', id, parentId, timestamp, message:{ role, content } }`.
 * Returns null for control frames / meta records that shouldn't be rendered.
 */
function normalizeRecord(raw) {
  const type = raw.type;
  if (type !== 'user' && type !== 'assistant') return null;
  if (raw.isMeta) return null;
  const msg = raw.message;
  if (!msg) return null;

  let role = msg.role || (type === 'user' ? 'user' : 'assistant');
  const content = msg.content;
  if (role === 'user' && isToolResultMessage(content)) role = 'tool';

  return {
    type: 'message',
    id: raw.uuid,
    parentId: raw.parentUuid ?? null,
    timestamp: raw.timestamp,
    message: { role, content },
  };
}

/** Pull a session title from an ai-title / agent-name / summary record. */
function recordTitle(raw) {
  if (raw.type === 'ai-title' && raw.aiTitle) return raw.aiTitle;
  if (raw.type === 'agent-name' && raw.agentName) return raw.agentName;
  if (raw.type === 'summary' && raw.summary) return raw.summary;
  return undefined;
}

// ── parsing ───────────────────────────────────────────────────────────────────

function parseSessionMeta(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const stat = statSync(filePath);

    let entryCount = 0;
    let sessionName;
    let firstMessage;
    let cwd;
    let lastTimestamp;
    let sessionUuid;

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!sessionUuid && entry.sessionId) sessionUuid = entry.sessionId;
      if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
      if (entry.timestamp) lastTimestamp = entry.timestamp;

      const title = recordTitle(entry);
      if (title) sessionName = title;

      if (entry.type === 'user' || entry.type === 'assistant') {
        if (entry.isMeta) continue;
        entryCount++;
        if (
          !firstMessage &&
          entry.type === 'user' &&
          !isToolResultMessage(entry.message?.content)
        ) {
          const t = firstText(entry.message?.content).trim();
          if (t && !isCommandText(t)) firstMessage = t.slice(0, 120).trim();
        }
      }
    }

    const header = {
      id: sessionUuid,
      cwd,
      timestamp: lastTimestamp || stat.mtime.toISOString(),
    };
    return {
      filePath,
      header,
      cwd,
      sessionName,
      firstMessage,
      entryCount,
      fileSize: stat.size,
    };
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
  const lines = content.split('\n');

  const records: any[] = []; // records with a uuid, in file order
  let sessionName;
  let cwd;
  let sessionUuid;
  let lastTimestamp;

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionUuid && raw.sessionId) sessionUuid = raw.sessionId;
    if (!cwd && typeof raw.cwd === 'string') cwd = raw.cwd;
    if (raw.timestamp) lastTimestamp = raw.timestamp;

    const title = recordTitle(raw);
    if (title) sessionName = title;

    if (raw.uuid) records.push(raw);
  }

  const byId = new Map();
  for (const r of records) byId.set(r.uuid, r);

  const hasChildren = new Set();
  for (const r of records) {
    if (r.parentUuid && byId.has(r.parentUuid)) hasChildren.add(r.parentUuid);
  }

  // Leaf = last record (by file order) that is nobody's parent → active branch.
  let leaf: any = null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!hasChildren.has(records[i].uuid)) {
      leaf = records[i];
      break;
    }
  }

  // Walk parentUuid pointers from the leaf back to the root.
  const reversed: any[] = [];
  const seen = new Set();
  let cur = leaf;
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    reversed.push(cur);
    cur = cur.parentUuid ? byId.get(cur.parentUuid) : null;
  }
  const chain = reversed.reverse();

  const branch = chain.map(normalizeRecord).filter(Boolean);
  const allEntries = records.map(normalizeRecord).filter(Boolean);

  const header = {
    id: sessionUuid,
    cwd,
    directory: cwd,
    timestamp: lastTimestamp,
  };

  return {
    header,
    sessionName,
    branch,
    allEntries,
    leafId: branch.length ? branch[branch.length - 1]!.id : (leaf as any)?.uuid,
  };
}

// ── path decoding ─────────────────────────────────────────────────────────────

/**
 * "-home-dng52--pi-agent" -> "/home/dng52/-pi/agent" (lossy: Claude encodes both
 * "/" and "." as "-", so the real cwd from a record's `cwd` field is preferred).
 */
function decodeDirName(dirName) {
  return dirName.replace(/-/g, '/');
}
