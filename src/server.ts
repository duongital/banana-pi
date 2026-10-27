/**
 * server.js
 * Read-only HTTP server exposing the banana-pi API + SPA.
 *
 * All agent-specific logic lives behind the AgentAdapter interface, so this
 * router is agent-agnostic: every data endpoint takes an `agent` query param.
 *
 * Endpoints:
 *   GET /                                  -> redirect to /chat (React pages bundled by Bun at startup)
 *   GET /api/agents                        -> [{ id, name }]
 *   GET /api/projects?agent=pi             -> ProjectSummary[]
 *   GET /api/sessions?agent=pi&project=..  -> SessionSummary[]
 *   GET /api/session?agent=pi&id=..        -> full parsed session
 *   GET /api/search?agent=pi&q=..&scope=.. -> SearchResult[]
 *   GET /api/image?path=<base64url>        -> image bytes (allow-listed dirs)
 *   /agents                                -> agents, models and tools page (CRUD API at /api/agent-defs)
 *   GET /docs                              -> hidden API docs (not linked in nav)
 *   GET /healthz                           -> "ok"
 */

import { chatModels, modelDetails, chatCompletion, chatSessions, apiKey } from './chat.ts';
import { agentChat } from './agent-loop.ts';
import { agentDefsApi } from './agent-defs.ts';
import { schedulerApi } from './scheduler.ts';
import { listSkills } from './skills.ts';
import { listTags, renameTagged, setTags, getTagNote, setTagNote } from './tags.ts';
import { listSaved, addSaved, removeSaved, updateSaved } from './saved.ts';
import { createServer } from 'node:http';
import { existsSync, createReadStream, statSync, watch } from 'node:fs';
import { extname } from 'node:path';
import { agentDescriptors, getAgent } from './sessions/index.ts';
import { openapi, docsHtml } from './docs.ts';
import { buildClient, type Assets } from './client/build.ts';

const PORT = Number(process.env.PORT || 4241);
const HOST = process.env.HOST || '0.0.0.0';

// Directories images may be served from (as they appear in session text).
const IMAGE_ROOTS = (process.env.IMAGE_ROOTS || '/tmp')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Prefix prepended when resolving on disk, for Docker mount remapping
// (e.g. host /tmp mounted at /host/tmp -> IMAGE_MOUNT_PREFIX=/host).
const IMAGE_MOUNT_PREFIX = process.env.IMAGE_MOUNT_PREFIX || '';
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

let assets: Assets;
const DEV = process.env.NODE_ENV === 'development';
const reloadClients = new Set<any>();
// Browsers allow only ~6 HTTP/1.1 connections per origin; one SSE per tab per stream starves navigation/fetches.
// So only one "leader" tab (Web Lock) opens the EventSources and relays messages to the other tabs via BroadcastChannel.
const SHARED_SSE_JS = (dev: boolean) => `<script>(function(){var bc=new BroadcastChannel('banana-sse'),dev=${dev};
function onMsg(k,d){if(k==='reload'){location.reload()}else if(k==='sched'){window.__schedNotify&&window.__schedNotify(d)}}
bc.onmessage=function(e){onMsg(e.data.k,e.data.d)};
function lead(){var l=[];
if(dev){var r=new EventSource('/__reload');r.onmessage=function(){bc.postMessage({k:'reload'});onMsg('reload')};l.push(r)}
if(window.__schedNotify){var s=new EventSource('/api/scheduler/events');s.onmessage=function(m){bc.postMessage({k:'sched',d:m.data});onMsg('sched',m.data)};l.push(s)}
addEventListener('pagehide',function(){l.forEach(function(x){x.close()})})}
if(navigator.locks){navigator.locks.request('banana-sse-leader',function(){lead();return new Promise(function(){})})}else lead()})()</script>`;

/** Dev only: rebuild the client bundle on src/client changes and tell open tabs to reload. */
function watchClient() {
  let timer: any;
  let building = false;
  const rebuild = async () => {
    if (building) return rebuild_later();
    building = true;
    try {
      assets = await buildClient();
      for (const c of reloadClients) c.write('data: reload\n\n');
      console.log('client rebuilt');
    } catch (e) { console.error(e); }
    building = false;
  };
  const rebuild_later = () => { clearTimeout(timer); timer = setTimeout(rebuild, 150); };
  watch(new URL('./client', import.meta.url).pathname, { recursive: true }, rebuild_later);
}

