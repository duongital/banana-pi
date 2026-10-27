import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, savedKey, patchSaved, saveItem, shortPath, baseName, unsaveItem, useDebounced, useLatest, useStored } from '../lib.ts';
import { Entry, SaveContext } from './Messages.tsx';
import { Minimap } from './Minimap.tsx';
import { MermaidViewer } from './MermaidViewer.tsx';
import { ViewerContext } from './Markdown.tsx';

type Agent = { id: string; name: string; canModify?: boolean };
type Row = { id: string; title: string; sub: string; badge?: string | number; projectLabel?: string; tags?: string[] };

const sessionRow = (s: any, search = false): Row => ({
  id: s.id,
  title: s.sessionName || s.firstMessage || s.fileName,
  sub: search
    ? `${shortPath(s.projectLabel)} · ${fmtTime(s.timestamp)}`
    : `${fmtTime(s.timestamp)} · ${s.entryCount ?? '?'} entries`,
  badge: search ? s.matchField : undefined,
  projectLabel: search ? s.projectLabel : undefined,
});

function parseUrl() {
  const segs = location.pathname.split('/').filter(Boolean).map(decodeURIComponent).slice(1);
  const q = new URLSearchParams(location.search);
  const bool = (v: string | null) => (v === null ? undefined : v === 'true' || v === '1');
  return {
    agent: segs[0] || null,
    session: segs[1] || null,
    toolResults: bool(q.get('tool-results')),
    hideTools: bool(q.get('hide-tools')),
    hideThinking: bool(q.get('hide-thinking')),
    q: q.get('q') || '',
    fullText: bool(q.get('full-text')),
    tagOnly: bool(q.get('tag-only')),
  };
}

function ListItem({ row, active, onClick, actions, onTag }: {
  row: Row; active: boolean; onClick: () => void; onTag?: (t: string) => void;
  actions?: { tag?: () => void; rename?: () => void; del?: () => void; save?: () => void; saved?: boolean };
}) {
  return (
    <a href="#" className="list-item" aria-current={active ? 'true' : undefined}
      onClick={(e) => { e.preventDefault(); onClick(); }}>
      <hgroup>
        <strong>{row.title}{row.badge !== undefined && <> <mark className="badge badge-sm badge-primary">{row.badge}</mark></>}</strong>
        <p>{row.sub}</p>
        {!!row.tags?.length && <p className="tag-row">{row.tags.map((t) => (
          <span key={t} className="tag-chip" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTag?.(t); }}>#{t}</span>))}</p>}
      </hgroup>
      {actions && (
        <span className={'row-actions join' + (actions.saved ? ' is-saved' : '')}>
          {actions.tag && <button className="btn btn-xs join-item" title="Edit tags" onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.tag!(); }}>#</button>}
          {actions.rename && <button className="btn btn-xs join-item" title="Rename" onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.rename!(); }}>✎</button>}
          {actions.del && <button className="btn btn-xs join-item" title="Delete" onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.del!(); }}>×</button>}
        </span>
      )}
    </a>
  );
}

