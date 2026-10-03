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
// position instead of appended after a flattened text blob.
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
function resolveAdapterForJob(model: string): AgentCliAdapter {
  try {
    return resolveAdapterForModel(model);
  } catch {
    return getAdapter(listAdapterNames()[0]);
  }
}

// cancelWorkflow is false when the workflow finished while the confirm was open.
export function cancelWorkflowMessage(title: string, cancelled: boolean): string {
  return cancelled
    ? `Pi minion workflow "${title}" cancelled.`
    : `Pi minion workflow "${title}" already finished.`;
}

export async function openPiMinionsPicker(ctx: ExtensionContext): Promise<void> {
  const jobUI = getJobUI(ctx);
  const scheduleRows = scheduleIdsOwnedBySession(schedules, ctx.sessionManager.getSessionId()).map(
    (id) => {
      const schedule = schedules.get(id)!;
      return {
        id,
        label: formatScheduleLabel(
          schedule,
          schedule.job.nextRun(),
          schedule.kind === "workflow" ? undefined : scheduleResolvedModel(schedule)
        )
      };
    }
  );
  const workflowRows = workflowIdsOwnedBySession(workflows, ctx.sessionManager.getSessionId())
    .filter((id) => workflowStatus(workflows.get(id)!) === "running")
    .flatMap((id) => workflowPickerRows(id, workflows.get(id)!));
  const id = await jobUI.pick([...workflowRows, ...scheduleRows]);
  if (!id) return;
  const workflow = workflows.get(id);
  if (workflow) {
    if (await ctx.ui.confirm("Cancel workflow?", workflow.title)) {
      ctx.ui.notify(
        cancelWorkflowMessage(workflow.title, cancelWorkflow(id, defaultWorkflowDeps)),
        "info"
      );
    }
    return;
  }
  const schedule = schedules.get(id);
  if (schedule) {
    if (await ctx.ui.confirm("Stop schedule?", `${schedule.title} (${schedule.cron})`)) {
      stopSchedule(id);
      void logJobEvent("unscheduled", { id, model: scheduleModel(schedule) });
      ctx.ui.notify(`Pi minion schedule "${schedule.title}" stopped.`, "info");
    }
    return;
  }
  const meta = jobMeta.get(id) ?? {
    title: "pi minion task",
    model: "?",
    prompt: "",
    workspace: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    status: "running" as const
  };
  const adapter = resolveAdapterForJob(meta.model);
  jobUI.openModal(id, {
    title: meta.title,
    model: meta.resolvedModel ?? meta.model,
    effort: meta.effort,
    prompt: meta.prompt
  });
  await backfillModal(join(JOB_ROOT, id), adapter, jobUI, id);
}
