// Agent loop built on the Pi SDK (@earendil-works/pi-coding-agent).
// The browser stays stateless: it sends the full OpenAI-format history ({ agentId, messages }); we replay it into an
// in-memory Pi session, prompt with the last user message and translate Pi events back to the SSE protocol:
//   {type:'text'|'thinking', delta}   streaming deltas of the current assistant turn
//   {type:'message', message}          a completed OpenAI-format message (assistant / tool)
//   {type:'error', error} , {type:'done'}
import {
  createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager,
  loadSkillsFromDir, type ResourceLoader, type Skill, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { getAgentDef, type AgentDef } from './agent-defs.ts';
import { SKILL_DIRS } from './skills.ts';

const BASE_URL = process.env.LITELLM_BASE_URL || 'https://aigateway.pec.hrs.cc/v1';
const MAX_TURNS = 20;
const WORKDIR = process.env.AGENT_WORKDIR || process.cwd();
const BUILTIN = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} });

// ---- custom tools (everything else is a Pi built-in) ----
const CUSTOM: Record<string, ToolDefinition<any>> = {
  web_fetch: defineTool({
    name: 'web_fetch', label: 'web_fetch', description: 'Fetch the content of a URL',
    parameters: Type.Object({ url: Type.String({ description: 'URL' }) }),
    async execute(_id, a, signal) { const r = await fetch(a.url, { signal }); return text(`HTTP ${r.status}\n` + (await r.text())); },
  }),
  web_search: defineTool({
    name: 'web_search', label: 'web_search', description: 'Search the web',
    parameters: Type.Object({ query: Type.String({ description: 'Search query' }) }),
    async execute(_id, a, signal) {
      const k = process.env.EXA_API_KEY;
      if (!k) throw new Error('web_search unavailable: EXA_API_KEY not set');
      const r = await fetch('https://api.exa.ai/search', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-api-key': k },
        body: JSON.stringify({ query: a.query, numResults: 5, contents: { highlights: true } }),
      });
      const d: any = await r.json();
      return text((d.results || []).map((x: any) => `${x.title}\n${x.url}\n${(x.highlights || []).join(' ')}`).join('\n\n') || JSON.stringify(d));
    },
  }),
};

// ---- model access: the LiteLLM gateway as an OpenAI-compatible Pi provider ----
let runtime: Promise<ModelRuntime> | undefined;
async function gatewayModel(modelId: string, apiKey: string) {
  const rt = await (runtime ??= ModelRuntime.create({ modelsPath: null }));
  const provider = 'litellm-' + modelId.replace(/[^A-Za-z0-9_-]/g, '_');
  rt.registerProvider(provider, {
    baseUrl: BASE_URL, api: 'openai-completions', apiKey,
    models: [{
      id: modelId, name: modelId, reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }],
  });
  const model = rt.getModel(provider, modelId);
  if (!model) throw new Error(`Model not available: ${modelId}`);
  return { rt, model };
}

// ---- OpenAI-format <-> Pi message conversion ----
const asText = (c: any) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function toPiMessage(m: any, model: any) {
  const timestamp = Date.now();
  if (m.role === 'user') return { role: 'user', content: asText(m.content), timestamp };
  if (m.role === 'tool') {
    return { role: 'toolResult', toolCallId: m.tool_call_id, toolName: m.name || 'tool', content: [{ type: 'text', text: asText(m.content) }], isError: false, timestamp };
  }
  if (m.role === 'assistant') {
    const content: any[] = [];
    if (m.thinking) content.push({ type: 'thinking', thinking: m.thinking });
    const t = asText(m.content);
    if (t) content.push({ type: 'text', text: t });
    for (const c of m.tool_calls || []) {
      let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      content.push({ type: 'toolCall', id: c.id, name: c.function?.name, arguments: args });
    }
    return {
      role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: ZERO_USAGE, stopReason: m.tool_calls?.length ? 'toolUse' : 'stop', timestamp,
    };
  }
  return null; // 'error' and unknown roles are not part of the model context
}

function fromPiAssistant(m: any) {
  const blocks: any[] = m.content || [];
  const content = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
  const calls = blocks.filter((b) => b.type === 'toolCall')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) } }));
  const u = m.usage;
  const prompt = (u?.input || 0) + (u?.cacheRead || 0) + (u?.cacheWrite || 0);
  return {
    role: 'assistant', content: content || (calls.length ? null : ''),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(thinking ? { thinking } : {}),
    ...(u ? { usage: { prompt_tokens: prompt, completion_tokens: u.output || 0, total_tokens: prompt + (u.output || 0), prompt_tokens_details: { cached_tokens: u.cacheRead || 0 } } } : {}),
  };
}

