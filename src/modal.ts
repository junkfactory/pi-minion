import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stepNavFor } from "./minion.ui.js";
import type { JobUI, ModalState, StepNav } from "./minion.ui.js";
import type { AgentCliAdapter, NormalizedEvent } from "./adapters/types.js";
import type { JobMetaEntry } from "./job-types.js";
import { getAdapter, listAdapterNames, resolveAdapterForModel } from "./adapters/registry.js";
import { getJobUI, JOB_ROOT, jobMeta } from "./job-store.js";
import { logJobEvent } from "./log.js";
import {
  formatScheduleLabel,
  scheduleIdsOwnedBySession,
  scheduleModel,
  scheduleResolvedModel,
  schedules,
  stopSchedule
} from "./schedule-store.js";
import {
  countFinishedTrails,
  runTrailBrowser,
  TRAIL_SENTINEL_ID,
  trailSentinelLabel
} from "./trail-picker.js";
import { cancelWorkflow, defaultWorkflowDeps } from "./workflow-runner.js";
import {
  workflowPickerRows,
  workflowForJobId,
  workflowIdsOwnedBySession,
  workflowStatus,
  workflows
} from "./workflow-store.js";

// Applies the modal-facing subset of a normalized event — shared by the live
// stream (job-runner.ts's consumeLine) and backfillModal's replay, so both
// render identically. Other event kinds are ignored here. toolDurationFallback
// fills in a wall-clock duration for an adapter whose toolResult reports none.
export function applyModalEvent(
  jobUI: JobUI,
  id: string,
  event: NormalizedEvent,
  toolDurationFallback?: (toolCallId: string) => number | undefined
): void {
  switch (event.kind) {
    case "model":
      jobUI.setModalModel(id, event.model);
      break;
    case "textBlockStart":
      jobUI.startModalTextBlock(id);
      break;
    case "text":
      jobUI.appendModalText(id, event.text);
      break;
    case "toolUse":
      jobUI.startModalToolCall(id, event.id, event.name);
      if (event.args) jobUI.updateModalToolCallArgs(id, event.id, event.args);
      break;
    case "toolUseArgs":
      jobUI.updateModalToolCallArgs(id, event.id, event.args);
      break;
    case "toolResult":
      jobUI.finishModalToolCall(id, event.id, {
        durationMs: event.durationMs ?? toolDurationFallback?.(event.id),
        output: event.output,
        isError: event.isError
      });
      break;
  }
}

// Replays a job's stored stdout.json events against its already-open modal,
// in original order — so tool-call rows land interleaved at their real
// position instead of appended after a flattened text blob. Used by the
// live picker to backfill a late-opened modal, and by the trail browser's
// detail view (which registers its ModalState via setActiveDetail so stream
// routing still flows into the same state this writes to).
// `state`, when given, is the modal a step loader is backfilling: its event
// hold is lifted for the replay, because the replay must land *before* the
// live chunks that queued while this read was still pending. The replay loop
// is synchronous, so nothing live can slip in between; the hold is restored
// for the loader to flush the queue behind the replayed history.
export async function backfillModal(
  jobDir: string,
  adapter: AgentCliAdapter,
  jobUI: JobUI,
  id: string,
  state?: ModalState
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(jobDir, "stdout.json"), "utf8");
  } catch {
    return;
  }
  const holding = state?.holding;
  if (state) state.holding = false;
  try {
    for (const line of raw.split(/\r?\n/)) {
      // One malformed stored line (a torn write, a truncated tail) must not
      // abort the replay of the rest of the job's history.
      try {
        for (const event of adapter.parseLine(line)) applyModalEvent(jobUI, id, event);
      } catch {
        continue;
      }
    }
  } finally {
    if (state) state.holding = holding;
  }
}

// The header/fallback fields a preview needs; the picker's fallback object
// and a jobMeta entry both satisfy it. turnsSeen/maxTurns are optional so the
// picker's fallback (which has no turn history) still satisfies it.
type JobPreviewMeta = Pick<
  JobMetaEntry,
  "title" | "model" | "effort" | "prompt" | "resolvedModel" | "turnsSeen" | "maxTurns"
>;

// Header for a ←/→ sibling the picker holds no metadata for (its jobMeta can
// be pruned, e.g. by a session replacement). A visible unknown beats showing
// the originally opened job's title/model/prompt under another step's jobId.
const unknownStepMeta: JobPreviewMeta = { title: "pi minion step", model: "?", prompt: "" };