function handleRequest(req, res) {
  const [pathname, qs = ''] = (req.url ?? '/').split('?');
  const params = Object.fromEntries(new URLSearchParams(qs));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname.startsWith('/api/chat/sessions')) {
    chatSessions(req, res, pathname);
    return;
  }

  if (pathname === '/api/agent-defs' || pathname.startsWith('/api/agent-defs/') || pathname === '/api/agent-tools') {
    agentDefsApi(req, res, pathname, readBody);
    return;
  }

  if (pathname.startsWith('/api/scheduler/')) {
    schedulerApi(req, res, pathname, readBody);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat/agent') {
    const key = apiKey();
    if (!key) return sendJson(res, { error: 'No LiteLLM API key configured' }, 500);
    return agentChat(req, res, key, readBody);
  }

  if (req.method === 'POST' && pathname === '/api/chat') return chatCompletion(req, res);

  if (pathname === '/api/tags') {
    if (req.method === 'GET') return sendJson(res, listTags());
    if (req.method === 'PUT') {
      readBody(req)
        .then((body: any) => {
          let p: any;
          try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'Invalid JSON body' }, 400); }
          sendJson(res, setTags(p));
        })
        .catch((err) => sendJson(res, { error: err.message }, err.status || 500));
      return;
    }
  }

  if (pathname === '/api/tag-notes') {
    if (req.method === 'GET') return sendJson(res, getTagNote(params.tag || ''));
    if (req.method === 'PUT') {
      readBody(req)
        .then((body: any) => {
          let p: any;
          try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'Invalid JSON body' }, 400); }
          sendJson(res, setTagNote(p));
        })
        .catch((err) => sendJson(res, { error: err.message }, err.status || 500));
      return;
    }
  }

  if (pathname === '/api/saved') {
    if (req.method === 'GET') return sendJson(res, listSaved());
    if (req.method === 'POST') {
      readBody(req, 2 * 1024 * 1024)
        .then((body: any) => {
          let p: any;
          try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'Invalid JSON body' }, 400); }
          sendJson(res, addSaved(p));
        })
        .catch((err) => sendJson(res, { error: err.message }, err.status || 500));
      return;
    }
    if (req.method === 'PATCH') {
      readBody(req)
        .then((body: any) => {
          let p: any;
          try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, { error: 'Invalid JSON body' }, 400); }
          sendJson(res, updateSaved(params.agent, params.id, params.entryId, p));
        })
        .catch((err) => sendJson(res, { error: err.message }, err.status || 500));
      return;
    }
    if (req.method === 'DELETE') {
      try { return sendJson(res, removeSaved(params.agent, params.id, params.entryId)); }
      catch (err: any) { return sendJson(res, { error: err.message }, 500); }
    }
  }

  if (req.method === 'DELETE') {
    try {
      if (pathname !== '/api/session') return sendJson(res, { error: 'Not found' }, 404);
      return sendJson(res, withAgent(params).deleteSession(params.id));
    } catch (err: any) {
      return sendJson(res, { error: err.message }, err.status || 500);
    }
  }

  if (req.method === 'PATCH') {
    if (pathname !== '/api/session') return sendJson(res, { error: 'Not found' }, 404);
    readBody(req)
      .then((body: any) => {
        let payload: any = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          return sendJson(res, { error: 'Invalid JSON body' }, 400);
        }
        const out = withAgent(params).renameSession(params.id, payload.name);
        try { renameTagged(params.agent, params.id, (out as any)?.name); } catch {}
        sendJson(res, out);
      })
      .catch((err) => sendJson(res, { error: err.message }, err.status || 500));
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, { error: 'Method not allowed' }, 405);
    return;
  }

  try {
    switch (pathname) {
      case '/':
      case '/index.html':
        res.writeHead(302, { Location: '/chat' });
        return res.end();
      case '/chat':
      case '/chat/':
        return sendHtml(res, assets.html.chat, 200, '/chat');
      case '/agents':
      case '/agents/':
        return sendHtml(res, assets.html.agents, 200, '/agents');
      case '/scheduler':
      case '/scheduler/':
        return sendHtml(res, assets.html.scheduler, 200, '/scheduler');
      case '/api/skills':
        return sendJson(res, listSkills());
      case '/api/models':
        return modelDetails(res);
      case '/api/chat/models':
        return chatModels(res);
      case '/sessions':
        return sendHtml(res, assets.html.sessions, 200, '/sessions');
      case '/sessions-saved':
      case '/sessions-saved/':
        return sendHtml(res, assets.html['sessions-saved'], 200, '/sessions-saved');
      case '/__reload':
        if (!DEV) return sendJson(res, { error: 'Not found' }, 404);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        reloadClients.add(res);
        req.on('close', () => reloadClients.delete(res));
        return;
      case '/docs':
      case '/docs/':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(docsHtml);
      case '/docs/openapi.json':
        return sendJson(res, openapi);
      case '/healthz':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      case '/api/agents':
        return sendJson(res, agentDescriptors());
      case '/api/projects':
        return sendJson(res, withAgent(params).listProjects());
      case '/api/sessions':
        return sendJson(res, withAgent(params).listSessions(params.project));
      case '/api/session':
        return sendJson(res, withAgent(params).getSession(params.id));
      case '/api/search':
        return sendJson(res, withAgent(params).search(params.q, params.scope));
      case '/api/image':
        return sendImage(res, params.path);
      default:
        if (pathname.startsWith('/assets/')) return sendAsset(res, pathname);
        // SPA fallback: any non-API GET path (e.g. /:agent/:session) serves the
        // app shell so client-side routing can restore state on reload.
        if (pathname.startsWith('/scheduler/')) return sendHtml(res, assets.html.scheduler, 200, '/scheduler');
        if (pathname.startsWith('/agents/')) return sendHtml(res, assets.html.agents, 200, '/agents');
        if (pathname.startsWith('/chat/')) return sendHtml(res, assets.html.chat, 200, '/chat');
        if (pathname.startsWith('/sessions/')) return sendHtml(res, assets.html.sessions, 200, '/sessions');
        return sendJson(res, { error: 'Not found' }, 404);
    }
  } catch (err: any) {
    sendJson(res, { error: err.message }, err.status || 500);
  }
}

