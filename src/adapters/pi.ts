import type {
  AdapterCapabilities,
  AgentCliAdapter,
  ModelBreakdown,
  NormalizedEvent,
  MinionConfig,
  MinionRequest,
  TokenCounts,
  UsageTotals
} from "./types.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { MINION_PROMPT_BASE, EFFORT_RANK, resolveTaskText, sumFields } from "./util.js";

// Captured from the extension ctx by pi-minion.ts's session_start handler
// (same capture-and-refresh shape as jobUI's setCtx): the parent pi process
// already loaded the live model catalog + credentials, so routing checks real
// availability instead of hardcoded claims. The registry (not a snapshot) is
// held so getAvailable() reflects later credential changes.
let modelRegistry: ModelRegistry | undefined;

export function setModelRegistry(registry: ModelRegistry | undefined): void {
  modelRegistry = registry;
}

// pi's alias rule is the TRAILING token ("luna" from gpt-6-luna — verified
// against the pi CLI's own fuzzy matcher), NOT agy's version-stripped stem
// ("gemini-flash" from gemini-3.8-flash-high), so the shared
// deriveAliasClusters machinery in util.ts doesn't apply here; these few
// lines derive pi's own alias universe instead. Version-shaped and
// effort-shaped trailing tokens are skipped — "claude-sonnet-5-5" shouldn't
// suggest "5", and no real model is named "medium".
function piAliasCandidates(ids: string[]): string[] {
  return [
    ...new Set(
      ids
        .map((id) => id.split("-").pop() ?? "")
        .filter((token) => token && !/^\d/.test(token) && !(token in EFFORT_RANK))
    )
  ];
}

// help_pi_minion's universe when allowedModels is empty: short aliases
// first, then deduped bare ids of the available catalog. Resolution stays
// delegated — the pi CLI fuzzy-matches at spawn ("--model luna" runs
// gpt-6-luna over gpt-5.6-luna), so pi-minion only enumerates, never
// resolves. Each entry is routable by some present adapter (registry check
// order keeps claude/agy claims ahead of pi's).
export function availableModelIds(): string[] {
  const ids = [...new Set((modelRegistry?.getAvailable() ?? []).map((model) => model.id))];
  return [...new Set([...piAliasCandidates(ids), ...ids])];
}

// pi's --model accepts patterns (short alias names like "luna" fuzzy-match
// and resolve to the latest version — verified: "--model luna" runs
// gpt-6-luna over gpt-5.6-luna), and any explicit "provider/id" reference is
// pi's own syntax, which no other adapter accepts. Routing mirrors that with
// a claim-only check against the available catalog (buildArgs passes the
// model through, so pi still does the actual version resolution): an exact
// bare id, a catalogued provider/id (bare or trailing alias — pi accepts
// "opencode-go/luna" for gpt-6-luna, verified via `pi auth check`), or an
// alias some available id ends with. claude-*/gemini-*/gpt-oss ids can appear in that catalog too (pi
// routes those providers itself) — safe because the registry checks the
// claude and agy adapters before this one. pi's own model matcher isn't
// publicly exported (only ModelRuntime-bound resolvers are), so this stays a
// small local approximation: narrower than pi's fuzzy matching, which at
// worst routes an exotic pattern to a clear "Unknown model" error instead of
// a spawn-time failure.
export function ownsModel(model: string): boolean {
  const available = modelRegistry?.getAvailable();
  if (!available) return false;
  const lower = model.toLowerCase();
  const slash = model.indexOf("/");
  if (slash !== -1) {
    const provider = lower.slice(0, slash);
    const alias = lower.slice(slash + 1);
    return available.some(
      (candidate) =>
        candidate.provider.toLowerCase() === provider &&
        // provider/alias too, mirroring the suffix match the bare-id path
        // allows: pi resolves "opencode-go/luna" to gpt-6-luna itself.
        (candidate.id.toLowerCase() === alias || candidate.id.toLowerCase().endsWith(`-${alias}`))
    );
  }
  return (
    available.some((candidate) => candidate.id.toLowerCase() === lower) ||
    available.some((candidate) => candidate.id.toLowerCase().endsWith(`-${lower}`))
  );
}