// Resolve the agent's selected skill names against the configured skill dirs (first match wins; unknown names ignored).
// Pi lists them in the system prompt (name + description + path); the model loads SKILL.md with the `read` tool.
function selectSkills(names: string[] = []): Skill[] {
  if (!names.length) return [];
  const found = new Map<string, Skill>();
  for (const dir of SKILL_DIRS) {
    for (const s of loadSkillsFromDir({ dir, source: dir }).skills) if (!found.has(s.name)) found.set(s.name, s);
  }
  return names.map((n) => found.get(n)).filter((s): s is Skill => !!s);
}

// Minimal resource loader: no discovery of extensions/context files; the agent's own system prompt and selected skills only.
const loaderFor = (systemPrompt: string, skills: Skill[]): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills, diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});

type AgentEvent = { type: 'text' | 'thinking'; delta: string } | { type: 'message'; message: any } | { type: 'error'; error: string } | { type: 'done' };

/** Run the agent loop headlessly. `messages` must end with a user message. Emits the same events as the SSE protocol. */
export async function runAgent(o: { def: AgentDef; messages: any[]; apiKey: string; signal?: AbortSignal; onEvent: (ev: AgentEvent) => void }) {
  const { def, apiKey, signal, onEvent: emit } = o;
  const msgs = o.messages.filter((m: any) => m.role !== 'error');
  const last = msgs[msgs.length - 1];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let closed = !!signal?.aborted;
  const onAbort = () => { closed = true; session?.abort().catch(() => {}); };
  signal?.addEventListener('abort', onAbort);

  try {
    const { rt, model } = await gatewayModel(def.model, apiKey);
    const sm = SessionManager.inMemory(WORKDIR);
    for (const m of msgs.slice(0, -1)) { const pm = toPiMessage(m, model); if (pm) sm.appendMessage(pm as any); }

    const customTools = def.tools.filter((t) => CUSTOM[t]).map((t) => CUSTOM[t]);
    ({ session } = await createAgentSession({
      cwd: WORKDIR, model, thinkingLevel: 'off', modelRuntime: rt,
      resourceLoader: loaderFor(def.systemPrompt, selectSkills(def.skills)), sessionManager: sm,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools: def.tools.filter((t) => BUILTIN.includes(t) || CUSTOM[t]), customTools,
    }));
    if (closed) { session.dispose(); return; }

    let turns = 0;
    session.subscribe((ev: any) => {
      switch (ev.type) {
        case 'message_update': {
          const e = ev.assistantMessageEvent;
          if (e.type === 'text_delta') emit({ type: 'text', delta: e.delta });
          else if (e.type === 'thinking_delta') emit({ type: 'thinking', delta: e.delta });
          break;
        }
        case 'message_end': {
          const m = ev.message;
          if (m.role === 'assistant') {
            emit({ type: 'message', message: fromPiAssistant(m) });
            if (m.stopReason === 'error') emit({ type: 'error', error: m.errorMessage || 'Model error' });
          } else if (m.role === 'toolResult') {
            emit({ type: 'message', message: { role: 'tool', tool_call_id: m.toolCallId, name: m.toolName, content: asText(m.content) || '(no output)' } });
          }
          break;
        }
        case 'turn_end':
          if (++turns >= MAX_TURNS && ev.message?.stopReason === 'toolUse') {
            emit({ type: 'error', error: `Stopped after ${MAX_TURNS} turns` });
            session!.abort().catch(() => {});
          }
          break;
      }
    });
    await session.prompt(asText(last.content));
  } catch (e: any) {
    if (!closed) emit({ type: 'error', error: e.message });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    session?.dispose();
  }
  emit({ type: 'done' });
}

export async function agentChat(req: any, res: any, apiKey: string, readBody: (r: any) => Promise<unknown>) {
  const fail = (m: string, s = 400) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: m })); };
  let p: any;
  try { p = JSON.parse((await readBody(req)) as string); } catch { return fail('Invalid JSON'); }
  let def;
  try { def = getAgentDef(String(p.agentId)); } catch (e: any) { return fail(e.message, e.status || 400); }
  if (!Array.isArray(p.messages)) return fail('messages required');
  const last = p.messages.filter((m: any) => m.role !== 'error').at(-1);
  if (!last || last.role !== 'user') return fail('last message must be a user message');

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  await runAgent({
    def, messages: p.messages, apiKey, signal: ac.signal,
    onEvent: (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); },
  });
  res.end();
}
