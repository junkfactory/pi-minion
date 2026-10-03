import type { AgentCliAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { agyAdapter } from "./agy.js";
import { piAdapter } from "./pi.js";

const registry = new Map<string, AgentCliAdapter>([
  ["claude", claudeAdapter],
  ["agy", agyAdapter],
  ["pi", piAdapter]
]);

export function getAdapter(name: string): AgentCliAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`Unknown agentCli "${name}". Registered adapters: ${listAdapterNames().join(", ")}`);
  }
  return adapter;
}

export function listAdapterNames(): string[] {
  return [...registry.keys()];
}

export function resolveAdapterForModel(model: string): AgentCliAdapter {
  const adapter = [...registry.values()].find((candidate) => candidate.ownsModel(model));
  if (!adapter) {
    throw new Error(
      `Unknown model "${model}". Call help_pi_minion for the models usable here.`
    );
  }
  return adapter;
}
