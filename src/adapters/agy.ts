import type {
  AdapterCapabilities,
  AgentCliAdapter,
  NormalizedEvent,
  MinionConfig,
  MinionRequest
} from "./types.js";
import { MINION_PROMPT_BASE, resolveTaskText, sumFields } from "./util.js";

// agy also lists claude-* slugs (it's Google's own multi-provider router), but
// Claude models always route through claudeAdapter — this prefix intentionally
// covers only the aliases below and any literal Gemini/GPT-OSS slug a user
// pins directly, never claude-*.
const MODEL_ALIASES: Record<string, string> = {
  // Latest version pointers as of 2026-09 — re-check `agy models` periodically;
  // same staleness risk as claude.ts's CLAUDE_MODEL_ALIASES.
  "gemini-flash": "gemini-3.8-flash",
  "gemini-pro": "gemini-3.1-pro",
  "gpt-oss": "gpt-oss-120b"
};

export function ownsModel(model: string): boolean {
  return /^(gemini-|gpt-oss)/i.test(model);
}

// Same staleness risk as MODEL_ALIASES — re-check `agy models` periodically. We
// list both aliases ("gemini-flash") and their resolved ids ("gemini-3.8-flash")
// so the help output is useful whether the caller prefers short aliases or
// pinned versions. Other gemini-/gpt-oss-prefixed ids are accepted by
// ownsModel but not enumerated here; they'll route fine, just won't appear in
// help_pi_minion until this list catches up.
export function availableIds(): string[] {
  const ids = new Set<string>();
  for (const [alias, resolved] of Object.entries(MODEL_ALIASES)) {
    ids.add(alias);
    ids.add(resolved);
  }
  return [...ids];
}

function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
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
    resolveModelId(request.model),
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
  buildArgs,
  environment,
  parseLine,
  describeUnsupported
};
