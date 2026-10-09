import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJobUI, type JobUI } from "./agent.ui.js";
import {
  DISPLAY_ENTRY_TYPE,
  RESULT_MESSAGE_TYPE,
  type JobMetaEntry,
  type JobMetaStatus,
  type PiMinionDisplayEntry,
  type MinionJob
} from "./job-types.js";

export const JOB_ROOT = join(homedir(), ".pi", "agent", "pi-minion");

export const jobs = new Map<string, MinionJob>();
export const jobMeta = new Map<string, JobMetaEntry>();
let jobUI: JobUI | undefined;

// Each session start (including every /reload, /new, fork, and resume) runs
// the extension factory with a fresh `pi`, and the previous one throws once
// its session is replaced. A job outlives that, so its result must post
// through its owning session's current handle, looked up at post time —
// never the `pi` captured when the job started.
const sessionApis = new Map<string, ExtensionAPI>();

// A replaced session's id points at its replacement (/new, fork, resume), so
// anything still holding the old id — a job that was mid-start when
// rehomeJobs ran — resolves to the session the user is now in.
const sessionAliases = new Map<string, string>();

// Posts for a session whose handle is released but whose replacement hasn't
// bound yet (between a non-quit session_shutdown and the next session_start).
// Only sessions in `replacing` hold posts, so one that really ended still
// drops them instead of queueing forever. Flushed on bind.
type PendingPost = { content: string; displayContent?: string; details: Record<string, unknown>; triggerTurn: boolean };
const pendingPosts = new Map<string, PendingPost[]>();
const replacing = new Set<string>();

export function resolveSessionId(sessionId: string): string {
  let id = sessionId;
  for (let hops = 0; sessionAliases.has(id) && hops < sessionAliases.size; hops++) id = sessionAliases.get(id)!;
  return id;
}

export function bindSessionApi(sessionId: string, pi: ExtensionAPI): void {
  sessionApis.set(sessionId, pi);
  replacing.delete(sessionId);
  const pending = pendingPosts.get(sessionId);
  pendingPosts.delete(sessionId);
  for (const post of pending ?? []) postToSession(sessionId, post.content, post.details, post.triggerTurn, post.displayContent);
}

// Called on a non-quit session_shutdown: its replacement binds shortly.
export function holdPostsFor(sessionId: string): void {
  replacing.add(sessionId);
}

export function releaseSessionApi(sessionId: string, pi: ExtensionAPI): void {
  if (sessionApis.get(sessionId) === pi) sessionApis.delete(sessionId);
}

export function sessionApi(sessionId: string): ExtensionAPI | undefined {
  return sessionApis.get(sessionId);
}

// Moves jobs from a replaced session to its replacement (/new, fork, resume),
// so their results, list_pi_minions, and cancel_pi_minion follow the user.
export function rehomeJobs(from: string, to: string): void {
  for (const job of jobs.values()) if (job.sessionId === from) job.sessionId = to;
  for (const meta of jobMeta.values()) if (meta.sessionId === from) meta.sessionId = to;
  if (from === to) return;
  sessionAliases.set(from, to);
  if (replacing.delete(from)) replacing.add(to);
  const pending = pendingPosts.get(from);
  if (pending) {
    pendingPosts.delete(from);
    pendingPosts.set(to, [...(pendingPosts.get(to) ?? []), ...pending]);
  }
}

// Posts into the owning session through its current handle, looked up now —
// never one captured earlier (see sessionApis above). No handle means the
// session is mid-replacement, so the post waits for its replacement to bind
// (see pendingPosts); if it quits instead, the content is still in result.md
// and the child session.
export function postToSession(
  sessionId: string,
  content: string,
  details: Record<string, unknown>,
  triggerTurn: boolean,
  displayContent: string = content
): void {
  const id = resolveSessionId(sessionId);
  const pi = sessionApi(id);
  if (!pi) {
    if (replacing.has(id))
      pendingPosts.set(id, [...(pendingPosts.get(id) ?? []), { content, displayContent, details, triggerTurn }]);
    return;
  }
  try {
    pi.appendEntry(DISPLAY_ENTRY_TYPE, { content: displayContent, indent: true } satisfies PiMinionDisplayEntry);
    pi.sendMessage(
      { customType: RESULT_MESSAGE_TYPE, content, display: false, details },
      { triggerTurn, deliverAs: "followUp" }
    );
  } catch {
    // A handle can still go stale between a session's shutdown and its
    // replacement's start; a throw here would be an uncaught exception
    // that takes down the whole pi process.
  }
}

