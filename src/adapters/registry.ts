import type { AgentCliAdapter, MinionConfig } from "./types.js";
import { createClaudeAdapter } from "./claude.js";
import { createAgyAdapter } from "./agy.js";
import { createPiAdapter } from "./pi.js";
import { isProviderAllowed } from "../config.js";
import { commandExists } from "./util.js";

// Detection blueprints, probed in claim order (claude → agy → pi, the same
// order resolveAdapterForModel uses). A blueprint is registered when its CLI
// is on PATH; its command doubles as the registry key (all three match).
const BLUEPRINTS: {
  command: string;
  create: (config: MinionConfig) => AgentCliAdapter;
}[] = [
  { command: "claude", create: createClaudeAdapter },
  { command: "agy", create: createAgyAdapter },
  { command: "pi", create: createPiAdapter }
];

// Registration = presence in this map; an unregistered adapter owns nothing
// (every string it would claim resolves as unknown). Starts EMPTY — populated
// by ensureRegistry()'s detection at startup, or pinned wholesale by
// setAdaptersForTest() in tests.
let current = new Map<string, AgentCliAdapter>();

// Test pin: while set, ensureRegistry() no-ops and the pinned set stands
// (mirrors setModelRegistry's precedent of a test-only override that the
// production path must respect). setAdaptersForTest() unpins.
let pinned = false;

// Detect installed CLIs, instantiate the installed ones bound to `config`
// (adapters are factories, never static instances — the bound config drives
// every gated decision), and replace the registry. Always rebuilds: rebinding
// a new config must change gated outcomes. No-ops while test-pinned.
export async function ensureRegistry(config: MinionConfig): Promise<void> {
  if (pinned) return;
  const detected = new Map<string, AgentCliAdapter>();
  for (const blueprint of BLUEPRINTS) {
    if (await commandExists(blueprint.command)) {
      detected.set(blueprint.command, blueprint.create(config));
    }
  }
  current = detected;
}

// Pins (or, with no argument, unpins) the registry for tests. While pinned,
// ensureRegistry() no-ops, so detection never overwrites the fixture. Keys
// follow the same rule as detection: registry key = adapter.command. The
// detect path itself shells out to the environment and is not mocked — this
// seam pins the exact state detection would produce.
export function setAdaptersForTest(adapters?: AgentCliAdapter[]): void {
  if (adapters === undefined) {
    pinned = false;
    current = new Map();
    return;
  }
  pinned = true;
  current = new Map(adapters.map((adapter) => [adapter.command, adapter]));
}

export function getAdapter(name: string): AgentCliAdapter {
  const adapter = current.get(name);
  if (!adapter) {
    throw new Error(`Unknown agentCli "${name}". Registered adapters: ${listAdapterNames().join(", ")}`);
  }
  return adapter;
}

export function listAdapterNames(): string[] {
  return [...current.keys()];
}

// All registered adapters (generic — callers never name a specific CLI).
export function listAdapters(): AgentCliAdapter[] {
  return [...current.values()];
}

// Claims with the config-gated ownsModel: a string the adapter would own
// raw but whose provider/model the bound config excludes is unknown here.
export function resolveAdapterForModel(model: string): AgentCliAdapter {
  const adapter = [...current.values()].find((candidate) => candidate.ownsModel(model));
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

// Claims with the UNGATED rawOwnsModel, not the gated ownsModel: a
// provider-blocked string has no gated claimer, and claiming with the gate
// would return [] and misreport it as unidentifiable. The owning adapter
// decides the provider identity (claim order: claude → agy → pi, same as
// resolveAdapterForModel).
export function providersOfModel(model: string): string[] {
  const adapter = [...current.values()].find((candidate) => candidate.rawOwnsModel(model));
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
