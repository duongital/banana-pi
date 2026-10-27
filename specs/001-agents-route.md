# 001 – `/agents` route: manage custom agents

Status: **DRAFT – awaiting review**

## Goal
New page `/agents` to create / list / edit / delete **agents**. An agent =
**model** + **system prompt** + **set of tools**.

Create form:
- **Name** (text, required, unique) + optional description
- **Model** – dropdown populated from the existing `GET /api/models` (LiteLLM gateway)
- **System prompt** – textarea
- **Tools** – checkboxes, one per available tool

## Out of scope (this spec)
- Executing agents / running tool calls (chat integration is a follow-up, see "Future").
- Auth / multi-user ownership.

## Findings in current code
- Pages are React bundles under `src/client/<page>/main.tsx`, registered in `PAGES` (`src/client/build.ts`), routed in `src/server.ts` (switch on pathname + `NAV_LINKS`).
- Persistence pattern: JSON files in env-configured dir (`CHAT_DATA_DIR`, `SAVED_DATA_DIR`) – see `src/saved.ts`, `src/chat.ts`.
- **Name clash:** `GET /api/agents` already exists and lists *session-viewer adapters* (pi/claude/opencode). The new API must NOT reuse it → use **`/api/agent-defs`**. (The UI route stays `/agents` as requested.)
- No tool catalog exists yet; chat (`/api/chat`) only proxies plain completions without tools.

## Data model
```ts
type AgentDef = {
  id: string;          // slug/uuid, matches /^[A-Za-z0-9_-]{1,64}$/
  name: string;        // 1–80 chars, unique (case-insensitive)
  description?: string;
  model: string;       // model id from the gateway
  systemPrompt: string;
  tools: string[];     // tool ids from the catalog
  created: number;     // ms epoch
  updated: number;
};
```
Storage: one JSON file per agent in `AGENTS_DATA_DIR`
(default `~/.local/share/banana-pi-agents`), same as chat sessions; atomic write (tmp + rename).
`docker-compose.yaml`: add `AGENTS_DATA_DIR: /data/agents` and a volume mirroring `/data/chat`.

## Tool catalog
Static list in `src/agent-defs.ts` (server is the source of truth), returned by API:
```ts
type ToolInfo = { id: string; label: string; description: string };
```
Initial proposal (mirrors pi built-ins): `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`.
Unknown tool ids are rejected on save (400). Skills (`/api/skills`) are not included in v1.

## API (add to `src/docs.ts` per AGENTS.md)
| Method | Path | Description |
|---|---|---|
| GET | `/api/agent-defs` | list agents (summary: id, name, description, model, tools, updated) |
| POST | `/api/agent-defs` | create; body `{name, description?, model, systemPrompt, tools}` → created `AgentDef` (201) |
| GET | `/api/agent-defs/:id` | get one (404 if missing) |
| PUT | `/api/agent-defs/:id` | update (full replace of editable fields) |
| DELETE | `/api/agent-defs/:id` | delete |
| GET | `/api/agent-tools` | tool catalog |

Validation: name required & unique (409 on dup), model non-empty string, systemPrompt string (≤ 20k chars), tools ⊆ catalog. Model is **not** re-validated against the gateway on save (gateway may be down); UI shows a warning if a stored model is no longer listed.
Errors: `{ "error": string }` like other endpoints.

## UI (`src/client/agents/main.tsx`, `agents.css`)
Layout like `/skills`: left list of agents + "New agent" button, right pane = form.
- Form fields as above; model `<select>` fed by `/api/models` (loading/error states; disabled while loading); tools as a checkbox grid with label + description tooltip; "Select all / none".
- Buttons: Save (create or update), Delete (with confirm), Reset/Cancel. Save disabled until name + model are set.
- Inline error display (`.e`), dirty-state indicator, uses existing `styles.css` / daisyUI.
- Deep link: `/agents/:id` opens that agent (server falls back to the agents page for `/agents/*`, like `/chat/*`).

## Files to change / add
- add `src/agent-defs.ts` – storage, validation, tool catalog, request handler (modeled on `chatSessions`)
- edit `src/server.ts` – routes `/agents`, `/agents/*`, `/api/agent-defs*`, `/api/agent-tools`; add `['/agents','Agents']` to `NAV_LINKS`; update header comment
- edit `src/client/build.ts` – add `'agents'` to `PAGES`
- add `src/client/agents/main.tsx` (+ css)
- edit `src/docs.ts` – document new endpoints
- edit `docker-compose.yaml` (+ README mention) – data dir env/volume

## Implementation steps
1. Backend module + endpoints + docs.
2. Page registration + nav link.
3. UI: list, form, create/edit/delete.
4. Docker/env wiring.
5. Verify: `bun run typecheck`; manual curl of CRUD incl. validation errors; browser check of create → reload → edit → delete.

## Open questions for review
1. Is the proposed tool list right, or should tools come from something else (e.g. pi's actual tool registry / MCP servers)?
2. Should agents be selectable in `/chat` in this iteration (system prompt applied; tools need a tool-execution loop, which is large)? Proposed: **no**, follow-up spec.
3. OK to use `/api/agent-defs` to avoid the existing `/api/agents` clash?
4. Extra fields wanted (temperature, max tokens)? Proposed: not in v1.

## Future
- "Use agent" in `/chat` (prepend system prompt, pass tool definitions, run tool loop).
- Duplicate/export/import agents as JSON; skills as attachable capabilities.
