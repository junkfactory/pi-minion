import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterCapabilities,
  AgentCliAdapter,
  NormalizedEvent,
  MinionConfig,
  MinionRequest
} from "./types.js";
import { MINION_PROMPT_BASE, resolveTaskText, sumFields } from "./util.js";

// The live model catalog, parsed from `agy --output-format=json models`.
// Everything below (ownership, derived aliases, help ids, --model resolution)
// derives from this snapshot — the same capture-and-refresh shape pi.ts's
// setModelRegistry uses, so a new Gemini/GPT-OSS release needs no code changes.
type AgyModelEntry = { id: string; label?: string };

type AgyModelsEvent = {
  status?: unknown;
  command?: { data?: { models?: unknown } };
};

// Shape-guarded parser: [] on wrong status, wrong shape, malformed JSON —
// never a partial result. claude-* ids are dropped here as a POLICY, not a
// mechanism: Claude models always route through claudeAdapter, so agy must
// not silently claim them; a new foreign-provider family needs a deliberate
// ownership decision, not a silent filter extension.
export function parseAgyModelsList(stdout: string): AgyModelEntry[] {
  try {
    const parsed = JSON.parse(stdout) as AgyModelsEvent;
    if (parsed?.status !== "SUCCESS") return [];
    const models = parsed.command?.data?.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter(
        (model): model is { id: string; label?: unknown } =>
          typeof model?.id === "string" &&
          model.id !== "" &&
          !model.id.toLowerCase().startsWith("claude-")
      )
      .map((model) => ({
        id: model.id,
        label: typeof model.label === "string" ? model.label : undefined
      }));
  } catch {
    return [];
  }
}

const AGY_MODELS_TTL_MS = 60 * 60 * 1000;
// Bounded so a hung agy subprocess can't stall help_pi_minion's await.
const AGY_MODELS_TIMEOUT_MS = 2000;

// One snapshot for every consumer (see parseAgyModelsList's header). A failed
// refresh (spawn error, timeout, parse failure) keeps the previous snapshot —
// the catalog only empties on a legitimate empty/failed response after a
// process restart, or never mid-session, so a transient agy hiccup never
// routes a job to nothing.
let cache: { entries: AgyModelEntry[]; fetchedAt: number } | undefined;
let inflight: Promise<void> | undefined;

