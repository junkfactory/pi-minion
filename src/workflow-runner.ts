import { randomUUID } from "node:crypto";
import type { MinionRequest } from "./adapters/types.js";
import type { JobUI, StepRunStats } from "./agent.ui.js";
import type { WorkflowSession } from "./child-session.js";
import {
  clearJobViews,
  markJobFinished,
  peekJobUI,
  postToSession,
  stopJob
} from "./job-store.js";
import { distinctModels } from "./format.js";
import { logJobEvent, type JobLogEvent } from "./log.js";
import { hasStopMarker, STOP_SCHEDULE_INSTRUCTION, schedules, stopSchedule } from "./schedule-store.js";
import {
  formatWorkflowSummary,
  isWorkflowRunning,
  MAX_PARALLEL_STEPS,
  newWorkflow,
  renderStepTask,
  terminalStepIds,
  workflows,
  workflowStepTitle,
  workflowWidgetStatus,
  type MinionWorkflow,
  type WorkflowStep
} from "./workflow-store.js";

export type StepOutcome = { finalResult?: string; reportPath?: string; ok: boolean } & Partial<StepRunStats>;

// Everything the runner touches outside its own workflow record, injected so
// tests can drive it without spawning processes.
export type WorkflowDeps = {
  // Starts one step as an ordinary job (job-runner.ts's startJob) and
  // resolves to its job id; `onSettled` fires once when the job exits.
  startStep: (
    request: MinionRequest,
    wf: MinionWorkflow,
    onSettled: (outcome: StepOutcome) => void,
    step: { title: string; id: string },
    // Checked right before spawning; true means the step was cancelled while
    // starting, so startStep must reject without spawning.
    isCancelled: () => boolean
  ) => Promise<string>;
  stopStep: (jobId: string) => void;
  ui: () => JobUI | undefined;
  post: (
    sessionId: string,
    content: string,
    details: Record<string, unknown>,
    triggerTurn: boolean
  ) => void;
  log: (event: JobLogEvent, info: { id: string; model: string; detail?: string }) => void;
  // The workflow's own /resume session, which its steps' sessions nest under.
  // Optional so tests needn't write sessions; a throw just skips grouping.
  startSession?: (wf: MinionWorkflow) => WorkflowSession | undefined;
};

// What cancelling needs; startStep is only for starting.
export const defaultWorkflowDeps: Omit<WorkflowDeps, "startStep"> = {
  stopStep: (jobId) => {
    stopJob(jobId);
    markJobFinished(jobId, "cancelled");
    const ui = peekJobUI();
    if (ui) clearJobViews(ui, jobId);
  },
  ui: peekJobUI,
  post: postToSession,
  log: (event, info) => void logJobEvent(event, info)
};

const BLOCKED = new Set(["failed", "skipped", "cancelled"]);

function logInfo(id: string, wf: MinionWorkflow, detail?: string) {
  return {
    id,
    model: distinctModels(wf.steps),
    detail: `title="${wf.title}" steps=${wf.steps.length}${detail ? ` ${detail}` : ""}`
  };
}

function syncUi(id: string, wf: MinionWorkflow, deps: Pick<WorkflowDeps, "ui">): void {
  deps.ui()?.setWorkflow(id, workflowWidgetStatus(wf));
}

// Posts the one summary and removes the tree. Idempotent; a requested
// cancel posts quietly (the user already knows), a natural finish starts
// the turn that reports back.
// A scheduled run is quiet unless a final step ended the schedule or no step
// succeeded (a broken schedule would otherwise fail silently every tick).
function finishWorkflow(
  id: string,
  wf: MinionWorkflow,
  triggerTurn: boolean,
  deps: Pick<WorkflowDeps, "ui" | "post" | "log">
): void {
  if (wf.finishedAt !== undefined) return;
  wf.finishedAt = Date.now();
  deps.ui()?.clearWorkflow(id);
  deps.log(wf.cancelled ? "workflow_cancelled" : "workflow_finished", logInfo(id, wf));
  let note: string | undefined;
  if (wf.stopRequested && wf.scheduled?.stop()) {
    deps.log("unscheduled", logInfo(id, wf, "self_stop"));
    note = `"${wf.title}" ended itself; the final step reported the task complete.`;
  }
  const allFailed = wf.scheduled !== undefined && !wf.cancelled && wf.steps.every((step) => step.status !== "done");
  const summary = formatWorkflowSummary(wf, note, allFailed ? "no step of this scheduled run succeeded." : undefined);
  try {
    wf.session?.finish(summary);
  } catch {}
  deps.post(
    wf.sessionId,
    summary,
    { id, steps: wf.steps.map((step) => ({ id: step.id, status: step.status, jobId: step.jobId })) },
    triggerTurn && (!wf.scheduled || note !== undefined || allFailed)
  );
}

