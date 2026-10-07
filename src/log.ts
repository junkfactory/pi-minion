import { appendFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JOB_ROOT } from "./job-store.js";

// Sibling to JOB_ROOT, not inside it — a terse job-lifecycle log (started/
// exited/errored/cancelled only, never stdout/stderr/UI events), rolled
// over to one backup file once it would exceed MAX_LOG_BYTES.
const LOG_PATH = join(dirname(JOB_ROOT), "pi-minion.log");
const LOG_ROTATED_PATH = `${LOG_PATH}.1`;
const MAX_LOG_BYTES = 15 * 1024 * 1024;

export type JobLogEvent =
  | "started"
  | "exited"
  | "errored"
  | "cancelled"
  | "scheduled"
  | "skipped"
  | "unscheduled"
  // Prefixed because plain "started"/"cancelled" already mean job events.
  | "workflow_started"
  | "workflow_finished"
  | "workflow_cancelled"
  | "workflow_declined"
  // A workflow step rejected before spawn (validation/model-routing error);
  // job_id is the step id since no job exists yet.
  | "step_failed";

// logPath/rotatedPath/maxBytes default to the real ~/.pi paths, overridable
// so tests can exercise rotation against a temp dir (same rationale as
// loadConfig's overridePath) without touching the user's real log.
export async function rotateLogIfOversized(
  logPath: string = LOG_PATH,
  rotatedPath: string = LOG_ROTATED_PATH,
  maxBytes: number = MAX_LOG_BYTES
): Promise<void> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return; // No file yet; appendFile below creates one.
  }
  if (size < maxBytes) return;
  try {
    await rm(rotatedPath, { force: true });
    await rename(logPath, rotatedPath);
  } catch {
    // Best-effort — keep appending to the existing file rather than losing
    // or blocking on log writes.
  }
}

// Fire-and-forget by every caller (`void logJobEvent(...)`, never awaited):
// a disk-full/permission error here must never fail a job or surface as a
// tool error. Terse by design — job lifecycle only, never stdout/stderr.
export async function logJobEvent(
  status: JobLogEvent,
  info: { id: string; model: string; detail?: string },
  logPath: string = LOG_PATH,
  rotatedPath: string = LOG_ROTATED_PATH,
  maxBytes: number = MAX_LOG_BYTES
): Promise<void> {
  const line = `${new Date().toISOString()} status=${status} job_id=${info.id} model=${info.model}${info.detail ? ` ${info.detail}` : ""}\n`;
  try {
    await rotateLogIfOversized(logPath, rotatedPath, maxBytes);
    await appendFile(logPath, line, "utf8");
  } catch {
    // Best-effort only — see header comment.
  }
}
