/** Hidden /docs page: minimal, dependency-free Swagger-like view of the HTTP API. */

const agent = { name: 'agent', in: 'query', required: true, schema: { type: 'string' }, description: 'Agent id from /api/agents' };
const q = (name: string, description = '', required = false) => ({ name, in: 'query', required, schema: { type: 'string' }, description });
const body = (desc: string, example?: unknown) => ({ required: true, description: desc, content: { 'application/json': { example } } });
const ok = (description = 'OK') => ({ 200: { description } });

export const openapi = {
  openapi: '3.0.3',
  info: { title: 'banana-pi API', version: '1.0.0', description: 'Endpoints used by the bundled web client. All errors: `{ "error": string }`.' },
  paths: {
    '/api/agents': { get: { tags: ['Sessions'], summary: 'List available agents', responses: ok('[{ id, name, canModify }]') } },
    '/api/projects': { get: { tags: ['Sessions'], summary: 'List projects', parameters: [agent], responses: ok('ProjectSummary[]') } },
    '/api/sessions': { get: { tags: ['Sessions'], summary: 'List sessions of a project', parameters: [agent, q('project', 'Project id')], responses: ok('SessionSummary[]') } },
    '/api/session': {
      get: { tags: ['Sessions'], summary: 'Get a parsed session', parameters: [agent, q('id', 'Session id', true)], responses: ok('Full session') },
      patch: { tags: ['Sessions'], summary: 'Rename a session', parameters: [agent, q('id', 'Session id', true)], requestBody: body('New name', { name: 'My session' }), responses: ok() },
      delete: { tags: ['Sessions'], summary: 'Delete a session', parameters: [agent, q('id', 'Session id', true)], responses: ok() },
    },
    '/api/search': { get: { tags: ['Sessions'], summary: 'Search sessions', parameters: [agent, q('q', 'Query', true), q('scope', 'Search scope')], responses: ok('SearchResult[]') } },
    '/api/image': { get: { tags: ['Sessions'], summary: 'Serve an allow-listed image', parameters: [q('path', 'base64url-encoded absolute path', true)], responses: { 200: { description: 'Image bytes' }, 403: { description: 'Path not allowed' }, 404: { description: 'Not found' } } } },
    '/api/tags': {
      get: { tags: ['Tags'], summary: 'List tags per session', responses: ok() },
      put: { tags: ['Tags'], summary: 'Set tags for a session', requestBody: body('Tag assignment'), responses: ok() },
    },
    '/api/tag-notes': {
      get: { tags: ['Tags'], summary: 'Get note for a tag', parameters: [q('tag', 'Tag name', true)], responses: ok() },
      put: { tags: ['Tags'], summary: 'Set note for a tag', requestBody: body('Tag note'), responses: ok() },
    },
    '/api/saved': {
      get: { tags: ['Saved'], summary: 'List saved responses', responses: ok() },
      post: { tags: ['Saved'], summary: 'Save a response (max 2MB body)', requestBody: body('Saved entry'), responses: ok() },
      patch: { tags: ['Saved'], summary: 'Update a saved entry', parameters: [agent, q('id', 'Session id', true), q('entryId', 'Entry id', true)], requestBody: body('Fields to update'), responses: ok() },
      delete: { tags: ['Saved'], summary: 'Remove a saved entry', parameters: [agent, q('id', 'Session id', true), q('entryId', 'Entry id', true)], responses: ok() },
    },
    '/api/skills': { get: { tags: ['Misc'], summary: 'List discovered skills (name, description, source, path, body)', responses: ok() } },
    '/api/models': { get: { tags: ['Chat'], summary: 'Model details (LiteLLM)', responses: ok() } },
    '/api/chat/models': { get: { tags: ['Chat'], summary: 'Chat model list', responses: ok('[{ id, owned_by, mode, created, max_input_tokens, max_output_tokens }]') } },
    '/api/chat': { post: { tags: ['Chat'], summary: 'Streaming chat completion (SSE passthrough)', requestBody: body('Model and messages', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }), responses: { 200: { description: 'text/event-stream' } } } },
    '/api/chat/agent': { post: { tags: ['Chat'], summary: 'Agent loop chat (system prompt + tool calls, SSE events: text, thinking, message, error, done)', requestBody: body('Agent definition id and OpenAI-format messages', { agentId: '<id from /api/agent-defs>', messages: [{ role: 'user', content: 'hi' }] }), responses: { 200: { description: 'text/event-stream' } } } },
    '/api/chat/sessions': { get: { tags: ['Chat'], summary: 'List persisted chats', responses: ok('[{ id, title, model, updated }]') } },
    '/api/chat/sessions/{id}': {
      get: { tags: ['Chat'], summary: 'Get a chat', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() },
      put: { tags: ['Chat'], summary: 'Create/update a chat', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body('Chat', { title: 'New chat', model: '', messages: [] }), responses: ok() },
      delete: { tags: ['Chat'], summary: 'Delete a chat', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() },
    },
    '/api/agent-tools': { get: { tags: ['Agents'], summary: 'List available tools', responses: ok('[{ id, label, description }]') } },
    '/api/agent-defs': {
      get: { tags: ['Agents'], summary: 'List agent definitions', responses: ok('AgentDef[]') },
      post: { tags: ['Agents'], summary: 'Create an agent', requestBody: body('Agent', { name: 'reviewer', description: '', model: 'gpt-4o', systemPrompt: 'You are...', tools: ['read', 'grep'], skills: ['fetch-exa'] }), responses: { 201: { description: 'Created AgentDef' }, 400: { description: 'Validation error' }, 409: { description: 'Duplicate name' } } },
    },
    '/api/agent-defs/{id}': {
      get: { tags: ['Agents'], summary: 'Get an agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('AgentDef') },
      put: { tags: ['Agents'], summary: 'Update an agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body('Agent', { name: 'reviewer', model: 'gpt-4o', systemPrompt: '', tools: [] }), responses: ok('AgentDef') },
      delete: { tags: ['Agents'], summary: 'Delete an agent', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() },
    },
    '/api/scheduler/jobs': {
      get: { tags: ['Scheduler'], summary: 'List jobs (with nextRunAt, running count, lastRun)', responses: ok('ScheduledJob[]') },
      post: { tags: ['Scheduler'], summary: 'Create a scheduled job', requestBody: body('Job', { name: 'daily report', agentId: '<AgentDef id>', prompt: 'Summarize...', trigger: { type: 'cron', expr: '0 9 * * 1-5', timezone: 'Asia/Bangkok' }, enabled: true, overlap: 'skip', timeoutSec: 600, notify: true }), responses: { 201: { description: 'Created job' }, 400: { description: 'Validation error' }, 409: { description: 'Duplicate name' } } },
    },
    '/api/scheduler/jobs/{id}': {
      get: { tags: ['Scheduler'], summary: 'Get a job', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('ScheduledJob') },
      put: { tags: ['Scheduler'], summary: 'Update a job (trigger/enabled/agent/prompt); schedule re-applied immediately', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body('Job (same as create)'), responses: ok('ScheduledJob') },
      delete: { tags: ['Scheduler'], summary: 'Delete a job and its run history', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() },
    },
    '/api/scheduler/jobs/{id}/run': { post: { tags: ['Scheduler'], summary: 'Run now (manual); returns immediately', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: { description: '{ runId, status }' } } } },
    '/api/scheduler/jobs/{id}/runs': { get: { tags: ['Scheduler'], summary: 'Run history, newest first (no transcript)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, q('limit', 'Max rows (default 50)')], responses: ok('JobRun[]') } },
    '/api/scheduler/runs/{id}': {
      get: { tags: ['Scheduler'], summary: 'Get a run incl. transcript', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok('JobRun') },
      delete: { tags: ['Scheduler'], summary: 'Delete a finished run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() },
    },
    '/api/scheduler/runs/{id}/cancel': { post: { tags: ['Scheduler'], summary: 'Cancel a running run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: ok() } },
    '/api/scheduler/preview': { post: { tags: ['Scheduler'], summary: 'Validate a cron expression; next 5 fire times (ms)', requestBody: body('Cron', { expr: '*/15 * * * *', timezone: 'UTC' }), responses: ok('{ next: number[] }') } },
    '/api/scheduler/events': { get: { tags: ['Scheduler'], summary: 'SSE of run updates ({type:"run", run, notify}); used for browser notifications', responses: { 200: { description: 'text/event-stream' } } } },
    '/healthz': { get: { tags: ['Misc'], summary: 'Health check', responses: ok('"ok"') } },
  },
};

export const docsHtml = `<!doctype html><html><head><meta charset="utf-8"><title>API docs</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#fafafa;color:#222}
header{padding:16px 24px;background:#222;color:#fff}header h1{margin:0;font-size:20px}header p{margin:4px 0 0;opacity:.7}
main{max-width:960px;margin:0 auto;padding:16px 24px}
h2{margin:24px 0 8px}
details{border:1px solid;border-radius:4px;margin:6px 0;background:#fff}
summary{cursor:pointer;padding:8px;display:flex;gap:10px;align-items:center}
.m{color:#fff;font-weight:700;font-size:12px;padding:3px 0;width:62px;text-align:center;border-radius:3px}
.get{border-color:#61affe}.get .m{background:#61affe}.post{border-color:#49cc90}.post .m{background:#49cc90}
.put{border-color:#fca130}.put .m{background:#fca130}.patch{border-color:#50e3c2}.patch .m{background:#50e3c2}
.delete{border-color:#f93e3e}.delete .m{background:#f93e3e}
code{font-family:ui-monospace,monospace}.s{color:#666}
.d{padding:4px 14px 12px}table{border-collapse:collapse}td,th{padding:2px 12px 2px 0;text-align:left}
pre{background:#f0f0f0;padding:8px;overflow:auto}
</style></head><body>
<header><h1 id="t"></h1><p id="d"></p><p><a style="color:#9cf" href="/docs/openapi.json">openapi.json</a></p></header><main id="m"></main>
<script>
fetch('/docs/openapi.json').then(r=>r.json()).then(function(s){
var E=function(x){return String(x==null?'':x).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})};
t.textContent=s.info.title+' '+s.info.version;d.textContent=s.info.description;
var g={};
Object.keys(s.paths).forEach(function(p){Object.keys(s.paths[p]).forEach(function(m){var o=s.paths[p][m];(g[o.tags[0]]=g[o.tags[0]]||[]).push([p,m,o])})});
m.innerHTML=Object.keys(g).map(function(k){return '<h2>'+E(k)+'</h2>'+g[k].map(function(e){var p=e[0],me=e[1],o=e[2];
var h='<details class="'+me+'"><summary><span class="m">'+me.toUpperCase()+'</span><code>'+E(p)+'</code><span class="s">'+E(o.summary)+'</span></summary><div class="d">';
if(o.parameters)h+='<b>Parameters</b><table>'+o.parameters.map(function(a){return '<tr><td><code>'+E(a.name)+'</code>'+(a.required?' *':'')+'</td><td>'+a.in+'</td><td>'+E(a.description)+'</td></tr>'}).join('')+'</table>';
if(o.requestBody){var ex=o.requestBody.content['application/json'].example;h+='<p><b>Body</b> (JSON): '+E(o.requestBody.description)+'</p>'+(ex?'<pre>'+E(JSON.stringify(ex,null,2))+'</pre>':'')}
h+='<p><b>Responses</b></p><table>'+Object.keys(o.responses).map(function(c){return '<tr><td>'+c+'</td><td>'+E(o.responses[c].description)+'</td></tr>'}).join('')+'</table></div></details>';return h}).join('')}).join('');
});
</script></body></html>`;