function TagNote({ tag }: { tag: string }) {
  const [val, setVal] = useState('');
  const [state, setState] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const timer = useRef<any>(null);
  const pending = useRef<string | null>(null);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    const v = pending.current; pending.current = null;
    try {
      const r = await fetch('/api/tag-notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, note: v }) });
      setState(r.ok ? 'saved' : 'error');
    } catch { setState('error'); }
  }, [tag]);
  useEffect(() => {
    let dead = false;
    setVal(''); setState('');
    api(`/api/tag-notes?tag=${encodeURIComponent(tag)}`).then((r) => { if (!dead) setVal(r.note || ''); }).catch(() => {});
    return () => { dead = true; flush(); };
  }, [tag, flush]);
  return (
    <div className="tag-note">
      <small className="opacity-70">Note for #{tag}</small>
      <textarea className="textarea textarea-sm" spellCheck={false} placeholder="Notes for this tag (auto-saved)…" value={val}
        onChange={(e) => { setVal(e.target.value); pending.current = e.target.value; setState('saving'); clearTimeout(timer.current); timer.current = setTimeout(flush, 600); }}
        onBlur={flush} />
      {state && <small style={{ position: 'absolute', right: 12, bottom: 8, opacity: .6 }}>{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved' : 'save failed'}</small>}
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useStored('banana-pi-theme', 'dark');
  const [navCollapsed, setNavCollapsed] = useStored('banana-pi-nav-collapsed', false);
  const [showTools, setShowTools] = useStored('banana-pi-show-tools', false);
  const [hideTools, setHideTools] = useStored('banana-pi-hide-tools', false);
  const [hideThinking, setHideThinking] = useStored('banana-pi-hide-thinking', false);

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [projects, setProjects] = useState<any[] | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [sessionsTitle, setSessionsTitle] = useState('Sessions');
  const [sessions, setSessions] = useState<Row[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [data, setData] = useState<any>(null); // loaded session, or { error }
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [fullText, setFullText] = useState(false);
  const [tagOnly, setTagOnly] = useState(false);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [tagList, setTagList] = useState<any[]>([]);
  const [svg, setSvg] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(false);

  const debouncedSearch = useDebounced(search, 250);
  const canModify = !!agents?.find((a) => a.id === agent)?.canModify;

  useEffect(() => {
    const on = (e: any) => setTheme(e.detail);
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);

  // ── URL sync ────────────────────────────────────────────────────────────
  const syncUrl = useCallback((over: Partial<{ agent: string | null; session: string | null; replace: boolean }> = {}) => {
    const a = 'agent' in over ? over.agent : agent;
    const s = 'session' in over ? over.session : sessionId;
    const parts: string[] = [];
    if (a) parts.push(encodeURIComponent(a));
    if (a && s) parts.push(encodeURIComponent(s));
    const qs = new URLSearchParams({
      'tool-results': String(showTools), 'hide-tools': String(hideTools),
      'hide-thinking': String(hideThinking),
    });
    const cur = new URLSearchParams(location.search);
    for (const k of ['q', 'full-text', 'tag-only']) if (cur.has(k)) qs.set(k, cur.get(k)!);
    const url = '/sessions' + (parts.length ? '/' + parts.join('/') : '') + '?' + qs;
    if (url === location.pathname + location.search) return;
    try { history[over.replace ? 'replaceState' : 'pushState'](null, '', url); } catch {}
  }, [agent, sessionId, showTools, hideTools, hideThinking]);

  // Toggle changes update the URL (replace-style would lose history; mirror original: push).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    syncUrl();
  }, [showTools, hideTools, hideThinking]);

  // Persist search filter in URL (replace, so refresh keeps it).
  const firstQ = useRef(true);
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return; }
    const p = new URLSearchParams(location.search);
    const set = (k: string, v: string | false) => (v ? p.set(k, v as string) : p.delete(k));
    set('q', debouncedSearch.trim() && debouncedSearch);
    set('full-text', fullText && 'true');
    set('tag-only', tagOnly && 'true');
    const url = location.pathname + '?' + p;
    if (url !== location.pathname + location.search) try { history.replaceState(null, '', url); } catch {}
  }, [debouncedSearch, fullText, tagOnly]);

  // ── Loaders ─────────────────────────────────────────────────────────────
  const loadSession = useCallback(async (id: string, ag: string) => {
    setSessionId(id);
    setLoading(true);
    setData(null);
    const d = await api(`/api/session?agent=${ag}&id=${encodeURIComponent(id)}`);
    setSessionId((cur) => {
      if (cur === id) { setData(d); setLoading(false); if (messagesRef.current) messagesRef.current.scrollTop = 0; }
      return cur;
    });
  }, []);

  const loadProjects = useCallback(async (ag: string) => {
    setSessionId(null); setData(null); setProject(null); setSessions(null);
    setSessionsTitle('Sessions');
    setProjects(null);
    setProjects(await api(`/api/projects?agent=${ag}`));
  }, []);

  const loadSessions = useCallback(async (ag: string, pid: string, label: string) => {
    setProject(pid);
    setSessionsTitle(shortPath(label));
    const list = await api(`/api/sessions?agent=${ag}&project=${encodeURIComponent(pid)}`);
    setSessions(list.map((s: any) => sessionRow(s)));
  }, []);

  // Deep link: load the session, then best-effort locate its project.
  const restoreSession = useCallback(async (id: string, ag: string) => {
    loadSession(id, ag);
    try {
      const ps = await api(`/api/projects?agent=${ag}`);
      for (const p of ps) {
        const list = await api(`/api/sessions?agent=${ag}&project=${encodeURIComponent(p.id)}`);
        if (list.some((s: any) => s.id === id)) { await loadSessions(ag, p.id, p.label); break; }
      }
    } catch {}
  }, [loadSession, loadSessions]);

  useEffect(() => {
    api('/api/saved').then((l: any[]) => Array.isArray(l) && setSavedKeys(new Set(l.map((s) => savedKey(s.agent, s.id, s.entryId))))).catch(() => {});
  }, []);

  const tagsOf = useCallback((id: string) => tagList.find((t) => t.agent === agent && t.id === id)?.tags as string[] | undefined, [tagList, agent]);
  useEffect(() => {
    api('/api/tags').then((l: any) => Array.isArray(l) && setTagList(l)).catch(() => {});
  }, []);

  // ── Init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const list: Agent[] = await api('/api/agents');
      setAgents(list);
      if (!list.length) return;
      const url = parseUrl();
      if (url.hideTools !== undefined) setHideTools(url.hideTools);
      if (url.hideThinking !== undefined) setHideThinking(url.hideThinking);
      if (url.toolResults !== undefined) setShowTools(url.toolResults);
      if (url.q) setSearch(url.q);
      if (url.fullText) setFullText(true);
      if (url.tagOnly) setTagOnly(true);
      const pref = (url.agent && list.find((a) => a.id === url.agent)) || list.find((a) => a.id === 'pi') || list[0];
      setAgent(pref.id);
      await loadProjects(pref.id);
      if (url.session) await restoreSession(url.session, pref.id);
      else history.replaceState(null, '', `/sessions/${encodeURIComponent(pref.id)}?tool-results=${url.toolResults ?? showTools}&hide-tools=${url.hideTools ?? hideTools}&hide-thinking=${url.hideThinking ?? hideThinking}${location.search.includes('q=') || url.fullText || url.tagOnly ? '&' + new URLSearchParams(location.search).toString().split('&').filter((p) => /^(q|full-text|tag-only)=/.test(p)).join('&') : ''}`);
    })();
  }, []);

  // Back/forward.
  const latest = useLatest({ agent, sessionId, agents });
  useEffect(() => {
    const onPop = async () => {
      const url = parseUrl();
      const cur = latest.current;
      if (url.hideTools !== undefined) setHideTools(url.hideTools);
      if (url.hideThinking !== undefined) setHideThinking(url.hideThinking);
      if (url.toolResults !== undefined) setShowTools(url.toolResults);
      let ag = cur.agent;
      if (url.agent && url.agent !== ag && cur.agents?.some((a) => a.id === url.agent)) {
        ag = url.agent; setAgent(ag); await loadProjects(ag);
      }
      if (url.session && url.session !== cur.sessionId && ag) await restoreSession(url.session, ag);
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (stickBottom.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    stickBottom.current = false;
  }, [data]);

  // ── Search ──────────────────────────────────────────────────────────────
  const searching = useRef(false);
  useEffect(() => {
    if (!agent) return;
    const q = debouncedSearch.trim();
    if (!q) {
      if (searching.current) {
        searching.current = false;
        // Restore the current project's sessions; keep the open conversation.
        const label = projects?.find((p: any) => p.id === project)?.label;
        if (project && label !== undefined) loadSessions(agent, project, label);
        else { setSessions(null); setSessionsTitle('Sessions'); }
      }
      return;
    }
    searching.current = true;
    let dead = false;
    if (q.startsWith('#')) {
      const want = q.slice(1).toLowerCase();
      const hits = tagList.filter((t) => t.agent === agent && t.tags.some((x: string) => x.includes(want)));
      setSessionsTitle(`Tag: ${hits.length} result(s)`);
      setSessions(hits.map((t) => ({
        id: t.id, title: t.title || t.id, sub: `${shortPath(t.project || '')} · ${fmtTime(t.timestamp)}`, projectLabel: t.project || '',
      })));
      return;
    }
    api(`/api/search?agent=${agent}&q=${encodeURIComponent(q)}&scope=${fullText ? 'content' : 'meta'}`).then((r) => {
      if (dead) return;
      setSessionsTitle(`Search: ${r.length} result(s)`);
      setSessions(r.map((s: any) => sessionRow(s, true)));
    });
    return () => { dead = true; };
  }, [debouncedSearch, fullText, agent, tagList]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const rename = async (row: Row) => {
    const next = window.prompt('Rename session:', row.title)?.trim();
    if (!next || next === row.title) return;
    try {
      const res = await fetch(`/api/session?agent=${agent}&id=${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setSessions((l) => l && l.map((r) => (r.id === row.id ? { ...r, title: next } : r)));
      setTagList((l: any[]) => l.map((t) => (t.id === row.id ? { ...t, title: next } : t)));
      setData((d: any) => (sessionId === row.id && d && !d.error ? { ...d, sessionName: next } : d));
    } catch (err: any) { alert('Failed to rename: ' + err.message); }
  };
  const del = async (row: Row) => {
    if (!confirm('Delete this session?\n' + row.title)) return;
    try {
      const res = await fetch(`/api/session?agent=${agent}&id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setSessions((l) => l && l.filter((r) => r.id !== row.id));
      if (sessionId === row.id) { setSessionId(null); setData(null); }
    } catch (err: any) { alert('Failed to delete: ' + err.message); }
  };

  const editTags = async (row: Row) => {
    if (!agent) return;
    const cur = tagsOf(row.id) || [];
    const next = window.prompt('Tags (comma separated):', cur.join(', '));
    if (next === null) return;
    const tags = next.split(',');
    try {
      const res = await fetch('/api/tags', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, id: row.id, tags, title: row.title, project: projectOf(row), timestamp: row.sub.split(' · ')[0] }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      setTagList(await api('/api/tags'));
    } catch (err: any) { alert('Failed to tag: ' + err.message); }
  };

  const projectOf = (row?: Row) => row?.projectLabel ?? projects?.find((p) => p.id === project)?.label ?? '';
  const flip = (key: string, was: boolean) =>
    setSavedKeys((s) => { const n = new Set(s); was ? n.delete(key) : n.add(key); return n; });
  const toggleSave = async (row: Row) => {
    if (!agent) return;
    const key = savedKey(agent, row.id);
    const was = savedKeys.has(key);
    try {
      if (was) await unsaveItem(agent, row.id);
      else await saveItem({ agent, id: row.id, title: row.title, project: projectOf(row) });
      flip(key, was);
    } catch (err: any) { alert('Failed to save: ' + err.message); }
  };
  const saveCtx = useMemo(() => ({
    isSaved: (entryId: string) => !!agent && !!sessionId && savedKeys.has(savedKey(agent, sessionId, entryId)),
    toggle: async (entryId: string, text: string) => {
      if (!agent || !sessionId) return;
      const key = savedKey(agent, sessionId, entryId);
      const was = savedKeys.has(key);
      if (was) await unsaveItem(agent, sessionId, entryId);
      else await saveItem({
        agent, id: sessionId, entryId, text, project: projectOf(),
        title: (data && !data.error && data.sessionName) || sessions?.find((r) => r.id === sessionId)?.title || sessionId,
      });
      flip(key, was);
    },
    listTags: async () => {
      const l: any[] = await api('/api/saved');
      return [...new Set(l.flatMap((s) => s.tags || []))].sort() as string[];
    },
    addTag: async (entryId: string, tag: string) => {
      if (!agent || !sessionId) return;
      const l: any[] = await api('/api/saved');
      const cur = l.find((s) => s.agent === agent && s.id === sessionId && s.entryId === entryId)?.tags || [];
      await patchSaved(agent, sessionId, entryId, { tags: [...cur, tag] });
    },
  }), [agent, sessionId, savedKeys, data, sessions, project, projects]);

  const pickAgent = (id: string) => {
    searching.current = false;
    setAgent(id); setSearch('');
    syncUrl({ agent: id, session: null });
    loadProjects(id);
  };
  const pickSession = (id: string) => {
    if (!agent) return;
    syncUrl({ session: id });
    loadSession(id, agent);
  };

  const viewer = useMemo(() => ({ theme, expand: setSvg }), [theme]);
  const closeViewer = useCallback(() => setSvg(null), []);

  const branch: any[] = data && !data.error ? data.branch || [] : [];
  const cls = [showTools ? 'show-tools' : '', hideTools ? 'hide-tools' : '', hideThinking ? 'hide-thinking' : ''].filter(Boolean).join(' ');

  const shownSessions = (sessions || []).filter((r) => !tagOnly || !!tagsOf(r.id)?.length);
  let sessionsBody;
  if (sessions === null) sessionsBody = <p className="empty"><small>Select a project</small></p>;
  else if (!shownSessions.length) sessionsBody = <p className="empty"><small>{search.trim() || tagOnly ? 'No matches' : 'No sessions'}</small></p>;
  else sessionsBody = shownSessions.map((r) => (
    <ListItem key={r.id} row={{ ...r, tags: tagsOf(r.id) }} active={r.id === sessionId} onClick={() => pickSession(r.id)}
      onTag={(t) => setSearch('#' + t)}
      actions={{
        tag: () => editTags(r),
        ...(canModify ? { rename: () => rename(r), del: () => del(r) } : {}),
      }} />
  ));

  let messagesBody;
  if (loading) messagesBody = <p className="empty"><small>Loading…</small></p>;
  else if (data?.error) messagesBody = <p className="empty"><small>{data.error}</small></p>;
  else if (data) messagesBody = branch.length ? branch.map((e, i) => <Entry key={e.id ?? i} e={e} />) : <p className="empty"><small>Empty</small></p>;
  else messagesBody = <p className="empty"><small>Select a session</small></p>;

  return (
    <ViewerContext.Provider value={viewer}>
      <SaveContext.Provider value={saveCtx}>
      <div id="app" className={navCollapsed ? 'nav-collapsed' : ''}>
        <div className="col" id="col-projects">
          <header>
            <h1>Banana Pi <span className="spacer" />
              <button className="btn btn-xs btn-ghost" title="Hide this panel" onClick={() => setNavCollapsed(true)}>‹</button>
            </h1>
            <select className="select select-sm w-full" value={agent ?? ''} onChange={(e) => pickAgent(e.target.value)}>
              {(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </header>
          <div>
            {agents && !agents.length ? <p className="empty"><small>No agents available.<br />Mount a session directory.</small></p>
              : projects && !projects.length ? <p className="empty"><small>No projects</small></p>
              : (projects ?? []).map((p) => (
                <ListItem key={p.id} active={p.id === project}
                  row={{ id: p.id, title: baseName(p.label), sub: p.label, badge: p.sessionCount }}
                  onClick={() => { if (!agent) return; searching.current = false; setSearch(''); loadSessions(agent, p.id, p.label); }} />
              ))}
          </div>
        </div>
        <div className="col" id="col-sessions">
          <header>
            <h1><button className="btn btn-xs btn-ghost" title="Show/hide agents panel" onClick={() => setNavCollapsed(!navCollapsed)}>☰</button>
              <span>{sessionsTitle}</span></h1>
            <div className="search-row">
              <input className="input input-sm w-full" placeholder="Search sessions… (#tag)" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="search-row">
              <label><input className="checkbox checkbox-xs" type="checkbox" checked={fullText}
                onChange={(e) => setFullText(e.target.checked)} /> full-text</label>
              <label className="ml-3"><input className="checkbox checkbox-xs" type="checkbox" checked={tagOnly}
                onChange={(e) => setTagOnly(e.target.checked)} /> tag-only</label>
            </div>
          </header>
          <div className="list-scroll">{sessionsBody}</div>
          {debouncedSearch.trim().startsWith('#') && debouncedSearch.trim().length > 1 && !!sessions?.length && (
            <TagNote tag={debouncedSearch.trim().slice(1)} />)}
        </div>
        <div id="col-messages">
          <header><h1><span>{data && !data.error && data.sessionName ? data.sessionName : 'Conversation'}</span>
            {data && !data.error && data.header?.id && <code className="text-xs opacity-60 select-all" title="Session ID">{data.header.id}</code>}
            <span className="spacer" />
            <label>
              <input className="checkbox checkbox-xs" type="checkbox" checked={hideTools} onChange={(e) => setHideTools(e.target.checked)} /> hide tools</label>
            <label>
              <input className="checkbox checkbox-xs" type="checkbox" checked={hideThinking} onChange={(e) => setHideThinking(e.target.checked)} /> hide thinking</label>
            <label style={{ display: hideTools ? 'none' : 'inline-flex' }}>
              <input className="checkbox checkbox-xs" type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> tool results</label>
          </h1></header>
          <div className="msg-area">
            <div id="messages" ref={messagesRef} className={cls}
              onErrorCapture={(e) => { const t = e.target as HTMLElement; if (t.tagName === 'IMG') t.style.display = 'none'; }}>
              <div className="inner">{messagesBody}</div>
            </div>
            <Minimap scrollRef={messagesRef} version={data} visibilityKey={cls} />
          </div>
        </div>
      </div>
      <MermaidViewer svg={svg} onClose={closeViewer} />
      </SaveContext.Provider>
    </ViewerContext.Provider>
  );
}
