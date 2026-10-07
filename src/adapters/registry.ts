import type { AgentCliAdapter, MinionConfig } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { agyAdapter } from "./agy.js";
import { piAdapter } from "./pi.js";
import { isProviderAllowed } from "../config.js";

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

// All registered adapters (generic — callers never name a specific CLI).
export function listAdapters(): AgentCliAdapter[] {
  return [...registry.values()];
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

// A run can land before session_start's fire-and-forget catalog refresh has
// populated a catalog (help_pi_minion awaits the same refreshes, so it lists
// models the run would call unknown). One awaited refresh, then the original
// error — the retry's error would be identical, so rethrow the first.
export async function resolveAdapterForModelRefreshed(
  model: string,
  refresh: () => Promise<unknown>
): Promise<AgentCliAdapter> {
  try {
    return resolveAdapterForModel(model);
  } catch (error) {
    await refresh();
    try {
      return resolveAdapterForModel(model);
    } catch {
      throw error;
    }
  }
}

// The owning adapter decides the provider identity (claim order:
// claude → agy → pi, same as resolveAdapterForModel).
export function providersOfModel(model: string): string[] {
  const adapter = [...registry.values()].find((candidate) => candidate.ownsModel(model));
  return adapter?.providersOf?.(model) ?? [];
}

// Help list + validateRequest gate: unidentifiable providers keep the
// model; otherwise EVERY backing provider must survive
// blocked-wins-allowed — pi resolves aliases itself at spawn, so one
// blocked entry under a shared alias must hide the whole string.
export function isModelProviderAllowed(
  config: Pick<MinionConfig, "providers">,
  model: string
): boolean {
  const providers = providersOfModel(model);
  return providers.length === 0 || providers.every((p) => isProviderAllowed(config, p));
}
