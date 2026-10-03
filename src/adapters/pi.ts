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
import { MINION_PROMPT_BASE, resolveTaskText, sumFields } from "./util.js";

const MODEL_ALIASES: Record<string, string> = {
  // Latest version per family as of 2026-10 — re-check `pi --list-models`
  // periodically; same staleness risk as agy.ts's MODEL_ALIASES.
  luna: "gpt-6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-6.1-sol",
  astra: "gpt-6-astra"
};

// pi is a multi-provider router: besides the aliases above, "gpt-<digit>"
// covers its openai-codex models (gpt-6-luna, gpt-5.6-terra, …) without
// colliding with agy's "gpt-oss", and any explicit "provider/id" (e.g.
// "openai-codex/gpt-6-sol") is pi's own --model syntax, which no other
// adapter accepts.
export function ownsModel(model: string): boolean {
  return model in MODEL_ALIASES || /^gpt-\d/i.test(model) || model.includes("/");
}

function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
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
    resolveModelId(request.model),
    "--thinking",
    request.effort ?? config.defaultEffort,
    "--append-system-prompt",
    MINION_PROMPT_BASE,
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
  buildArgs,
  environment,
  parseLine,
  describeUnsupported
};