export function getJobUI(ctx: ExtensionContext): JobUI {
  if (jobUI) {
    // Every caller here already holds a fresh, valid ctx for this call —
    // hand it over each time, not just on the first call, since jobUI is a
    // process-lifetime singleton and the ctx it captured earlier goes stale
    // the moment its session is replaced (reload/new/fork/switchSession).
    jobUI.setCtx(ctx);
  } else {
    jobUI = createJobUI(ctx);
  }
  return jobUI;
}

// The singleton as-is, without creating it — for lifecycle hooks that must
// stay a no-op when no job has ever run in this process.
export function peekJobUI(): JobUI | undefined {
  return jobUI;
}

export function clearJobViews(ui: JobUI, id: string): void {
  ui.clearJob(id);
  ui.finishModalJob(id);
}

// Kills a job's process and forgets it. Callers decide whether it's theirs
// to stop (see resolveOwnedJob / jobIdsOwnedBySession).
export function stopJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  clearTimeout(job.timeout);
  job.stop();
  jobs.delete(id);
}

export function markJobFinished(
  id: string,
  status: Exclude<JobMetaStatus, "running">,
  extra: Pick<JobMetaEntry, "reportPath"> = {}
): JobMetaEntry | undefined {
  const meta = jobMeta.get(id);
  if (meta) Object.assign(meta, { status, finishedAt: Date.now(), ...extra });
  return meta;
}

// jobMeta backs list_pi_minions' finished-job hints, not just the
// /pi-minions UI, so it needs the same retention as pruneOldJobs' on-disk
// cleanup rather than growing unbounded for the life of the process.
export function pruneJobMeta(days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const [id, meta] of jobMeta) {
    if (meta.status !== "running" && (meta.finishedAt ?? 0) < cutoff) {
      jobMeta.delete(id);
    }
  }
}

export async function pruneOldJobs(days: number): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(JOB_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const jobDir = join(JOB_ROOT, entry.name);
        try {
          const info = await stat(jobDir);
          if (info.mtimeMs < cutoff) await rm(jobDir, { recursive: true });
        } catch {
          // Best-effort cleanup; ignore individual failures.
        }
      })
  );
}

// Extension factories load once per process and are shared across every
// session (including subagents), so a "quit" fired by one session must not
// reap a job started by a different, still-running one. Pulled out as a pure
// function so the selection logic is testable without a real ChildProcess/
// timer/ExtensionAPI.
export function jobIdsOwnedBySession(
  jobs: ReadonlyMap<string, { sessionId: string; status: string }>,
  sessionId: string
): string[] {
  return [...jobs.entries()]
    .filter(([, job]) => job.sessionId === sessionId && job.status === "running")
    .map(([id]) => id);
}

// Same testability rationale as jobIdsOwnedBySession. Unlike that helper,
// this one intentionally includes finished jobs (done/errored/cancelled), not
// just running ones — list_pi_minions uses it to hint an orchestrator at a
// just-finished job's reportPath before it writes context for a follow-up.
export function relevantJobsForSession(
  jobMeta: ReadonlyMap<string, JobMetaEntry>,
  sessionId: string,
  workspace: string
): Array<{ id: string } & JobMetaEntry> {
  return [...jobMeta.entries()]
    .filter(([, meta]) => meta.sessionId === sessionId && meta.workspace === workspace)
    .map(([id, meta]) => ({ id, ...meta }));
}

// Same testability rationale as jobIdsOwnedBySession: cancel_pi_minion must
// confirm the calling session owns the job before touching it. A job that
// has already exited and is finalizing its result is not "owned and
// running" — it's not cancellable, and its result is already on the way.
export function resolveOwnedJob(
  jobs: ReadonlyMap<string, { sessionId: string; status: string }>,
  id: string,
  sessionId: string
): boolean {
  const job = jobs.get(id);
  return job !== undefined && job.sessionId === sessionId && job.status === "running";
}
