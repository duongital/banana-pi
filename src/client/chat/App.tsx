import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../sessions/Markdown.tsx';

type Msg = { role: string; content: string | null; thinking?: string; tool_calls?: any[]; tool_call_id?: string; name?: string; usage?: any };
type AgentDef = { id: string; name: string; model?: string };
const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const AG = 'agent:';
type Chat = { id: string; title: string; model?: string };

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const j = (u: string, o?: RequestInit) => fetch(u, o).then((r) => r.json());
const urlId = () => location.pathname.split('/')[2] || null;

export function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [list, setList] = useState<Chat[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [ctxMax, setCtxMax] = useState<Record<string, number>>({});
  const [model, setModel] = useState('');
  const [modelError, setModelError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const label = (m?: string) => !m ? '' : m.startsWith(AG) ? '🍌 ' + (agents.find((a) => AG + a.id === m)?.name ?? 'deleted agent') : m;
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Mirrors of state for async code / listeners.
  const s = useRef({ busy, cur, model, messages });
  s.current = { busy, cur, model, messages };

  useEffect(() => { if (log.current) log.current.scrollTop = 1e9; }, [messages]);

  const refresh = async () => {
    const l = await j('/api/chat/sessions');
    if (Array.isArray(l)) setList(l);
  };

  const navigate = (id: string | null, push: boolean) => {
    setCur(id);
    s.current.cur = id;
    const url = id ? '/chat/' + id : '/chat';
    if (location.pathname !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
  };

  const startNew = (push: boolean) => {
    if (s.current.busy) return;
    setMessages([]);
    navigate(null, push);
    input.current?.focus();
  };

  const open = async (id: string, push: boolean, available = [...models, ...agents.map((a) => AG + a.id)]) => {
    if (s.current.busy) return;
    setOpening(true);
    const d = await j('/api/chat/sessions/' + id).finally(() => setOpening(false));
    if (d.error) return startNew(false);
    setMessages(d.messages);
    if (d.model && available.includes(d.model)) setModel(d.model);
    navigate(id, push);
  };

  useEffect(() => {
    (async () => {
      const d = await j('/api/chat/models');
      j('/api/models').then((l) => Array.isArray(l) && setCtxMax(Object.fromEntries(l.filter((m: any) => m.max_input_tokens).map((m: any) => [m.id, m.max_input_tokens])))).catch(() => {});
      const ad = await j('/api/agent-defs').catch(() => []);
      const ags: AgentDef[] = Array.isArray(ad) ? ad : [];
      setAgents(ags);
      let avail: string[] = ags.map((a) => AG + a.id);
      if (!Array.isArray(d)) setModelError(d.error || 'Failed to load models');
      else avail = [...d, ...avail], setModels(d);
      const saved = localStorage.getItem('chat-model');
      setModel(saved && avail.includes(saved) ? saved : (Array.isArray(d) ? d[0] : avail[0]) ?? '');
      await refresh();
      const id = urlId();
      if (id) open(id, false, avail);
    })();
    const onPop = () => { const id = urlId(); id ? open(id, false) : startNew(false); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const save = async (msgs: Msg[], mdl: string) => {
    const id = s.current.cur ?? newId();
    const first = msgs.find((m) => m.role === 'user');
    await fetch('/api/chat/sessions/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: first ? (first.content ?? '').replace(/\s+/g, ' ').slice(0, 60) : 'New chat', model: mdl, messages: msgs }),
    });
    navigate(id, false);
    await refresh();
  };

  const onModel = (m: string) => {
    setModel(m);
    localStorage.setItem('chat-model', m);
    if (s.current.cur && s.current.messages.length) save(s.current.messages, m);
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this chat?')) return;
    await fetch('/api/chat/sessions/' + id, { method: 'DELETE' });
    if (id === s.current.cur) { setBusy(false); s.current.busy = false; startNew(true); }
    refresh();
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText(''); setBusy(true); s.current.busy = true;
    const history_: Msg[] = [...messages, { role: 'user', content: t }];
    setMessages([...history_, { role: 'assistant', content: '' }]);
    await save(history_, model).catch(() => {}); // show the chat in the sidebar right away
    let acc = '';
    let usage: any;
    let final: Msg[] = history_;
    const isAgent = model.startsWith(AG);
    const turns: Msg[] = []; // completed agent messages
    let cur_: Msg = { role: 'assistant', content: '', thinking: '' };
    const show = () => setMessages([...history_, ...turns, ...(cur_.content || cur_.thinking || !turns.length ? [{ ...cur_ }] : [])]);
    try {
      const r = await fetch(isAgent ? '/api/chat/agent' : '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isAgent ? { agentId: model.slice(AG.length), messages: history_ } : { model, messages: history_.map(({ role, content }) => ({ role, content })) }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.status); }
      const rd = r.body!.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop()!;
        for (const l of lines) {
          if (!l.startsWith('data:')) continue;
          const p = l.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          try {
            const ev = JSON.parse(p);
            if (isAgent) {
              if (ev.type === 'text') { cur_.content += ev.delta; show(); }
              else if (ev.type === 'thinking') { cur_.thinking += ev.delta; show(); }
              else if (ev.type === 'message') { turns.push(ev.message); cur_ = { role: 'assistant', content: '', thinking: '' }; show(); save([...history_, ...turns], model).catch(() => {}); }
              else if (ev.type === 'error') { turns.push({ role: 'error', content: ev.error }); show(); }
              continue;
            }
            if (ev.usage) usage = ev.usage;
            const c = ev.choices?.[0]?.delta?.content;
            if (c) { acc += c; const snap = acc; setMessages([...history_, { role: 'assistant', content: snap }]); }
          } catch {}
        }
      }
      final = isAgent ? [...history_, ...turns] : [...history_, { role: 'assistant', content: acc, ...(usage ? { usage } : {}) }];
      setMessages(final);
    } catch (e: any) {
      setMessages([...history_, ...turns, { role: 'error', content: (acc ? acc + '\n\n' : '') + 'Error: ' + e.message }]);
      if (isAgent) final = [...history_, ...turns];
      else if (acc) final = [...history_, { role: 'assistant', content: acc }];
    }
    setBusy(false); s.current.busy = false;
    await save(final, model);
  };

  const us = messages.filter((m) => m.usage);
  const sum = (f: (u: any) => number) => us.reduce((a, m) => a + (f(m.usage) || 0), 0);
  const cachedOf = (u: any) => u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  const mdlId = model.startsWith(AG) ? agents.find((a) => AG + a.id === model)?.model : model;
  const info = us.length ? {
    ctx: us[us.length - 1].usage.prompt_tokens || 0, max: mdlId ? ctxMax[mdlId] : 0,
    inp: sum((u) => u.prompt_tokens), out: sum((u) => u.completion_tokens), cached: sum(cachedOf), turns: us.length,
    title: 'ctx = last prompt size; in/out/cache are session totals across all calls',
  } : null;

  return (
    <>
      <aside id="side">
        <button className="btn btn-primary btn-sm" onClick={() => startNew(true)}>+ New chat</button>
        <div id="list">
          {list.map((c) => (
            <a key={c.id} href={'/chat/' + c.id} className="s" aria-current={c.id === cur ? 'true' : undefined}
              onClick={(e) => { e.preventDefault(); open(c.id, true); }}>
              <span className="t">{c.title}<small>{label(c.model)}</small></span>
              <button type="button" className="btn btn-xs btn-ghost" title="Delete"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(c.id); }}>✕</button>
            </a>
          ))}
        </div>
      </aside>
      <main id="main">
        <header>
          <select className="select select-sm" value={model} onChange={(e) => onModel(e.target.value)}>
            {models.length > 0 && <optgroup label="Models">{models.map((m) => <option key={m} value={m}>{m}</option>)}</optgroup>}
            {agents.length > 0 && <optgroup label="Agents">{agents.map((a) => <option key={a.id} value={AG + a.id}>{a.name}</option>)}</optgroup>}
          </select>
          {info && (
            <div id="info" title={info.title}>
              <span>ctx {fmt(info.ctx)}{info.max ? ` / ${fmt(info.max)} (${Math.round(100 * info.ctx / info.max)}%)` : ''}</span>
              <span>in {fmt(info.inp)}</span><span>out {fmt(info.out)}</span>
              <span>cache {info.inp ? Math.round(100 * info.cached / info.inp) : 0}% hit ({fmt(info.cached)} hit / {fmt(info.inp - info.cached)} miss)</span>
              <span>{info.turns} calls</span>
            </div>
          )}
        </header>
        <div id="log" ref={log}>
          {modelError && <article className="m error">{modelError}</article>}
          {opening && <div className="m-loading"><span className="loading loading-dots loading-md" /></div>}
          {messages.map((m, i) => m.role === 'tool' ? (
            <details key={i} className="m tool"><summary>🔧 {m.name || 'tool'} result</summary><pre>{m.content}</pre></details>
          ) : (
            <article key={i} className={'m ' + m.role}>
              {m.thinking && <details className="think"><summary>Thinking</summary>{m.thinking}</details>}
              {(m.role === 'assistant' && m.content ? <Markdown text={m.content} /> : m.content) || (m.tool_calls?.length ? null : busy && m.role === 'assistant' && i === messages.length - 1
                ? <span className="loading loading-dots loading-md" aria-label="Waiting for response" /> : '')}
              {m.tool_calls?.map((c: any) => (
                <details key={c.id} className="tool"><summary>🔧 {c.function.name}</summary><pre>{c.function.arguments}</pre></details>
              ))}
            </article>
          ))}
        </div>
        <form id="f" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea className="textarea" ref={input} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button id="send" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : 'Send'}</button>
        </form>
      </main>
    </>
  );
}
