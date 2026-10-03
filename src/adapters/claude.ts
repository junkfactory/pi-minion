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

// Exact wording from the `claude` CLI binary (v2.1.236), not a documented
// contract. A future CLI upgrade can reword this and silently break
// detection; re-verify against the installed binary after upgrading.
const PERMISSION_DENIAL_MARKER = "denied by the Claude Code auto mode classifier";

const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function ownsModel(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(model) || /^claude-/i.test(model);
}

export function buildArgs(request: MinionRequest, config: MinionConfig): string[] {
  const task = resolveTaskText(request);
  return [
    "-p",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "auto",
    ...(config.allowedTools.length
      ? ["--allowedTools", ...config.allowedTools]
      : []),
    "--model",
    request.model,
    "--max-budget-usd",
    String(request.maxBudgetUsd ?? config.maxBudgetUsd),
    "--append-system-prompt",
    MINION_PROMPT_BASE,
    ...(request.effort ? ["--effort", request.effort] : []),
    task
  ];
}

export function environment(): NodeJS.ProcessEnv {
  const names = ["ANTHROPIC_API_KEY", "HOME", "LANG", "PATH", "TERM", "USER"];
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : []
    )
  );
}

export function streamedResult(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; result?: unknown };
    if (parsed.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch {
    // Ignore malformed stream output; it remains available in stdout.json.
  }
}

// The session's `system`/`init` line carries the concrete model id the
// `--model` alias resolved to.
export function initModel(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; subtype?: unknown; model?: unknown };
    if (parsed.type === "system" && parsed.subtype === "init" && typeof parsed.model === "string") {
      return parsed.model;
    }
  } catch {
    // Ignore malformed stream output; it remains available in stdout.json.
  }
}

// Only the terminal `result` event carries total_cost_usd/usage for the whole
// run — per-turn assistant messages carry their own delta usage, not the run
// total — so this fires at most once per job, same as streamedResult above.
//
// total_cost_usd itself already aggregates every model actually billed for
// the run (see modelUsage below), including any Task-tool subagent the minion
// spawned internally — but the top-level `usage` object only reflects the
// outermost turn's own tokens, not a subagent's. Summing tokens from
// modelUsage instead keeps totalTokens in the same scope as totalCostUsd;
// otherwise a run that delegates heavily to a subagent (e.g. a "researcher"
// persona doing many web searches) shows a cost wildly disproportionate to
// the displayed token count. Falls back to the top-level `usage` sum when
// modelUsage is absent (older CLI versions).
export function streamedUsage(line: string): UsageTotals | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      total_cost_usd?: unknown;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
        cache_read_input_tokens?: unknown;
      };
      modelUsage?: Record<
        string,
        {
          inputTokens?: unknown;
          outputTokens?: unknown;
          cacheReadInputTokens?: unknown;
          cacheCreationInputTokens?: unknown;
          costUSD?: unknown;
        }
      >;
    };
    if (parsed.type !== "result" || typeof parsed.total_cost_usd !== "number") {
      return undefined;
    }
    const modelUsage = parsed.modelUsage ?? {};
    const modelUsageEntries = Object.entries(modelUsage);
    const perModel: ModelBreakdown[] = modelUsageEntries.map(([model, entry]) => ({
      model,
      costUsd: typeof entry.costUSD === "number" ? entry.costUSD : 0,
      inputTokens: sumFields([entry.inputTokens]),
      outputTokens: sumFields([entry.outputTokens]),
      cacheWriteTokens: sumFields([entry.cacheCreationInputTokens]),
      cacheReadTokens: sumFields([entry.cacheReadInputTokens])
    }));
    const inputTokens = modelUsageEntries.length
      ? sumFields(modelUsageEntries.map(([, entry]) => entry.inputTokens))
      : sumFields([parsed.usage?.input_tokens]);
    const outputTokens = modelUsageEntries.length
      ? sumFields(modelUsageEntries.map(([, entry]) => entry.outputTokens))
      : sumFields([parsed.usage?.output_tokens]);
    const cacheWriteTokens = modelUsageEntries.length
      ? sumFields(modelUsageEntries.map(([, entry]) => entry.cacheCreationInputTokens))
      : sumFields([parsed.usage?.cache_creation_input_tokens]);
    const cacheReadTokens = modelUsageEntries.length
      ? sumFields(modelUsageEntries.map(([, entry]) => entry.cacheReadInputTokens))
      : sumFields([parsed.usage?.cache_read_input_tokens]);
    return {
      totalCostUsd: parsed.total_cost_usd,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      perModel
    };
  } catch {
    return undefined;
  }
}

// One `message_delta` stream event fires per completed message, carrying
// that message's finalized (not a running total, not a noisy snapshot —
// see streamedUsage's header comment for why the "assistant" event type is
// unusable here) usage delta. Summing this across every message_delta seen
// so far reproduces streamedUsage's own totals exactly by the time the job
// ends — verified against a real job log — except for any hidden internal
// call (e.g. the auto-mode permission classifier) that never emits a
// visible stream event, so a live sum can slightly undercount the eventual
// total.
export function streamedMessageDeltaTokens(
  line: string
): TokenCounts | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      event?: {
        type?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
        };
      };
    };
    if (parsed.type !== "stream_event" || parsed.event?.type !== "message_delta") {
      return undefined;
    }
    const usage = parsed.event.usage;
    return {
      input: sumFields([usage?.input_tokens]),
      output: sumFields([usage?.output_tokens]),
      cacheWrite: sumFields([usage?.cache_creation_input_tokens]),
      cacheRead: sumFields([usage?.cache_read_input_tokens])
    };
  } catch {
    return undefined;
  }
}

