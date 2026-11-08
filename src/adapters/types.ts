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
  // with providers. Entries are minimatch globs, matched case-insensitively
  // ("gemini*" matches gemini-flash, gemini-pro, ...; "*" does not cross
  // "/"; negation is off). blocked wins
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
  // Optional turn cap applied to every run that omits MinionRequest.maxTurns;
  // absent = unlimited (no constant default). Bounds 1..100000, validated at
  // load like every other field. Absence stays undefined end to end.
  maxTurns?: number;
  pruneAfterDays?: number;
  maxOutputBytes?: number;
  maxResultPreviewBytes?: number;
  // Caps the result body of the model-facing completion message (the
  // display entry keeps maxResultPreviewBytes and never reaches the
  // model). 0 posts a pointer to result.md with no body.
  maxResultContextBytes?: number;
  shortcut?: string;
  showGlyphs?: boolean;
  adapterArgs?: Record<string, AdapterArgs>;
  // User-authored usage notes appended last into help_pi_minion's usage
  // notes; each entry renders as one line. Replaced wholesale by the user
  // override (same as every top-level config key; see applyConfigOverride
  // in config.ts).
  usageNotes?: string[];
  // Model-selection routing table: task-responsibility label ->
  // { first, fallback } model family patterns. Merged additively with the
  // bundled defaults (per-key deep merge) — see readPromptConfigSync in
  // config.ts. Purely policy: rendered into run_pi_minion's prompt
  // guidelines, not validated beyond shape.
  routingTable?: Record<string, { first: string; fallback: string }>;
  // Cost gate: model-family globs that require user approval before a
  // minion launches with a matching model, unless the user names the model
  // explicitly. Wholesale override (same as every other top-level key).
  costGate?: string[];
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
  // Idle limit for this run in milliseconds: the run is stopped only after it
  // has produced no stdout output for this long (an idle backstop, not a
  // wall-clock budget). Overrides config.timeoutMs when set; validateRequest()
  // rejects 0, negative, and non-finite values.
  timeoutMs?: number;
  // Cap on assistant turns for this run. Omitted = unlimited (the default):
  // an open-ended task shouldn't be cut short by a guess, so a cap is only
  // imposed when the caller names one. validateRequest() rejects anything
  // outside 1..100000. Enforced by the runner's own turn count, not by a
  // CLI's native flag (claude's --max-turns re-arms per queued stdin frame).
  // null = "pinned no cap": the cap was resolved when this request was built
  // (a schedule pins step ?? workflow ?? config at creation), so the runner
  // must NOT fall back to the then-current config.maxTurns.
  maxTurns?: number | null;
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
  | { kind: "toolResult"; id: string; durationMs?: number; output?: string; isError: boolean }
  // A new assistant turn started — the unit a turn cap counts and the
  // boundary a steering channel queues against. No payload; the runner keeps
  // its own count.
  | { kind: "turnStart" }
  // The child has no automatic work left (no retry, queued follow-up, or
  // compaction retry pending) — completion, not merely the last result line.
  // aborted is true only when the CLI says the run ended aborted; undefined
  // when the adapter's CLI carries no such field.
  | { kind: "runSettled"; aborted?: boolean };

// Per-run scratch a parser may need to keep across stdout lines — the turnStart
// dedupe both claude.ts (an assistant message id) and agy.ts (an agent_response
// step index) use. The run's owner (job-runner.ts) creates one per job and threads
// it through every parseLine call, so two concurrent jobs sharing a single
// adapter instance never share parse state. Omitted (a replay of stored lines,
// as modal.ts's backfill does) = no cross-line memory, which is safe because
// no replayer counts turns.
export type AdapterParseState = {
  // The assistant response currently counted as the open turn (claude: the id
  // of its assistant message, which the consolidated "assistant" line repeats;
  // agy: the id of its agent_response step), cleared once that response reports
  // DONE where the CLI says so.
  openTurnId?: string;
};

export type AdapterCapabilities = {
  supportsAllowedTools: boolean;
  supportsEffort: boolean;
  supportsMaxBudgetUsd: boolean;
  // Does this adapter emit turnStart for each assistant turn its CLI's stream
  // exposes? Optional (false by omission) so a stand-in adapter — a test
  // double or the no-op fallback for an unregistered job — declares nothing
  // rather than claiming a turn boundary it never parses.
  emitsTurnEvents?: boolean;
  // Where runSettled comes from. "event": the CLI reports run completion
  // itself (pi's agent_settled, claude's terminal result). "endOfStream":
  // the CLI has no completion event, so the run is only verifiably over when
  // its one-shot output ends — the adapter emits it on that terminal line.
  // Undefined: never emitted.
  runSettledSource?: "event" | "endOfStream";
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
  // The task frame this CLI reads from stdin, newline-terminated. Present =
  // the runner spawns with stdin as a pipe, writes this line, and keeps the
  // channel open for steering writes; absent = the task travels in argv (see
  // buildArgs) and stdin stays closed. Owning the wire format here keeps
  // job-runner.ts free of CLI-specific framing.
  stdinPrompt?(request: MinionRequest): string;
  // The command frame that makes this CLI abandon its in-flight run (the turn
  // cap's stop). Absent = no command channel: the runner falls back to
  // stopping the process by signal.
  capStopFrame?(): string;
  // A mid-run steering message as this CLI's own stdin frame. `steer` lands
  // at the next turn boundary; `followUp` waits until the agent has no work
  // left. Absent = this adapter has no steering channel and the caller must
  // reject the request rather than guess a frame.
  steerFrame?(message: string, deliverAs: "steer" | "followUp"): string;
  environment(): NodeJS.ProcessEnv;
  parseLine(line: string, state?: AdapterParseState): NormalizedEvent[];
  // Non-fatal warnings for a request/config combination this adapter can't
  // honor (e.g. an effort value it has no flag for). [] when nothing needs
  // flagging.
  describeUnsupported(request: MinionRequest, config: MinionConfig): string[];
  // What the CALLING agent must do about the limits describeUnsupported
  // states — the actionable half, rendered as a Policy line above the result.
  // Optional: an adapter with nothing to advise omits it, and a caller that
  // asks for policy gets [].
  describePolicy?(request: MinionRequest, config: MinionConfig): string[];
  // Statically known capability notes for this adapter, appended into
  // help_pi_minion's usageNotes (request-free — unlike describeUnsupported,
  // this is always surfaced, not only on a run). [] when the adapter has no
  // special capabilities to advertise. Pipelines through the registry: an
  // unregistered adapter contributes nothing.
  usageNotes(): string[];
}
