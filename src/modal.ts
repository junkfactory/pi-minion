import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobUI } from "./agent.ui.js";
import type { AgentCliAdapter, NormalizedEvent } from "./adapters/types.js";
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
export async function backfillModal(
  jobDir: string,
  adapter: AgentCliAdapter,
  jobUI: JobUI,
  id: string
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(jobDir, "stdout.json"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    for (const event of adapter.parseLine(line)) applyModalEvent(jobUI, id, event);
  }
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
  describeUnsupported: () => []
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

    // Running row / unknown id — today's openModal + backfill, unchanged.
    const fallback = jobMeta.get(id) ?? {
      title: "pi minion task",
      model: "?",
      prompt: "",
      workspace: ctx.cwd,
      sessionId,
      status: "running" as const
    };
    jobUI.openModal(id, {
      title: fallback.title,
      model: fallback.resolvedModel ?? fallback.model,
      effort: fallback.effort,
      prompt: fallback.prompt
    });
    await backfillModal(join(JOB_ROOT, id), resolveAdapterForJob(fallback.model), jobUI, id);
    return;
  }
}