/** Resolve the agent adapter from ?agent=, throwing a 400/404 on failure. */
function withAgent(params) {
  const agent = getAgent(params.agent);
  if (!agent) {
    const err = new Error(`Unknown or unavailable agent: ${params.agent ?? '(none)'}`);
    err.status = 404;
    throw err;
  }
  return agent;
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
const NAV_CSS = `<style>
html{font-size:87.5%}
body{box-sizing:border-box!important;padding-top:34px!important}
#app{height:calc(100vh - 34px)!important}
#topnav{position:fixed;top:0;left:0;right:0;height:34px;z-index:1000;display:flex;justify-content:flex-start;align-items:center;gap:4px;padding:0 10px;background:var(--color-base-200);border-bottom:1px solid var(--color-base-300);font-size:14px}
#topnav a{margin:0;padding:4px 10px;border-radius:var(--radius-field);text-decoration:none;color:color-mix(in oklab,var(--color-base-content) 60%,transparent)}
#topnav a:hover{background:var(--color-base-300);color:var(--color-base-content)}
#topnav a.on{background:color-mix(in oklab,var(--color-primary) 25%,transparent);color:var(--color-base-content)}
#topnav #theme-select{width:auto;margin-left:auto;appearance:none;-webkit-appearance:none;background-image:none;padding-inline:.75rem;text-align:center;text-align-last:center}
#topnav #theme-select::after{display:none!important;content:none!important}
</style>`;
const THEME_HEAD = `<script>try{document.documentElement.setAttribute('data-theme',localStorage.getItem('banana-pi-theme')||'dark')}catch(e){}</script>`;
const THEMES = ['abyss', 'acid', 'aqua', 'autumn', 'black', 'bumblebee', 'business', 'caramellatte', 'cmyk', 'coffee', 'corporate', 'cupcake', 'cyberpunk', 'dark', 'dim', 'dracula', 'emerald', 'fantasy', 'forest', 'garden', 'halloween', 'lemonade', 'light', 'lofi', 'luxury', 'night', 'nord', 'pastel', 'retro', 'silk', 'sunset', 'synthwave', 'valentine', 'winter', 'wireframe'];
const THEME_JS = `<script>(function(){var T=${JSON.stringify(THEMES)},s=document.getElementById('theme-select'),r=document.documentElement;
T.forEach(function(t){var o=document.createElement('option');o.value=o.textContent=t;s.appendChild(o)});
function cur(){return r.getAttribute('data-theme')||'dark'}
function paint(){s.value=cur()}
function set(t,store){r.setAttribute('data-theme',t);if(store){try{localStorage.setItem('banana-pi-theme',t)}catch(e){}}paint();window.dispatchEvent(new CustomEvent('themechange',{detail:t}))}
s.onchange=function(){set(s.value,true)};
window.addEventListener('storage',function(e){if(e.key==='banana-pi-theme'&&e.newValue)set(e.newValue,false)});
paint()})()</script>`;
// Chrome desktop notifications for finished scheduler runs (any open tab; Notification `tag` dedupes across tabs).
const NOTIFY_JS = `<script>(function(){if(!('Notification' in window)||Notification.permission!=='granted')return;
window.__schedNotify=function(d){try{var e=JSON.parse(d);
if(e.type!=='run'||!e.notify||e.run.status==='running'||e.run.status==='skipped')return;
var r=e.run,ok=r.status==='success',t=(ok?'✅ ':'❌ ')+r.jobName+' — '+r.status;
var b=(r.error||r.output||'').slice(0,200);
var n=new Notification(t,{body:b,tag:r.id});n.onclick=function(){window.focus();location.href='/scheduler/'+r.jobId+'?run='+r.id;n.close()}}catch(_){}}})()</script>`;
const NAV_LINKS: [string, string][] = [['/sessions', 'Sessions'], ['/sessions-saved', 'Responses'], ['/agents', 'Agents'], ['/scheduler', 'Scheduler'], ['/chat', 'Chat']];

function withNav(html: string, path: string) {
  const nav = '<nav id="topnav"><a href="/sessions" class="logo" title="Banana Pi" style="font-size:18px;line-height:1;padding:4px 6px;text-decoration:none">🍌</a>' + NAV_LINKS.map(([h, l]) =>
    `<a href="${h}"${path === h || path.startsWith(h + '/') ? ' class="on"' : ''}>${l}</a>`).join('') +
    '<select id="theme-select" class="select select-xs w-auto" title="Select theme"></select></nav>' + THEME_JS + NOTIFY_JS + SHARED_SSE_JS(DEV);
  return html.replace('</head>', THEME_HEAD + NAV_CSS + '</head>').replace(/<body[^>]*>/, (m) => m + nav);
}

function sendAsset(res, pathname) {
  const f = assets.files.get(pathname);
  if (!f) return sendJson(res, { error: 'Not found' }, 404);
  f.body.arrayBuffer().then((buf) => {
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(Buffer.from(buf));
  });
}

function sendHtml(res, html, status = 200, path = '') {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(withNav(html, path));
}

/** Serve an image file from an allow-listed directory, with path checks. */
function sendImage(res, pathB64) {
  if (!pathB64) return sendJson(res, { error: 'Missing path' }, 400);
  let p;
  try {
    p = Buffer.from(pathB64, 'base64url').toString('utf8');
  } catch {
    return sendJson(res, { error: 'Invalid path' }, 400);
  }
  if (p.includes('..') || p.includes('\0')) return sendJson(res, { error: 'Invalid path' }, 400);
  if (!IMAGE_ROOTS.some((r) => p.startsWith(r.endsWith('/') ? r : r + '/')))
    return sendJson(res, { error: 'Path not allowed' }, 403);

  const mime = IMAGE_MIME[extname(p).toLowerCase()];
  if (!mime) return sendJson(res, { error: 'Unsupported image type' }, 415);

  const disk = IMAGE_MOUNT_PREFIX + p;
  if (!existsSync(disk) || !statSync(disk).isFile())
    return sendJson(res, { error: 'Not found' }, 404);

  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=300' });
  createReadStream(disk).pipe(res);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startServer() {
  assets = await buildClient();
  if (DEV) watchClient();
  const server = createServer(handleRequest);
  // If PORT isn't set explicitly, fall back to the next ports when busy (4241 -> 4242 ...).
  const maxTries = process.env.PORT ? 1 : 10;
  let port = PORT;
  let tries = 0;

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && ++tries < maxTries) {
      console.warn(`port ${port} in use, trying ${port + 1}`);
      port += 1;
      server.listen(port, HOST);
    } else {
      throw err;
    }
  });
  server.on('listening', () => {
    const agents = agentDescriptors().map((a) => a.id).join(', ') || '(none)';
    console.log(`banana-pi listening on http://${HOST}:${port}`);
    console.log(`available agents: ${agents}`);
  });
  server.listen(port, HOST);
  return server;
}