// The open/switch tail shared by a fresh preview and a ←/→ step switch:
// retarget the mounted state, replay the job's stored events into it, then
// mark a terminal jobMeta finished so the modal shows its finished marker
// instead of a spinner (mirrors trail-picker's openDetailForJob).
// `state.jobId` doubles as the swap's sequence token: a later ←/→ press moves
// it before this load's await resolves, and the stored replay is then dropped
// instead of interleaving two backfills (its streamed events are already
// dropped by the same jobId routing gate in minion.ui.ts).
// Live events for this job route into the same state while the read is in
// flight, so the load holds them from the synchronous prefix (before the
// first await — that is the only window where nothing has been replayed yet)
// and flushes them after the replay, keeping new chunks below older history.
export async function loadJobIntoModal(
  jobUI: JobUI,
  state: ModalState,
  id: string,
  meta: JobPreviewMeta
): Promise<void> {
  state.jobId = id;
  state.title = meta.title;
  state.model = meta.resolvedModel ?? meta.model;
  state.effort = meta.effort;
  state.prompt = meta.prompt;
  // A running job's live count (seeded by openModal and by the ←/→ swap) wins;
  // the live registry drops a job the instant it finishes, so a finished
  // step's frozen jobMeta count fills the gap and keeps its turn badge.
  state.turns ??=
    meta.turnsSeen !== undefined ? { current: meta.turnsSeen, max: meta.maxTurns } : undefined;
  state.blocks = [];
  state.finished = false;
  state.requestRender();
  jobUI.holdModalEvents(id);
  await backfillModal(join(JOB_ROOT, id), resolveAdapterForJob(meta.model), jobUI, id, state);
  if (state.jobId !== id) return;
  // Ahead of the terminal marker: a queued live event lands on the replayed
  // history, and finishModalJob's own marker (queued or not) comes last.
  jobUI.flushModalEvents(id);
  const stored = jobMeta.get(id);
  if (stored && stored.status !== "running") jobUI.finishModalJob(id);
}

// Opens a job's preview modal: live stream if the job is running
// (applyModalEvent routing), else a replay of stdout.json from disk. `nav`,
// when given, lets ←/→ switch to a sibling workflow step in place.
export async function openJobPreview(
  jobUI: JobUI,
  id: string,
  meta: JobPreviewMeta,
  nav?: StepNav
): Promise<void> {
  // openModal creates the modal state synchronously and its own promise
  // settles on close, so the initial load's promise is captured from the
  // loader openModal runs at creation — openJobPreview resolves once the
  // first job has been replayed, as it always has.
  let initial: Promise<void> = Promise.resolve();
  jobUI.openModal(
    id,
    {
      title: meta.title,
      model: meta.resolvedModel ?? meta.model,
      effort: meta.effort,
      prompt: meta.prompt
    },
    nav,
    (state, nextId) => {
      // The picker's own meta describes the id it opened; for a sibling with
      // no jobMeta left, show the placeholder rather than this job's header.
      const stepMeta = jobMeta.get(nextId) ?? (nextId === id ? meta : unknownStepMeta);
      const load = loadJobIntoModal(jobUI, state, nextId, stepMeta);
      if (nextId === id) initial = load;
      return load;
    }
  );
  await initial;
}

// A job's recorded model (or the "?" placeholder when even jobMeta has no
// entry for it, e.g. after a session replacement) may not resolve to a
// registered adapter — best-effort fall back to whichever adapter is
// registered first rather than fail the picker over stale/missing metadata.
// With an empty registry (no CLI installed yet) there is no first adapter;
// fall back to a no-op parser so backfillModal still runs and just replays
// nothing instead of throwing over stale/missing metadata.
const unresolvableAdapter: AgentCliAdapter = {
  name: "none",
  command: "none",
  description: "no pi-minion adapter is registered",
  installHint: "",
  rawOutputHint: "",
  permissionDeniedWarning: "",
  capabilities: { supportsAllowedTools: false, supportsEffort: false, supportsMaxBudgetUsd: false },
  rawOwnsModel: () => false,
  ownsModel: () => false,
  availableModels: () => [],
  providersOf: () => [],
  buildArgs: () => [],
  environment: () => ({}),
  parseLine: () => [],
  describeUnsupported: () => [],
  usageNotes: () => []
};

