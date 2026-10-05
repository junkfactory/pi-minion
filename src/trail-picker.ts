import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  headerRow,
  jobDetailScrollKeys,
  renderFrame,
  Viewport,
  type FrameSpec
} from "./modal-shell.js";
import {
  jobDetailSpec,
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
// finished workflow's steps; the detail view renders jobDetailSpec for a
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
  // One viewport per view (list / steps / detail); renderFrame owns the
  // window sizing and keeps the cursor row visible inside it. Pi's overlay
  // crops render(width) output to maxHeight, so the frame renders only its
  // visible window.
  private readonly listViewport = new Viewport();
  private readonly stepsViewport = new Viewport();
  private readonly detailViewport = new Viewport();
  private stepsWorkflow: MinionWorkflow | undefined;
  // Detail view's state; setActiveDetail is wired so stream mutators route
  // into this state for the duration of the detail view.
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
    // Clear active-modal routing and drop the state so a stale handleInput
    // can't reach a closed view.
    if (this.view === "detail") this.clearActiveDetail();
  }

  render(width: number): string[] {
    if (this.view === "detail" && this.detailState) {
      // The detail view and the browser are the same single overlay, so
      // jobDetailSpec's frame IS the browser's frame — no nesting.
      return renderFrame(jobDetailSpec(this.detailState), {
        theme: this.ctx.ui.theme,
        tui: this.tui!,
        viewport: this.detailViewport,
        width
      });
    }
    if (this.view === "steps") {
      return this.renderStepsFrame(width);
    }
    return this.renderListFrame(width);
  }

  handleInput(data: string): void {
    if (this.view === "detail" && this.detailState) {
      // esc/ctrl+c/q exit detail through api.done, matching the old
      // detail-modal done contract; unclaimed keys fall through.
      const api = {
        viewport: this.detailViewport,
        requestRender: this.requestRenderFn,
        done: () => this.exitDetail()
      };
      if (jobDetailScrollKeys(data, api)) return;
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
  }

  // Section-aware: -1 at the top of the first section wraps to the bottom
  // of the second; +1 at the bottom of the second wraps to the top of the
  // first.
  private moveListCursor(delta: number): void {
    const { jobs, workflows } = this.lists;
    const total = jobs.length + workflows.length;
    if (total === 0) return;
    this.listCursor = (this.listCursor + delta + total) % total;
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
  // it (the v1 contract). The browser renders jobDetailSpec over that state
  // and routes input through jobDetailScrollKeys.
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
      requestRender: this.requestRenderFn
    };
    this.detailState = state;
    this.jobUI.setActiveDetail(state);
    if (!pruned) {
      await backfillModal(jobDir!, resolveAdapterForJob(meta.model), this.jobUI, meta.id);
      if (finished) this.jobUI.finishModalJob(meta.id);
    }
    this.previousView = this.view;
    this.view = "detail";
  }

  private exitDetail(): void {
    this.clearActiveDetail();
    this.view = this.previousView;
    this.requestRenderFn();
  }

  private clearActiveDetail(): void {
    if (!this.detailState) return;
    this.detailState = undefined;
    this.jobUI.setActiveDetail(undefined);
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

  // List view: bold accent title + trailing rule; the two completed
  // sections (with muted in-content rules); cursor kept visible inside the
  // body window. No fill/indicator rows.
  private listSpec(): FrameSpec {
    return {
      border: (theme) => (text) => theme.fg("accent", text),
      titleRows: ({ theme }) => [theme.bold(theme.fg("accent", "Completed trails")), null],
      body: ({ theme, innerWidth }) => ({
        rows: this.listBodyRows(theme, innerWidth),
        cursorRow: this.listRowIndex()
      }),
      footerRows: ({ theme }) => [null, theme.fg("muted", "↑↓ navigate  Enter open  Esc/q exit")]
    };
  }

  // Body rows of the list view, without title/footer chrome. null = ambient
  // separators (frameLines draws ├──┤); section dividers use mutedRule() so
  // only the title/footer chrome keeps the accent border.
  private listBodyRows(theme: Theme, innerWidth: number): Array<string | null> {
    const { jobs, workflows } = this.lists;
    const rows: Array<string | null> = [];
    if (jobs.length === 0 && workflows.length === 0) {
      rows.push(theme.fg("muted", "No finished jobs or workflows yet."));
      return rows;
    }
    rows.push(this.renderSectionHeader(theme, "Completed jobs", innerWidth));
    if (jobs.length === 0) {
      rows.push(theme.fg("muted", "  (none)"));
    } else {
      jobs.forEach((row, index) => {
        rows.push(this.renderListRow(theme, row, index === this.listCursor, innerWidth));
      });
    }
    rows.push(this.mutedRule(innerWidth));
    rows.push(this.renderSectionHeader(theme, "Completed workflows", innerWidth));
    if (workflows.length === 0) {
      rows.push(theme.fg("muted", "  (none)"));
    } else {
      workflows.forEach((row, index) => {
        const cursor = jobs.length + index;
        rows.push(this.renderListRow(theme, row, cursor === this.listCursor, innerWidth));
      });
    }
    return rows;
  }

  // Row index in listBodyRows() of the current cursor's selected item.
  // Returns -1 if no cursor item is selectable (empty state).
  private listRowIndex(): number {
    let i = 0;
    const { jobs: js, workflows: wfs } = this.lists;
    if (js.length === 0 && wfs.length === 0) return -1; // "No finished..." row, no cursor
    i += 1; // section header "Completed jobs"
    if (js.length === 0) {
      i += 1; // "(none)"
    } else {
      if (this.listCursor < js.length) return i + this.listCursor;
      i += js.length;
    }
    i += 1; // muted rule
    i += 1; // section header "Completed workflows"
    if (wfs.length === 0) {
      i += 1; // "(none)"
    } else {
      const wfIndex = this.listCursor - js.length;
      if (wfIndex >= 0 && wfIndex < wfs.length) return i + wfIndex;
    }
    return -1;
  }

  private renderListFrame(width: number): string[] {
    return renderFrame(this.listSpec(), {
      theme: this.ctx.ui.theme,
      tui: this.tui!,
      viewport: this.listViewport,
      width
    });
  }

  // Steps view: bold accent title via headerRow with a right-aligned step
  // count, then the runnable steps; same cursor-visible windowing as list.
  private stepsSpec(wf: MinionWorkflow): FrameSpec {
    return {
      border: (theme) => (text) => theme.fg("accent", text),
      titleRows: ({ theme, innerWidth }) => [
        headerRow(
          theme,
          theme.bold(theme.fg("accent", `${glyph("⇉ ")}${wf.title}`)),
          theme.fg("muted", `Steps · ${wf.steps.length} total`),
          innerWidth
        ),
        null
      ],
      body: ({ theme, innerWidth }) => ({
        rows: this.stepsBodyRows(theme, wf, innerWidth),
        cursorRow: this.stepsRowIndex()
      }),
      footerRows: ({ theme }) => [null, theme.fg("muted", "↑↓ navigate  Enter open detail  Esc back")]
    };
  }

  private stepsBodyRows(theme: Theme, wf: MinionWorkflow, innerWidth: number): Array<string | null> {
    const rows: Array<string | null> = [];
    const steps = wf.steps.filter((step) => step.jobId !== undefined);
    if (steps.length === 0) {
      rows.push(theme.fg("muted", "  (no runnable steps)"));
    } else {
      steps.forEach((step, index) => {
        const isCursor = index === this.stepsCursor;
        rows.push(this.renderStepsRow(theme, formatStepTrailLabel(step), isCursor, innerWidth));
      });
    }
    return rows;
  }

  // Non-title, non-footer divider: a muted full-width rule rendered as a
  // content row (the detail spec's in-content separator pattern). The
  // title-bar and footer-bar rules stay full-strength ├──┤ null dividers.
  private mutedRule(innerWidth: number): string {
    return this.ctx.ui.theme.fg("borderMuted", "─".repeat(innerWidth));
  }

  private stepsRowIndex(): number {
    const wf = this.stepsWorkflow;
    if (!wf) return -1;
    const steps = wf.steps.filter((step) => step.jobId !== undefined);
    if (steps.length === 0) return -1;
    return this.stepsCursor;
  }

  private renderStepsFrame(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const wf = this.stepsWorkflow;
    if (!wf) {
      this.view = "list";
      return this.renderListFrame(width);
    }
    return renderFrame(this.stepsSpec(wf), {
      theme,
      tui: this.tui!,
      viewport: this.stepsViewport,
      width
    });
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