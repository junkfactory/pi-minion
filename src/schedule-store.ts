import type { Cron } from "croner";
import type { MinionRequest } from "./adapters/types.js";
import { distinctModels } from "./format.js";
import { glyph } from "./glyphs.js";
import type { JobMetaEntry } from "./job-types.js";
import type { WorkflowDef } from "./workflow-store.js";

// Session-lifetime only (never persisted): each tick calls job-runner.ts's
// startJob() with the values captured here, so a scheduled run is an ordinary
// job everywhere else (widget, picker, modal, result post, child session).
// A "workflow" schedule instead starts a whole workflow per tick.
type ScheduleBase = {
  title: string;
  cron: string;
  // request.effort, or pi-minion.json's defaultEffort when omitted.
  effort: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  job: Cron;
  runs: number;
  skipped: number;
};

export type JobSchedule = ScheduleBase & {
  kind?: "job";
  // Already validated, with workspace filled in from ctx.cwd.
  request: MinionRequest;
  lastJobId?: string;
  // The latest run's jobMeta entry, held by reference: job-runner.ts fills
  // in resolvedModel on this same object, and pruneJobMeta only drops it
  // from the map, so the reference outlives pruning.
  lastRun?: JobMetaEntry;
  // Carried over from the previous run at each tick, so the picker keeps the
  // real model id while a new run hasn't reported its own yet.
  resolvedModel?: string;
};

export type WorkflowSchedule = ScheduleBase & {
  kind: "workflow";
  // Already validated; every tick runs a fresh workflow built from it.
  def: WorkflowDef;
  // pi-minion.json's maxResultPreviewBytes at schedule time.
  maxResultPreviewBytes: number;
  lastWorkflowId?: string;
};

export type MinionSchedule = JobSchedule | WorkflowSchedule;

export const schedules = new Map<string, MinionSchedule>();

// Same as job-store.ts's rehomeJobs, for schedules: later ticks run under
// the replacement session and thread their child sessions under its file.
export function rehomeSchedules(from: string, to: string, sessionFile: string | undefined): void {
  for (const schedule of schedules.values()) {
    if (schedule.sessionId !== from) continue;
    schedule.sessionId = to;
    schedule.sessionFile = sessionFile;
  }
}

// Stops future ticks only — an in-flight run started by this schedule keeps
// going and is cancelled like any other job (cancel_pi_minion).
export function stopSchedule(id: string): boolean {
  const schedule = schedules.get(id);
  if (!schedule) return false;
  schedule.job.stop();
  schedules.delete(id);
  return true;
}

// Same rationale as job-store.ts's jobIdsOwnedBySession: extensions are
// shared by every session in the process, so a "quit" must only reap its own.
export function scheduleIdsOwnedBySession(
  schedules: ReadonlyMap<string, { sessionId: string }>,
  sessionId: string
): string[] {
  return [...schedules.entries()]
    .filter(([, schedule]) => schedule.sessionId === sessionId)
    .map(([id]) => id);
}

export function resolveOwnedSchedule(
  schedules: ReadonlyMap<string, { sessionId: string }>,
  id: string,
  sessionId: string
): boolean {
  return schedules.get(id)?.sessionId === sessionId;
}

// "14:05" for later today, "Oct 2 14:05" for any other day, "—" when the
// cron has no further runs.
export function formatNextRun(date: Date | null, now: Date = new Date()): string {
  if (!date) return "—";
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

// The model(s) a schedule runs, for logs: one alias, or a workflow's distinct step models.
export function scheduleModel(schedule: MinionSchedule): string {
  return schedule.kind === "workflow"
    ? distinctModels(schedule.def.steps)
    : schedule.request.model;
}

export function scheduleResolvedModel(
  schedule: Pick<JobSchedule, "lastRun" | "resolvedModel">
): string | undefined {
  return schedule.lastRun?.resolvedModel ?? schedule.resolvedModel;
}

// The alt+j picker row. `resolvedModel` is the CLI-reported id from the
// schedule's latest run, when there has been one; until then the alias shows.
export type ScheduleLabelInput = Pick<ScheduleBase, "title" | "cron" | "effort"> &
  (
    | { kind?: "job"; request: Pick<MinionRequest, "model"> }
    | { kind: "workflow"; def: { steps: readonly unknown[] } }
  );

export function formatScheduleLabel(
  schedule: ScheduleLabelInput,
  nextRun: Date | null,
  resolvedModel?: string,
  now: Date = new Date()
): string {
  if (schedule.kind === "workflow") {
    return `${glyph("⏱⇉ ")}${schedule.title} · ${schedule.def.steps.length} steps · ${schedule.cron} · next ${formatNextRun(nextRun, now)}`;
  }
  const model = resolvedModel ?? schedule.request.model;
  return `${glyph("⏱ ")}${schedule.title} · ${model} / ${schedule.effort} · ${schedule.cron} · next ${formatNextRun(nextRun, now)}`;
}

// Lets a scheduled minion end its own schedule ("monitor X until Y"): the
// tick appends the instruction to each run's task, and the run's final
// result is checked for the marker when the job exits.
export const STOP_SCHEDULE_MARKER = "[[STOP_SCHEDULE]]";
export const STOP_SCHEDULE_INSTRUCTION = `\n\nThis task runs on a recurring schedule. Once its goal is fully complete and no future run is needed, end your final reply with ${STOP_SCHEDULE_MARKER} alone on the last line; otherwise never write it.`;

// Last non-empty line only, so a quoted or mid-text marker doesn't stop it.
export function hasStopMarker(text: string | undefined): boolean {
  const lines = text?.trimEnd().split(/\r?\n/);
  return lines?.at(-1)?.trim() === STOP_SCHEDULE_MARKER;
}
