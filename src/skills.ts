/** Lists global Pi skills (SKILL.md with frontmatter) from SKILLS_DIRS (comma-separated). */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SKILL_DIRS = (process.env.SKILLS_DIRS || `/skills/pi,/skills/agents,${homedir()}/.pi/agent/skills,${homedir()}/.agents/skills`).split(',').map((s) => s.trim()).filter(Boolean);

function parse(raw: string) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (!m) return { meta, body: raw };
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^([\w-]+):\s*(.*)$/);
    if (k) meta[k[1]] = k[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: m[2] };
}

export function listSkills() {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name, 'SKILL.md');
      if (e.name.startsWith('.') || !existsSync(file)) continue;
      try {
        const { meta, body } = parse(readFileSync(file, 'utf8'));
        const name = meta.name || e.name;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, description: meta.description || '', source: dir, path: file, body: body.trim() });
      } catch {}
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
