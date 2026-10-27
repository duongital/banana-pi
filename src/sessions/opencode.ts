/**
 * opencode.js
 * Agent adapter for the `opencode` CLI.
 *
 * Unlike pi / pir (JSONL files on disk), recent opencode versions store all
 * sessions in a single SQLite database:
 *   <root>/opencode.db
 *
 * Relevant tables:
 *   project(id, worktree, name, time_created, time_updated, ...)
 *   session(id, project_id, parent_id, slug, directory, title,
 *           version, time_created, time_updated, ...)
 *   message(id, session_id, time_created, time_updated, data)   -- data = JSON
 *   part(id, message_id, session_id, time_created, time_updated, data) -- data = JSON
 *
 * A session's conversation is the linear list of its `message` rows ordered by
 * `time_created`; each message's rendered content is the ordered list of its
 * `part` rows. We normalize these into the shared UI shape:
 *   { type:'message', id, parentId, message:{ role, content:[...blocks] } }
 *
 * opencode part types → UI blocks:
 *   text        -> { type:'text', text }
 *   reasoning   -> { type:'reasoning', text }
 *   tool        -> { type:'tool_use', name, input } (+ { type:'tool_result', output })
 *   file        -> { type:'text', text:'📎 <filename>' }
 *   patch       -> { type:'text', text:'📝 patch: <files>' }
 *   step-start / step-finish -> skipped (control frames)
 *
 * This adapter is read-only (SQLite opened with readOnly:true); rename/delete
 * are intentionally not supported so we never mutate opencode's live database.
 *
 * Data directory resolution order:
 *   1. OPENCODE_SESSIONS_DIR env var (used by the Docker mount)
 *   2. ~/.local/share/opencode
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { AgentAdapter } from './base.ts';

const ROOT_DIR =
  process.env.OPENCODE_SESSIONS_DIR || join(homedir(), '.local', 'share', 'opencode');

export class OpencodeAdapter extends AgentAdapter {
  id = 'opencode';
  name = 'opencode';
  root: string;
  dbPath: string;
  _db: Database | null;

  constructor(rootDir = ROOT_DIR) {
    super();
    this.root = rootDir;
    this.dbPath = join(rootDir, 'opencode.db');
    this._db = null;
  }

  isAvailable() {
    return existsSync(this.dbPath);
  }

  /** Lazily open (and cache) a read-only handle to the SQLite database. */
  _openDb() {
    if (this._db) {
      try {
        // Cheap liveness probe; reopen if the handle went stale.
        this._db.prepare<any, any[]>('SELECT 1').get();
        return this._db;
      } catch {
        try { this._db.close(); } catch {}
        this._db = null;
      }
    }
    const db = new Database(this.dbPath, { readonly: true });
    try { db.run('PRAGMA busy_timeout = 2000'); } catch {}
    this._db = db;
    return db;
  }

  listProjects() {
    if (!this.isAvailable()) return [];
    const db = this._openDb();

    const rows = db
      .prepare<any, any[]>(
        `SELECT p.id                        AS id,
                p.worktree                   AS worktree,
                p.name                       AS name,
                COUNT(s.id)                  AS sessionCount,
                MAX(s.time_updated)          AS latest
           FROM project p
           LEFT JOIN session s ON s.project_id = p.id
          GROUP BY p.id`,
      )
      .all();

    const projects = rows
      .filter((r) => r.sessionCount > 0)
      .map((r) => ({
        id: r.id,
        label: projectLabel(r),
        sessionCount: r.sessionCount,
        latestTimestamp: toIso(r.latest),
      }));

    projects.sort((a, b) =>
      (b.latestTimestamp ?? '').localeCompare(a.latestTimestamp ?? ''),
    );
    return projects;
  }

  listSessions(projectId) {
    assertSafeId(projectId);
    if (!this.isAvailable()) return [];
    const db = this._openDb();

    const sessions = db
      .prepare<any, any[]>(
        `SELECT id, title, slug, directory, time_created, time_updated
           FROM session
          WHERE project_id = ?
          ORDER BY time_updated DESC`,
      )
      .all(projectId);

    const firstMsgStmt = db.prepare<any, any[]>(
      `SELECT p.data AS data
         FROM part p
         JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ?
          AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
        ORDER BY p.time_created
        LIMIT 1`,
    );
    const countStmt = db.prepare<any, any[]>(
      'SELECT COUNT(*) AS c FROM message WHERE session_id = ?',
    );

    return sessions.map((s) => {
      let firstMessage;
      try {
        const row = firstMsgStmt.get(s.id);
        if (row) firstMessage = (safeParse(row.data)?.text ?? '').slice(0, 120).trim();
      } catch {}
      let entryCount = 0;
      try {
        entryCount = countStmt.get(s.id)?.c ?? 0;
      } catch {}
      return {
        id: s.id,
        fileName: s.slug || s.id,
        timestamp: toIso(s.time_updated),
        sessionId: s.id,
        sessionName: s.title || undefined,
        firstMessage,
        entryCount,
      };
    });
  }

  getSession(sessionId) {
    assertSafeId(sessionId);
    if (!this.isAvailable()) {
      const err = new Error('opencode database not found');
      err.status = 404;
      throw err;
    }
    const db = this._openDb();

    const session = db
      .prepare<any, any[]>('SELECT * FROM session WHERE id = ?')
      .get(sessionId);
    if (!session) {
      const err = new Error(`Session not found: ${sessionId}`);
      err.status = 404;
      throw err;
    }

    const messages = db
      .prepare<any, any[]>(
        'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id',
      )
      .all(sessionId);

    const partStmt = db.prepare<any, any[]>(
      'SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id',
    );

    const branch: any[] = [];
    let prevId: any = null;
    for (const m of messages) {
      const md = safeParse(m.data) ?? {};
      const parts = partStmt.all(m.id).map((p) => safeParse(p.data)).filter(Boolean);
      const content = partsToBlocks(parts);
      if (content.length === 0) continue; // drop empty (control-only) messages
      branch.push({
        type: 'message',
        id: m.id,
        parentId: prevId,
        timestamp: toIso(md.time?.created),
        message: { role: md.role || 'assistant', content },
      });
      prevId = m.id;
    }

    return {
      header: {
        id: session.id,
        projectID: session.project_id,
        directory: session.directory,
        title: session.title,
        version: session.version,
        timestamp: toIso(session.time_updated),
      },
      sessionName: session.title || undefined,
      branch,
      allEntries: branch,
      leafId: prevId,
    };
  }

  search(query, scope) {
    const q = (query ?? '').trim().toLowerCase();
    if (!q || !this.isAvailable()) return [];
    const db = this._openDb();
    const grepContent = scope === 'content';

    const projectLabels = new Map();
    for (const p of db.prepare<any, any[]>('SELECT id, worktree, name FROM project').all()) {
      projectLabels.set(p.id, projectLabel(p));
    }

    const sessions = db
      .prepare<any, any[]>(
        `SELECT id, project_id, title, slug, time_updated
           FROM session
          ORDER BY time_updated DESC`,
      )
      .all();

    const firstMsgStmt = db.prepare<any, any[]>(
      `SELECT p.data AS data
         FROM part p
         JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ?
          AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
        ORDER BY p.time_created
        LIMIT 1`,
    );
    const contentStmt = db.prepare<any, any[]>(
      `SELECT 1
         FROM part
        WHERE session_id = ?
          AND json_extract(data, '$.type') IN ('text','reasoning')
          AND lower(json_extract(data, '$.text')) LIKE ?
        LIMIT 1`,
    );

    const results: any[] = [];
    for (const s of sessions) {
      const name = (s.title ?? '').toLowerCase();
      let firstMessage;
      try {
        const row = firstMsgStmt.get(s.id);
        if (row) firstMessage = (safeParse(row.data)?.text ?? '').slice(0, 120).trim();
      } catch {}
      const first = (firstMessage ?? '').toLowerCase();

      let matchField: any = null;
      if (name.includes(q)) matchField = 'name';
      else if (first.includes(q)) matchField = 'message';
      else if (grepContent) {
        try {
          if (contentStmt.get(s.id, `%${q}%`)) matchField = 'content';
        } catch {}
      }
      if (!matchField) continue;

      results.push({
        id: s.id,
        fileName: s.slug || s.id,
        projectId: s.project_id,
        projectLabel: projectLabels.get(s.project_id) || s.project_id,
        matchField,
        timestamp: toIso(s.time_updated),
        sessionName: s.title || undefined,
        firstMessage,
      });
    }

    return results;
  }

  /** Read-only viewer: never mutate opencode's live database. */
  canModify() {
    return false;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Human-friendly project label. */
function projectLabel(p) {
  if (p.name) return p.name;
  if (p.id === 'global') return 'global';
  return p.worktree || p.id;
}

/** opencode ids are `[A-Za-z0-9_]`; reject anything that could break a query. */
function assertSafeId(id) {
  if (!id || !/^[A-Za-z0-9_]+$/.test(id)) {
    const err = new Error('Invalid id');
    err.status = 400;
    throw err;
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Epoch-ms (or anything Date accepts) → ISO string, for consistent sorting. */
function toIso(t) {
  if (t == null) return undefined;
  const d = new Date(t);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Map opencode message parts → the shared UI content blocks. */
function partsToBlocks(parts) {
  const blocks: any[] = [];
  for (const p of parts) {
    switch (p?.type) {
      case 'text':
        if (p.text) blocks.push({ type: 'text', text: p.text });
        break;
      case 'reasoning':
        if (p.text) blocks.push({ type: 'reasoning', text: p.text });
        break;
      case 'tool': {
        const st = p.state ?? {};
        blocks.push({ type: 'tool_use', name: p.tool, input: st.input ?? {} });
        const output = st.output ?? st.error;
        if (st.status === 'error' && st.error) {
          blocks.push({ type: 'tool_result', output: `⚠ error: ${st.error}` });
        } else if (output != null && output !== '') {
          blocks.push({ type: 'tool_result', output });
        }
        break;
      }
      case 'file': {
        const label = p.filename || p.source?.path || p.url || 'file';
        blocks.push({ type: 'text', text: `📎 ${label}` });
        break;
      }
      case 'patch': {
        const files = Array.isArray(p.files) ? p.files.join(', ') : '';
        blocks.push({ type: 'text', text: `📝 patch${files ? `: ${files}` : ''}` });
        break;
      }
      // step-start / step-finish and unknown control frames are not shown.
      default:
        break;
    }
  }
  return blocks;
}
