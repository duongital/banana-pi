import { createContext, memo, useContext, useState } from 'react';
import { Markdown, IMG_PATH_RE, imageSrc } from './Markdown.tsx';

/** Lets assistant messages be saved individually; provided by the page. */
export const SaveContext = createContext<{
  isSaved: (entryId: string) => boolean;
  toggle: (entryId: string, text: string) => Promise<void>;
  /** Tags currently used in the Responses page. */
  listTags: () => Promise<string[]>;
  addTag: (entryId: string, tag: string) => Promise<void>;
} | null>(null);

const normalize = (content: any): any[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }]
    : Array.isArray(content) ? content
    : [{ type: 'text', text: JSON.stringify(content) }];

function stringifyResult(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : JSON.stringify(x))).join('\n');
  return JSON.stringify(c, null, 2);
}

function InlineImg({ path }: { path: string }) {
  return <img className="inline-img" loading="lazy" src={imageSrc(path)} alt={path} />;
}

function ToolArgs({ name, args }: { name: string; args: any }) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return null;
  if (name === 'bash' && args.command) return <pre className="tool-args">$ {args.command}</pre>;
  if ((name === 'read' || name === 'write' || name === 'edit') && args.path) {
    const { path, ...extra } = args;
    const rest = Object.keys(extra).length ? '\n' + JSON.stringify(extra, null, 2) : '';
    IMG_PATH_RE.lastIndex = 0;
    const isImg = IMG_PATH_RE.test(path);
    IMG_PATH_RE.lastIndex = 0;
    return (
      <>
        <pre className="tool-args">{path}{rest}</pre>
        {isImg && <InlineImg path={path} />}
      </>
    );
  }
  return <pre className="tool-args">{JSON.stringify(args, null, 2)}</pre>;
}

function Block({ b }: { b: any }) {
  if (!b || typeof b !== 'object') return <>{String(b)}</>;
  switch (b.type) {
    case 'text': return <Markdown text={b.text} />;
    case 'thinking': case 'reasoning':
      return <div className="thinking"><Markdown text={b.text || b.thinking} /></div>;
    case 'tool_use': case 'toolCall':
      return (
        <div className="tool-call-block">
          <span className="tool-name">▸ {b.name}</span>
          <ToolArgs name={b.name} args={b.input || b.args || b.arguments || {}} />
        </div>
      );
    case 'tool_result': case 'toolResult':
      return <pre className="tool-result-block">{stringifyResult(b.content ?? b.output)}</pre>;
    case 'image': return <em>[image]</em>;
    default: return <pre>{JSON.stringify(b, null, 2)}</pre>;
  }
}

function SaveButton({ entryId, text }: { entryId: string; text: string }) {
  const ctx = useContext(SaveContext);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[] | null>(null);
  if (!ctx) return null;
  const saved = ctx.isSaved(entryId);
  const click = async () => {
    setBusy(true);
    setTags(null);
    try {
      await ctx.toggle(entryId, text);
      if (!saved) { const t = await ctx.listTags().catch(() => []); if (t.length) setTags(t); }
    } catch (err: any) { alert('Failed to save: ' + err.message); }
    setBusy(false);
  };
  const pick = async (tag: string) => {
    if (!tag) return;
    try { await ctx.addTag(entryId, tag); setTags(null); } catch (err: any) { alert('Failed to tag: ' + err.message); }
  };
  return (
    <>
      {saved && tags && (
        <select className="select select-xs save-tag-pick" value="" onChange={(e) => pick(e.target.value)} title="Add a tag in Responses">
          <option value="">+ tag?</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
      )}
      <button type="button" className="copy-btn save-btn" disabled={busy} onClick={click}>{saved ? 'Saved ★' : 'Save'}</button>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    setOk(true); setTimeout(() => setOk(false), 1500);
  };
  return <button type="button" className="copy-btn" onClick={copy}>{ok ? 'Copied' : 'Copy'}</button>;
}

const Message = memo(function Message({ m, entryId }: { m: any; entryId?: string }) {
  const role = m.role || 'assistant';
  const isToolResult = role === 'toolResult' || role === 'tool';
  const cls = role === 'user' ? 'user' : isToolResult ? 'tool tool-result' : 'assistant';
  const blocks = normalize(m.content);
  const isFinal = role === 'assistant' && !blocks.some((b) => b?.type === 'tool_use' || b?.type === 'toolCall');
  const text = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n\n');
  return (
    <article className={'msg ' + cls}>
      <small className="role">{role}</small>
      {isFinal && text && <div className="msg-actions">{entryId && <SaveButton entryId={entryId} text={text} />}<CopyButton text={text} /></div>}
      {blocks.map((b, i) => <Block key={i} b={b} />)}
    </article>
  );
});

export function Entry({ e }: { e: any }) {
  if (e.type === 'message' && e.message) return <Message m={e.message} entryId={e.id} />;
  if (e.type === 'session_info') return <article className="msg event"><small>renamed → {e.name}</small></article>;
  if (e.type === 'compaction') return <article className="msg event"><small>— context compacted —</small></article>;
  if (e.type === 'branch_summary') return <article className="msg event"><small>branch summary</small></article>;
  return null;
}