export function streamedText(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      event?: { delta?: { type?: unknown; text?: unknown } };
    };
    const delta = parsed.event?.delta;
    if (
      parsed.type === "stream_event" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      return delta.text;
    }
  } catch {
    // Ignore malformed stream output; it remains available in stdout.json.
  }
}

export function isThinkingDelta(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      event?: { delta?: { type?: unknown } };
    };
    return parsed.type === "stream_event" && parsed.event?.delta?.type === "thinking_delta";
  } catch {
    // Ignore malformed stream output; it remains available in stdout.json.
    return false;
  }
}

// True at the start of a new "text" content block — i.e. a new assistant text
// turn, as opposed to a text_delta continuing the current one. Adjacent text
// blocks (separated by tool_use blocks / message boundaries in between) don't
// carry their own whitespace seam, so callers use this to insert one.
export function isTextBlockStart(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      event?: { type?: unknown; content_block?: { type?: unknown } };
    };
    return (
      parsed.type === "stream_event" &&
      parsed.event?.type === "content_block_start" &&
      parsed.event?.content_block?.type === "text"
    );
  } catch {
    return false;
  }
}

// True at the start of a tool call — a `content_block_start` for a
// "tool_use" block — returning the tool's id and name (e.g. "Bash", "Read").
// Distinct from isTextBlockStart/isThinkingDelta: a minion job can spend
// minutes here (reading files, running commands) with no text_delta or
// thinking_delta at all, which otherwise leaves the widget/modal frozen on
// whatever they last showed. `input` is always `{}` on this event — the
// fully-parsed args only show up later, on the consolidated "assistant"
// message (see toolUseArgs below).
export function toolUseStarted(line: string): { id: string; name: string } | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      event?: { type?: unknown; content_block?: { type?: unknown; id?: unknown; name?: unknown } };
    };
    const block = parsed.event?.content_block;
    if (
      parsed.type === "stream_event" &&
      parsed.event?.type === "content_block_start" &&
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      return { id: block.id, name: block.name };
    }
  } catch {
    // Ignore malformed stream output; it remains available in stdout.json.
  }
}

// The CLI emits a consolidated, non-streaming "assistant" message once a
// turn's content blocks finish streaming, repeating each tool_use block from
// that turn — this time with its `input` fully parsed (unlike the empty
// `{}` on toolUseStarted's content_block_start). Reading this instead of
// accumulating `input_json_delta` chunks keeps this adapter stateless.
export function toolUseArgs(line: string): Array<{ id: string; args: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      message?: { content?: Array<{ type?: unknown; id?: unknown; input?: unknown }> };
    };
    if (parsed.type !== "assistant") return [];
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) =>
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.input === "object" &&
      block.input !== null &&
      Object.keys(block.input).length > 0
        ? [{ id: block.id, args: block.input as Record<string, unknown> }]
        : []
    );
  } catch {
    return [];
  }
}

// A tool call's result arrives as a "user" message carrying one or more
// tool_result blocks, correlated back to toolUseStarted's id via
// tool_use_id. `content` is usually a plain string but can also be an array
// (e.g. ToolSearch's tool_reference entries) — stringified rather than
// special-cased per tool.
export function toolResults(
  line: string
): Array<{ id: string; output?: string; isError: boolean }> {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      message?: {
        content?: Array<{
          type?: unknown;
          tool_use_id?: unknown;
          content?: unknown;
          is_error?: unknown;
        }>;
      };
    };
    if (parsed.type !== "user") return [];
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block?.type === "tool_result" && typeof block.tool_use_id === "string")
      .map((block) => ({
        id: block.tool_use_id as string,
        output:
          typeof block.content === "string"
            ? block.content
            : block.content !== undefined
              ? JSON.stringify(block.content)
              : undefined,
        isError: block.is_error === true
      }));
  } catch {
    return [];
  }
}

export function parseLine(line: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (line.includes(PERMISSION_DENIAL_MARKER)) events.push({ kind: "permissionDenied" });
  const result = streamedResult(line);
  if (result !== undefined) events.push({ kind: "result", result });
  const model = initModel(line);
  if (model) events.push({ kind: "model", model });
  const usage = streamedUsage(line);
  if (usage !== undefined) events.push({ kind: "usage", usage });
  const delta = streamedMessageDeltaTokens(line);
  if (delta !== undefined) events.push({ kind: "usageDelta", delta });
  if (isTextBlockStart(line)) events.push({ kind: "textBlockStart" });
  const text = streamedText(line);
  if (text) {
    events.push({ kind: "text", text });
  } else if (isThinkingDelta(line)) {
    events.push({ kind: "thinking" });
  }
  const toolStart = toolUseStarted(line);
  if (toolStart) events.push({ kind: "toolUse", id: toolStart.id, name: toolStart.name });
  for (const { id, args } of toolUseArgs(line)) events.push({ kind: "toolUseArgs", id, args });
  for (const toolResult of toolResults(line)) events.push({ kind: "toolResult", ...toolResult });
  return events;
}

const capabilities: AdapterCapabilities = {
  supportsAllowedTools: true,
  supportsEffort: true,
  supportsMaxBudgetUsd: true
};

export function describeUnsupported(_request: MinionRequest, _config: MinionConfig): string[] {
  return [];
}

export const claudeAdapter: AgentCliAdapter = {
  name: "Claude",
  command: "claude",
  description: "Anthropic's Claude Code CLI",
  installHint: "see https://code.claude.com/docs/en/setup.md for installation instructions",
  rawOutputHint:
    'raw stream-json, one JSON object per line; assistant text is in "stream_event" lines under event.delta.text where delta.type is "text_delta".',
  permissionDeniedWarning:
    "one or more actions were denied by the auto-mode permission classifier during this run; the result below may be incomplete.",
  capabilities,
  ownsModel,
  buildArgs,
  environment,
  parseLine,
  describeUnsupported
};
