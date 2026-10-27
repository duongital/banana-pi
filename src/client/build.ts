/**
 * Bundles the React pages (src/client/<page>/index.html) with Bun at startup.
 * Output is kept in memory: HTML per page plus hashed JS/CSS assets under /assets/.
 */
import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

export const PAGES = ['sessions', 'sessions-saved', 'chat', 'agents', 'scheduler'] as const;
export type Page = (typeof PAGES)[number];

export type Assets = {
  html: Record<Page, string>;
  files: Map<string, { body: Blob; type: string }>;
};

export async function buildClient(): Promise<Assets> {
  const root = join(import.meta.dir);
  const result = await Bun.build({
    entrypoints: PAGES.map((p) => join(root, p, 'index.html')),
    plugins: [tailwind],
    splitting: true,
    minify: process.env.NODE_ENV !== 'development',
    publicPath: '/assets/',
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') },
  });
  if (!result.success) {
    for (const l of result.logs) console.error(l);
    throw new Error('client build failed');
  }

  const html = {} as Record<Page, string>;
  const files = new Map<string, { body: Blob; type: string }>();
  const htmlOutputs = result.outputs.filter((o) => o.kind === 'entry-point' && o.path.endsWith('.html'));
  for (const o of result.outputs) {
    if (o.path.endsWith('.html')) continue;
    const name = o.path.split('/').pop()!;
    files.set('/assets/' + name, { body: o, type: o.type });
  }
  // Bun emits html outputs in entrypoint order.
  for (let i = 0; i < PAGES.length; i++) html[PAGES[i]] = await htmlOutputs[i].text();
  return { html, files };
}