// Provider identities pi would route this model string to — the exact id,
// the "provider/alias" prefix, or every entry an alias suffix matches
// (aliases can span providers: "luna" over opencode-go and
// amazon-bedrock), deduped. Deliberately mirrors ownsModel's match logic
// so claim and attribution never disagree; [] = catalog can't identify it.
export function providersOf(model: string): string[] {
  const available = modelRegistry?.getAvailable();
  if (!available) return [];
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  const alias = slash === -1 ? lower : lower.slice(slash + 1);
  const matches =
    slash === -1
      ? available.filter((c) => c.id.toLowerCase() === lower || c.id.toLowerCase().endsWith(`-${lower}`))
      : available.filter(
          (c) =>
            c.provider.toLowerCase() === lower.slice(0, slash) &&
            (c.id.toLowerCase() === alias || c.id.toLowerCase().endsWith(`-${alias}`))
        );
  return [...new Set(matches.map((c) => c.provider))];
}

export function buildArgs(request: MinionRequest, config: MinionConfig): string[] {
  // --mode json streams JSONL and exits once the prompt finishes (no -p
  // needed). --no-extensions keeps the child from loading pi-minion itself
  // (recursive minions) and any other user extension. "--" stops a task that
  // starts with "-" from being parsed as a flag.
  return [
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--model",
    request.model,
    "--thinking",
    request.effort,
    "--append-system-prompt",
    MINION_PROMPT_BASE,
    ...(config.adapterArgs?.pi?.args ?? []),
    "--",
    resolveTaskText(request)
  ];
}

export function environment(): NodeJS.ProcessEnv {
  // pi reads provider credentials (OAuth/API keys) from its agent dir under
  // HOME, or from PI_CODING_AGENT_DIR when that's overridden.
  const names = ["HOME", "LANG", "PATH", "PI_CODING_AGENT_DIR", "TERM", "USER"];
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : []
    )
  );
}

type PiUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
};

type PiContentPart = { type?: unknown; text?: unknown };

type PiMessage = {
  role?: unknown;
  content?: unknown;
  model?: unknown;
  responseModel?: unknown;
  usage?: PiUsage;
  stopReason?: unknown;
  errorMessage?: unknown;
};

type PiEvent = {
  type?: unknown;
  assistantMessageEvent?: { type?: unknown; delta?: unknown };
  message?: PiMessage;
  messages?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  result?: { content?: unknown };
  isError?: unknown;
};

// usage.reasoning is already included in output (per pi's message-types
// docs), so it's not added again.
function tokenDelta(usage: PiUsage | undefined): TokenCounts {
  return {
    input: sumFields([usage?.input]),
    output: sumFields([usage?.output]),
    cacheWrite: sumFields([usage?.cacheWrite]),
    cacheRead: sumFields([usage?.cacheRead])
  };
}

function joinText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = (content as PiContentPart[]).flatMap((part) =>
    part?.type === "text" && typeof part.text === "string" ? [part.text] : []
  );
  return texts.length ? texts.join("") : undefined;
}

// responseModel is null unless the provider answered with a different model
// than requested.
function messageModel(message: PiMessage): string | undefined {
  const model = message.responseModel || message.model;
  return typeof model === "string" && model ? model : undefined;
}

