/** Short session ids: the session UUID (file name sans timestamp prefix and .jsonl). Legacy base64url path ids still decode. */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export const shortId = (filePath: string) => {
  const b = basename(filePath).replace(/\.jsonl$/, '');
  const i = b.indexOf('_');
  return i >= 0 ? b.slice(i + 1) : b;
};

const index = new Map<string, Map<string, string>>(); // root -> id -> path

function scan(root: string) {
  const m = new Map<string, string>();
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        for (const f of readdirSync(join(root, d.name))) if (f.endsWith('.jsonl')) m.set(shortId(f), join(root, d.name, f));
      } catch {}
    }
  } catch {}
  index.set(root, m);
  return m;
}

export function resolveId(root: string, id: string): string {
  if (/^[\w-]{8,64}$/.test(id) && !id.startsWith('L')) {
    const hit = index.get(root)?.get(id) ?? scan(root).get(id);
    if (hit) return hit;
  }
  try { return Buffer.from(id, 'base64url').toString('utf8'); } catch {
    throw Object.assign(new Error('Invalid session id'), { status: 400 });
  }
}
