/**
 * Live in-flight status widget, snapshot job picker, and scrollable detail
 * modal for a Pi extension that runs background jobs. See pi-minion's
 * README.md for the extension's overall shape; this header is the "how
 * do I wire this up" version for a fresh caller.
 *
 * One `JobUI` instance (from `createJobUI(ctx)`) should be shared across an
 * extension's whole session — it owns the single `aboveEditor` widget key,
 * the live job registry, and the single "at most one modal open" reference.
 * Create it lazily on first use (e.g. inside a tool's `execute()`, not at
 * the extension-factory top level) since it needs an `ExtensionContext`,
 * which isn't available until then.
 *
 * Call sites, matching where pi-minion's job-runner.ts/tools.ts/modal.ts call each method:
 *
 * - Job lifecycle (wherever a job's status changes):
 *   - `setJob(id, status)` on start, and again on every streamed update —
 *     it both (re)registers the widget on first use and refreshes it.
 *   - `appendModalText(id, chunk)`/`startModalTextBlock(id)` alongside each
 *     streamed text event, and `startModalToolCall`/`updateModalToolCallArgs`/
 *     `finishModalToolCall` alongside each tool-call event. All are no-ops
 *     unless a modal is currently open for that id.
 *   - `clearJob(id)` and `finishModalJob(id)` on process close/error. The
 *     first drops the job from the live widget/picker; the second marks an
 *     already-open modal for this id "finished" without closing it — a
 *     modal stays open and scrollable after its job completes until the
 *     user closes it themselves.
 * - Command handler (e.g. `pi.registerCommand("pi-minions", ...)`):
 *   - `const id = await pick()` — undefined if the user cancelled or no
 *     jobs are running (in which case `pick()` itself calls
 *     `ctx.ui.notify(...)`, so the caller doesn't need its own empty check).
 *   - `if (id) openModal(id, { title, model, prompt })`, then replay a
 *     finished job's stored events (e.g. read from disk) through the same
 *     mutator methods above to backfill its blocks in order — this module
 *     has no opinion on where a job's full output lives.
 * - `dispose()` on session teardown (e.g. a `session_shutdown` handler) —
 *   stops the spinner interval and removes the widget if one is mounted.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI
} from "@earendil-works/pi-tui";
import type { TokenCounts } from "./adapters/types.js";
import { truncate } from "./adapters/util.js";

export type JobStatusUpdate = {
  title: string;
  model: string;
  effort: string;
  startedAt: number;
  previewLine?: string;
  tokenUsage?: TokenCounts;
  // Set for a finished step's row: elapsed stops here instead of ticking.
  finishedAt?: number;
};

// What a finished step's row keeps from its job, so it reads like the live
// row did: tokens, and elapsed time frozen at finishedAt.
export type StepRunStats = { startedAt: number; finishedAt: number; tokenUsage?: TokenCounts };

export type WorkflowStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

// A workflow's tree in the widget. A running step's live row is looked up
// by `jobId` in the job registry, so it nests here instead of top-level.
export type WorkflowWidgetStatus = {
  title: string;
  startedAt: number;
  stage: number;
  stages: number;
  steps: Array<{
    id: string;
    status: WorkflowStepStatus;
    model: string;
    effort: string;
    jobId?: string;
  } & Partial<StepRunStats>>;
};

// Shared with format.ts's posted-result frontmatter so both the live widget
// and the final report use identical units — 1 decimal, always "K", "n/a"
// when unknown.
export function formatTokenCount(tokens: number | undefined): string {
  return tokens === undefined ? "n/a" : `${(tokens / 1000).toFixed(1)}K`;
}

// input/output are fresh generation; cacheWrite/cacheRead are priced very
// differently from each other and from input/output, so a single combined
// total is a poor "rough cost" signal — this breaks it into the four
// categories the underlying CLI itself bills separately.
export function formatTokenUsage(
  input: number | undefined,
  output: number | undefined,
  cacheWrite: number | undefined,
  cacheRead: number | undefined
): string {
  return `↑${formatTokenCount(input)} ↓${formatTokenCount(output)} →${formatTokenCount(cacheWrite)} ←${formatTokenCount(cacheRead)}`;
}

export interface JobUI {
  /**
   * Hand this JobUI a fresh ctx (e.g. from the current tool/command call, or
   * a `session_start` event) — every prior ctx becomes invalid the moment
   * its session is replaced by /reload, /new, fork, or switchSession. If
   * jobs are still tracked, this also re-registers the widget immediately
   * in case an earlier registration attempt silently failed against a now
   * stale ctx.
   */
  setCtx(ctx: ExtensionContext): void;
  /** Widget: create or update a job's row. Starts the widget/timers on the first call. */
  setJob(id: string, status: JobStatusUpdate): void;
  /** Widget: remove a job's row on completion — stops timers once the registry empties. */
  clearJob(id: string): void;
  /** Widget: create or update a workflow's tree. Mirrors setJob. */
  setWorkflow(id: string, status: WorkflowWidgetStatus): void;
  /** Widget: remove a workflow's tree — stops timers once jobs and workflows are both empty. */
  clearWorkflow(id: string): void;
  /**
   * Picker: static "title - model" snapshot of the current registry, via
   * ctx.ui.select(), followed by any caller-supplied `extra` rows (e.g.
   * schedules). Resolves to the chosen job id or extra id.
   */
  pick(extra?: Array<{ id: string; label: string }>): Promise<string | undefined>;
  /**
   * Modal: open the detail view for a job (called after `pick()` resolves).
   * `text`, if given, seeds the modal's first text block — backfilling a
   * reopened job's tool-call rows (not just its text) requires replaying
   * events via the methods below instead.
   */
  openModal(
    id: string,
    initial: { title: string; model: string; prompt: string; text?: string; effort?: string }
  ): void;
  /** Modal: feed a streamed text chunk to the open modal, if one is open for this id. No-op otherwise. */
  appendModalText(id: string, text: string): void;
  /** Modal: force a new text-block boundary. No-op if nothing has been emitted yet, or no modal is open for this id. */
  startModalTextBlock(id: string): void;
  /** Modal: append a new (running) tool-call row. No-op unless a modal is open for this id. */
  startModalToolCall(id: string, toolCallId: string, name: string): void;
  /** Modal: fill in a tool call's arguments once known. No-op if that tool call isn't tracked. */
  updateModalToolCallArgs(id: string, toolCallId: string, args: Record<string, unknown>): void;
  /** Modal: mark a tool call finished with its result. No-op if that tool call isn't tracked. */
  finishModalToolCall(
    id: string,
    toolCallId: string,
    result: { durationMs?: number; output?: string; isError: boolean }
  ): void;
  /** Modal: replace the header's model alias with the CLI-reported model id. No-op unless a modal is open for this id. */
  setModalModel(id: string, model: string): void;
  /** Modal: mark the open modal's job finished, if one is open for this id. No-op otherwise; does not close it. */
  finishModalJob(id: string): void;
  /** Tear down widget/timers. */
  dispose(): void;
}

