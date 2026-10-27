import '../styles.css';
import '../sessions/sessions.css';
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, patchSaved, savedKey, shortPath, unsaveItem, useStored, type SavedItem } from '../lib.ts';
import { Entry } from '../sessions/Messages.tsx';
import { MermaidViewer } from '../sessions/MermaidViewer.tsx';
import { Markdown, ViewerContext } from '../sessions/Markdown.tsx';

type Saved = SavedItem;
const keyOf = (s: Saved) => savedKey(s.agent, s.id, s.entryId);
const snippet = (t = '') => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > 140 ? x.slice(0, 140) + '…' : x; };

/** Note shared by every response carrying this tag (same store as the Sessions page). */
function TagNoteBox({ tag }: { tag: string }) {
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
    <div style={{ position: 'relative', flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <small className="opacity-70">Note for #{tag}</small>
      <textarea className="textarea textarea-sm" style={{ flex: 1, width: '100%', resize: 'none', fontSize: '1rem' }}
        spellCheck={false} autoCorrect="off" autoCapitalize="off" data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false"
        placeholder="Notes for this tag (auto-saved)…" value={val}
        onChange={(e) => { setVal(e.target.value); pending.current = e.target.value; setState('saving'); clearTimeout(timer.current); timer.current = setTimeout(flush, 600); }}
        onBlur={flush} />
      {state && <small style={{ position: 'absolute', right: 8, bottom: 4, opacity: .6 }}>{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved' : 'save failed'}</small>}
    </div>
  );
}

function App() {
  const [theme, setTheme] = useStored('banana-pi-theme', 'dark');
  const [showTools, setShowTools] = useStored('banana-pi-show-tools', false);
  const [hideTools, setHideTools] = useStored('banana-pi-hide-tools', false);
  const [hideThinking, setHideThinking] = useStored('banana-pi-hide-thinking', false);
  const [list, setList] = useState<Saved[] | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Saved | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: any) => setTheme(e.detail);
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);

  useEffect(() => {
    api('/api/saved').then((l: Saved[]) => {
      setList(l);
      const sel = new URLSearchParams(location.search).get('s');
      const hit = sel && l.find((x) => x.agent + '/' + x.id + (x.entryId ? '/' + x.entryId : '') === sel);
      if (hit) open(hit, true);
    });
  }, []);

  const open = async (s: Saved, replace = false) => {
    setActive(s); setLoading(false); setData(null);
    try {
      history[replace ? 'replaceState' : 'pushState'](null, '', '/sessions-saved?s=' + encodeURIComponent(s.agent + '/' + s.id + (s.entryId ? '/' + s.entryId : '')));
    } catch {}
    if (s.entryId) return; // single response: rendered from stored text
    setLoading(true);
    const d = await api(`/api/session?agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(s.id)}`);
    setActive((cur) => {
      if (cur && keyOf(cur) === keyOf(s)) { setData(d); setLoading(false); if (messagesRef.current) messagesRef.current.scrollTop = 0; }
      return cur;
    });
  };

  const remove = async (s: Saved) => {
    await unsaveItem(s.agent, s.id, s.entryId);
    setList((l) => l && l.filter((x) => keyOf(x) !== keyOf(s)));
    if (active && keyOf(active) === keyOf(s)) { setActive(null); setData(null); history.replaceState(null, '', '/sessions-saved'); }
  };

  const edit = async (s: Saved, field: 'title' | 'note') => {
    const cur = (field === 'title' ? s.title : s.note) ?? '';
    const next = window.prompt(field === 'title' ? 'Rename saved title (does not affect the original session):' : 'Note (leave empty to remove):', cur);
    if (next === null || next.trim() === cur) return;
    if (field === 'title' && !next.trim()) return;
    try {
      await patchSaved(s.agent, s.id, s.entryId, { [field]: next });
      setList((l) => l && l.map((x) => (keyOf(x) === keyOf(s) ? { ...x, [field]: next.trim() || undefined } : x)));
      setActive((a) => (a && keyOf(a) === keyOf(s) ? { ...a, [field]: next.trim() || undefined } : a));
    } catch (err: any) { alert('Failed: ' + err.message); }
  };

  const editTags = async (s: Saved) => {
    const cur = (s.tags || []).join(', ');
    const next = window.prompt('Tags (comma separated):', cur);
    if (next === null) return;
    const tags = [...new Set(next.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))];
    try {
      await patchSaved(s.agent, s.id, s.entryId, { tags });
      const v = tags.length ? tags : undefined;
      setList((l) => l && l.map((x) => (keyOf(x) === keyOf(s) ? { ...x, tags: v } : x)));
      setActive((a) => (a && keyOf(a) === keyOf(s) ? { ...a, tags: v } : a));
    } catch (err: any) { alert('Failed: ' + err.message); }
  };

  const allTags = useMemo(() => [...new Set((list || []).flatMap((s) => s.tags || []))].sort(), [list]);
  const q = query.trim().toLowerCase();
  const shown = list && list.filter((s) => (!tagFilter || s.tags?.includes(tagFilter))
    && (!q || (s.entryId ? (s.title || snippet(s.text)) : s.title).toLowerCase().includes(q)));
  useEffect(() => { if (tagFilter && !allTags.includes(tagFilter)) setTagFilter(''); }, [allTags, tagFilter]);

  const viewer = useMemo(() => ({ theme, expand: setSvg }), [theme]);
  const closeViewer = useCallback(() => setSvg(null), []);
  const branch: any[] = data && !data.error ? data.branch || [] : [];
  const cls = [showTools ? 'show-tools' : '', hideTools ? 'hide-tools' : '', hideThinking ? 'hide-thinking' : ''].filter(Boolean).join(' ');

  let body;
  if (active?.entryId) body = <article className="msg assistant"><small className="role">assistant</small><Markdown text={active.text || ''} /></article>;
  else if (loading) body = <p className="empty"><small>Loading…</small></p>;
  else if (data?.error) body = <p className="empty"><small>{data.error}</small></p>;
  else if (data) body = branch.length ? branch.map((e, i) => <Entry key={e.id ?? i} e={e} />) : <p className="empty"><small>Empty</small></p>;
  else body = <p className="empty"><small>Select a saved session</small></p>;

  return (
    <ViewerContext.Provider value={viewer}>
      <div id="app" style={{ gridTemplateColumns: '360px 1fr' }}>
        <div className="col">
          <header>
            <h1><span>Responses Saved</span>{shown && <span className="badge badge-sm badge-primary">{shown.length}</span>}
              <span className="spacer" />
              <select className="select select-xs" style={{ width: 'auto', maxWidth: 140 }} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} title="Filter by tag">
                <option value="">all tags</option>
                {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
              </select></h1>
            <div className="search-row">
              <input className="input input-sm w-full" placeholder="Search by title…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </header>
          <div>
            {list === null ? <p className="empty"><small>Loading…</small></p>
              : !shown!.length ? <p className="empty"><small>{tagFilter || q ? 'No matches' : <>No saved sessions.<br />Click ☆ on a session to save it.</>}</small></p>
              : shown!.map((s) => (
                <a key={keyOf(s)} href="#" className="list-item" aria-current={active && keyOf(active) === keyOf(s) ? 'true' : undefined}
                  onClick={(e) => { e.preventDefault(); open(s); }}>
                  <hgroup>
                    <strong>{s.entryId ? (s.title || snippet(s.text)) : s.title}</strong>
                    <p>{s.project ? shortPath(s.project) + ' · ' : ''}{s.agent} · saved {fmtTime(new Date(s.savedAt).toISOString())}</p>
                    {!!s.tags?.length && <p className="tag-row">{s.tags.map((t) => <span key={t} className="tag-chip" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTagFilter(t); }}>#{t}</span>)}</p>}
                  </hgroup>
                  <span className="row-actions join">
                    <button className="btn btn-xs join-item" title="Edit tags"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); editTags(s); }}>#</button>
                    <button className="btn btn-xs join-item" title="Rename saved title"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); edit(s, 'title'); }}>✎</button>
                    <button className="btn btn-xs join-item" title="Remove from saved"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(s); }}>×</button>
                  </span>
                </a>
              ))}
          </div>
        </div>
        <div id="col-messages">
          <header><h1><span>{data && !data.error && data.sessionName ? data.sessionName : active?.title ?? 'Conversation'}</span> <span className="spacer" />
            {!active?.entryId && <>
            <label><input className="checkbox checkbox-xs" type="checkbox" checked={hideTools} onChange={(e) => setHideTools(e.target.checked)} /> hide tools</label>
            <label><input className="checkbox checkbox-xs" type="checkbox" checked={hideThinking} onChange={(e) => setHideThinking(e.target.checked)} /> hide thinking</label>
            <label style={{ display: hideTools ? 'none' : 'inline-flex' }}>
              <input className="checkbox checkbox-xs" type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> tool results</label>
            </>}
            {active && <a className="btn btn-xs" href={`/sessions/${encodeURIComponent(active.agent)}/${encodeURIComponent(active.id)}`}>open in Sessions</a>}
          </h1>
          </header>
          <div className="msg-area">
            <div id="messages" ref={messagesRef} className={cls}
              onErrorCapture={(e) => { const t = e.target as HTMLElement; if (t.tagName === 'IMG') t.style.display = 'none'; }}>
              <div className="inner">{body}</div>
            </div>
            {active && <div className="note-side" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {active.tags?.length
                ? active.tags.map((t) => <TagNoteBox key={t} tag={t} />)
                : <small className="opacity-60">Add a tag (#) to this response to write notes for it.</small>}
            </div>}
          </div>
        </div>
      </div>
      <MermaidViewer svg={svg} onClose={closeViewer} />
    </ViewerContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
