import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { formatTokenUsage } from "./agent.ui.js";
import type { ModelBreakdown, TokenCounts, UsageTotals } from "./adapters/types.js";
import { truncate } from "./adapters/util.js";

const MAX_TITLE_LENGTH = 48;

export type UsageFields = Partial<Omit<UsageTotals, "perModel">>;

// Flattens a job's final usage into the fields both the posted frontmatter
// and the result message's details carry.
export function usageFields(usage: UsageTotals | undefined): UsageFields {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    totalCostUsd: usage?.totalCostUsd
  };
}

// A workflow's distinct step models, comma-joined, for log lines.
export function distinctModels(steps: ReadonlyArray<{ model: string }>): string {
  return [...new Set(steps.map((step) => step.model))].join(",");
}

// A CLI's final usage totals in the widget's TokenCounts shape.
export function tokenCountsFromUsage(usage: UsageTotals): TokenCounts {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheWrite: usage.cacheWriteTokens,
    cacheRead: usage.cacheReadTokens
  };
}

export function deriveJobTitle(task: string, maxLength = MAX_TITLE_LENGTH): string {
  const firstLine = task.trim().split(/\r?\n/)[0] ?? "";
  const stripped = firstLine.replace(/[`*_#>]/g, "").trim();
  return stripped ? truncate(stripped, maxLength) : "pi minion task";
}

const THINKING_QUIPS: Record<string, string> = {
  low: "barely trying...",
  medium: "mid, and proud of it...",
  high: "putting in real work this time...",
  xhigh: "overthinking, on purpose...",
  max: "shopping for Louis Vuitton bags..."
};

export function thinkingPlaceholder(effort: string | undefined): string {
  if (!effort) return "Thinking... or am I? No idea how hard, actually...";
  const quip = THINKING_QUIPS[effort];
  return quip ? `Thinking in ${effort} effort — ${quip}` : `Thinking in ${effort}...`;
}

export function describeJobResult(outcome: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  exceededOutputLimit: boolean;
  finalResult: string | undefined;
  stderrTail: string;
  stdoutPath: string;
  // The adapter's rawOutputHint — how to read stdoutPath's format.
  rawOutputHint: string;
}): string {
  // Both partial-output cases point at stdoutPath instead of reading it back
  // and inlining what could be megabytes of recovered text into the caller's
  // context — they can grep/read it themselves if they need it.
  const partialOutputHint = `Output captured before the cutoff is at ${outcome.stdoutPath} — ${outcome.rawOutputHint} Read it directly if you need the partial output.`;
  if (outcome.exceededOutputLimit) {
    return `Pi minion stopped because its output exceeded the configured limit before finishing. ${partialOutputHint}`;
  }
  if (outcome.timedOut) {
    // A killed `claude` process typically self-reports as exit code
    // 128+SIGTERM(15)=143 with no stderr, rather than surfacing as a
    // Node-level signal — checking timedOut explicitly (set when the
    // config.timeoutMs timer fires) is what distinguishes this from a
    // generic non-zero exit below.
    return `Pi minion timed out before finishing and was stopped. ${partialOutputHint}`;
  }
  if (outcome.code === 0) {
    return outcome.finalResult ?? "Pi minion finished without a result event.";
  }
  const failureHeader = `Pi minion failed (exit ${outcome.code ?? "unknown"}${
    outcome.signal ? `, signal ${outcome.signal}` : ""
  }).${outcome.stderrTail ? `\n${outcome.stderrTail}` : ""}`;
  // A result event can still arrive before a later non-zero exit (e.g. the
  // minion reported its final answer, then crashed during cleanup) — surface
  // it rather than discarding it, but flag it since a failing exit means the
  // run didn't complete cleanly and the result may not reflect finished work.
  return outcome.finalResult
    ? `${failureHeader}\n\n**Note:** a result was captured before the failure; it may be incomplete.\n\n${outcome.finalResult}`
    : failureHeader;
}

export function formatCostUsd(totalCostUsd: number | undefined): string {
  return totalCostUsd === undefined ? "n/a" : `$${totalCostUsd.toFixed(4)}`;
}

// Renders a "(claude-haiku-4-5-20251001 37.0K + claude-sonnet-5 10.0K)" suffix, largest contributor
// first, so a run that quietly delegated to another model is visible right
// next to the total it fed into. Omitted for a single-model run — the
// breakdown would just repeat the total field.
export function formatModelBreakdown(
  perModel: ModelBreakdown[] | undefined,
  getValue: (entry: ModelBreakdown) => number,
  formatValue: (value: number) => string
): string {
  if (!perModel || perModel.length < 2) return "";
  const parts = [...perModel]
    .sort((a, b) => getValue(b) - getValue(a))
    .map((entry) => `${entry.model} ${formatValue(getValue(entry))}`);
  return ` (${parts.join(" + ")})`;
}

// Same convention as formatModelBreakdown above, but each model gets the
// full ↑/↓/→/← breakdown (a single number per model wouldn't say anything
// useful — see formatTokenUsage) rather than one value; sorted by each
// model's combined token count, largest first.
export function formatTokenModelBreakdown(
  perModel: ModelBreakdown[] | undefined
): string {
  if (!perModel || perModel.length < 2) return "";
  const combined = (entry: ModelBreakdown) =>
    entry.inputTokens + entry.outputTokens + entry.cacheWriteTokens + entry.cacheReadTokens;
  const parts = [...perModel]
    .sort((a, b) => combined(b) - combined(a))
    .map(
      (entry) =>
        `${entry.model} ${formatTokenUsage(entry.inputTokens, entry.outputTokens, entry.cacheWriteTokens, entry.cacheReadTokens)}`
    );
  return ` (${parts.join(" + ")})`;
}

// Prepended to every completion message regardless of outcome (success,
// failure, timeout, output-limit, spawn error) — tokens/cost are only known
// when the minion process exited on its own and emitted a final `result` event
// (see streamedUsage), so they read "n/a" when it was killed before getting
// there.
export function formatJobFrontmatter(
  params: UsageFields & {
    jobId: string;
    agent: string;
    model: string;
    effort?: string;
    perModel?: ModelBreakdown[];
    maxBudgetUsd: number;
    jobDir: string;
    // Only set when the minion's full result was actually written to disk
    // (the clean-exit, non-empty-result path) — omitted for timeouts,
    // output-limit kills, and spawn errors, none of which produce a result.md.
    reportPath?: string;
    // "<workflow title> › <step id>"; set only for workflow steps.
    step?: string;
  }
): string {
  return [
    `# Pi Minion: ${params.agent}`,
    "---",
    `model: ${params.model}${params.effort ? ` (${params.effort})` : ""}`,
    `job_id: ${params.jobId}`,
    ...(params.step ? [`step: ${params.step}`] : []),
    `token_usage: ${formatTokenUsage(params.inputTokens, params.outputTokens, params.cacheWriteTokens, params.cacheReadTokens)}${formatTokenModelBreakdown(params.perModel)}`,
    // "$" escaped: pi-tui reads an unpaired "$" as still-streaming inline
    // LaTeX and prints the rest of the paragraph raw, report link included.
    `cost_usd: ${formatCostUsd(params.totalCostUsd)}${formatModelBreakdown(params.perModel, (entry) => entry.costUsd, (n) => formatCostUsd(n))}`.replaceAll("$", "\\$"),
    `budget_usd: \\$${params.maxBudgetUsd}`,
    `output_path: ${params.jobDir}`,
    // A markdown link so pi's renderer makes it clickable (OSC 8). Only the
    // filename shows — its directory is output_path, right above.
    ...(params.reportPath ? [`report: [${basename(params.reportPath)}](${pathToFileURL(params.reportPath).href})`] : []),
    "",
    // A blank line must separate the last field from this closing fence — a
    // "---" directly under a paragraph with no gap is CommonMark's setext
    // heading syntax, so without it markdown renderers turn every field
    // above into a bolded H2 instead of leaving them as plain text. The
    // heading above is unaffected: an ATX "# ..." heading is a complete
    // block on its own, so the "---" right after it is always a plain rule.
    "---"
  ].join("\n");
}

// Only the clean-exit path inlines its full result into the primary
// session's context (the other outcomes already point at stdoutPath
// instead) — so it's the one that needs a size cap of its own. Line-based
// display (matching how a Read tool reports its own truncation) so the
// "offset" in the notice is directly usable against resultPath; byte-based
// cutoff (matching maxOutputBytes' reasoning) since that's what actually
// costs the caller context.
export function truncateResultForContext(
  text: string,
  resultPath: string,
  maxBytes: number
): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const lines = text.split(/\r?\n/);
  let bytes = 0;
  let shown = 0;
  while (shown < lines.length) {
    const lineBytes = Buffer.byteLength(lines[shown] + "\n");
    if (shown > 0 && bytes + lineBytes > maxBytes) break;
    bytes += lineBytes;
    shown++;
  }
  const kb = (maxBytes / 1000).toFixed(1);
  const preview = lines.slice(0, shown).join("\n");
  return [
    `[Showing lines 1-${shown} of ${lines.length} (${kb}KB limit). Use offset=${shown + 1} to continue.]`,
    preview,
    `[Truncated: ${shown} lines shown (${kb}KB limit). Full result at ${resultPath} — read it directly from offset=${shown + 1} for the rest.]`
  ].join("\n");
}