const DEFAULT_WIDGET_KEY = "pi-minion-jobs";
const DEFAULT_MAX_WIDGET_LINES = 12;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
// Must match overlayOptions.maxHeight below — duplicated here because render(width)
// isn't told the resolved height, only width; see modal-sizing note on openModal().
const MODAL_HEIGHT_RATIO = 0.7;
// Top border + header + header divider + footer divider + footer + bottom border.
const MODAL_CHROME_LINES = 6;
const MODAL_FOOTER_HINT = "↑↓ scroll · ⇧↑↓ page · Esc close";
const MODAL_TOOL_ARGS_SNIPPET_LENGTH = 80;
const MODAL_TOOL_OUTPUT_SNIPPET_LENGTH = 160;

type ModalTextBlock = { type: "text"; text: string };
type ModalToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  output?: string;
  // undefined while the call is still running.
  isError?: boolean;
};
// A single ordered sequence (not text + a parallel tool-call array) so
// interleaving between streamed prose and tool calls stays correct with no
// extra position bookkeeping.
type ModalBlock = ModalTextBlock | ModalToolCallBlock;

type ModalState = {
  jobId: string;
  title: string;
  model: string;
  /** The minion job's own resolved effort/thinking level — never the main session's. */
  effort?: string;
  /** The prompt sent to the pi minion; static for the life of the modal. */
  prompt: string;
  blocks: ModalBlock[];
  finished: boolean;
  scrollOffset: number;
  autoScroll: boolean;
  requestRender: () => void;
};

