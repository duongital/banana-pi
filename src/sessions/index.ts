/**
 * index.js
 * Agent registry. Add new agents (claude, opencode, ...) here.
 *
 * Only agents whose data directory exists are exposed to the UI.
 */

import { PiAdapter } from './pi.ts';
import { PirAdapter } from './pir.ts';
import { OpencodeAdapter } from './opencode.ts';
import { ClaudeAdapter } from './claude.ts';

/** @type {import('./base.ts').AgentAdapter[]} */
const ALL_AGENTS = [
  new PiAdapter(),
  new PirAdapter(),
  new OpencodeAdapter(),
  new ClaudeAdapter(),
];

/** Agents that are actually usable on this machine (data dir exists). */
export function availableAgents() {
  return ALL_AGENTS.filter((a) => a.isAvailable());
}

/** Look up a usable agent by id, or undefined. */
export function getAgent(id) {
  return availableAgents().find((a) => a.id === id);
}

/** Lightweight descriptors for the /api/agents endpoint. */
export function agentDescriptors() {
  return availableAgents().map((a) => ({ id: a.id, name: a.name, canModify: a.canModify() }));
}
