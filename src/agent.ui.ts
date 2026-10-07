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
  type TUI
} from "@earendil-works/pi-tui";
import type { TokenCounts } from "./adapters/types.js";
import { truncate } from "./adapters/util.js";
import { glyph } from "./glyphs.js";
import {
  headerRow,
  jobDetailScrollKeys,
  ModalShell,
  openModal as mountModal,
  Viewport,
  type FrameSpec
} from "./modal-shell.js";

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
export type StepRunStats = {
  startedAt: number;
  finishedAt: number;
  tokenUsage?: TokenCounts;
  // Final billed cost, when the CLI reported one; undefined for a CLI with
  // no cost concept (formatCostUsd renders that as "n/a").
  totalCostUsd?: number;
};

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
  /** Modal: open the detail overlay. The returned promise resolves when the
   *  user closes it (or the ctx goes stale) — callers that re-present an
   *  overlay of their own must await it, or the two overlays fight for
   *  keybindings and Esc reaches the wrong one. Fire-and-forget is fine when
   *  nothing is stacked above the session afterward.
   */
  openModal(
    id: string,
    initial: { title: string; model: string; prompt: string; text?: string; effort?: string; finished?: boolean }
  ): Promise<void>;
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
  /**
   * Modal: register an externally-owned ModalState as the currently active
   * detail, so stream mutators (appendModalText / startModalTextBlock /
   * startModalToolCall / updateModalToolCallArgs / finishModalToolCall /
   * setModalModel / finishModalJob) route to it. Pass undefined to clear
   * the reference (e.g. when a custom overlay closes its inline detail).
   * Use only from a single active detail at a time — assigning overwrites
   * any previous active detail without notifying its owner.
   */
  setActiveDetail(state: ModalState | undefined): void;
  /** Tear down widget/timers. */
  dispose(): void;
}

const DEFAULT_WIDGET_KEY = "pi-minion-jobs";
const DEFAULT_MAX_WIDGET_LINES = 12;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
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

export type ModalState = {
  jobId: string;
  title: string;
  model: string;
  /** The minion job's own resolved effort/thinking level — never the main session's. */
  effort?: string;
  /** The prompt sent to the pi minion; static for the life of the modal. */
  prompt: string;
  blocks: ModalBlock[];
  finished: boolean;
  requestRender: () => void;
};

