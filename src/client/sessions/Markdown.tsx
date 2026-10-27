import { createContext, memo, useContext, useMemo } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { b64url } from '../lib.ts';
import { Mermaid } from './Mermaid.tsx';

export const ViewerContext = createContext<{ theme: string; expand: (svg: string) => void }>({
  theme: 'dark',
  expand: () => {},
});

// Escape raw HTML (e.g. JSX like <StyledLeftSideContainer>) instead of letting
// the browser parse it; otherwise unclosed tags swallow later content.
const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
marked.use({ renderer: { html: (token: any) => escHtml(typeof token === 'string' ? token : token.text) } });
marked.setOptions({ breaks: true, gfm: true });

// Bare /abs/path/foo.png references become inline images served via /api/image.
export const IMG_PATH_RE = /(^|[\s'"(])(\/[^\s'"()]+\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;
export const imageSrc = (path: string) => `/api/image?path=${b64url(path)}`;
const linkifyImages = (text: string) =>
  text.replace(IMG_PATH_RE, (_m, pre, path) => `${pre}${path}\n\n![${path}](${imageSrc(path)})`);

type Part = { kind: 'html'; html: string } | { kind: 'mermaid'; code: string };

function toParts(text: string): Part[] | null {
  try {
    const tokens = marked.lexer(linkifyImages(text));
    const parts: Part[] = [];
    let group: Token[] = [];
    const flush = () => {
      if (!group.length) return;
      (group as any).links = (tokens as any).links;
      parts.push({ kind: 'html', html: marked.parser(group as any) });
      group = [];
    };
    for (const t of tokens) {
      if (t.type === 'code' && (t as Tokens.Code).lang === 'mermaid') {
        flush();
        parts.push({ kind: 'mermaid', code: (t as Tokens.Code).text });
      } else group.push(t);
    }
    flush();
    return parts;
  } catch {
    return null;
  }
}

export const Markdown = memo(function Markdown({ text }: { text?: string }) {
  const parts = useMemo(() => (text ? toParts(text) : []), [text]);
  const { theme, expand } = useContext(ViewerContext);
  if (!text) return null;
  if (!parts) return <div className="md-content">{text}</div>;
  return (
    <div className="md-content">
      {parts.map((p, i) =>
        p.kind === 'mermaid'
          ? <Mermaid key={i} code={p.code} theme={theme} onExpand={expand} />
          : <div key={i} style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: p.html }} />)}
    </div>
  );
});
