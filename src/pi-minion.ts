import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { DEFAULT_PRUNE_AFTER_DAYS, loadConfig, readShortcutConfigSync, resolveShortcut } from "./config.js";
import { setShowGlyphs } from "./glyphs.js";
import { ensureRegistry, listAdapters } from "./adapters/registry.js";
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

// Captured by the startup chain below so session_start's startSession
// dispatch can await adapter detection even if that async chain hasn't
// landed yet. Undefined only while loadConfig() is pending or failed —
// without a config there is nothing to detect against.
let bootstrappedConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;

// Registration must not depend on the startup chain's loadConfig() having
// resolved first: on /reload, session_start can fire before it does, and
// skipping registration (and the startSession seeding that follows it) even
// once leaves pi's model registry unseeded for the whole session — empty
// help list, every model "Unknown model". Fall back to loading the config
// here; only a genuinely failed load skips registration. Exported for the
// regression test that pins this ordering guarantee.
export async function ensureRegistryReady(): Promise<void> {
  const config = bootstrappedConfig ?? (await loadConfig().catch(() => undefined));
  if (!config) return;
  bootstrappedConfig = config;
  await ensureRegistry(config);
}

export default function (pi: ExtensionAPI) {
  // Must happen synchronously here, not inside the async loadConfig() chain
  // below — see readShortcutConfigSync()'s comment for why an async
  // registration silently never takes effect.
  const startupConfig = readShortcutConfigSync();
  setShowGlyphs(startupConfig.showGlyphs);
  pi.registerShortcut(resolveShortcut(startupConfig), {
    description: "Browse running pi-minion jobs and open a live detail view.",
    handler: openPiMinionsPicker
  });

  loadConfig()
    .then((config) => {
      // Non-blocking CLI detection: registration = presence of the adapter's
      // command on PATH, instances bound to this config. session_start's
      // startSession dispatch awaits ensureRegistry() first, so it only ever
      // reaches registered adapters.
      bootstrappedConfig = config;
      void ensureRegistry(config);
      return pruneOldJobs(config.pruneAfterDays ?? DEFAULT_PRUNE_AFTER_DAYS);
    })
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

  pi.on("session_start", async (event, ctx) => {
    // Only registered adapters receive startSession/refreshCatalog — wait for
    // detection first (a no-op once the startup chain already ran, or while
    // tests have pinned the registry). Skipped only when loadConfig() failed;
    // without a config there is nothing to detect against. Loads the config
    // itself when the startup chain hasn't resolved yet (see
    // ensureRegistryReady) so this event's timing can't skip seeding.
    await ensureRegistryReady();
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
    // Generic session-start hook over every registered adapter — the parent
    // process's live state (pi: its model registry; agy: kicks off a model
    // catalog refresh) gets captured here, so ownsModel routes against real
    // availability from now on instead of a cold/hardcoded cache.
    for (const adapter of listAdapters()) {
      adapter.startSession?.(ctx);
      void adapter.refreshCatalog?.();
    }
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
