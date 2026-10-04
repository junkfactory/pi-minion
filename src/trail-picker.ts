import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  frameLines,
  JobDetailModal,
  type JobUI,
  type ModalState
} from "./agent.ui.js";
import { backfillModal, resolveAdapterForJob } from "./modal.js";
import { formatRelative } from "./format.js";
import { glyph } from "./glyphs.js";
import { JOB_ROOT, jobMeta, relevantJobsForSession } from "./job-store.js";
import type { JobMetaEntry } from "./job-types.js";
import {
  workflowIdsOwnedBySession,
  workflowStatus,
  workflows,
  type MinionWorkflow
} from "./workflow-store.js";

// === Trail-row helpers =================================================
//
// Moved out of src/modal.ts in v2: the v1 flat-row trail preview that
// `ctx.ui.select` rendered is gone, and so is the v1 union cap. The browser
// renders two sections with their own recent-10 caps; this file owns those
// row builders + the per-row label formatters. finishedAt stays on the
// returned rows because the per-section sort reads it (combineTrailRows is
// deleted — there is no longer a shared cap across the two sections).

export type TrailRow = { id: string; label: string; finishedAt: number };

// Pure: standalone finished jobs in this session/workspace, excluding
// running jobs (they're already in the live widget row) and excluding
// workflow-step metas (those show up under their owning workflow's step
// view in the browser). Sorted desc by finishedAt and capped at 10 — the
// per-section cap the v2 browser renders, replacing the v1 union cap.
export function recentStandaloneTrails(
  ctx: ExtensionContext,
  jobMeta: ReadonlyMap<string, JobMetaEntry>
): TrailRow[] {
  const sessionId = ctx.sessionManager.getSessionId();
  return relevantJobsForSession(jobMeta, sessionId, ctx.cwd)
    .filter((entry) => entry.status !== "running" && entry.workflowId === undefined)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 10)
    .map((meta) => ({
      id: meta.id,
      finishedAt: meta.finishedAt ?? 0,
      label: formatStandaloneTrailLabel(meta)
    }));
}

// Pure: finished workflows in this session, same per-section recent-10 cap
// as the standalone list. The counts line reuses the formatWorkflowSummary
// pattern — done/failed/skipped/cancelled, non-zero only — so a finished
// workflow's status shape is consistent between the trail row and its
// end-of-run post.
export function finishedWorkflowTrails(
  ctx: ExtensionContext,
  workflows: ReadonlyMap<string, MinionWorkflow>
): TrailRow[] {
  const sessionId = ctx.sessionManager.getSessionId();
  return workflowIdsOwnedBySession(workflows, sessionId)
    .map((id) => ({ id, wf: workflows.get(id)! }))
    .filter(({ wf }) => workflowStatus(wf) !== "running")
    .sort((a, b) => (b.wf.finishedAt ?? 0) - (a.wf.finishedAt ?? 0))
    .slice(0, 10)
    .map(({ id, wf }) => ({
      id,
      finishedAt: wf.finishedAt ?? 0,
      label: formatWorkflowTrailLabel(wf)
    }));
}

// Sum of the two per-section caps' actual contents — used by
// openPiMinionsPicker to decide whether to surface the "✓ Completed · N
// trails" sentinel row (N = 0 hides it; > 0 shows it).
export function countFinishedTrails(
  ctx: ExtensionContext,
  jobMeta: ReadonlyMap<string, JobMetaEntry>,
  workflows: ReadonlyMap<string, MinionWorkflow>
): number {
  return recentStandaloneTrails(ctx, jobMeta).length + finishedWorkflowTrails(ctx, workflows).length;
}

export function formatStandaloneTrailLabel(meta: JobMetaEntry): string {
  const prefix =
    meta.status === "done"
      ? glyph("✓ ")
      : meta.status === "errored"
        ? glyph("✗ ")
        : meta.status === "cancelled"
          ? glyph("− ")
          : "";
  const model = meta.resolvedModel ?? meta.model;
  return `${prefix}${meta.title} · ${model} · ${meta.status} ${formatRelative(meta.finishedAt ?? Date.now())}`;
}