function renderModalBlock(theme: Theme, block: ModalBlock): string {
  if (block.type === "text") return block.text;
  const name = theme.bold(theme.fg("accent", block.name));
  const argsSnippet = block.args
    ? truncate(JSON.stringify(block.args), MODAL_TOOL_ARGS_SNIPPET_LENGTH)
    : undefined;
  const header = argsSnippet
    ? `⚙ ${name} ${theme.fg("syntaxComment", argsSnippet)}`
    : `⚙ ${name}`;
  if (block.isError === undefined) {
    return `${header}\n${theme.fg("syntaxComment", "⎿ running…")}`;
  }
  const status = block.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const duration = block.durationMs !== undefined ? `${(block.durationMs / 1000).toFixed(1)}s` : undefined;
  const outputSnippet = block.output ? truncate(block.output, MODAL_TOOL_OUTPUT_SNIPPET_LENGTH) : undefined;
  const meta = [duration, outputSnippet].filter(Boolean).join(theme.fg("syntaxComment", " · "));
  return `${header}\n${theme.fg("syntaxComment", "⎿")} ${status}${meta ? ` ${meta}` : ""}`;
}

// "(model/effort) · tokens · 12s", shared by a standalone job's row and a
// running workflow step's row.
// "(model/effort) · tokens · Ns" — shared by standalone job rows and every
// workflow step row. No startedAt (a step that hasn't run) omits elapsed.
function formatJobMeta(
  theme: Theme,
  status: Pick<JobStatusUpdate, "model" | "effort" | "tokenUsage" | "finishedAt"> & { startedAt?: number }
): string {
  const elapsedSeconds =
    status.startedAt === undefined
      ? undefined
      : Math.floor(((status.finishedAt ?? Date.now()) - status.startedAt) / 1_000);
  // Same per-effort border color the detail modal uses for its own
  // header/border, so a job's thinking level reads consistently between
  // the live widget row and its modal.
  const effortColor = theme.getThinkingBorderColor(
    status.effort as Parameters<Theme["getThinkingBorderColor"]>[0]
  );
  const modelEffortPart = effortColor(`(${status.model}/${status.effort})`);
  const tokenUsagePart = status.tokenUsage
    ? theme.fg(
        "syntaxComment",
        formatTokenUsage(
          status.tokenUsage.input,
          status.tokenUsage.output,
          status.tokenUsage.cacheWrite,
          status.tokenUsage.cacheRead
        )
      )
    : undefined;
  const elapsedPart = elapsedSeconds === undefined ? undefined : theme.fg("syntaxComment", `${elapsedSeconds}s`);
  const dot = theme.fg("syntaxComment", " · ");
  return [modelEffortPart, tokenUsagePart, elapsedPart].filter(Boolean).join(dot);
}

function formatWorkflowBlock(
  theme: Theme,
  status: WorkflowWidgetStatus,
  jobs: ReadonlyMap<string, JobStatusUpdate>,
  spinner: string,
  connector: string,
  vbar: string
): string[] {
  const dim = (text: string) => theme.fg("syntaxComment", text);
  const done = status.steps.filter((step) => step.status === "done").length;
  const elapsedSeconds = Math.floor((Date.now() - status.startedAt) / 1_000);
  const header = [
    `⛓ ${theme.fg("accent", status.title)}`,
    dim(`stage ${status.stage}/${status.stages}`),
    dim(`${done}/${status.steps.length} done`),
    dim(`${elapsedSeconds}s`)
  ].join(dim(" · "));
  const lines = [`${dim(connector)} ${header}`];
  status.steps.forEach((step, index) => {
    const stepConnector = index === status.steps.length - 1 ? "└─" : "├─";
    const live = step.status === "running" && step.jobId ? jobs.get(step.jobId) : undefined;
    const marker =
      step.status === "running"
        ? spinner
        : step.status === "done"
          ? theme.fg("success", "✓")
          : step.status === "failed"
            ? theme.fg("error", "✗")
            : step.status === "pending"
              ? dim("○")
              : dim("–");
    // A running step reads its live job row; a finished one the stats its job
    // left behind; a pending one just its model/effort.
    const meta = formatJobMeta(theme, live ? { ...live, effort: step.effort } : step);
    const body = `${marker} ${step.id} ${meta}${live ? dim(` · ${live.previewLine ?? "Working…"}`) : ""}`;
    lines.push(`${dim(`${vbar}  ${stepConnector}`)} ${body}`);
  });
  return lines;
}

// "π minions · 1 job · 2 workflows": the root the widget's tree hangs from.
function formatWidgetRoot(theme: Theme, jobCount: number, workflowCount: number): string {
  const count = (n: number, noun: string) => (n ? [`${n} ${noun}${n === 1 ? "" : "s"}`] : []);
  const dim = (text: string) => theme.fg("syntaxComment", text);
  return [
    `${theme.fg("accent", "π")} ${theme.bold("minions")}`,
    ...count(jobCount, "job").map(dim),
    ...count(workflowCount, "workflow").map(dim)
  ].join(dim(" · "));
}

