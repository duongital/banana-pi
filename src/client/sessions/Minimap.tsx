import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

type Block = { isUser: boolean; height: number };

export function Minimap({ scrollRef, version, visibilityKey }: { scrollRef: RefObject<HTMLDivElement | null>; version: unknown; visibilityKey?: string }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [active, setActive] = useState(0);
  const nodes = useRef<HTMLElement[]>([]);
  const mapRef = useRef<HTMLDivElement>(null);

  const collect = () =>
    Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.msg.user, .msg.assistant') ?? [])
      .filter((el) => el.offsetHeight > 0);

  // Rebuild after each render of a new/updated session, or when hidden blocks change.
  useLayoutEffect(() => {
    const els = collect();
    nodes.current = els;
    const root = scrollRef.current;
    const total = root?.firstElementChild?.scrollHeight || 1;
    setBlocks(els.map((el) => ({
      isUser: el.classList.contains('user'),
      height: Math.max(6, Math.min(48, Math.round((el.offsetHeight / total) * 320))),
    })));
  }, [version, visibilityKey]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      last = Date.now();
      const top = root.scrollTop;
      let idx = 0;
      for (let i = 0; i < nodes.current.length; i++) {
        if (nodes.current[i].offsetTop - 20 <= top) idx = i; else break;
      }
      setActive(idx);
    };
    const onScroll = () => {
      clearTimeout(timer);
      const wait = 100 - (Date.now() - last);
      if (wait <= 0) update(); else timer = setTimeout(update, wait);
    };
    root.addEventListener('scroll', onScroll);
    update();
    return () => { root.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, [blocks]);

  useEffect(() => {
    (mapRef.current?.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!blocks.length) return <div id="minimap" />;
  return (
    <div id="minimap" className="visible" ref={mapRef}>
      {blocks.map((b, i) => (
        <div key={i}
          className={`minimap-block minimap-block--${b.isUser ? 'user' : 'assistant'}${i === active ? ' active' : ''}`}
          style={{ height: b.height }}
          title={`${b.isUser ? 'User' : 'Assistant'} #${i + 1}`}
          onClick={() => { setActive(i); nodes.current[i]?.scrollIntoView({ behavior: 'instant', block: 'start' }); }} />
      ))}
    </div>
  );
}
