import { useEffect, useRef, useState } from 'react';

export function MermaidViewer({ svg, onClose }: { svg: string | null; onClose: () => void }) {
  // scale is relative to the SVG's intrinsic (viewBox) size. The SVG is re-laid-out at
  // width*scale instead of CSS-scaled, so the browser re-rasterizes vectors (stays crisp).
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const [base, setBase] = useState({ w: 0, h: 0, fit: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ sx: 0, sy: 0, active: false });
  const content = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tRef = useRef(t);
  const baseRef = useRef(base);
  tRef.current = t;
  baseRef.current = base;

  const clamp = (n: number) => Math.min(Math.max(n, baseRef.current.fit * 0.2), Math.max(baseRef.current.fit * 30, 8));
  // Zoom by ratio r around a screen point (default: stage center).
  const zoomAt = (r: number, cx?: number, cy?: number) =>
    setT((p) => {
      const ns = clamp(p.scale * r);
      const k = ns / p.scale;
      const px = (cx ?? innerWidth / 2) - innerWidth / 2 - p.x;
      const py = (cy ?? innerHeight / 2) - innerHeight / 2 - p.y;
      return { scale: ns, x: p.x - px * (k - 1), y: p.y - py * (k - 1) };
    });
  const reset = () => setT({ scale: baseRef.current.fit, x: 0, y: 0 });

  // Measure intrinsic size and fit to viewport whenever a new diagram opens.
  useEffect(() => {
    if (!svg) return;
    const el = content.current?.querySelector('svg');
    if (!el) return;
    const vb = el.viewBox?.baseVal;
    let w = vb?.width || 0, h = vb?.height || 0;
    if (!w || !h) { const r = el.getBoundingClientRect(); w = r.width; h = r.height; }
    if (!w || !h) return;
    const fit = Math.min((innerWidth * 0.92) / w, (innerHeight * 0.9) / h);
    baseRef.current = { w, h, fit };
    setBase({ w, h, fit });
    setT({ scale: fit, x: 0, y: 0 });
  }, [svg]);

  useEffect(() => {
    if (!svg) return;
    const move = (e: MouseEvent) => {
      if (!drag.current.active) return;
      setT((p) => ({ ...p, x: e.clientX - drag.current.sx, y: e.clientY - drag.current.sy }));
    };
    const up = () => { drag.current.active = false; setDragging(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      removeEventListener('keydown', key);
    };
  }, [svg, onClose]);

  // Wheel must be non-passive to preventDefault.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-Math.max(-100, Math.min(100, dy)) * 0.0025), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [svg]);

  if (!svg) return null;
  return (
    <div id="mermaidViewer" className={'visible' + (dragging ? ' dragging' : '')}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.mv-content')) {
          const cur = tRef.current;
          drag.current = { sx: e.clientX - cur.x, sy: e.clientY - cur.y, active: true };
          setDragging(true);
        }
      }}>
      <div className="mv-toolbar">
        <button className="mv-btn btn btn-sm" title="Zoom out" onClick={() => zoomAt(1 / 1.25)}>−</button>
        <button className="mv-btn btn btn-sm" title="Reset" onClick={() => reset()}>⬜</button>
        <button className="mv-btn btn btn-sm" title="Zoom in" onClick={() => zoomAt(1.25)}>+</button>
        <button className="mv-btn btn btn-sm" title="Close (Esc)" onClick={onClose}>✕</button>
      </div>
      <div className="mv-stage" ref={stage} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="mv-content" ref={content}
          style={{ transform: `translate(${t.x}px, ${t.y}px)`,
            ...(base.w ? { width: base.w * t.scale, height: base.h * t.scale } : { visibility: 'hidden' as const }) }}
          dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <div className="mv-hint">Scroll to zoom · drag to pan · Esc to close</div>
    </div>
  );
}
