import '../styles.css';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './agents.css';

type Agent = { id: string; name: string; description?: string; model: string; systemPrompt: string; tools: string[]; skills?: string[]; updated: number };
type ModelInfo = { id: string; owned_by: string | null; mode: string | null; created: number | null; max_input_tokens: number | null; max_output_tokens: number | null };
const fmt = (n: number | null) => (n == null ? '—' : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n));
const fmtDate = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '—');
type Tool = { id: string; label: string; description: string };
type Skill = { name: string; description: string; source: string; path: string; body: string };
type Form = { name: string; description: string; model: string; systemPrompt: string; tools: string[]; skills: string[] };
const EMPTY: Form = { name: '', description: '', model: '', systemPrompt: '', tools: [], skills: [] };
const toForm = (a: Agent): Form => ({ name: a.name, description: a.description || '', model: a.model, systemPrompt: a.systemPrompt, tools: a.tools, skills: a.skills || [] });
const idFromPath = () => location.pathname.match(/^\/agents\/([^/]+)/)?.[1] || null;

async function api(url: string, method = 'GET', body?: unknown) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [modelList, setModelList] = useState<ModelInfo[] | null>(null);
  const models = modelList && modelList.map((m) => m.id);
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [viewSkill, setViewSkill] = useState<Skill | null>(null);
  const [open, setOpen] = useState(false);
  const [selId, setSelId] = useState<string | null>(null); // null = new agent
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState('');
  const [modelErr, setModelErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => api('/api/agent-defs').then((d: Agent[]) => { setAgents(d); return d; });

  const show = (a: Agent | null) => {
    setSelId(a?.id ?? null); setForm(a ? toForm(a) : EMPTY); setError(''); setOpen(true);
    history.pushState(null, '', a ? `/agents/${a.id}` : '/agents');
  };
  const close = () => { setOpen(false); if (location.pathname !== '/agents') history.pushState(null, '', '/agents'); };

  useEffect(() => {
    reload().then((d) => { const a = d.find((x) => x.id === idFromPath()); if (a) show(a); }).catch((e) => setError(e.message));
    api('/api/agent-tools').then(setTools).catch((e) => setError(e.message));
    api('/api/skills').then(setSkills).catch(() => {});
    api('/api/models').then((d: ModelInfo[]) => setModelList(d)).catch((e) => { setModelList([]); setModelErr(e.message); });
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (viewSkill) setViewSkill(null); else close(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open, viewSkill]);

  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const toggle = (id: string) => set({ tools: form.tools.includes(id) ? form.tools.filter((t) => t !== id) : [...form.tools, id] });

  const toggleSkill = (n: string) => set({ skills: form.skills.includes(n) ? form.skills.filter((s) => s !== n) : [...form.skills, n] });

  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (selId) await api(`/api/agent-defs/${selId}`, 'PUT', form); else await api('/api/agent-defs', 'POST', form);
      await reload();
      close();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!selId || !confirm(`Delete agent "${form.name}"?`)) return;
    try { await api(`/api/agent-defs/${selId}`, 'DELETE'); await reload(); close(); }
    catch (e: any) { setError(e.message); }
  };

  const shownModels = modelList;
  const modelMissing = models && models.length > 0 && form.model && !models.includes(form.model);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Agents {agents && <small>({agents.length})</small>}</h2>
        <button className="btn btn-primary btn-sm" onClick={() => show(null)}>+ New agent</button>
      </div>
      {error && !open && <p className="e">{error}</p>}
      {!agents && !error && <div style={{ textAlign: 'center', padding: '2rem' }}><span className="loading loading-spinner loading-lg" /></div>}
      {agents && !agents.length && <p className="hint">No agents yet. Click “New agent” to create one.</p>}
      {agents && (
        <div className="grid-cards">
          {agents.map((a) => (
            <button key={a.id} className="card-a" onClick={() => show(a)}>
              <b>{a.name}</b>
              <span className="sp">{a.model}</span>
              {a.description && <span>{a.description}</span>}
              <span className="sp">{a.tools.length ? a.tools.join(', ') : 'no tools'}</span>
              {!!a.skills?.length && <span className="sp">skills: {a.skills.join(', ')}</span>}
            </button>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Models {modelList && <small>({shownModels!.length}{shownModels!.length !== modelList.length ? `/${modelList.length}` : ''})</small>}</h2>
      {modelErr && <p className="e">{modelErr}</p>}
      {!modelList && !modelErr && <div style={{ textAlign: 'center', padding: '1rem' }}><span className="loading loading-spinner" /></div>}
      {shownModels && (
        <table className="tbl">
          <thead><tr><th>ID</th><th>Mode</th><th>Owner</th><th>Max input</th><th>Max output</th><th>Created</th></tr></thead>
          <tbody>
            {shownModels.map((m) => (
              <tr key={m.id}>
                <td>{m.id}</td><td>{m.mode ?? '—'}</td><td>{m.owned_by ?? '—'}</td>
                <td className="n" title={m.max_input_tokens?.toLocaleString()}>{fmt(m.max_input_tokens)}</td>
                <td className="n" title={m.max_output_tokens?.toLocaleString()}>{fmt(m.max_output_tokens)}</td>
                <td>{fmtDate(m.created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32 }}>Tools <small>({tools.length})</small></h2>
      <table className="tbl">
        <thead><tr><th>ID</th><th>Label</th><th>Description</th></tr></thead>
        <tbody>{tools.map((t) => <tr key={t.id}><td>{t.id}</td><td>{t.label}</td><td>{t.description}</td></tr>)}</tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Skills <small>({skills.length})</small></h2>
      {!skills.length && <p className="hint">No skills found.</p>}
      {!!skills.length && (
        <table className="tbl">
          <thead><tr><th>ID</th><th>Path</th></tr></thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name} className="clk" onClick={() => setViewSkill(s)} title={s.description}>
                <td>{s.name}</td><td>{s.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {viewSkill && (
        <div className="modal modal-open" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewSkill(null); }}>
          <div className="modal-box f" style={{ maxWidth: 780 }}>
            <h3 style={{ margin: 0 }}>{viewSkill.name}</h3>
            <p style={{ margin: 0 }}>{viewSkill.description || <i>No description</i>}</p>
            <small className="sp">{viewSkill.path}</small>
            {viewSkill.body && <pre className="sbody">{viewSkill.body}</pre>}
            <div className="modal-action" style={{ margin: 0 }}><button type="button" className="btn btn-sm" onClick={() => setViewSkill(null)}>Close</button></div>
          </div>
        </div>
      )}

      {open && (
        <div className="modal modal-open" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <form className="modal-box f" style={{ maxWidth: 680 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <h3 style={{ margin: 0 }}>{selId ? 'Edit agent' : 'New agent'}</h3>
            <div><label className="l">Name *</label><input autoFocus value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></div>
            <div><label className="l">Description</label><input value={form.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} /></div>
            <div>
              <label className="l">Model *</label>
              <select value={form.model} disabled={!models} onChange={(e) => set({ model: e.target.value })}>
                <option value="">{models ? 'Select a model…' : 'Loading models…'}</option>
                {form.model && models && !models.includes(form.model) && <option value={form.model}>{form.model}</option>}
                {models?.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {modelErr && <div className="e">Failed to load models: {modelErr}</div>}
              {modelMissing && <div className="w">This model is no longer listed by the gateway.</div>}
            </div>
            <div><label className="l">System prompt</label><textarea value={form.systemPrompt} maxLength={20000} onChange={(e) => set({ systemPrompt: e.target.value })} /></div>
            <div>
              <label className="l">Tools ({form.tools.length}/{tools.length}) <button type="button" className="link" onClick={() => set({ tools: tools.map((t) => t.id) })}>all</button> <button type="button" className="link" onClick={() => set({ tools: [] })}>none</button></label>
              <div className="tools">
                {tools.map((t) => (
                  <label key={t.id} title={t.description}><input type="checkbox" checked={form.tools.includes(t.id)} onChange={() => toggle(t.id)} />{t.label}</label>
                ))}
              </div>
            </div>
            <div>
              <label className="l">Skills ({form.skills.length}/{skills.length}) <button type="button" className="link" onClick={() => set({ skills: [] })}>none</button></label>
              <div className="tools">
                {skills.map((s) => (
                  <label key={s.name} title={s.description}><input type="checkbox" checked={form.skills.includes(s.name)} onChange={() => toggleSkill(s.name)} />{s.name}</label>
                ))}
                {form.skills.filter((n) => !skills.some((s) => s.name === n)).map((n) => (
                  <label key={n} title="Skill no longer found"><input type="checkbox" checked onChange={() => toggleSkill(n)} />{n} ⚠</label>
                ))}
              </div>
              {form.skills.length > 0 && !form.tools.includes('read') && <div className="w">Skills are loaded via the <code>read</code> tool — enable it (and <code>bash</code> if skills run scripts).</div>}
            </div>
            {error && <p className="e" style={{ margin: 0 }}>{error}</p>}
            <div className="modal-action row" style={{ margin: 0 }}>
              {selId && <button type="button" className="btn btn-error btn-outline btn-sm" onClick={remove}>Delete</button>}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" onClick={close}>Cancel</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !form.name.trim() || !form.model}>{selId ? 'Save' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Agents />);
