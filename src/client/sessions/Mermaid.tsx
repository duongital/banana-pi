import { useEffect, useState } from 'react';

let mermaidP: Promise<any> | null = null;
const loadMermaid = () => (mermaidP ??= import('mermaid').then((m) => m.default));
let counter = 0;

const DARK = ['dark', 'synthwave', 'halloween', 'forest', 'black', 'luxury', 'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss'];
export function Mermaid({ code, theme, onExpand }: { code: string; theme: string; onExpand: (svg: string) => void }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    loadMermaid().then(async (m) => {
      m.initialize({ startOnLoad: false, theme: DARK.includes(theme) ? 'dark' : 'default' });
      const id = 'mmd-' + ++counter;
      try {
        const out = await m.render(id, code);
        if (!dead) setSvg(out.svg);
      } catch (e) {
        console.warn('Mermaid render error:', e);
        document.getElementById('d' + id)?.remove();
        if (!dead) setSvg(null);
      }
    });
    return () => { dead = true; };
  }, [code, theme]);

  if (svg == null) return <pre><code>{code}</code></pre>;
  return (
    <div className="mermaid ready" onClick={() => onExpand(svg)}>
      <button className="mermaid-expand btn btn-xs" title="Open fullscreen"
        onClick={(e) => { e.stopPropagation(); onExpand(svg); }}>{'\u26F6'}</button>
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