function formatWidgetLines(
  theme: Theme,
  entries: Array<[string, JobStatusUpdate]>,
  workflows: Array<[string, WorkflowWidgetStatus]>,
  spinnerFrame: number,
  maxLines: number,
  width: number
): string[] {
  // A running step's job renders inside its workflow, not as its own row.
  const claimed = new Set(
    workflows.flatMap(([, wf]) => wf.steps.flatMap((step) => (step.jobId ? [step.jobId] : [])))
  );
  const standalone = entries.filter(([id]) => !claimed.has(id));
  const jobsById = new Map(entries);
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  // One block per top-level item, rendered once its connector is known.
  const blocks: Array<{ size: number; render: (connector: string, vbar: string) => string[] }> = [
    ...workflows.map(([, wf]) => ({
      size: wf.steps.length + 1,
      render: (connector: string, vbar: string) =>
        formatWorkflowBlock(theme, wf, jobsById, spinner, connector, vbar)
    })),
    ...standalone.map(([, status]) => ({
      size: 2,
      render: (connector: string, vbar: string) => [
        `${theme.fg("syntaxComment", connector)} ${spinner} ${theme.fg("accent", status.title)} ${formatJobMeta(theme, status)}`,
        theme.fg("syntaxComment", `${vbar}  ⎿  ${status.previewLine ?? "Working…"}`)
      ]
    }))
  ];
  if (blocks.length === 0) return [];
  // The root row the tree hangs from takes one of maxLines.
  const room = maxLines - 1;
  let shown = blocks;
  let overflow = 0;
  if (blocks.reduce((sum, block) => sum + block.size, 0) > room) {
    // Reserve one line for the overflow summary row; always show at least one.
    let used = 0;
    let count = 0;
    while (count < blocks.length && used + blocks[count].size <= room - 1) {
      used += blocks[count].size;
      count++;
    }
    count = Math.max(1, count);
    shown = blocks.slice(0, count);
    overflow = blocks.length - count;
  }
  const lines = [formatWidgetRoot(theme, standalone.length, workflows.length)];
  shown.forEach((block, index) => {
    const isLast = overflow === 0 && index === shown.length - 1;
    lines.push(...block.render(isLast ? "└─" : "├─", isLast ? " " : "│"));
  });
  if (overflow > 0) {
    lines.push(theme.fg("syntaxComment", `└─ +${overflow} more running`));
  }
  return lines.map((line) => truncateToWidth(line, width));
}

// The bordered box shared by the detail modal and the workflow confirm
// dialog: each row is truncated to the inner width; null draws a ├─┤ divider.
function frameLines(border: (text: string) => string, width: number, rows: Array<string | null>): string[] {
  const innerWidth = Math.max(4, width - 4);
  const rule = (left: string, right: string) => border(`${left}${"─".repeat(width - 2)}${right}`);
  return [
    rule("╭", "╮"),
    ...rows.map((content) =>
      content === null
        ? rule("├", "┤")
        : `${border("│")} ${truncateToWidth(content, innerWidth, "…", true)} ${border("│")}`
    ),
    rule("╰", "╯")
  ];
}

