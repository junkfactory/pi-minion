import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { DEFAULT_PRUNE_AFTER_DAYS, loadConfig, readShortcutConfigSync, resolveShortcut } from "./config.js";
import {
  bindSessionApi,
  holdPostsFor,
  jobIdsOwnedBySession,
  jobs,
  peekJobUI,
  pruneOldJobs,
  rehomeJobs,
  releaseSessionApi,
  stopJob
} from "./job-store.js";
import { DISPLAY_ENTRY_TYPE, type PiMinionDisplayEntry } from "./job-types.js";
import { openPiMinionsPicker } from "./modal.js";
import {
  rehomeSchedules,
  scheduleIdsOwnedBySession,
  schedules,
  stopSchedule
} from "./schedule-store.js";
import { registerTools } from "./tools.js";
import { cancelWorkflow, defaultWorkflowDeps } from "./workflow-runner.js";
import { rehomeWorkflows, workflowIdsOwnedBySession, workflows } from "./workflow-store.js";

const MAX_COLLAPSED_ENTRY_LINES = 12;

// The shared JobUI is only torn down once nothing still draws on it: no job,
// and no workflow between steps (it has no job then, but starts the next one).
export function canDisposeJobUI(jobCount: number, allWorkflows: Iterable<{ finishedAt?: number }>): boolean {
  return jobCount === 0 && [...allWorkflows].every((wf) => wf.finishedAt !== undefined);
}

// Module-level, not per factory run: set by the replaced session's
// session_shutdown and consumed by its replacement's session_start, which
// run in different factory instances.
let replacedSessionId: string | undefined;

export default function (pi: ExtensionAPI) {
  // Must happen synchronously here, not inside the async loadConfig() chain
  // below — see readShortcutConfigSync()'s comment for why an async
  // registration silently never takes effect.
  pi.registerShortcut(resolveShortcut(readShortcutConfigSync()), {
    description: "Browse running pi-minion jobs and open a live detail view.",
    handler: openPiMinionsPicker
  });

  loadConfig()
    .then((config) => pruneOldJobs(config.pruneAfterDays ?? DEFAULT_PRUNE_AFTER_DAYS))
    .catch(() => {
      // Best-effort startup cleanup; ignore missing/invalid config.
    });

  pi.registerEntryRenderer(DISPLAY_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const { content, indent } = entry.data as PiMinionDisplayEntry;
    const paddingX = indent ? 2 : 0;
    const mdTheme = getMarkdownTheme();
    const lines = content.split("\n");
    const truncated = lines.length > MAX_COLLAPSED_ENTRY_LINES;
    if (expanded || !truncated) {
      return new Markdown(content, paddingX, 0, mdTheme);
    }
    const collapsed = lines.slice(0, MAX_COLLAPSED_ENTRY_LINES).join("\n");
    const container = new Container();
    container.addChild(new Markdown(collapsed, paddingX, 0, mdTheme));
    container.addChild(
      new Text(theme.fg("muted", "(Ctrl+O to expand)"), paddingX, 0)
    );
    return container;
  });

  registerTools(pi);

  pi.registerCommand("pi-minions", {
    description: "Browse running pi-minion jobs and open a live detail view.",
    handler: async (_args, ctx) => openPiMinionsPicker(ctx)
  });

  // Disabled while we observe whether the registered tool is used effectively.
  // Revisit this input interception if tool use proves insufficient.
  /*
  pi.on("input", async (event, ctx) => {
    const match = /^(?:have\s+)?pi-minion\s+([\s\S]+)$/i.exec(
      event.text.trim()
    );
    if (!match) return { action: "continue" };
    const content = `## Pi minion request\n\n${event.text.trim()}`;
    pi.appendEntry("pi-minion-display", { content, indent: true });
    pi.sendMessage(
      {
        customType: "pi-minion-request",
        content,
        display: false
      },
      { triggerTurn: false, deliverAs: "followUp" }
    );
    const config = await loadConfig();
    const id = await startJob(
      {
        task: match[1],
        workspace: ctx.cwd,
        model: config.defaultModel
      },
      ctx.cwd,
      (message) => ctx.ui.notify(message, "info")
    );
    ctx.ui.notify(`Pi minion job ${id} is running in the background.`, "info");
    return { action: "handled" };
  });
  */

  pi.on("session_shutdown", async (event, ctx) => {
    // `reason` is "quit" | "reload" | "new" | "resume" | "fork" — only "quit"
    // means the disposing session is really done, not swapped for a sibling
    // under /reload, /new, fork, or resume (killing in-flight jobs on those
    // was the bug reported as a ~15min-timeout job dying in ~11s with no
    // explanation). But "quit" fires per session, not per process: this
    // extension factory runs once for the whole pi process and its `jobs`
    // map is shared by every session — including subagents, which get their
    // own short-lived session and their own "quit" once their turn ends. So
    // a sibling subagent finishing normally must not reap a job started by a
    // different (still-running) session; scope the kill to jobs whose
    // sessionId matches the one actually quitting.
    const sessionId = ctx.sessionManager.getSessionId();
    releaseSessionApi(sessionId, pi);
    if (event.reason !== "quit") {
      replacedSessionId = sessionId;
      holdPostsFor(sessionId);
      return;
    }
    // Workflows first (pending steps cancelled, then running ones stopped),
    // so none can start another step; then schedules, so none can tick and
    // start a job after its jobs are reaped.
    for (const id of workflowIdsOwnedBySession(workflows, sessionId)) {
      cancelWorkflow(id, defaultWorkflowDeps);
      workflows.delete(id);
    }
    for (const id of scheduleIdsOwnedBySession(schedules, sessionId)) stopSchedule(id);
    for (const id of jobIdsOwnedBySession(jobs, sessionId)) stopJob(id);
    if (canDisposeJobUI(jobs.size, workflows.values())) peekJobUI()?.dispose();
  });

  pi.on("session_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Only a replacement consumes the handoff — a subagent's own session
    // starts with "startup" and must not take over the replaced session's jobs.
    if (event.reason !== "startup" && replacedSessionId !== undefined) {
      rehomeJobs(replacedSessionId, sessionId);
      rehomeSchedules(replacedSessionId, sessionId, ctx.sessionManager.getSessionFile());
      rehomeWorkflows(replacedSessionId, sessionId, ctx.sessionManager.getSessionFile());
      replacedSessionId = undefined;
    }
    bindSessionApi(sessionId, pi);
    // Fires on the new, non-stale runner immediately after every session
    // replacement (/reload, /new, fork, switchSession) — and at process
    // startup — with a ctx that's valid even though no tool/command has
    // been invoked yet. A job started before the replacement keeps running
    // and keeps ticking its own statusInterval (see job-runner.ts's startJob()), but any
    // widget update it made while jobUI's ctx was stale was silently
    // swallowed; this hands jobUI a fresh ctx as early as possible so the
    // widget self-heals as soon as the reload finishes, not on whatever
    // unrelated tool/command call happens to come next. No-op if no job has
    // ever run in this process (jobUI is only created lazily).
    peekJobUI()?.setCtx(ctx);
  });
}