export function resolveAdapterForJob(model: string): AgentCliAdapter {
  try {
    return resolveAdapterForModel(model);
  } catch {
    const names = listAdapterNames();
    return names.length > 0 ? getAdapter(names[0]) : unresolvableAdapter;
  }
}

// cancelWorkflow is false when the workflow finished while the confirm was open.
export function cancelWorkflowMessage(title: string, cancelled: boolean): string {
  return cancelled
    ? `Pi minion workflow "${title}" cancelled.`
    : `Pi minion workflow "${title}" already finished.`;
}

// === Top-level picker loop =============================================
//
// Builds the row list from live state on every pass, so a job that
// finishes (or a schedule that ticks) while the user is in the picker
// shows up the next time the picker re-presents. Live rows stay
// byte-identical to v1: `pick()`'s internal jobs-map entries, running
// workflows' ⇉ cancel-confirm rows, schedule rows. The only trail-related
// row in this picker is the one "✓ Completed · N trails" sentinel — picking
// it routes into runTrailBrowser (the trail browser owns everything trail-
// browsing). After the browser closes, the loop continues so the user can
// pick another entry without leaving /pi-minions.
export async function openPiMinionsPicker(ctx: ExtensionContext): Promise<void> {
  const jobUI = getJobUI(ctx);
  const sessionId = ctx.sessionManager.getSessionId();
  while (true) {
    const scheduleRows = scheduleIdsOwnedBySession(schedules, sessionId).map((id) => {
      const schedule = schedules.get(id)!;
      return {
        id,
        label: formatScheduleLabel(
          schedule,
          schedule.job.nextRun(),
          schedule.kind === "workflow" ? undefined : scheduleResolvedModel(schedule)
        )
      };
    });
    const workflowRows = workflowIdsOwnedBySession(workflows, sessionId)
      .filter((id) => workflowStatus(workflows.get(id)!) === "running")
      .flatMap((id) => workflowPickerRows(id, workflows.get(id)!));
    const finishedCount = countFinishedTrails(ctx, jobMeta, workflows);
    // One sentinel, hidden when there are no finished trails to browse.
    // Lives alongside pick()'s other extras; the picker renders it as just
    // another row.
    const trailSentinelRow =
      finishedCount > 0
        ? [{ id: TRAIL_SENTINEL_ID, label: trailSentinelLabel(finishedCount) }]
        : [];
    const id = await jobUI.pick([...workflowRows, ...scheduleRows, ...trailSentinelRow]);
    if (id === undefined) return;

    if (id === TRAIL_SENTINEL_ID) {
      // The browser owns all trail browsing; loop continues once it closes
      // so the top picker re-presents with a fresh snapshot.
      await runTrailBrowser(ctx, jobUI);
      continue;
    }

    const workflow = workflows.get(id);
    if (workflow) {
      if (workflowStatus(workflow) === "running") {
        // Today's cancel-confirm path, byte-identical: a workflow row in
        // workflowRows is by construction running, so any branch the user
        // reaches here through that filter is the cancel path.
        if (await ctx.ui.confirm("Cancel workflow?", workflow.title)) {
          ctx.ui.notify(
            cancelWorkflowMessage(workflow.title, cancelWorkflow(id, defaultWorkflowDeps)),
            "info"
          );
        }
        return;
      }
      // Finished workflows no longer have an in-picker branch — the trail
      // browser (entered via the sentinel) lists them in its Completed
      // workflows section. Falling through to today's "unknown id" no-op
      // preserves the loop's iteration count.
      return;
    }

    const schedule = schedules.get(id);
    if (schedule) {
      // Today's stop path, unchanged.
      if (await ctx.ui.confirm("Stop schedule?", `${schedule.title} (${schedule.cron})`)) {
        stopSchedule(id);
        void logJobEvent("unscheduled", { id, model: scheduleModel(schedule) });
        ctx.ui.notify(`Pi minion schedule "${schedule.title}" stopped.`, "info");
      }
      return;
    }

    // Running row / unknown id — the preview helper owns openModal + backfill.
    const fallback = jobMeta.get(id) ?? {
      title: "pi minion task",
      model: "?",
      prompt: "",
      workspace: ctx.cwd,
      sessionId,
      status: "running" as const
    };
    // A workflow step previews with ←/→ across its siblings; standalone jobs
    // and schedules pass no nav context, so their behavior is unchanged.
    const owner = workflowForJobId(workflows, id);
    await openJobPreview(jobUI, id, fallback, owner ? stepNavFor(owner.steps, id) : undefined);
    return;
  }
}