class JobDetailModal implements Component {
  // Visible body height from the last render(); the shift+up/down page size.
  private pageRows = 1;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly tui: TUI,
    private readonly state: ModalState,
    private readonly done: (result: undefined) => void,
    private readonly onDispose: () => void
  ) {}

  invalidate(): void {
    // No cached rendering state to invalidate — render() always reads live state.
  }

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    // Resolved level, not the main session's — an unset effort falls back to
    // "off", the same convention core Pi uses for "no thinking level chosen".
    const borderColor = theme.getThinkingBorderColor(
      (this.state.effort ?? "off") as Parameters<Theme["getThinkingBorderColor"]>[0]
    );
    const innerWidth = Math.max(4, width - 4);
    const rows = Math.max(1, Math.floor(this.tui.terminal.rows * MODAL_HEIGHT_RATIO));
    const bodyRows = Math.max(0, rows - MODAL_CHROME_LINES);
    this.pageRows = Math.max(1, bodyRows);

    const separator = theme.fg("borderMuted", "─".repeat(innerWidth));
    const body = this.state.blocks.length
      ? this.state.blocks.map((block) => renderModalBlock(theme, block)).join("\n\n")
      : "Working…";
    const fullText = `${this.state.prompt}\n\n${separator}\n\n${body}`;
    const contentLines = wrapTextWithAnsi(fullText, innerWidth);
    const maxScroll = Math.max(0, contentLines.length - bodyRows);
    if (this.state.autoScroll) {
      this.state.scrollOffset = maxScroll;
    } else {
      this.state.scrollOffset = Math.min(this.state.scrollOffset, maxScroll);
      if (this.state.scrollOffset >= maxScroll) this.state.autoScroll = true;
    }
    const visible = contentLines.slice(
      this.state.scrollOffset,
      this.state.scrollOffset + bodyRows
    );
    while (visible.length < bodyRows) visible.push("");

    // Left: job title, bold and accented. Right: model, then the resolved
    // thinking level in the same color as the border (so the badge and the
    // box outline visually agree), then a finished marker once done.
    const titlePart = theme.bold(theme.fg("accent", this.state.title));
    const dot = theme.fg("syntaxComment", " · ");
    const badges = [theme.fg("syntaxComment", this.state.model), borderColor(`thinking: ${this.state.effort ?? "off"}`)];
    if (this.state.finished) badges.push(theme.fg("syntaxComment", "finished"));
    const metaPart = badges.join(dot);
    const gap = Math.max(1, innerWidth - visibleWidth(titlePart) - visibleWidth(metaPart));
    const header = `${titlePart}${" ".repeat(gap)}${metaPart}`;

    return frameLines(borderColor, width, [
      header,
      null,
      ...visible,
      separator,
      theme.fg("syntaxComment", MODAL_FOOTER_HINT)
    ]);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "shift+up")) {
      this.state.autoScroll = false;
      this.state.scrollOffset = Math.max(0, this.state.scrollOffset - this.pageRows);
      this.state.requestRender();
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.state.scrollOffset += this.pageRows;
      this.state.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.state.autoScroll = false;
      this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 1);
      this.state.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.state.scrollOffset += 1;
      this.state.requestRender();
      return;
    }
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      matchesKey(data, "q")
    ) {
      this.done(undefined);
    }
  }

  dispose(): void {
    this.onDispose();
  }
}

// One styled run inside a confirm line: plain, muted, or colored with an
// effort's thinking border color.
export type ConfirmSegment = { text: string; style?: "muted" | "effort"; effort?: string };
// A line is its segments in order; an empty array is a blank line.
export type ConfirmLine = ConfirmSegment[];
export type WorkflowConfirm = { title: string; lines: ConfirmLine[] };

function renderConfirmLine(theme: Theme, line: ConfirmLine): string {
  return line
    .map((seg) => {
      if (seg.style === "muted") return theme.fg("muted", seg.text);
      if (seg.style === "effort") {
        const color = theme.getThinkingBorderColor(
          (seg.effort ?? "off") as Parameters<Theme["getThinkingBorderColor"]>[0]
        );
        return color(seg.text);
      }
      return seg.text;
    })
    .join("");
}

// Pure: only the title is accent+bold; lines wrap to `width`.
export function renderWorkflowConfirmTitle(theme: Theme, title: string, width: number): string[] {
  return wrapTextWithAnsi(theme.fg("accent", theme.bold(title)), Math.max(1, width));
}

// Wrapped continuation lines hang under the text after a line's leading
// indent and bullet ("  • "), so a long step reads as one block.
export function renderWorkflowConfirmLines(theme: Theme, lines: ConfirmLine[], width: number): string[] {
  return lines.flatMap((line) => {
    if (line.length === 0) return [""];
    const prefix = /^\s*(?:[•·-]\s+)?/.exec(line[0].text)?.[0] ?? "";
    const rest: ConfirmLine = [{ ...line[0], text: line[0].text.slice(prefix.length) }, ...line.slice(1)];
    const hang = prefix.length < width ? prefix.length : 0;
    const wrapped = wrapTextWithAnsi(renderConfirmLine(theme, hang ? rest : line), Math.max(1, width - hang));
    return hang ? wrapped.map((row, i) => (i === 0 ? prefix : " ".repeat(hang)) + row) : wrapped;
  });
}

export function renderWorkflowConfirmBody(theme: Theme, confirm: WorkflowConfirm, width: number): string[] {
  return [
    ...renderWorkflowConfirmTitle(theme, confirm.title, width),
    ...renderWorkflowConfirmLines(theme, confirm.lines, width)
  ];
}

const CONFIRM_OPTIONS = ["Yes", "No"] as const;
const CONFIRM_HEIGHT_RATIO = 0.9;
// Top border, blank, two options, blank, hint, bottom border.
const CONFIRM_CHROME_LINES = 7;
// Rows reserved for the "↑ N more" / "↓ N more" lines while the body overflows.
const CONFIRM_INDICATOR_LINES = 2;