export async function refreshAgyModels(): Promise<void> {
  // Fresh enough snapshot: caller gets the cache without re-spawning agy.
  if (cache && Date.now() - cache.fetchedAt < AGY_MODELS_TTL_MS) return;
  if (inflight) return inflight; // dedupe concurrent calls, no subprocess pounding
  inflight = (async () => {
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(
      "agy",
      ["--output-format=json", "models"],
      { timeout: AGY_MODELS_TIMEOUT_MS }
    );
    cache = { entries: parseAgyModelsList(result.stdout), fetchedAt: Date.now() };
  })()
    .catch(() => {
      // spawn error / timeout — snapshot unchanged, same as if agy were absent.
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

function cachedEntries(): AgyModelEntry[] {
  return cache?.entries ?? [];
}

// Test-only: seed/restore the snapshot without spawning agy.
export function setAgyModelsForTesting(entries: AgyModelEntry[] | undefined): void {
  cache = entries ? { entries, fetchedAt: Date.now() } : undefined;
}

// Version segment of a catalog id: the digit-led token
// ("gemini-3.8-flash-high" -> "3.8", "gpt-oss-120b-medium" -> "120b").
function versionOf(id: string): string | undefined {
  return (
    id
      .toLowerCase()
      .split("-")
      .find((token) => /^\d/.test(token))
  );
}

function versionRank(version: string | undefined): number {
  if (version === undefined) return 0;
  const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(version);
  if (!match) return 0;
  let rank = 0;
  for (const part of match[1].split(".")) rank = rank * 1000 + Number(part);
  return rank; // [3,8] -> 3008 > [3,7] -> 3007; [120] -> 120 > [20] -> 20
}

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// Derived alias clusters: ids sharing a stem once the version token is
// dropped, e.g. gemini-3.8-flash-high -> gemini-flash, gpt-oss-120b-medium ->
// gpt-oss. Latest version wins; effort resolution matches the request's
// effort exactly, then falls to the nearest rank, preferring the
// higher-intensity side (so gemini-pro + medium lands on high, matching
// agy's own high>low tie-break on a 2-suffix catalog).
export type AliasCluster = {
  name: string;
  members: Array<{ id: string; version: string | undefined; effort?: string }>;
};

const aliasMemo = new WeakMap<AgyModelEntry[], AliasCluster[]>();

export function deriveAliases(entries: AgyModelEntry[]): AliasCluster[] {
  const memoed = aliasMemo.get(entries);
  if (memoed) return memoed;
  const clusters = new Map<string, AliasCluster>();
  for (const entry of entries) {
    const tokens = entry.id.toLowerCase().split("-");
    const version = versionOf(entry.id);
    // Effort is recognized as the trailing token of a versioned id only —
    // an id without a version segment keeps its full string as the stem
    // (its last token would otherwise alias-strip a meaningful word).
    const last = tokens[tokens.length - 1] ?? "";
    const effort = version !== undefined && last in EFFORT_RANK ? last : undefined;
    const stemTokens = version !== undefined ? tokens.filter((token) => token !== version && token !== effort) : tokens;
    const stem = stemTokens.join("-");
    const cluster = clusters.get(stem) ?? { name: stem, members: [] };
    cluster.members.push({ id: entry.id, version, effort });
    clusters.set(stem, cluster);
  }
  const derived = [...clusters.values()];
  aliasMemo.set(entries, derived);
  return derived;
}

export function resolveAlias(cluster: AliasCluster, effort: string): string {
  // Latest version wins (3.8 over 3.7 over 3.1); undefined versions rank 0.
  const latest = cluster.members.reduce((best, member) =>
    versionRank(member.version) > versionRank(best.version) ? member : best
  );
  const latestMembers = cluster.members.filter(
    (member) => versionRank(member.version) === versionRank(latest.version)
  );
  const ranked = latestMembers
    .filter((member) => member.effort !== undefined)
    .map((member) => ({ ...member, rank: EFFORT_RANK[member.effort as string] }));
  if (!ranked.length) return latest.id; // effort-less cluster: bare latest id
  const requested = EFFORT_RANK[effort.toLowerCase()];
  if (requested === undefined) return ranked[0].id;
  const exact = ranked.find((member) => member.rank === requested);
  if (exact) return exact.id;
  // Nearest effort rank; on an equal distance, prefer the higher side.
  const closer = (member: (typeof ranked)[number], best: (typeof ranked)[number]) =>
    Math.abs(member.rank - requested) < Math.abs(best.rank - requested) ||
    (Math.abs(member.rank - requested) === Math.abs(best.rank - requested) &&
      member.rank > best.rank);
  return ranked.reduce((best, member) => (closer(member, best) ? member : best)).id;
}

// Single resolution path shared by buildArgs and ownsModel: a literal catalog
// id passes through; a derived alias resolves to a concrete id (see
// resolveAlias); anything else passes through untouched — agy prints its own
// error for a model it doesn't recognize, same failure surface as today.
function resolveModelAgainstCatalog(model: string, effort: string): string {
  const entries = cachedEntries();
  const lower = model.toLowerCase();
  const exact = entries.find((entry) => entry.id.toLowerCase() === lower);
  if (exact) return exact.id;
  const cluster = deriveAliases(entries).find((alias) => alias.name === lower);
  if (!cluster) return model;
  return resolveAlias(cluster, effort);
}

export function ownsModel(model: string): boolean {
  const entries = cachedEntries();
  const lower = model.toLowerCase();
  if (entries.some((entry) => entry.id.toLowerCase() === lower)) return true;
  return deriveAliases(entries).some((cluster) => cluster.name === lower);
}

// help_pi_minion's universe: aliases first (they read naturally), then the
// concrete catalog ids — reflected live from agy's models snapshot.
export function availableIds(): string[] {
  const entries = cachedEntries();
  return [...deriveAliases(entries).map((cluster) => cluster.name), ...entries.map((entry) => entry.id)];
}

export function buildArgs(request: MinionRequest, _config: MinionConfig): string[] {
  // agy has no --append-system-prompt/--system-prompt equivalent (confirmed
  // against `agy --help` — no prompt-related flag beyond --prompt itself, an
  // alias for --print) — the minion prompt is prepended to the task text
  // instead, the only lever available.
  //
  // -p/--print/--prompt takes the prompt text as its own value (confirmed
  // against `agy --help`), not a boolean toggle followed by a positional
  // prompt — passing it as a separate trailing arg let -p swallow the next
  // flag instead ("-p took \"--disable-slash-commands\" as its prompt").
  // Folding it into a single "-p=<task>" token removes the ambiguity
  // regardless of what other flags follow.
  const task = `${MINION_PROMPT_BASE}\n\n${resolveTaskText(request)}`;
  return [
    `-p=${task}`,
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--model",
    resolveModelAgainstCatalog(request.model, request.effort),
    "--effort",
    request.effort
  ];
}

export function environment(): NodeJS.ProcessEnv {
  const names = ["HOME", "LANG", "PATH", "TERM", "USER"];
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : []
    )
  );
}

type AgyUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  thinking_tokens?: unknown;
  cache_read_tokens?: unknown;
};

