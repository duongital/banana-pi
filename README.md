# banana-pi

A read-only web viewer for AI coding-agent session files, served on **port 4241**.

Today it reads sessions produced by the [`pi`](https://github.com/earendil-works) CLI,
the pi-like [`pir`](https://github.com/earendil-works) CLI, `opencode`, and
Anthropic's `claude` (Claude Code) CLI.
It's built around a pluggable **agent adapter** interface so support for other
agents can be added without touching the server or UI.

Derived from the `session-viewer` pi extension, repackaged as a standalone,
Dockerized service.

## Quick start (Docker)

```bash
cd ~/Docker/banana-pi
docker compose up -d --build
```

Then open <http://localhost:4241>.

The compose file mounts `~/.pi/agent/sessions` read-write into the container at
`/agents/pi` (read-write so the rename/delete actions work).

## Quick start (local Bun)

Requires Bun ≥ 1.4 (`bun install` once for type-checking dev deps; the
opencode adapter uses the built-in `bun:sqlite`):

```bash
bun start
# reads ~/.pi/agent/sessions by default (override with PI_SESSIONS_DIR)
```

## Agents

| Agent      | Storage                                            | Modifiable |
|------------|----------------------------------------------------|------------|
| `pi`       | JSONL files under `~/.pi/agent/sessions`           | yes (rename/delete) |
| `pir`      | JSONL files under `~/.pir/sessions`                | yes (rename/delete) |
| `opencode` | SQLite db at `~/.local/share/opencode/opencode.db` | no (read-only) |
| `claude`   | JSONL files under `~/.claude/projects`             | no (read-only) |

The opencode adapter reads directly from opencode's SQLite database
(`session` / `message` / `part` tables) and never writes to it, so rename and
delete are disabled for opencode sessions.

The claude adapter reads Claude Code's per-project JSONL session files
(`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`). Each record forms a
DAG via `uuid`/`parentUuid`; the active branch is the newest leaf walked back to
its root. Session titles come from Claude's own `ai-title` records. It's
read-only (Claude Code owns and manages this data itself), so rename/delete are
disabled.

## Configuration

| Env var            | Default                     | Purpose                                 |
|--------------------|-----------------------------|-----------------------------------------|
| `PORT`             | `4241`                      | HTTP port                               |
| `HOST`             | `0.0.0.0`                   | Bind address                            |
| `PI_SESSIONS_DIR`  | `~/.pi/agent/sessions`      | pi session root                         |
| `PIR_SESSIONS_DIR` | `~/.pir/sessions`           | pir session root                        |
| `OPENCODE_SESSIONS_DIR` | `~/.local/share/opencode` | opencode data dir (holds `opencode.db`) |
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects`      | Claude Code projects root               |
| `IMAGE_ROOTS`      | `/tmp`                      | Dirs images may be served from (comma-separated) |
| `IMAGE_MOUNT_PREFIX`| (empty)                    | On-disk prefix for image lookups (Docker remap) |
| `LITELLM_BASE_URL` | `https://aigateway.pec.hrs.cc/v1` | OpenAI-compatible API base URL (e.g. `https://api.deepseek.com/v1`) |
| `LITELLM_API_KEY`  | (empty)                     | API key for the gateway above           |

## Inline images

When a message references an absolute image path (e.g. a `/tmp/pi-clipboard-*.png`
clipboard image), the viewer renders it inline via `/api/image`. Only files under
`IMAGE_ROOTS` with an image extension are served; missing files are hidden. In
Docker, host `/tmp` is mounted read-only at `/host/tmp` with `IMAGE_MOUNT_PREFIX=/host`
so the original `/tmp/...` paths resolve.

## API

| Endpoint | Description |
|---|---|
| `GET /api/agents` | Available agents `[{ id, name }]` |
| `GET /api/projects?agent=pi` | Projects (grouped by working directory) |
| `GET /api/sessions?agent=pi&project=<id>` | Session list for a project |
| `GET /api/session?agent=pi&id=<id>` | Full parsed session (active branch + all entries) |
| `GET /api/search?agent=pi&q=<query>&scope=meta\|content` | Search sessions |
| `PATCH /api/session?agent=pi&id=<id>` | Rename a session (body `{"name":"..."}`; appends a `session_info` entry) |
| `DELETE /api/session?agent=pi&id=<id>` | Delete a session file |
| `GET /healthz` | Health check |

> Rename/delete require the agent's data dir to be mounted **read-write**
> (the default for `pi` in `docker-compose.yaml`). Agents report writability via
> `canModify` in `/api/agents`; the UI only shows the ✎/× buttons when true.
> Append `:ro` to the volume if you want a strictly read-only viewer.

## Adding a new agent

1. Create `src/sessions/<name>.ts` extending `AgentAdapter` (see `src/sessions/base.ts`).
2. Implement `isAvailable`, `listProjects`, `listSessions`, `getSession`, `search`.
3. Register it in `src/sessions/index.ts`.
4. Mount its data dir in `docker-compose.yaml` and set the relevant env var.

No server or UI changes are required — the UI discovers agents from `/api/agents`.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Entry point / process lifecycle |
| `src/server.ts` | Agent-agnostic HTTP router |
| `src/ui.ts` | Self-contained SPA (HTML+CSS+JS) |
| `src/sessions/base.ts` | `AgentAdapter` contract |
| `src/sessions/pi.ts` | pi adapter (JSONL parser + project/session listing) |
| `src/sessions/pir.ts` | pir adapter (pi-like `meta`/`node` JSONL format) |
| `src/sessions/index.ts` | Agent registry |