// The user's answer; `message` is the optional reason typed on "No".
export type WorkflowConfirmResult = { approved: boolean; message?: string };

// Yes/No overlay mirroring pi's extension selector, minus its all-accent body.
class WorkflowConfirmDialog implements Component {
  // Starts on "No": a stray enter must not spend money.
  private selected = CONFIRM_OPTIONS.indexOf("No");
  // Shown inline on "No" while it is selected; typing goes here.
  private readonly reason: Input;
  // Body scroll state; maxScroll and pageRows are refreshed by every render().
  private scrollOffset = 0;
  private maxScroll = 0;
  private pageRows = 1;

  constructor(
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly confirm: WorkflowConfirm,
    private readonly done: (result: WorkflowConfirmResult) => void
  ) {
    this.reason = new Input({
      prompt: "reason: ",
      placeholder: "tell the agent why…",
      placeholderStyle: (text) => theme.fg("muted", text)
    });
    this.reason.focused = true;
  }

  private onNo(): boolean {
    return CONFIRM_OPTIONS[this.selected] === "No";
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.theme;
    const border = (text: string) => theme.fg("border", text);
    const innerWidth = Math.max(4, width - 4);
    const title = renderWorkflowConfirmTitle(theme, this.confirm.title, innerWidth);
    const all = renderWorkflowConfirmLines(theme, this.confirm.lines, innerWidth);
    const room = Math.max(
      1,
      Math.floor(this.tui.terminal.rows * CONFIRM_HEIGHT_RATIO) - CONFIRM_CHROME_LINES - title.length
    );
    const overflow = all.length > room;
    const bodyRows = overflow ? Math.max(1, room - CONFIRM_INDICATOR_LINES) : room;
    this.pageRows = bodyRows;
    this.maxScroll = Math.max(0, all.length - bodyRows);
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
    const hidden = (n: number, arrow: string) => (n > 0 ? theme.fg("muted", `${arrow} ${n} more`) : "");
    const body = overflow
      ? [
          hidden(this.scrollOffset, "↑"),
          ...all.slice(this.scrollOffset, this.scrollOffset + bodyRows),
          hidden(all.length - this.scrollOffset - bodyRows, "↓")
        ]
      : all;
    const options = CONFIRM_OPTIONS.map((option, i) => {
      if (i !== this.selected) return `  ${theme.fg("text", option)}`;
      if (option !== "No") return theme.fg("accent", `→ ${option}`);
      const head = `→ ${option} · `;
      const reason = this.reason.render(Math.max(1, innerWidth - visibleWidth(head)))[0];
      return theme.fg("accent", `→ ${option}`) + theme.fg("muted", " · ") + reason;
    });
    return frameLines(border, width, [
      ...title,
      ...body,
      "",
      ...options,
      "",
      theme.fg(
        "muted",
        `↑↓ navigate  ${overflow ? "shift+↑↓ scroll  " : ""}type a reason on No  enter select  esc cancel`
      )
    ]);
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.min(this.maxScroll, Math.max(0, this.scrollOffset + delta));
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    // Same paging as JobDetailModal (shift+↑/↓); ↑/↓ belong to Yes/No here.
    if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) return this.scrollBy(-this.pageRows);
    if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) return this.scrollBy(this.pageRows);
    // On "No", j/k are text for the reason, not navigation.
    const vim = !this.onNo();
    if (matchesKey(data, "up") || (vim && data === "k")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || (vim && data === "j")) {
      this.selected = Math.min(CONFIRM_OPTIONS.length - 1, this.selected + 1);
    } else if (matchesKey(data, "enter") || data === "\n") {
      if (!this.onNo()) return this.done({ approved: true });
      const message = this.reason.getValue().trim();
      this.done(message ? { approved: false, message } : { approved: false });
      return;
    } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done({ approved: false });
      return;
    } else if (this.onNo()) {
      this.reason.handleInput(data);
    } else {
      return;
    }
    this.tui.requestRender();
  }
}

/**
 * Yes/No approval overlay for a workflow plan. Approves only on "Yes"; "No"
 * may carry a typed reason. Esc, ctrl+c, or a stale ctx (session replaced)
 * all decline without one.
 */