// agent_end carries every message the run produced; each assistant
// message's usage covers only that one model call, so the run's totals are
// their sum.
function usageTotals(messages: PiMessage[]): UsageTotals {
  const perModel = new Map<string, ModelBreakdown>();
  for (const message of messages) {
    const model = messageModel(message) ?? "unknown";
    const delta = tokenDelta(message.usage);
    const entry = perModel.get(model) ?? {
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    };
    entry.costUsd += sumFields([message.usage?.cost?.total]);
    entry.inputTokens += delta.input;
    entry.outputTokens += delta.output;
    entry.cacheWriteTokens += delta.cacheWrite;
    entry.cacheReadTokens += delta.cacheRead;
    perModel.set(model, entry);
  }
  const rows = [...perModel.values()];
  return {
    totalCostUsd: sumFields(rows.map((row) => row.costUsd)),
    inputTokens: sumFields(rows.map((row) => row.inputTokens)),
    outputTokens: sumFields(rows.map((row) => row.outputTokens)),
    cacheWriteTokens: sumFields(rows.map((row) => row.cacheWriteTokens)),
    cacheReadTokens: sumFields(rows.map((row) => row.cacheReadTokens)),
    perModel: rows
  };
}

export function parseLine(line: string): NormalizedEvent[] {
  let parsed: PiEvent;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const events: NormalizedEvent[] = [];
  if (parsed.type === "message_update") {
    const update = parsed.assistantMessageEvent;
    if (update?.type === "text_start") {
      events.push({ kind: "textBlockStart" });
    } else if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta) {
      events.push({ kind: "text", text: update.delta });
    } else if (update?.type === "thinking_delta") {
      events.push({ kind: "thinking" });
    }
  } else if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
    const message = parsed.message;
    const model = messageModel(message);
    if (model) events.push({ kind: "model", model });
    if (message.usage) events.push({ kind: "usageDelta", delta: tokenDelta(message.usage) });
    const text = joinText(message.content);
    // Only a completed answer is a result — "toolUse" means another turn
    // follows, "error"/"aborted" leave the job without one.
    if (message.stopReason === "stop" && text !== undefined) {
      events.push({ kind: "result", result: text });
    } else if (message.stopReason === "error") {
      // The turn failed (provider/credential/config error): surface the
      // reason so the job's failure text isn't just "no result".
      events.push({
        kind: "error",
        message:
          typeof message.errorMessage === "string" && message.errorMessage
            ? message.errorMessage
            : "the model turn failed before producing a result"
      });
    }
  } else if (parsed.type === "tool_execution_start") {
    if (typeof parsed.toolCallId === "string" && typeof parsed.toolName === "string") {
      const args = parsed.args;
      events.push({
        kind: "toolUse",
        id: parsed.toolCallId,
        name: parsed.toolName,
        args:
          typeof args === "object" && args !== null && Object.keys(args).length > 0
            ? (args as Record<string, unknown>)
            : undefined
      });
    }
  } else if (parsed.type === "tool_execution_end") {
    if (typeof parsed.toolCallId === "string") {
      events.push({
        kind: "toolResult",
        id: parsed.toolCallId,
        output: joinText(parsed.result?.content),
        isError: parsed.isError === true
      });
    }
  } else if (parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
    const assistantMessages = (parsed.messages as PiMessage[]).filter(
      (message) => message?.role === "assistant"
    );
    events.push({ kind: "usage", usage: usageTotals(assistantMessages) });
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
    "No cost ceiling — maxBudgetUsd is unenforced (cost is still reported).",
    "No allowedTools or permission classifier — every built-in pi tool call is auto-approved."
  ];
}

export const piAdapter: AgentCliAdapter = {
  name: "pi",
  command: "pi",
  description: "The pi coding agent CLI — routes to OpenAI Codex (gpt-*) and any pi provider/id model",
  installHint: "install with `npm install -g @earendil-works/pi-coding-agent`",
  rawOutputHint:
    'raw JSONL, one JSON object per line; assistant text streams in "message_update" lines under assistantMessageEvent.delta where assistantMessageEvent.type is "text_delta", and each completed answer is in "message_end" lines under message.content.',
  permissionDeniedWarning:
    "one or more actions were denied during this run; the result below may be incomplete.",
  capabilities,
  ownsModel,
  availableIds: availableModelIds,
  providersOf,
  startSession: (ctx) => setModelRegistry(ctx.modelRegistry),
  buildArgs,
  environment,
  parseLine,
  describeUnsupported
};
