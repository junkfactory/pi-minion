import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Normalized per-adapter argv config. Raw JSON (base or user override)
// accepts either a bare string[] (args only) or an object with optional
// "args"/"preExec"; loadConfig normalizes both shapes here so consumers
// never branch. args = extra CLI argv appended after an adapter's
// built-in flags (before the task positional/`--`), no dedup. preExec =
// wrapper argv prefixed at spawn: spawn(preExec[0],
// [...preExec.slice(1), adapter.command, ...args]) with shell:false, so
// ["env","-u","AWS_PROFILE"] runs the adapter under env(1). Absent/empty
// preExec = spawn the adapter directly (today's behavior). The whole
// adapterArgs map is replaced wholesale by a user override.
export type AdapterArgs = { args: string[]; preExec: string[] };

export type MinionConfig = {
  // Model-id filter: { allowed?: string[]; blocked?: string[] }, symmetric
  // with providers. Entries are exact model ids or a trailing-'*' prefix
  // pattern ("gemini*" matches gemini-flash, gemini-pro, ...). blocked wins
  // over allowed; empty/absent allowed = no allowlist (every routable model
  // passes); empty/absent blocked = nothing blocked. Replaced wholesale by
  // user override.
  models?: { allowed?: string[]; blocked?: string[] };
  // Provider-level model filter: { allowed?: string[]; blocked?: string[] }
  // of provider names — "claude" (claude adapter), "antigravity" (agy), or
  // a pi catalog entry's provider ("opencode-go", "openai-codex", ...).
  // blocked wins over allowed; empty/absent allowed = no allowlist;
  // empty/absent blocked = nothing blocked. Applied to help_pi_minion's
  // list and to validateRequest, same hide-and-reject contract as
  // models.allowed/models.blocked. Replaced wholesale by user override.
  providers?: { allowed?: string[]; blocked?: string[] };
  allowedTools: string[];
  maxBudgetUsd: number;
  timeoutMs: number;
  pruneAfterDays?: number;
  maxOutputBytes?: number;
  maxResultPreviewBytes?: number;
  shortcut?: string;
  showGlyphs?: boolean;
  adapterArgs?: Record<string, AdapterArgs>;
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
  // The CLI reported the final turn failed (e.g. pi's message_end with
  // stopReason "error" carrying errorMessage): the run ends with no result
  // and this is the reason to surface in the job's failure text.
  | { kind: "error"; message: string }
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

// The boundary of the adapters/ subtree: this interface (plus the shared
// data types alongside it) is the ONLY thing published outside the adapter
// implementation files. CLI-specific implementations, caches, and live
// catalogs (claude.ts, agy.ts, pi.ts) must not leak beyond it — outside code
// goes through ./registry.ts and addresses adapters only via these members,
// never by importing a specific adapter module or naming a CLI.
// Adapters are FACTORIES instantiated with a MinionConfig (e.g.
// createClaudeAdapter(config)), never static objects — the config belongs to
// the closure so every predicate/method below is evaluated against it.
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
  // Does this adapter's CLI recognize/handle this model string, gated
  // against the config the adapter was instantiated with:
  // rawOwnsModel(model) plus the provider/model gates on that config. The
  // ungated, CLI-intrinsic claim lives in rawOwnsModel.
  ownsModel(model: string): boolean;
  // Ungated claim that this adapter's CLI recognizes/handles this model
  // string. Hardcoded per adapter (e.g. claude's short aliases + "claude-*"
  // ids) — a fact about the CLI, not a user-configurable knob, which is why
  // it lives in code rather than pi-minion.json. Config gating (providers /
  // models) is layered on top in ownsModel.
  rawOwnsModel(model: string): boolean;
  // Model strings this adapter contributes to help_pi_minion's "allow all"
  // universe: allowed∩rawOwns when models.allowed is non-empty, otherwise
  // the adapter's own enumeration of what's reasonable to suggest today,
  // both piped through the config-bound provider/model filter chain.
  availableModels(): string[];
  // Provider identities for this model string as this adapter routes it —
  // called only on the adapter that owns the model (registry claim order).
  // [] = unidentifiable (callers keep the model). Optional — adapters
  // without provider knowledge omit it.
  providersOf?(model: string): string[];
  // Called on every pi session_start so the adapter can capture or warm live
  // state from the session context (pi seeds its model registry; agy kicks
  // off a model-catalog refresh). Optional — adapters with only static
  // knowledge omit it. Callers iterate the host registry generically; no
  // caller names a specific CLI.
  startSession?(ctx: ExtensionContext): void;
  // Opportunistically refresh this adapter's live model catalog (subprocess
  // or registry lookup — the caller doesn't care) so model enumeration and
  // routing reflect the CLI's current offering. Resolves even when the
  // refresh fails (the adapter decides what a failure means for its own
  // cache). Optional — adapters with a static catalog omit it.
  refreshCatalog?(): Promise<void>;
  buildArgs(request: MinionRequest, config: MinionConfig): string[];
  environment(): NodeJS.ProcessEnv;
  parseLine(line: string): NormalizedEvent[];
  // Non-fatal warnings for a request/config combination this adapter can't
  // honor (e.g. an effort value it has no flag for). [] when nothing needs
  // flagging.
  describeUnsupported(request: MinionRequest, config: MinionConfig): string[];
}