// agy has no cost concept anywhere in its output (no --max-budget-usd flag,
// no total_cost_usd/per-model field in `usage`) — totalCostUsd stays
// undefined and perModel stays [] for every job this adapter runs;
// formatCostUsd(undefined) already renders "n/a" with no further change
// needed. thinking_tokens is real produced token volume with no dedicated
// slot in UsageTotals, so it's folded into outputTokens. cache-write has no
// field in agy's usage schema at all (unlike cache_read_tokens, which does
// exist) — cacheWriteTokens stays 0.
function tokenDelta(usage: AgyUsage | undefined) {
  return {
    input: sumFields([usage?.input_tokens]),
    output: sumFields([usage?.output_tokens, usage?.thinking_tokens]),
    cacheWrite: 0,
    cacheRead: sumFields([usage?.cache_read_tokens])
  };
}

type StepUpdateEvent = {
  event?: unknown;
  step_update?: {
    step_index?: unknown;
    step_type?: unknown;
    state?: unknown;
    text_delta?: unknown;
    usage?: AgyUsage;
    tool_name?: unknown;
    duration_seconds?: unknown;
    tool_info?: {
      parameters?: unknown;
      output?: unknown;
      error?: { message?: unknown };
    };
  };
};

type InitEvent = {
  event?: unknown;
  init?: { model?: unknown };
};

type ResultEvent = {
  event?: unknown;
  result?: {
    status?: unknown;
    response?: unknown;
    usage?: AgyUsage;
    denied_actions?: unknown[];
  };
};

export function parseLine(line: string): NormalizedEvent[] {
  let parsed: StepUpdateEvent & InitEvent & ResultEvent;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const events: NormalizedEvent[] = [];
  if (parsed.event === "init") {
    if (typeof parsed.init?.model === "string" && parsed.init.model) {
      events.push({ kind: "model", model: parsed.init.model });
    }
  } else if (parsed.event === "step_update") {
    const step = parsed.step_update;
    if (step?.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta) {
        events.push({ kind: "text", text: step.text_delta });
      }
      if (step.state === "DONE" && step.usage) {
        events.push({ kind: "usageDelta", delta: tokenDelta(step.usage) });
      }
      // agy has no separate streamed "thinking" event — thinking_tokens only
      // ever shows up as a count inside an agent_response step's usage
      // (folded into outputTokens above), never as its own delta/step_type,
      // unlike Claude's thinking_delta stream events. No `thinking` kind to
      // emit here.
    } else if (step?.step_type === "tool") {
      const id = typeof step.step_index === "number" ? String(step.step_index) : undefined;
      if (id && step.state === "ACTIVE" && typeof step.tool_name === "string") {
        const params = step.tool_info?.parameters;
        events.push({
          kind: "toolUse",
          id,
          name: step.tool_name,
          args:
            typeof params === "object" && params !== null && Object.keys(params).length > 0
              ? (params as Record<string, unknown>)
              : undefined
        });
      } else if (id && (step.state === "DONE" || step.state === "ERROR")) {
        const output = step.tool_info?.output ?? step.tool_info?.error?.message;
        events.push({
          kind: "toolResult",
          id,
          durationMs:
            typeof step.duration_seconds === "number"
              ? Math.round(step.duration_seconds * 1000)
              : undefined,
          output: typeof output === "string" ? output : undefined,
          isError: step.state === "ERROR"
        });
      }
    }
  } else if (parsed.event === "result") {
    const result = parsed.result;
    if (result?.status === "SUCCESS" && typeof result.response === "string") {
      events.push({ kind: "result", result: result.response });
    }
    if (result?.usage) {
      const delta = tokenDelta(result.usage);
      events.push({
        kind: "usage",
        usage: {
          totalCostUsd: undefined,
          inputTokens: delta.input,
          outputTokens: delta.output,
          cacheWriteTokens: delta.cacheWrite,
          cacheReadTokens: delta.cacheRead,
          perModel: []
        }
      });
    }
    if (Array.isArray(result?.denied_actions) && result.denied_actions.length) {
      events.push({ kind: "permissionDenied" });
    }
  }
  return events;
}

const capabilities: AdapterCapabilities = {
  supportsAllowedTools: false,
  supportsEffort: true,
  supportsMaxBudgetUsd: false
};

export function describeUnsupported(_request: MinionRequest, _config: MinionConfig): string[] {
  return [
    "No cost ceiling or reporting — maxBudgetUsd is unenforced and cost_usd will read n/a.",
    "No per-action permission classifier — every tool call is auto-approved."
  ];
}

export const agyAdapter: AgentCliAdapter = {
  name: "Antigravity",
  command: "agy",
  description: "Google's Antigravity CLI — routes to Gemini and GPT-OSS models",
  installHint: "see https://antigravity.google/ for installation instructions",
  rawOutputHint:
    'raw stream-json, one JSON object per line; assistant text is in "step_update" events under step_update.text_delta where step_update.step_type is "agent_response".',
  permissionDeniedWarning:
    "one or more actions were denied during this run (agy reported denied_actions); the result below may be incomplete.",
  capabilities,
  ownsModel,
  availableIds,
  refreshCatalog: refreshAgyModels,
  buildArgs,
  environment,
  parseLine,
  describeUnsupported
};