export async function confirmWorkflow(
  ctx: ExtensionContext,
  confirm: WorkflowConfirm
): Promise<WorkflowConfirmResult> {
  try {
    const result = await ctx.ui.custom<WorkflowConfirmResult>(
      (tui, _theme, _keybindings, done) => new WorkflowConfirmDialog(ctx.ui.theme, tui, confirm, done),
      { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" } }
    );
    if (result?.approved === true) return { approved: true };
    return result?.message ? { approved: false, message: result.message } : { approved: false };
  } catch {
    return { approved: false };
  }
}

/**
 * `opts.widgetKey` defaults to `"pi-minion-jobs"` — override only if an
 * extension mounts more than one independent `JobUI` (each needs its own
 * `aboveEditor` widget key). `opts.maxWidgetLines` defaults to 12 (2 lines
 * per running job plus a "+N more running" summary row once it would
 * overflow) — override to fit a different expected concurrency.
 */
export function createJobUI(
  initialCtx: ExtensionContext,
  opts?: { widgetKey?: string; maxWidgetLines?: number }
): JobUI {
  const widgetKey = opts?.widgetKey ?? DEFAULT_WIDGET_KEY;
  const maxWidgetLines = opts?.maxWidgetLines ?? DEFAULT_MAX_WIDGET_LINES;

  let ctx = initialCtx;
  const jobs = new Map<string, JobStatusUpdate>();
  const workflows = new Map<string, WorkflowWidgetStatus>();
  let spinnerFrame = 0;
  let spinnerInterval: NodeJS.Timeout | undefined;
  let widgetTui: TUI | undefined;
  let activeModal: ModalState | undefined;

  const requestWidgetRender = () => widgetTui?.requestRender();

  function safeUi(fn: () => void): void {
    try {
      fn();
    } catch {
      // ctx invalidated by a session reload/new/fork/switchSession while a
      // background job outlives the session that started it — UI updates
      // are best-effort; the job itself keeps running regardless.
    }
  }

  function ensureWidgetRegistered(): void {
    if (widgetTui) return;
    try {
      ctx.ui.setWidget(
        widgetKey,
        (tui) => {
          widgetTui = tui;
          return {
            render: (width: number) => {
              try {
                return formatWidgetLines(
                  ctx.ui.theme,
                  [...jobs.entries()],
                  [...workflows.entries()],
                  spinnerFrame,
                  maxWidgetLines,
                  width
                );
              } catch {
                return [];
              }
            },
            invalidate: () => {
              // No cached rendering state — render() always reads live jobs/theme.
            },
            dispose: () => {
              // Pi tore this widget instance down (resetExtensionUI on
              // reload/new/fork/switchSession, or our own setWidget(key,
              // undefined) below) — reset the guard so the next call, with
              // whatever ctx setCtx() has been given by then, re-registers
              // instead of staying permanently blocked. Identity-guarded so
              // a late dispose() from a superseded instance can't clobber a
              // newer, already-registered one.
              if (widgetTui === tui) widgetTui = undefined;
            }
          };
        },
        { placement: "aboveEditor" }
      );
    } catch {
      // ctx was stale (session replaced by reload/new/fork/switchSession) or
      // setWidget failed for any other reason — widgetTui was never set by
      // this attempt, so the very next call retries cleanly instead of being
      // permanently blocked by the `if (widgetTui) return` guard above.
      widgetTui = undefined;
    }
  }

  function setCtx(next: ExtensionContext): void {
    ctx = next;
    if (jobs.size > 0 || workflows.size > 0) {
      ensureWidgetRegistered();
      ensureSpinnerRunning();
      requestWidgetRender();
    }
  }

  function ensureSpinnerRunning(): void {
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      requestWidgetRender();
    }, SPINNER_INTERVAL_MS);
    spinnerInterval.unref();
  }

  function stopSpinner(): void {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = undefined;
    }
  }

  function setJob(id: string, status: JobStatusUpdate): void {
    jobs.set(id, status);
    ensureWidgetRegistered();
    ensureSpinnerRunning();
    requestWidgetRender();
  }

  function setWorkflow(id: string, status: WorkflowWidgetStatus): void {
    workflows.set(id, status);
    ensureWidgetRegistered();
    ensureSpinnerRunning();
    requestWidgetRender();
  }

  function clearJob(id: string): void {
    jobs.delete(id);
    refreshOrTearDownWidget();
  }

  function clearWorkflow(id: string): void {
    workflows.delete(id);
    refreshOrTearDownWidget();
  }

  function refreshOrTearDownWidget(): void {
    if (jobs.size === 0 && workflows.size === 0) {
      stopSpinner();
      safeUi(() => ctx.ui.setWidget(widgetKey, undefined, { placement: "aboveEditor" }));
      widgetTui = undefined;
    } else {
      requestWidgetRender();
    }
  }

  async function pick(extra: Array<{ id: string; label: string }> = []): Promise<string | undefined> {
    try {
      if (jobs.size === 0 && extra.length === 0) {
        ctx.ui.notify("No pi-minion jobs running or scheduled.", "info");
        return undefined;
      }
      const entries = [...jobs.entries()].filter(([id]) => !extra.some((item) => item.id === id));
      // ctx.ui.select() returns the chosen label string with no positional
      // index, so two rows with an identical label would otherwise be
      // indistinguishable on return; disambiguate duplicates only when they
      // occur so the common (unique) case keeps the plain label.
      const seen = new Map<string, number>();
      const labels = [
        ...entries.map(([, status]) => `${status.title} - ${status.model}`),
        ...extra.map((item) => item.label)
      ].map((base) => {
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base} #${count}`;
      });
      const ids = [...entries.map(([id]) => id), ...extra.map((item) => item.id)];
      const chosen = await ctx.ui.select("pi-minion jobs", labels);
      if (chosen === undefined) return undefined;
      const index = labels.indexOf(chosen);
      return index === -1 ? undefined : ids[index];
    } catch {
      // ctx invalidated by a session reload/new/fork/switchSession while a
      // background job outlives the session that started it.
      return undefined;
    }
  }

  function openModal(
    id: string,
    initial: { title: string; model: string; prompt: string; text?: string; effort?: string }
  ): void {
    const state: ModalState = {
      jobId: id,
      title: initial.title,
      model: initial.model,
      effort: initial.effort,
      prompt: initial.prompt,
      blocks: initial.text ? [{ type: "text", text: initial.text }] : [],
      finished: false,
      scrollOffset: 0,
      autoScroll: true,
      requestRender: () => {}
    };
    activeModal = state;
    safeUi(() => {
      ctx.ui
        .custom<undefined>(
          (tui, _theme, _keybindings, done) => {
            state.requestRender = () => tui.requestRender();
            return new JobDetailModal(ctx, tui, state, done, () => {
              if (activeModal === state) activeModal = undefined;
            });
          },
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" }
          }
        )
        .catch(() => {
          if (activeModal === state) activeModal = undefined;
        });
    });
  }

  function appendModalText(id: string, text: string): void {
    if (activeModal?.jobId !== id) return;
    const last = activeModal.blocks.at(-1);
    if (last?.type === "text") last.text += text;
    else activeModal.blocks.push({ type: "text", text });
    activeModal.requestRender();
  }

  function startModalTextBlock(id: string): void {
    if (activeModal?.jobId !== id) return;
    if (activeModal.blocks.length === 0) return;
    activeModal.blocks.push({ type: "text", text: "" });
  }

  function startModalToolCall(id: string, toolCallId: string, name: string): void {
    if (activeModal?.jobId !== id) return;
    activeModal.blocks.push({ type: "toolCall", id: toolCallId, name });
    activeModal.requestRender();
  }

  function findModalToolCall(id: string, toolCallId: string): ModalToolCallBlock | undefined {
    if (activeModal?.jobId !== id) return undefined;
    return activeModal.blocks.find(
      (block): block is ModalToolCallBlock => block.type === "toolCall" && block.id === toolCallId
    );
  }

  function updateModalToolCallArgs(id: string, toolCallId: string, args: Record<string, unknown>): void {
    const block = findModalToolCall(id, toolCallId);
    if (!block) return;
    block.args = args;
    activeModal!.requestRender();
  }

  function finishModalToolCall(
    id: string,
    toolCallId: string,
    result: { durationMs?: number; output?: string; isError: boolean }
  ): void {
    const block = findModalToolCall(id, toolCallId);
    if (!block) return;
    Object.assign(block, result);
    activeModal!.requestRender();
  }

  function setModalModel(id: string, model: string): void {
    if (activeModal?.jobId !== id) return;
    activeModal.model = model;
    activeModal.requestRender();
  }

  function finishModalJob(id: string): void {
    if (activeModal?.jobId !== id) return;
    activeModal.finished = true;
    activeModal.requestRender();
  }

  function dispose(): void {
    stopSpinner();
    if (widgetTui) {
      safeUi(() => ctx.ui.setWidget(widgetKey, undefined, { placement: "aboveEditor" }));
      widgetTui = undefined;
    }
    jobs.clear();
    workflows.clear();
  }

  return {
    setCtx,
    setJob,
    clearJob,
    setWorkflow,
    clearWorkflow,
    pick,
    openModal,
    appendModalText,
    startModalTextBlock,
    startModalToolCall,
    updateModalToolCallArgs,
    finishModalToolCall,
    setModalModel,
    finishModalJob,
    dispose
  };
}
