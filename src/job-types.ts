import type { ChildProcess } from "node:child_process";

// Entry/message types this extension posts into the transcript.
export const DISPLAY_ENTRY_TYPE = "pi-minion-display";
export const RESULT_MESSAGE_TYPE = "pi-minion-result";

export type PiMinionDisplayEntry = { content: string; indent?: boolean };

// "running" until the child process's close/error event fires; then
// "finalizing" while the result is parsed/written/posted, right up until
// the entry is deleted from the jobs map. Lets cancel_pi_minion and
// session_shutdown tell "nothing to stop, about to report its own result"
// apart from "actually still running" during the gap between process exit
// and the map's own cleanup — see job-runner.ts's close/error handlers.
export type JobProcessStatus = "running" | "finalizing";

export type MinionJob = {
  process: ChildProcess;
  timeout: NodeJS.Timeout;
  stop: () => void;
  // The session that started this job. Extensions load once per process and
  // are shared across every session (including subagents) — see the
  // session_shutdown handler in pi-minion.ts for why this matters.
  sessionId: string;
  status: JobProcessStatus;
};

export type JobMetaStatus = "running" | "done" | "errored" | "cancelled";

// Title/model outlive a job's entry in agent.ui.ts's live registry (which
// drops a job the instant it finishes) but the detail modal can still be
// open for a finished job, so its header needs a title/model source that
// survives completion. Small and session-scoped; pruned by pruneJobMeta.
export type JobMetaEntry = {
  title: string;
  model: string;
  // The CLI-reported model id, once its init event arrives; display sites
  // prefer it over `model`, which stays the requested alias for adapter lookup.
  resolvedModel?: string;
  effort?: string;
  prompt: string;
  workspace: string;
  sessionId: string;
  status: JobMetaStatus;
  finishedAt?: number;
  reportPath?: string;
  // Set when this job is a workflow step (the owning workflow's map key);
  // lets the /pi-minions picker list step-owned metas separately from
  // standalone jobs and keep each finished workflow's steps grouped.
  workflowId?: string;
};