export function formatWorkflowTrailLabel(wf: MinionWorkflow): string {
  const counts = (["done", "failed", "skipped", "cancelled"] as const)
    .map((name) => [name, wf.steps.filter((step) => step.status === name).length] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
  return `${glyph("⇉ ")}${wf.title} · ${workflowStatus(wf)} · ${counts} · ${formatRelative(wf.finishedAt ?? Date.now())}`;
}

export function formatStepTrailLabel(step: MinionWorkflow["steps"][number]): string {
  const meta = step.jobId ? jobMeta.get(step.jobId) : undefined;
  const model = meta?.resolvedModel ?? step.model;
  return `${glyph("› ")}${step.id} · ${step.status} · ${model} · ${formatRelative(step.finishedAt ?? Date.now())}`;
}

// Sentinel id for the top picker's "✓ Completed · N trails" row. Picking
// this opens the trail browser, so openPiMinionsPicker routes this id to
// runTrailBrowser. Distinct from v1's STEP_BACK_SENTINEL_ID (which routed
// back from a step picker); the v2 steps view uses Esc directly to return.
export const TRAIL_SENTINEL_ID = "__pi_minion_completed_trails__";

export function trailSentinelLabel(count: number): string {
  return `${glyph("✓ ")}Completed · ${count} trail${count === 1 ? "" : "s"}`;
}

// === Trail browser =====================================================
//
// One persistent custom overlay with three views (list / steps / detail).
// The list view shows the two completed-sections; the steps view shows a
// finished workflow's steps; the detail view reuses JobDetailModal for a
// chosen job's replay. Esc walks up one view; at the list level it resolves
// the browser promise so openPiMinionsPicker re-presents the top picker.

type View = "list" | "steps" | "detail";

interface BrowserLists {
  jobs: TrailRow[];
  workflows: TrailRow[];
}

class TrailBrowser implements Component {
  private view: View = "list";
  // previousView remembers where detail was opened from, so Esc on detail
  // returns to steps or list (whichever was active) without losing the
  // section cursor the user had in steps view.
  private previousView: View = "list";
  // Cursor for the list (flat across both sections) and the steps view
  // (each). Section-aware on the list: moving past the last job row drops
  // the cursor onto the first workflow row (and vice-versa). Persisted
  // across detail-back: pressing Enter re-enters detail with the cursor
  // where it was, not reset.
  private listCursor = 0;
  private stepsCursor = 0;
  // Viewport scroll offsets — advanced when the cursor moves past the
  // visible window so the cursor stays in view; clamped to
  // [0, max(0, totalRows - bodyRows)]. The browser keeps its own
  // per-view scroll because pi's overlay crops render(width) output to
  // maxHeight: the browser has to render only its visible window.
  private listScrollOffset = 0;
  private stepsScrollOffset = 0;
  private stepsWorkflow: MinionWorkflow | undefined;
  // Detail view's modal + state; setActiveDetail is wired so stream
  // mutators route into this state for the duration of the detail view.
  private detailModal: JobDetailModal | undefined;
  private detailState: ModalState | undefined;
  private tui: TUI | undefined;
  private requestRenderFn: () => void = () => {};

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly jobUI: JobUI,
    private readonly lists: BrowserLists,
    private readonly done: (result: undefined) => void,
    private readonly jobRoot: string
  ) {}

  // Called by the factory once the tui handle is available — wires the
  // overlay's requestRender for both the browser's own frame and the
  // ModalState used by the detail view.
  bind(tui: TUI): void {
    this.tui = tui;
    this.requestRenderFn = () => tui.requestRender();
  }

  invalidate(): void {
    // render() always reads live state.
  }

  dispose(): void {
    // Same teardown the detail-modal's done callback performs: clear
    // active-modal routing and drop the modal reference so a stale
    // handleInput can't reach a closed view.
    if (this.view === "detail") this.clearActiveDetail();
  }

  render(width: number): string[] {
    if (this.view === "detail" && this.detailModal) {
      // The detail view's frame IS the JobDetailModal's frame — both the
      // v1 detail-modal layout and the browser are the same single
      // overlay, so nesting would only double-frame.
      return this.detailModal.render(width);
    }
    if (this.view === "steps") {
      return this.renderStepsFrame(width);
    }
    return this.renderListFrame(width);
  }

  handleInput(data: string): void {
    if (this.view === "detail" && this.detailModal) {
      this.detailModal.handleInput(data);
      return;
    }
    if (matchesKey(data, "up")) {
      if (this.view === "steps") this.moveStepsCursor(-1);
      else this.moveListCursor(-1);
      this.requestRenderFn();
      return;
    }
    if (matchesKey(data, "down")) {
      if (this.view === "steps") this.moveStepsCursor(1);
      else this.moveListCursor(1);
      this.requestRenderFn();
      return;
    }
    if (matchesKey(data, "enter") || data === "\n" || data === "\r") {
      void this.activate();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.exitOneLevel();
    }
  }

  private moveStepsCursor(delta: number): void {
    if (!this.stepsWorkflow) return;
    const total = this.stepsWorkflow.steps.filter((step) => step.jobId !== undefined).length;
    if (total === 0) return;
    this.stepsCursor = clamp(this.stepsCursor + delta, 0, total - 1);
    // Keep the cursor in the visible window. bodyRows is bounded by the
    // same helper the renderer uses, so the viewport is consistent with
    // what the user sees.
    this.stepsScrollOffset = this.scrollToShow(
      this.stepsRowIndex(),
      this.stepsScrollOffset,
      this.buildStepsRows().length
    );
  }

  // Section-aware: -1 at the top of the first section wraps to the bottom
  // of the second; +1 at the bottom of the second wraps to the top of the
  // first.
  private moveListCursor(delta: number): void {
    const { jobs, workflows } = this.lists;
    const total = jobs.length + workflows.length;
    if (total === 0) return;
    this.listCursor = (this.listCursor + delta + total) % total;
    this.listScrollOffset = this.scrollToShow(
      this.listRowIndex(),
      this.listScrollOffset,
      this.buildListRows().length
    );
  }

  private async activate(): Promise<void> {
    if (this.view === "list") {
      const { jobs, workflows } = this.lists;
      if (jobs.length + workflows.length === 0) return;
      if (this.listCursor < jobs.length) {
        const row = jobs[this.listCursor]!;
        const meta = jobMeta.get(row.id);
        if (meta) {
          await this.openDetailForJob({ ...meta, id: row.id });
          this.requestRenderFn();
        }
        return;
      }
      const wfIndex = this.listCursor - jobs.length;
      const wfRow = workflows[wfIndex];
      if (wfRow) {
        const wf = this.findWorkflow(wfRow.id);
        if (wf) {
          this.enterSteps(wf);
          this.requestRenderFn();
        }
      }
      return;
    }
    if (this.view === "steps" && this.stepsWorkflow) {
      const jobId = this.stepJobIdAt(this.stepsCursor);
      if (jobId === undefined) return;
      const meta = jobMeta.get(jobId);
      if (meta) {
        await this.openDetailForJob({ ...meta, id: jobId });
        this.requestRenderFn();
      }
    }
  }

  private stepJobIdAt(index: number): string | undefined {
    if (!this.stepsWorkflow) return undefined;
    let seen = 0;
    for (const step of this.stepsWorkflow.steps) {
      if (step.jobId === undefined) continue;
      if (seen === index) return step.jobId;
      seen++;
    }
    return undefined;
  }

  // Look up a finished workflow by id from the live workflows map (the
  // BrowserLists snapshot only carries ids + labels, not the full record).
  private findWorkflow(id: string): MinionWorkflow | undefined {
    return workflows.get(id);
  }

  private enterSteps(wf: MinionWorkflow): void {
    this.stepsWorkflow = wf;
    const runnable = wf.steps.filter((step) => step.jobId !== undefined).length;
    if (this.stepsCursor >= runnable) this.stepsCursor = 0;
    this.view = "steps";
  }

  // openDetailForJob replaces v1's openTrailModal: stat the job dir, seed
  // a pruned-text block if the log is gone (no backfill), or backfill from
  // stdout.json otherwise, then finishModalJob only for terminal metas. The
  // detail view is inline within the browser — the ModalState is registered
  // via setActiveDetail so applyModalEvent stream mutators still route to
  // it (the v1 contract). detailModal owns the framed rendering and
  // input/key handling; the browser only orchestrates the view transition
  // when its done callback fires.
  private async openDetailForJob(meta: { id: string } & JobMetaEntry): Promise<void> {
    const finished = meta.status !== "running";
    let pruned = false;
    let text: string | undefined;
    let jobDir: string | undefined;
    try {
      jobDir = join(this.jobRoot, meta.id);
      await stat(join(jobDir, "stdout.json"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        pruned = true;
        text = `stream log pruned — report: ${meta.reportPath ?? "(none)"}`;
      } else {
        throw err;
      }
    }
    const state: ModalState = {
      jobId: meta.id,
      title: meta.title,
      model: meta.resolvedModel ?? meta.model,
      effort: meta.effort,
      prompt: meta.prompt,
      blocks: pruned && text ? [{ type: "text", text }] : [],
      finished,
      scrollOffset: 0,
      autoScroll: true,
      requestRender: this.requestRenderFn
    };
    this.detailState = state;
    this.jobUI.setActiveDetail(state);
    if (!pruned) {
      await backfillModal(jobDir!, resolveAdapterForJob(meta.model), this.jobUI, meta.id);
      if (finished) this.jobUI.finishModalJob(meta.id);
    }
    this.detailModal = new JobDetailModal(
      this.ctx,
      // JobDetailModal reads tui.terminal.rows for its body sizing — the
      // browser's tui is the only tui this overlay ever knows about.
      this.tui!,
      state,
      () => this.exitDetail(),
      () => {
        if (this.detailState === state) this.clearActiveDetail();
      }
    );
    this.previousView = this.view;
    this.view = "detail";
  }

  private exitDetail(): void {
    this.clearActiveDetail();
    this.view = this.previousView;
    this.requestRenderFn();
  }

  private clearActiveDetail(): void {
    if (this.detailModal) {
      this.detailModal = undefined;
      this.detailState = undefined;
      this.jobUI.setActiveDetail(undefined);
    }
  }

  private exitOneLevel(): void {
    if (this.view === "detail") {
      this.exitDetail();
      return;
    }
    if (this.view === "steps") {
      this.stepsWorkflow = undefined;
      this.view = "list";
      this.requestRenderFn();
      return;
    }
    // list → exit browser; openPiMinionsPicker re-presents the top picker.
    this.done(undefined);
  }

  // === Rendering =====================================================

  // Box target height, in total lines (including frameLines' 2 border
  // rows). Matches overlayOptions.maxHeight ("70%") the same way
  // JobDetailModal's MODAL_HEIGHT_RATIO does, so the browser's box fills
  // the same screen real estate as the detail modal. Headless/test paths
  // where the tui handle is absent or rows is bogus fall back to a
  // sensible minimum so short content still renders without crashing.
  private targetBoxRows(): number {
    const tuiRows = this.tui?.terminal.rows;
    if (typeof tuiRows !== "number" || !Number.isFinite(tuiRows) || tuiRows <= 0) {
      return 14;
    }
    return Math.max(1, Math.floor(tuiRows * 0.7));
  }

  // Body rows available inside the framed box (targetBoxRows minus top
  // and bottom border rows). Used as the viewport size when content
  // overflows.
  private targetBodyRows(): number {
    return Math.max(1, this.targetBoxRows() - 2);
  }

  // Compute a scroll offset that keeps `rowIndex` in the visible body
  // window. Returns a value in [0, max(0, totalRows - bodyRows)].
  private scrollToShow(rowIndex: number, scrollOffset: number, totalRows: number): number {
    const bodyRows = this.targetBodyRows();
    const maxScroll = Math.max(0, totalRows - bodyRows);
    const clamped = Math.max(0, Math.min(scrollOffset, maxScroll));
    if (rowIndex < clamped) return rowIndex;
    if (rowIndex >= clamped + bodyRows) return rowIndex - bodyRows + 1;
    return clamped;
  }

  // Window of rows to actually render, given the current scroll offset.
  // Auto-sizes: when content fits inside the body window the box shrinks
  // to its natural height; when it overflows, the window is exactly
  // bodyRows tall (a stable size while scrolling). null dividers are
  // preserved so they render as ├──┤ rules in frameLines — never coerce
  // them to "".
  private windowedRows(scrollOffset: number, totalRows: number, source: Array<string | null>): Array<string | null> {
    const bodyRows = this.targetBodyRows();
    const start = Math.max(0, Math.min(scrollOffset, Math.max(0, totalRows - bodyRows)));
    return source.slice(start, start + bodyRows);
  }

  // Builds the full list-view rows once so both the renderer and the
  // cursor-index helper see the same layout. Returns an array indexed
  // by display row position; null = section divider (rendered as a
  // horizontal rule by frameLines), string = content row.
  private buildListRows(): Array<string | null> {
    const theme = this.ctx.ui.theme;
    const innerWidth = Math.max(4, this.lastRenderWidth - 4);
    const { jobs, workflows } = this.lists;
    const rows: Array<string | null> = [
      theme.bold(theme.fg("accent", "Completed trails")),
      null
    ];
    if (jobs.length === 0 && workflows.length === 0) {
      rows.push(theme.fg("muted", "No finished jobs or workflows yet."));
    } else {
      rows.push(this.renderSectionHeader(theme, "Completed jobs", innerWidth));
      if (jobs.length === 0) {
        rows.push(theme.fg("muted", "  (none)"));
      } else {
        jobs.forEach((row, index) => {
          rows.push(this.renderListRow(theme, row, index === this.listCursor, innerWidth));
        });
      }
      rows.push(null);
      rows.push(this.renderSectionHeader(theme, "Completed workflows", innerWidth));
      if (workflows.length === 0) {
        rows.push(theme.fg("muted", "  (none)"));
      } else {
        workflows.forEach((row, index) => {
          const cursor = jobs.length + index;
          rows.push(this.renderListRow(theme, row, cursor === this.listCursor, innerWidth));
        });
      }
    }
    rows.push(null);
    rows.push(theme.fg("muted", "↑↓ navigate  Enter open  Esc/q exit"));
    return rows;
  }

  // Cached terminal width passed to render(width) — the list-row builder
  // needs the same width the renderer used so truncation matches.
  private lastRenderWidth = 80;

  // Row index in buildListRows() of the current cursor's selected item.
  // Returns -1 if no cursor item is selectable (empty state).
  private listRowIndex(): number {
    // Build a parallel structure as the builder did to find the cursor's
    // row, since cursor selection is data-driven (the same shape of
    // sections + items).
    let cursorRow = -1;
    let i = 0;
    // Header (1 row) + null divider = 2 rows consumed.
    i += 2;
    const { jobs: js, workflows: wfs } = this.lists;
    if (js.length === 0 && wfs.length === 0) return cursorRow; // "No finished..." row, no cursor
    i += 1; // section header "Completed jobs"
    if (js.length === 0) {
      i += 1; // "(none)"
    } else {
      if (this.listCursor < js.length) {
        cursorRow = i + this.listCursor;
        return cursorRow;
      }
      i += js.length;
    }
    i += 1; // null divider
    i += 1; // section header "Completed workflows"
    if (wfs.length === 0) {
      i += 1; // "(none)"
    } else {
      const wfIndex = this.listCursor - js.length;
      if (wfIndex >= 0 && wfIndex < wfs.length) {
        cursorRow = i + wfIndex;
      }
    }
    return cursorRow;
  }

  private renderListFrame(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const border = (text: string) => theme.fg("accent", text);
    this.lastRenderWidth = width;
    const rows = this.buildListRows();
    // Keep the cursor in view after every render too — handles initial
    // open at the same scroll state as the last cursor move.
    const cursorRow = this.listRowIndex();
    if (cursorRow >= 0) {
      this.listScrollOffset = this.scrollToShow(cursorRow, this.listScrollOffset, rows.length);
    }
    const visible = this.windowedRows(this.listScrollOffset, rows.length, rows);
    return frameLines(border, width, visible);
  }

  private buildStepsRows(): Array<string | null> {
    const theme = this.ctx.ui.theme;
    const innerWidth = Math.max(4, this.lastRenderWidth - 4);
    const wf = this.stepsWorkflow;
    const rows: Array<string | null> = [];
    if (!wf) return rows;
    // Title bar, matching JobDetailModal: bold accent title on the left,
    // muted metadata right-aligned, then a ├──┤ rule underneath.
    const titlePart = theme.bold(theme.fg("accent", `${glyph("⇉ ")}${wf.title}`));
    const metaPart = theme.fg("muted", `Steps · ${wf.steps.length} total`);
    const gap = Math.max(1, innerWidth - visibleWidth(titlePart) - visibleWidth(metaPart));
    rows.push(`${titlePart}${" ".repeat(gap)}${metaPart}`);
    rows.push(null);
    const steps = wf.steps.filter((step) => step.jobId !== undefined);
    if (steps.length === 0) {
      rows.push(theme.fg("muted", "  (no runnable steps)"));
    } else {
      steps.forEach((step, index) => {
        const isCursor = index === this.stepsCursor;
        rows.push(this.renderStepsRow(theme, formatStepTrailLabel(step), isCursor, innerWidth));
      });
    }
    rows.push(null);
    rows.push(theme.fg("muted", "↑↓ navigate  Enter open detail  Esc back"));
    return rows;
  }

  private stepsRowIndex(): number {
    const wf = this.stepsWorkflow;
    if (!wf) return -1;
    const steps = wf.steps.filter((step) => step.jobId !== undefined);
    if (steps.length === 0) return -1;
    // Title-bar row + null divider = 2 rows consumed before the steps.
    return 2 + this.stepsCursor;
  }

  private renderStepsFrame(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const border = (text: string) => theme.fg("accent", text);
    this.lastRenderWidth = width;
    const wf = this.stepsWorkflow;
    if (!wf) {
      this.view = "list";
      return this.renderListFrame(width);
    }
    const rows = this.buildStepsRows();
    const cursorRow = this.stepsRowIndex();
    if (cursorRow >= 0) {
      this.stepsScrollOffset = this.scrollToShow(cursorRow, this.stepsScrollOffset, rows.length);
    }
    const visible = this.windowedRows(this.stepsScrollOffset, rows.length, rows);
    return frameLines(border, width, visible);
  }

  private renderSectionHeader(theme: Theme, title: string, innerWidth: number): string {
    const tag = theme.fg("syntaxComment", "── ");
    const label = theme.fg("accent", title);
    const trail = theme.fg("syntaxComment", " ──");
    return truncateToWidth(`${tag}${label}${trail}`, innerWidth);
  }

  private renderListRow(theme: Theme, row: TrailRow, isCursor: boolean, innerWidth: number): string {
    const cursor = isCursor ? theme.fg("accent", "❯ ") : "  ";
    const label = isCursor ? theme.bold(row.label) : row.label;
    return truncateToWidth(`${cursor}${label}`, innerWidth);
  }

  private renderStepsRow(theme: Theme, label: string, isCursor: boolean, innerWidth: number): string {
    const cursor = isCursor ? theme.fg("accent", "❯ ") : "  ";
    const text = isCursor ? theme.bold(label) : label;
    return truncateToWidth(`${cursor}${text}`, innerWidth);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Opens the trail browser as a single custom overlay. Resolves when the
// user exits the browser (Esc/q/ctrl+c at the list level) or the ctx goes
// stale. openPiMinionsPicker awaits this before re-presenting the top picker,
// so the user can keep browsing trails across multiple entries.
//
// `listsOverride` is internal/test-only — it bypasses the live snapshot
// from jobMeta/workflows so unit tests can drive the browser with rows
// that don't normally surface (e.g. status: "running" entries that the
// standalone-trails filter would exclude).
export async function runTrailBrowser(
  ctx: ExtensionContext,
  jobUI: JobUI,
  listsOverride?: BrowserLists,
  jobRoot = JOB_ROOT
): Promise<void> {
  const lists: BrowserLists = listsOverride ?? {
    jobs: recentStandaloneTrails(ctx, jobMeta),
    workflows: finishedWorkflowTrails(ctx, workflows)
  };
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  try {
    await ctx.ui.custom<undefined>(
      (tui, _theme, _keybindings, done) => {
        const browser = new TrailBrowser(ctx, jobUI, lists, (r) => {
          done(r);
          resolvePromise();
        }, jobRoot);
        browser.bind(tui);
        return browser;
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" }
      }
    );
  } catch {
    // ctx invalidated by a session reload/new/fork/switchSession while the
    // browser is up. Caller resumes the picker loop; no overlay to close.
  }
  // Ensure the loop's continuation happens once even if pi's custom
  // runtime never called back (e.g. test staves that never invoke done).
  resolvePromise();
  // The detail clear path calls setActiveDetail(undefined) before done, so
  // by the time we reach here the routing is already clean for the exit
  // path; this is the safety net for the catch branch above.
  jobUI.setActiveDetail(undefined);
  await promise;
}