import { useEffect, useRef, useState } from 'react';

export const api = (path: string) => fetch(path).then((r) => r.json());

export const shortPath = (p: string) => String(p).split('/').filter(Boolean).slice(-2).join('/') || p;
export const baseName = (p: string) => String(p).split("/").filter(Boolean).pop() || p;

export function fmtTime(t?: string) {
  if (!t) return '';
  const d = new Date(t);
  return isNaN(d.getTime()) ? t : d.toLocaleString();
}

export function b64url(s: string) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Persistent boolean/string state backed by localStorage. */
export function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void];
export function useStored(key: string, initial: string): [string, (v: string) => void];
export function useStored(key: string, initial: any): [any, (v: any) => void] {
  const [val, setVal] = useState<any>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return typeof initial === 'boolean' ? raw === '1' : raw;
    } catch { return initial; }
  });
  const set = (v: any) => {
    setVal(v);
    try { localStorage.setItem(key, typeof v === 'boolean' ? (v ? '1' : '0') : v); } catch {}
  };
  return [val, set];
}

export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Keep the latest value in a ref (for use inside intervals / listeners). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export type SavedItem = {
  agent: string; id: string; title: string; project?: string; savedAt: number; entryId?: string; text?: string; note?: string; tags?: string[];
};
export const savedKey = (agent: string, id: string, entryId?: string) => agent + '\0' + id + (entryId ? '\0' + entryId : '');

async function check(res: Response) {
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
}
export const saveItem = async (item: Partial<SavedItem>) =>
  check(await fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }));
export const unsaveItem = async (agent: string, id: string, entryId?: string) =>
  check(await fetch(`/api/saved?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(id)}${entryId ? '&entryId=' + encodeURIComponent(entryId) : ''}`, { method: 'DELETE' }));
export const patchSaved = async (agent: string, id: string, entryId: string | undefined, patch: { title?: string; note?: string; tags?: string[] }) =>
  check(await fetch(`/api/saved?agent=${encodeURIComponent(agent)}&id=${encodeURIComponent(id)}${entryId ? '&entryId=' + encodeURIComponent(entryId) : ''}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }));