export function renderModalBlock(theme: Theme, block: ModalBlock): string {
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
    `${glyph("⇉ ")}${theme.fg("accent", status.title)}`,
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
// dialog. Moved to modal-shell.ts (Step 1 of the reusable-modal-helper plan)
// so the shell can own framing without an agent.ui ↔ shell import cycle.

/**
 * FrameSpec for the job-detail modal: the accent border (uniform chrome
 * across all modals), a bold accent title with model/thinking/finished
 * badges, prompt + muted rule + streamed blocks as the body, and the
 * scroll-hint footer. Scroll/follow-tail state is owned by the mounting
 * shell's Viewport, driven by jobDetailScrollKeys.
 */
export function jobDetailSpec(state: ModalState): FrameSpec {
  // Resolved level, not the main session's — an unset effort falls back to
  // "off", the same convention core Pi uses for "no thinking level chosen".
  // Resolved once per spec so the badge costs one getThinkingBorderColor
  // call per render.
  let borderColor: ((text: string) => string) | undefined;
  const thinkingBorder = (theme: Theme) =>
    (borderColor ??= theme.getThinkingBorderColor(
      (state.effort ?? "off") as Parameters<Theme["getThinkingBorderColor"]>[0]
    ));

  return {
    // Uniform chrome: every modal frames in the accent color.
    border: (theme) => (text) => theme.fg("accent", text),
    titleRows: ({ theme, innerWidth }) => {
      const color = thinkingBorder(theme);
      // Left: job title, bold and accented. Right: model, then the resolved
      // thinking level in the same color as the border (so the badge and the
      // box outline visually agree), then a finished marker once done.
      const titlePart = theme.bold(theme.fg("accent", state.title));
      const dot = theme.fg("syntaxComment", " · ");
      const badges = [theme.fg("syntaxComment", state.model), color(`thinking: ${state.effort ?? "off"}`)];
      if (state.finished) badges.push(theme.fg("syntaxComment", "finished"));
      return [headerRow(theme, titlePart, badges.join(dot), innerWidth), null];
    },
    body: ({ theme, innerWidth }) => {
      const separator = theme.fg("borderMuted", "─".repeat(innerWidth));
      const blocks = state.blocks.length
        ? state.blocks.map((block) => renderModalBlock(theme, block)).join("\n\n")
        : "Working…";
      return { text: `${state.prompt}\n\n${separator}\n\n${blocks}` };
    },
    footerRows: ({ theme }) => [null, theme.fg("muted", MODAL_FOOTER_HINT)],
    fillBody: true
  };
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

// The user's answer; `message` is the optional reason typed on "No".
export type WorkflowConfirmResult = { approved: boolean; message?: string };

/**
 * Yes/No approval overlay for a workflow plan. Approves only on "Yes"; "No"
 * may carry a typed reason. Esc, ctrl+c, or a stale ctx (session replaced)
 * all decline without one.
 */
export async function confirmWorkflow(
  ctx: ExtensionContext,
  confirm: WorkflowConfirm
): Promise<WorkflowConfirmResult> {
  // Starts on "No": a stray enter must not spend money. The reason input is
  // shown inline on "No" while it is selected; typing goes here.
  let selected = CONFIRM_OPTIONS.indexOf("No");
  const reason = new Input({
    prompt: "reason: ",
    placeholder: "tell the agent why…",
    placeholderStyle: (text) => ctx.ui.theme.fg("muted", text)
  });
  reason.focused = true;
  const onNo = () => CONFIRM_OPTIONS[selected] === "No";

  const result = await mountModal<WorkflowConfirmResult>(ctx, {
    fallback: { approved: false },
    heightRatio: 0.9,
    width: "80%",
    make: (tui, done) => {
      const viewport = new Viewport();
      const optionRows = (theme: Theme, innerWidth: number): string[] =>
        CONFIRM_OPTIONS.map((option, i) => {
          if (i !== selected) return `  ${theme.fg("text", option)}`;
          if (option !== "No") return theme.fg("accent", `→ ${option}`);
          const head = `→ ${option} · `;
          const reasonLine = reason.render(Math.max(1, innerWidth - visibleWidth(head)))[0];
          return theme.fg("accent", `→ ${option}`) + theme.fg("muted", " · ") + reasonLine;
        });
      // renderFrame derives the same room from 2 borders + titleRows
      // (title + divider) + 5 footer rows; recomputing it here keeps the
      // footer's overflow hint in step with the indicator rows.
      const overflow = (theme: Theme, innerWidth: number): boolean =>
        renderWorkflowConfirmLines(theme, confirm.lines, innerWidth).length >
        Math.max(
          1,
          Math.floor(tui.terminal.rows * 0.9) -
            8 -
            renderWorkflowConfirmTitle(theme, confirm.title, innerWidth).length
        );

      const spec: FrameSpec = {
        // Uniform chrome: accent border, like every other modal.
        border: (theme) => (text) => theme.fg("accent", text),
        titleRows: ({ theme, innerWidth }) => [
          ...renderWorkflowConfirmTitle(theme, confirm.title, innerWidth),
          null
        ],
        body: ({ theme, innerWidth }) => ({
          rows: renderWorkflowConfirmLines(theme, confirm.lines, innerWidth)
        }),
        footerRows: ({ theme, innerWidth }) => [
          // Leading null: the footer-bar rule, same as JobDetail/trail.
          null,
          ...optionRows(theme, innerWidth),
          "",
          theme.fg(
            "muted",
            `↑↓ navigate  ${overflow(theme, innerWidth) ? "shift+↑↓ scroll  " : ""}type a reason on No  enter select  esc cancel`
          )
        ],
        // Must match mountModal's heightRatio below: renderFrame sizes the
        // body from this, and the footer's overflow() uses the same 0.9.
        heightRatio: 0.9,
        indicators: true
      };

      return new ModalShell<WorkflowConfirmResult>({
        theme: ctx.ui.theme,
        tui,
        done: (r) => done(r ?? { approved: false }),
        spec,
        viewport: () => viewport,
        // Ports the old dialog's handleInput; every key is claimed so
        // ModalShell's scroll/esc defaults never run.
        input: (data, api) => {
          // Same paging as the detail modal (shift+↑/↓); ↑/↓ belong to Yes/No here.
          if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) {
            api.viewport.pageBy(-1, api.viewport.bodyRows, api.viewport.total);
            api.requestRender();
            return true;
          }
          if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) {
            api.viewport.pageBy(1, api.viewport.bodyRows, api.viewport.total);
            api.requestRender();
            return true;
          }
          // On "No", j/k are text for the reason, not navigation.
          const vim = !onNo();
          if (matchesKey(data, "up") || (vim && data === "k")) {
            selected = Math.max(0, selected - 1);
          } else if (matchesKey(data, "down") || (vim && data === "j")) {
            selected = Math.min(CONFIRM_OPTIONS.length - 1, selected + 1);
          } else if (matchesKey(data, "enter") || data === "\n") {
            if (!onNo()) {
              done({ approved: true });
              return true;
            }
            const message = reason.getValue().trim();
            done(message ? { approved: false, message } : { approved: false });
            return true;
          } else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            done({ approved: false });
            return true;
          } else if (onNo()) {
            reason.handleInput(data);
          } else {
            return true;
          }
          api.requestRender();
          return true;
        }
      });
    }
  });

  if (result?.approved === true) return { approved: true };
  return result?.message ? { approved: false, message: result.message } : { approved: false };
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

  function safeUi<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      // ctx invalidated by a session reload/new/fork/switchSession while a
      // background job outlives the session that started it — UI updates
      // are best-effort; the job itself keeps running regardless.
      return undefined;
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
    initial: { title: string; model: string; prompt: string; text?: string; effort?: string; finished?: boolean }
  ): Promise<void> {
    const state: ModalState = {
      jobId: id,
      title: initial.title,
      model: initial.model,
      effort: initial.effort,
      prompt: initial.prompt,
      blocks: initial.text ? [{ type: "text", text: initial.text }] : [],
      finished: initial.finished ?? false,
      requestRender: () => {}
    };
    activeModal = state;
    return mountModal(ctx, {
      fallback: undefined,
      heightRatio: 0.7,
      finally: () => {
        if (activeModal === state) activeModal = undefined;
      },
      make: (tui, done) => {
        state.requestRender = () => tui.requestRender();
        const viewport = new Viewport();
        const shell = new ModalShell<undefined>({
          theme: ctx.ui.theme,
          tui,
          done,
          spec: jobDetailSpec(state),
          viewport: () => viewport,
          input: jobDetailScrollKeys
        });
        // dispose() clears the active-modal reference as the detail modal's
        // dispose did; mountModal's finally covers promise settle (resolve and reject).
        return Object.assign(shell, {
          dispose: () => {
            if (activeModal === state) activeModal = undefined;
          }
        });
      }
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

  // Externally-owned ModalState (e.g. the trail browser's inline detail
  // view) registers itself here so stream mutators route to it; `undefined`
  // clears the reference. The trail browser always pairs open with close,
  // so no identity guard is needed — overwriting simply steals the routing
  // from whatever was active, which is what openModal's flow already does
  // for a fresh live modal.
  function setActiveDetail(state: ModalState | undefined): void {
    activeModal = state;
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
    setActiveDetail,
    dispose
  };
}
