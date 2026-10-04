export type MinionConfig = {
  allowedModels: string[];
  allowedTools: string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  pruneAfterDays?: number;
  maxOutputBytes?: number;
  maxResultPreviewBytes?: number;
  shortcut?: string;
  showGlyphs?: boolean;
};

export type MinionRequest = {
  task: string;
  workspace: string;
  model: string;
  // Required in practice: validateRequest() rejects a request without one.
  // The schema fallback days are gone — pi-minion.json no longer carries a
  // defaultEffort, so the caller always picks the level that fits the task.
  effort: string;
  context?: string;
  maxBudgetUsd?: number;
};

export type ModelBreakdown = {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export type TokenCounts = { input: number; output: number; cacheWrite: number; cacheRead: number };

export type UsageTotals = {
  // undefined for a CLI that reports tokens but exposes no cost concept at
  // all (e.g. agy) — formatCostUsd already renders that as "n/a".
  totalCostUsd: number | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  perModel: ModelBreakdown[];
};

// The normalized shape every adapter's parseLine() must reduce its CLI's own
// wire format down to, so job-runner.ts's job-orchestration code never branches on
// a specific CLI's JSON shape. Returned as an array: a single stdout line can
// legitimately produce zero, one, or more than one event (e.g. a
// permission-denial substring match is independent of whatever else that
// same line also parses as).
export type NormalizedEvent =
  | { kind: "permissionDenied" }
  | { kind: "result"; result: string }
  // The concrete model id the CLI resolved the requested alias to (e.g.
  // "opus" -> "claude-opus-5-5"), reported once at session start.
  | { kind: "model"; model: string }
  | { kind: "usage"; usage: UsageTotals }
  | { kind: "usageDelta"; delta: TokenCounts }
  | { kind: "textBlockStart" }
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | { kind: "toolUse"; id: string; name: string; args?: Record<string, unknown> }
  | { kind: "toolUseArgs"; id: string; args: Record<string, unknown> }
  | { kind: "toolResult"; id: string; durationMs?: number; output?: string; isError: boolean };

export type AdapterCapabilities = {
  supportsAllowedTools: boolean;
  supportsEffort: boolean;
  supportsMaxBudgetUsd: boolean;
};

export interface AgentCliAdapter {
  readonly name: string;
  // The binary to spawn (e.g. "claude"/"agy") — a CLI-intrinsic fact, same
  // rationale as ownsModel, not a pi-minion.json knob.
  readonly command: string;
  // One-line human blurb, e.g. "Anthropic's Claude Code CLI".
  readonly description: string;
  // One-line instruction shown when `command` isn't found on PATH.
  readonly installHint: string;
  // How to find the assistant text in this CLI's raw stdout.json — shown
  // when a job is cut off (timeout/output limit) before a result arrived.
  readonly rawOutputHint: string;
  // Warning appended to the result when parseLine emitted permissionDenied,
  // naming this CLI's own denial mechanism.
  readonly permissionDeniedWarning: string;
  readonly capabilities: AdapterCapabilities;
  // Does this adapter's CLI recognize/handle this model string? Hardcoded per
  // adapter (e.g. claude's short aliases + "claude-*" ids) — a fact about the
  // CLI, not a user-configurable knob, which is why it lives in code rather
  // than pi-minion.json.
  ownsModel(model: string): boolean;
  buildArgs(request: MinionRequest, config: MinionConfig): string[];
  environment(): NodeJS.ProcessEnv;
  parseLine(line: string): NormalizedEvent[];
  // Non-fatal warnings for a request/config combination this adapter can't
  // honor (e.g. an effort value it has no flag for). [] when nothing needs
  // flagging.
  describeUnsupported(request: MinionRequest, config: MinionConfig): string[];
}
