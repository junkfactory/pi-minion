import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterCapabilities,
  AgentCliAdapter,
  NormalizedEvent,
  MinionConfig,
  MinionRequest
} from "./types.js";
import {
  MINION_PROMPT_BASE,
  resolveTaskText,
  sumFields,
  resolveAlias,
  deriveAliasClusters
} from "./util.js";
import type { AliasCluster } from "./util.js";

// The live model catalog, parsed from `agy --output-format=json models`.
// Everything below (ownership, derived aliases, help ids, --model resolution)
// derives from this snapshot — the same capture-and-refresh shape pi.ts's
// setModelRegistry uses, so a new Gemini/GPT-OSS release needs no code changes.
type AgyModelEntry = { id: string; label?: string };

type AgyModelsEvent = {
  status?: unknown;
  command?: { data?: { models?: unknown } };
};

// Shape-guarded parser: undefined on wrong status, wrong shape, malformed
// JSON — never a partial result. The undefined/array split is load-bearing:
// refreshAgyModels treats undefined as a FAILED refresh (keep the previous
// snapshot) and [] as a legitimately empty catalog (replace it). claude-* ids
// are dropped here as a POLICY, not a
// mechanism: Claude models always route through claudeAdapter, so agy must
// not silently claim them; a new foreign-provider family needs a deliberate
// ownership decision, not a silent filter extension.
export function parseAgyModelsList(stdout: string): AgyModelEntry[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as AgyModelsEvent;
    if (parsed?.status !== "SUCCESS") return undefined;
    const models = parsed.command?.data?.models;
    if (!Array.isArray(models)) return undefined;
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
    return undefined;
  }
}

const AGY_MODELS_TTL_MS = 60 * 60 * 1000;
// Bounded so a hung agy subprocess can't stall help_pi_minion's await.
const AGY_MODELS_TIMEOUT_MS = 2000;

// One snapshot for every consumer (see parseAgyModelsList's header). A failed
// refresh (spawn error, timeout, untrusted response) keeps the previous
// snapshot and its fetchedAt — the catalog only empties on a legitimate
// empty response (status SUCCESS with an empty models array) or at process
// start, so a transient agy hiccup never routes a job to nothing.
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
    const entries = parseAgyModelsList(result.stdout);
    // undefined = untrusted response: keep the previous snapshot AND its
    // fetchedAt, so the next refresh call retries instead of serving an hour
    // of emptiness.
    if (entries) cache = { entries, fetchedAt: Date.now() };
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

// Test-only: seed/restore the snapshot without spawning agy. fetchedAt is
// overridable so refresh tests can model an expired snapshot.
export function setAgyModelsForTesting(entries: AgyModelEntry[] | undefined, fetchedAt: number = Date.now()): void {
  cache = entries ? { entries, fetchedAt } : undefined;
}

// Aliases derive from the same shared machinery as pi's (util.ts) — version
// slot stripped from the stem, effort from the tail — but agy additionally
// RESOLVES to a concrete catalog id (see resolveModelAgainstCatalog), since
// agy offers no fuzzy matcher of its own.
const aliasMemo = new WeakMap<AgyModelEntry[], AliasCluster[]>();

export function deriveAliases(entries: AgyModelEntry[]): AliasCluster[] {
  const memoed = aliasMemo.get(entries);
  if (memoed) return memoed;
  const derived = deriveAliasClusters(entries.map((entry) => entry.id));
  aliasMemo.set(entries, derived);
  return derived;
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

export function buildArgs(request: MinionRequest, config: MinionConfig): string[] {
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
    request.effort,
    ...(config.adapterArgs?.agy?.args ?? [])
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