// Starts every pending step whose dependencies are all done (up to
// MAX_PARALLEL_STEPS running), skips steps behind a dead dependency, and
// finishes once nothing is pending or running. Independent branches keep going.
function pump(id: string, wf: MinionWorkflow, deps: WorkflowDeps): void {
  if (wf.cancelled || wf.finishedAt !== undefined) return;
  const byId = new Map(wf.steps.map((step) => [step.id, step]));
  // Skips can cascade down a chain, so repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const step of wf.steps) {
      if (step.status === "pending" && step.dependsOn.some((dep) => BLOCKED.has(byId.get(dep)!.status))) {
        step.status = "skipped";
        changed = true;
      }
    }
  }
  let running = wf.steps.filter((step) => step.status === "running").length;
  for (const step of wf.steps) {
    if (running >= MAX_PARALLEL_STEPS) break;
    if (step.status !== "pending" || !step.dependsOn.every((dep) => byId.get(dep)!.status === "done")) {
      continue;
    }
    running++;
    startStep(id, wf, step, deps);
  }
  syncUi(id, wf, deps);
  if (wf.steps.every((step) => step.status !== "pending" && step.status !== "running")) {
    finishWorkflow(id, wf, true, deps);
  }
}

function startStep(id: string, wf: MinionWorkflow, step: WorkflowStep, deps: WorkflowDeps): void {
  step.status = "running";
  const settle = (outcome: StepOutcome) => {
    // A cancelled step's job still exits and reports; ignore it.
    if (step.status !== "running") return;
    step.status = outcome.ok ? "done" : "failed";
    step.result = outcome.finalResult;
    step.reportPath = outcome.reportPath;
    step.startedAt = outcome.startedAt;
    step.finishedAt = outcome.finishedAt;
    step.tokenUsage = outcome.tokenUsage;
    if (outcome.ok && wf.scheduled && terminalStepIds(wf.steps).has(step.id) && hasStopMarker(outcome.finalResult)) {
      wf.stopRequested = true;
    }
    pump(id, wf, deps);
  };
  const request: MinionRequest = {
    task:
      renderStepTask(step.task, wf.steps, wf.maxResultPreviewBytes, step.dependsOn) +
      (wf.scheduled && terminalStepIds(wf.steps).has(step.id) ? STOP_SCHEDULE_INSTRUCTION : ""),
    workspace: wf.cwd,
    model: step.model,
    effort: step.effort,
    context: wf.context,
    maxBudgetUsd: step.maxBudgetUsd ?? wf.maxBudgetUsd
  };
  const isCancelled = () => step.status !== "running";
  deps.startStep(request, wf, settle, { title: workflowStepTitle(wf.title, step.id), id: step.id }, isCancelled).then(
    (jobId) => {
      if (step.status === "running") {
        step.jobId = jobId;
        syncUi(id, wf, deps);
      } else if (step.status === "cancelled") {
        // Cancelled while still spawning; the job exists now, so stop it.
        deps.stopStep(jobId);
      }
    },
    () => settle({ ok: false })
  );
}

export function startWorkflow(id: string, deps: WorkflowDeps): void {
  const wf = workflows.get(id);
  if (!wf) return;
  deps.log("workflow_started", logInfo(id, wf));
  try {
    wf.session = deps.startSession?.(wf);
  } catch {
    // Best-effort, like child sessions: steps then thread under the caller.
  }
  pump(id, wf, deps);
}

// Marks pending steps cancelled, stops running ones, and posts the summary
// quietly. False if the workflow is unknown or already over.
export function cancelWorkflow(
  id: string,
  deps: Omit<WorkflowDeps, "startStep">
): boolean {
  const wf = workflows.get(id);
  if (!wf || wf.finishedAt !== undefined) return false;
  wf.cancelled = true;
  for (const step of wf.steps) {
    if (step.status !== "pending" && step.status !== "running") continue;
    const wasRunning = step.status === "running";
    step.status = "cancelled";
    if (wasRunning && step.jobId) deps.stopStep(step.jobId);
  }
  finishWorkflow(id, wf, false, deps);
  return true;
}

// One cron tick of a workflow schedule: skipped while the previous workflow
// is still running, otherwise a fresh workflow built from the schedule's
// definition. Returns what happened.
export function tickWorkflowSchedule(scheduleId: string, deps: WorkflowDeps): "skipped" | "started" | undefined {
  const schedule = schedules.get(scheduleId);
  if (schedule?.kind !== "workflow") return undefined;
  const { def } = schedule;
  const models = distinctModels(def.steps);
  if (isWorkflowRunning(workflows, schedule.lastWorkflowId)) {
    schedule.skipped++;
    deps.log("skipped", {
      id: scheduleId,
      model: models,
      detail: `running_workflow_id=${schedule.lastWorkflowId}`
    });
    return "skipped";
  }
  const id = randomUUID();
  workflows.set(
    id,
    newWorkflow(def, {
      defaultEffort: schedule.effort,
      maxResultPreviewBytes: schedule.maxResultPreviewBytes,
      cwd: schedule.cwd,
      sessionId: schedule.sessionId,
      sessionFile: schedule.sessionFile,
      scheduled: { stop: () => stopSchedule(scheduleId) }
    })
  );
  schedule.lastWorkflowId = id;
  schedule.runs++;
  startWorkflow(id, deps);
  return "started";
}
