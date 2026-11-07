import { spawn } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobUI, StepRunStats } from "./agent.ui.js";
import type {
  AdapterParseState,
  AgentCliAdapter,
  MinionConfig,
  MinionRequest,
  TokenCounts,
  UsageTotals
} from "./adapters/types.js";
import { resolveTaskText, truncate } from "./adapters/util.js";
import {
  ensureRegistry,
  listAdapters,
  providersOfModel,
  resolveAdapterForModel,
  resolveAdapterForModelRefreshed
} from "./adapters/registry.js";
import { writeChildSession } from "./child-session.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_RESULT_CONTEXT_BYTES,
  DEFAULT_MAX_RESULT_PREVIEW_BYTES,
  DEFAULT_PRUNE_AFTER_DAYS,
  isValidMaxTurns,
  isModelAllowed,
  isModelBlocked,
  isProviderAllowed,
  loadConfig,
  MAX_MAX_TURNS,
  MIN_MAX_TURNS
} from "./config.js";
import {
  deriveJobTitle,
  describeJobResult,
  formatJobFrontmatter,
  formatNotices,
  thinkingPlaceholder,
  tokenCountsFromUsage,
  truncateResultForContext,
  usageFields
} from "./format.js";
import {
  clearJobViews,
  JOB_ROOT,
  jobMeta,
  jobs,
  markJobFinished,
  postToSession,
  pruneJobMeta,
  resolveSessionId
} from "./job-store.js";
import { logJobEvent, type JobLogEvent } from "./log.js";
import { applyModalEvent } from "./modal.js";
import { createOutputCapture } from "./output-capture.js";
import { pruneWorkflows } from "./workflow-store.js";

// Node's setTimeout clamps a larger delay to 1 ms, so a limit above this would
// expire instantly instead of never; reject it in validateRequest instead.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_PREVIEW_BYTES = 8_192;
const MAX_PREVIEW_LINE_LENGTH = 64;
const STATUS_UPDATE_INTERVAL_MS = 1_000;
// Grace for a child to act on a teardown request (stdin EOF, or SIGTERM after
// it) before the next, harsher signal.
const GRACE_MS = 5_000;

// The run's effective turn cap. A request value is final — a number is the cap,
// and null is a pinned "no cap" (a schedule resolved step ?? workflow ?? config
// when it was created, so a later config edit must not retarget a running
// schedule). config.maxTurns is only the default for a request that names
// neither, i.e. an ordinary one-off run.
export function resolveMaxTurns(
  request: Pick<MinionRequest, "maxTurns">,
  config: Pick<MinionConfig, "maxTurns">
): number | undefined {
  if (request.maxTurns === null) return undefined;
  return request.maxTurns ?? config.maxTurns;
}

export async function validateRequest(
  request: MinionRequest,
  cwd: string,
  config: MinionConfig
): Promise<MinionRequest> {
  await ensureRegistry(config);
  const workspace = resolve(request.workspace);
  if (workspace !== resolve(cwd)) {
    throw new Error("workspace must be the current Pi workspace");
  }
  if (!(await stat(workspace)).isDirectory())
    throw new Error("workspace is not a directory");
  const modelProviders = providersOfModel(request.model);
  if (modelProviders.length > 0 && !modelProviders.every((p) => isProviderAllowed(config, p))) {
    throw new Error(
      `Model ${request.model} is excluded by the providers config (providers: ${modelProviders.join(", ")}). Call help_pi_minion for the models usable here.`
    );
  }
  if (!isModelAllowed(config, request.model))
    throw new Error(
      isModelBlocked(config, request.model)
        ? `Model is blocked: ${request.model} (models.blocked). Call help_pi_minion for the models usable here.`
        : `Model is not allowed: ${request.model}. Call help_pi_minion for the models usable here.`
    );
  if (
    request.maxBudgetUsd !== undefined &&
    (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0)
  ) {
    throw new Error("maxBudgetUsd must be a positive number");
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isFinite(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      request.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `timeoutMs must be a positive number of milliseconds no greater than ${MAX_TIMEOUT_MS} (Node's setTimeout limit)`
    );
  }
  if (request.maxTurns !== undefined && request.maxTurns !== null && !isValidMaxTurns(request.maxTurns)) {
    throw new Error(
      `maxTurns must be a whole number from ${MIN_MAX_TURNS} to ${MAX_MAX_TURNS} (omit it for no turn cap)`
    );
  }
  // The adapter check runs on the EFFECTIVE cap, not just the request's own:
  // a config.maxTurns default reaches the runner the same way, so a request
  // that names none but inherits one must be rejected here too.
  if (resolveMaxTurns(request, config) !== undefined) {
    // A cap is enforced by counting the adapter's turnStart events, so an
    // adapter that reports no turn boundaries would leave it silently
    // unenforced: fail fast instead of accepting a cap that never fires.
    let capAdapter: AgentCliAdapter | undefined;
    try {
      capAdapter = resolveAdapterForModel(request.model);
    } catch {
      // Unknown model: startJob's refreshed resolution reports it, not this.
      capAdapter = undefined;
    }
    if (capAdapter && !capAdapter.capabilities.emitsTurnEvents) {
      throw new Error(
        `maxTurns is not supported for the ${capAdapter.command} adapter — it reports no assistant turn boundaries. Omit maxTurns.`
      );
    }
  }
  if (!request.task.trim()) throw new Error("task is required");
  if (!request.effort?.trim())
    throw new Error(
      "effort is required — pick the level that fits the task: low for simple, mechanical work; medium for ordinary coding; high for debugging, review, or risky changes (auth, money, data deletion, concurrency)."
    );
  if (request.context !== undefined) {
    const remainder = request.context
      .replace(/no prior context/i, "")
      .trim();
    if (/no prior context/i.test(request.context) && remainder.length > 20) {
      throw new Error(
        'context combines "no prior context" with other details — that phrase is only for a genuinely fresh task with nothing to restate. Either use exactly "No prior context." and nothing else, or drop the phrase and restate the real prior findings/decisions instead.'
      );
    }
  }
  return { ...request, workspace };
}

export async function startJob(
  request: MinionRequest,
  cwd: string,
  sessionId: string,
  parentSessionFile: string | undefined,
  notify: (message: string) => void,
  jobUI: JobUI,
  // Scheduled runs only. Called on exit with the final result (undefined on
  // failure); a returned note is appended to the posted result. Passing it
  // also makes the post quiet (no main-agent turn) unless a note comes back.
  onFinalResult?: (finalResult: string | undefined) => string | undefined,
  // Workflow steps only. Called once on either exit path; passing it
  // suppresses the end-of-job post entirely (the workflow posts one summary
  // with each step's status, usage and report). `ok` is a clean exit with a
  // final result.
  onSettled?: (outcome: { finalResult?: string; reportPath?: string; errorReason?: string; ok: boolean } & StepRunStats) => void,
  // Workflow steps only. `title` ("<workflow title> › <step id>") replaces
  // the title derived from the task (picker, modal) and is added to the result
  // frontmatter; the child session is named by `id`, since /resume already
  // shows it under its workflow's session. Also skips the "started" notify
  // (the widget shows it).
  workflowStep?: { title: string; id: string; workflowId: string },
  // Workflow steps only: checked right before the process spawns; true means
  // the step was cancelled while this job was still starting, so nothing is
  // spawned (no paid process) and the promise rejects.
  isCancelled?: () => boolean
): Promise<string> {
  const config = await loadConfig();
  pruneJobMeta(config.pruneAfterDays ?? DEFAULT_PRUNE_AFTER_DAYS);
  pruneWorkflows(config.pruneAfterDays ?? DEFAULT_PRUNE_AFTER_DAYS);
  const validRequest = await validateRequest(request, cwd, config);
  // help_pi_minion awaits every adapter's catalog refresh before listing
  // models; a run must not declare a model unknown against a catalog that
  // session_start's fire-and-forget refresh hasn't populated yet. The refresh
  // callback also re-runs ensureRegistry: a binary installed mid-session
  // becomes routable at the next resolution attempt.
  const adapter = await resolveAdapterForModelRefreshed(validRequest.model, async () => {
    await ensureRegistry(config);
    await Promise.all(listAdapters().map((candidate) => candidate.refreshCatalog?.()));
  });
  // One parse scratch per job: an adapter that keeps state across lines (agy's
  // turnStart dedupe) must never share it with a concurrent job on the same
  // adapter instance.
  const parseState: AdapterParseState = {};
  const warnings = adapter.describeUnsupported(validRequest, config);
  const id = randomUUID();
  const title = workflowStep?.title ?? deriveJobTitle(request.task);
  jobMeta.set(id, {
    title,
    model: request.model,
    effort: request.effort,
    prompt: resolveTaskText(request),
    workspace: validRequest.workspace,
    // Resolved now, not taken as-is: a session replaced while this job was
    // still loading config points at its replacement.
    sessionId: resolveSessionId(sessionId),
    status: "running",
    ...(workflowStep && { workflowId: workflowStep.workflowId })
  });
  const jobDir = join(JOB_ROOT, id);
  // The adapter that takes its task over stdin owns that frame's format; an
  // adapter without one keeps today's argv prompt and a closed stdin.
  const stdinPrompt = adapter.stdinPrompt?.(validRequest);
  // Anything failing between "running" and a live process must not leave the
  // job meta "running" forever.
  const spawnProcess = async () => {
    try {
      await mkdir(JOB_ROOT, { recursive: true, mode: 0o700 });
      await chmod(JOB_ROOT, 0o700);
      void logJobEvent("started", { id, model: request.model });
      await mkdir(jobDir, { mode: 0o700 });
      await chmod(jobDir, 0o700);
      if (isCancelled?.()) {
        markJobFinished(id, "cancelled");
        throw new Error("Cancelled before the pi minion started");
      }
      const args = adapter.buildArgs(validRequest, config);
      const preExec = config.adapterArgs?.[adapter.command]?.preExec ?? [];
      // Only a wrapper needs adapter.command inside argv — the wrapper execs
      // it as its program. Without a preExec, prepending it would inject a
      // stray positional before the real flags (claude read "claude" as the
      // prompt); the spawn's first argument already IS the command.
      const [wrapper, ...wrapperArgs] = preExec;
      return spawn(wrapper ?? adapter.command, [...wrapperArgs, ...(wrapper ? [adapter.command] : []), ...args], {
        cwd: validRequest.workspace,
        env: adapter.environment(),
        shell: false,
        // A stdin task frame means the channel stays open past the prompt, so
        // it must be a pipe; otherwise nothing is ever written and "ignore"
        // keeps the child from inheriting the runner's stdin.
        stdio: [stdinPrompt === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch (error) {
      if (jobMeta.get(id)?.status === "running") markJobFinished(id, "errored");
      throw error;
    }
  };
  const proc = await spawnProcess();
  const stdin = stdinPrompt === undefined ? undefined : proc.stdin ?? undefined;
  // Natural-completion teardown closes the channel before the process is gone,
  // so the "are we past settle?" flag is declared before the stdin wiring that
  // reads it.
  let inputClosed = false;
  // A stdin write that fails while the job is still open (EPIPE: the child
  // closed its end) means steering is unreachable from then on, and a cap
  // stop can no longer travel over the channel. Post-settle EPIPE (we ended
  // the channel ourselves) is the expected outcome and stays silent.
  //
  // Classified per WRITE, not on error-arrival time: a write issued before the
  // run settled can report its error only after runSettled closed the channel,
  // and that failure still means the channel broke mid-run.
  let stdinError: string | undefined;
  const stdinBroken = () => stdinError !== undefined;
  const recordStdinError = (error: Error, writtenBeforeSettle: boolean) => {
    if (!stdin || stdinBroken()) return;
    if (inputClosed && !writtenBeforeSettle) return;
    stdinError = error.message;
    // Destroying the stream makes the breakage visible where it matters:
    // steerJob rejects on a destroyed channel instead of reporting delivery.
    stdin.destroy();
    // A cap stop whose frame never reached the child must still end the run.
    if (cappedAt !== undefined) stopProcess();
  };
  const writeStdin = (frame: string) => {
    if (!stdin) return;
    const writtenBeforeSettle = !inputClosed;
    stdin.write(frame, (error) => {
      if (error) recordStdinError(error, writtenBeforeSettle);
    });
  };
  if (stdin && stdinPrompt !== undefined) {
    stdin.on("error", (error) => {
      // Covers an EPIPE that no write callback claimed; the per-write callback
      // above already classified the write that caused it.
      recordStdinError(error, false);
    });
    writeStdin(stdinPrompt);
  }
  const startedAt = Date.now();
  let forceKillTimeout: NodeJS.Timeout | undefined;
  const stopProcess = () => {
    proc.kill("SIGTERM");
    forceKillTimeout ??= setTimeout(() => proc.kill("SIGKILL"), GRACE_MS);
    forceKillTimeout.unref();
  };

  // Natural-completion teardown: once the run is verifiably over the channel
  // is closed, which is the CLI's own orderly-shutdown signal. A child that
  // ignores it must not linger, so the existing escalation backs the wait up.
  let graceTimeout: NodeJS.Timeout | undefined;
  let sawRunSettled = false;
  const closeInputThenEscalate = () => {
    if (inputClosed || !stdin) return;
    inputClosed = true;
    stdin.end();
    graceTimeout = setTimeout(stopProcess, GRACE_MS);
    graceTimeout.unref();
  };

  // Turn cap. The runner's own count of turnStart events is the authority — a
  // CLI's native cap re-arms per queued stdin message, so it cannot bound the
  // whole run. Reaching the cap asks the CLI to abandon the run over its own
  // command channel, which keeps the CLI's teardown (final turn bookkeeping)
  // intact; then the job finalizes like any other stop, as "cancelled". The
  // escalation wired to runSettled (and runTimeoutMs as the backstop) still
  // covers a child that ignores the request.
  // The caller's cap wins; config.maxTurns is the optional default (validated
  // at load). Absent in both = unlimited, so the cap stays undefined.
  const maxTurns = resolveMaxTurns(validRequest, config);
  let turnsSeen = 0;
  let cappedAt: number | undefined;
  const capStop = () => {
    if (cappedAt !== undefined || maxTurns === undefined) return;
    cappedAt = maxTurns;
    markJobFinished(id, "cancelled");
    void logJobEvent("cancelled", { id, model: request.model, detail: `maxTurns=${maxTurns} reached` });
    const frame = adapter.capStopFrame?.();
    if (frame !== undefined && stdin && !stdinBroken()) writeStdin(frame);
    else stopProcess();
  };

  let previewText = "";
  let finalResult: string | undefined;
  // Reason from the CLI's streamed error event (pi's stopReason "error"), if any.
  let runError: string | undefined;
  let finalUsage: UsageTotals | undefined;
  let sawPermissionDenial = false;
  let timedOut = false;
  let jobFinished = false;
  let lastPreviewLine: string | undefined;
  let sawThinkingDelta = false;
  // Fills in a wall-clock duration for an adapter that reports no duration
  // itself (Claude's tool_result has no timing field; agy always reports
  // duration_seconds and overrides this via toolResult.durationMs instead).
  const toolCallStartedAt = new Map<string, number>();
  // Running sum of usageDelta events; undefined until the first one arrives.
  let runningTokens: TokenCounts | undefined;
  // The CLI-reported model id, once its init event arrives; until then the
  // widget shows the requested alias.
  let resolvedModel: string | undefined;
  const displayModel = () => resolvedModel ?? request.model;
  const emitPreview = () => {
    jobUI.setJob(id, {
      title,
      model: displayModel(),
      effort: request.effort,
      startedAt,
      previewLine: lastPreviewLine,
      tokenUsage: runningTokens && { ...runningTokens }
    });
  };
  const updatePreview = (text: string) => {
    previewText += text;
    if (Buffer.byteLength(previewText) > MAX_PREVIEW_BYTES) {
      previewText = Buffer.from(previewText)
        .subarray(-MAX_PREVIEW_BYTES)
        .toString("utf8");
    }
    const lines = previewText.split(/\r?\n/);
    lastPreviewLine = truncate(lines[lines.length - 1] ?? "", MAX_PREVIEW_LINE_LENGTH);
    emitPreview();
  };
  const toolDurationFallback = (toolCallId: string) => {
    const toolStartedAt = toolCallStartedAt.get(toolCallId);
    return toolStartedAt !== undefined ? Date.now() - toolStartedAt : undefined;
  };
  const consumeLine = (line: string) => {
    for (const event of adapter.parseLine(line, parseState)) {
      applyModalEvent(jobUI, id, event, toolDurationFallback);
      switch (event.kind) {
        case "permissionDenied":
          sawPermissionDenial = true;
          break;
        case "result":
          finalResult = event.result;
          break;
        case "error":
          runError = event.message;
          break;
        case "usage":
          finalUsage = event.usage;
          break;
        case "model": {
          resolvedModel = event.model;
          const meta = jobMeta.get(id);
          if (meta) meta.resolvedModel = event.model;
          emitPreview();
          break;
        }
        case "usageDelta": {
          const total = (runningTokens ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
          total.input += event.delta.input;
          total.output += event.delta.output;
          total.cacheWrite += event.delta.cacheWrite;
          total.cacheRead += event.delta.cacheRead;
          emitPreview();
          break;
        }
        case "text":
          updatePreview(event.text);
          break;
        case "thinking":
          if (!sawThinkingDelta) {
            sawThinkingDelta = true;
            lastPreviewLine = thinkingPlaceholder(request.effort);
            emitPreview();
          }
          break;
        case "toolUse":
          toolCallStartedAt.set(event.id, Date.now());
          lastPreviewLine = truncate(`Using ${event.name}…`, MAX_PREVIEW_LINE_LENGTH);
          emitPreview();
          break;
        case "runSettled":
          sawRunSettled = true;
          // The CLI has no automatic work left, so the run takes no more
          // steering: a frame written after this point would be queued but
          // never delivered, and the job's result must never race it. Marking
          // the job finalizing makes resolveOwnedJob reject it from here on.
          // The channel itself closes below; finalization still waits for the
          // process to close, never for the result line alone.
          const job = jobs.get(id);
          if (job) job.status = "finalizing";
          break;
        case "turnStart":
          turnsSeen++;
          // Strictly greater: the maxTurns-th turn is the one the caller paid
          // for; the turn after it is the runaway one to stop.
          if (maxTurns !== undefined && turnsSeen > maxTurns && cappedAt === undefined) capStop();
          break;
      }
    }
    // A settled run is over by the CLI's own account, so its channel can be
    // closed — and closing is what lets these CLIs exit. Gated on settle, not
    // on a result: a failed turn settles too, and under rpc a child would
    // otherwise sit waiting for a command that never comes until the timeout.
    // Closing is safe either way: EOF ends the input, not the output stream.
    if (sawRunSettled) closeInputThenEscalate();
  };
  const output = createOutputCapture(
    proc,
    jobDir,
    config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    consumeLine,
    stopProcess
  );

  // The caller's per-run limit wins; config.timeoutMs is the fallback backstop.
  const runTimeoutMs = validRequest.timeoutMs ?? config.timeoutMs;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopProcess();
  }, runTimeoutMs);
  jobs.set(id, {
    process: proc,
    stdin,
    timeout,
    stop: stopProcess,
    // Also re-resolved: a replacement can land during the mkdir/spawn awaits.
    sessionId: resolveSessionId(sessionId),
    status: "running"
  });
  if (!workflowStep || warnings.length) {
    notify(
      `Pi minion job ${id} started.${warnings.length ? `\n${warnings.join("\n")}` : ""}`
    );
  }
  emitPreview();
  const statusInterval = setInterval(emitPreview, STATUS_UPDATE_INTERVAL_MS);
  statusInterval.unref();

  // Both exit paths end here, in a finally: onSettled must fire exactly once
  // even if the path's own work threw, or the workflow would never move on.
  let settled = false;
  const settle = (outcome: { finalResult?: string; reportPath?: string; errorReason?: string; ok: boolean }) => {
    if (settled) return;
    settled = true;
    // The same tokens the live widget row showed, falling back to the final
    // totals for a CLI that only reports usage at the end.
    const tokenUsage = runningTokens ?? (finalUsage && tokenCountsFromUsage(finalUsage));
    try {
      onSettled?.({ ...outcome, startedAt, finishedAt: Date.now(), tokenUsage, totalCostUsd: finalUsage?.totalCostUsd });
    } catch {}
  };
  // Shared first step of both exit paths: runs once, stops timers, logs, and
  // marks the job "finalizing". Returns false if the other path already ran.
  const beginFinalize = (event: JobLogEvent, detail: string): boolean => {
    if (jobFinished) return false;
    jobFinished = true;
    clearTimeout(timeout);
    clearTimeout(forceKillTimeout);
    clearTimeout(graceTimeout);
    clearInterval(statusInterval);
    void logJobEvent(event, { id, model: request.model, detail });
    const job = jobs.get(id);
    if (job) job.status = "finalizing";
    return true;
  };
  const frontmatter = (reportPath?: string) =>
    formatJobFrontmatter({
      jobId: id,
      agent: adapter.name,
      model: displayModel(),
      effort: request.effort,
      ...usageFields(finalUsage),
      perModel: finalUsage?.perModel,
      maxBudgetUsd: request.maxBudgetUsd ?? config.maxBudgetUsd,
      budgetEnforced: adapter.capabilities.supportsMaxBudgetUsd,
      timeoutMs: runTimeoutMs,
      jobDir,
      reportPath,
      step: workflowStep?.title
    });
  const postResult = (
    content: string,
    details: Record<string, unknown>,
    triggerTurn = true,
    displayContent?: string
  ) => {
    // A workflow step posts nothing at its end: the workflow's one summary
    // carries each step's status, usage, cost and report. Registry cleanup
    // still runs here on every path — jobs.get(id) must not report "not
    // found" while the job is still finalizing its result.
    // Owner looked up now, not at start: the session may have been replaced
    // (rehomed) or quit since.
    if (!onSettled)
      postToSession(jobMeta.get(id)?.sessionId ?? sessionId, content, details, triggerTurn, displayContent);
    jobs.delete(id);
  };

  proc.on("close", async (code, signal) => {
    if (
      !beginFinalize(
        "exited",
        `exit_code=${code ?? "null"} signal=${signal ?? "none"}${timedOut ? " timed_out=true" : ""} timeout_ms=${runTimeoutMs}${output.exceededOutputLimit ? " exceeded_output_limit=true" : ""}`
      )
    )
      return;
    let reportPath: string | undefined;
    let outputError: Error | undefined;
    let clean = false;
    // Failure text for the workflow step (a step's post is suppressed, so
    // describeJobResult's message would otherwise reach nobody).
    let failureReason: string | undefined;
    try {
      output.flush();
      clearJobViews(jobUI, id);
      outputError = await output.close();
      let resultForDisplay = finalResult;
      let resultForContext = finalResult;
      if (finalResult) {
        const resultPath = join(jobDir, "result.md");
        try {
          await writeFile(resultPath, finalResult, "utf8");
          reportPath = resultPath;
          resultForDisplay = truncateResultForContext(
            finalResult,
            resultPath,
            config.maxResultPreviewBytes ?? DEFAULT_MAX_RESULT_PREVIEW_BYTES
          );
          resultForContext = truncateResultForContext(
            finalResult,
            resultPath,
            config.maxResultContextBytes ?? DEFAULT_MAX_RESULT_CONTEXT_BYTES
          );
        } catch {
          // Best-effort: if the full result can't be written to disk, fall
          // back to inlining it untruncated rather than pointing at a file
          // that doesn't exist.
        }
      }
      // "done" requires a clean exit AND a result: the pi CLI reports a
      // failed model turn as exit 0 with the error only in its JSONL stream,
      // so anything else is "errored" — except a cancellation, which
      // cancel_pi_minion / workflow stopStep already recorded as
      // "cancelled" before killing the process; don't overwrite it here.
      // A cap-stopped run is never "done": stopping it was the point.
      clean =
        code === 0 &&
        !timedOut &&
        cappedAt === undefined &&
        !output.exceededOutputLimit &&
        !outputError &&
        finalResult !== undefined;
      const priorStatus = jobMeta.get(id)?.status;
      const meta = markJobFinished(
        id,
        priorStatus === "cancelled" ? "cancelled" : clean ? "done" : "errored",
        { reportPath }
      );
      const buildResult = (preview: string | undefined): string =>
        outputError
          ? `Pi minion output capture failed: ${outputError.message}`
          : describeJobResult({
              code,
              signal,
              timedOut,
              exceededOutputLimit: output.exceededOutputLimit,
              finalResult: preview,
              stderrTail: output.stderrTail,
              stdoutPath: output.stdoutPath,
              rawOutputHint: adapter.rawOutputHint,
              modelError: runError
            });
      const result = buildResult(resultForDisplay);
      const contextResult = resultForContext === resultForDisplay ? result : buildResult(resultForContext);
      // Why the run ended when the caller's own cap is the reason — the
      // generic "no result" wording would otherwise blame the CLI.
      const capNote =
        cappedAt !== undefined
          ? `\n\n**Note:** maxTurns=${cappedAt} reached — the run hit its turn cap and was cancelled.`
          : "";
      if (!clean) failureReason = `${result}${capNote}`;
      try {
        // Best-effort, like result.md: a failed session write mustn't lose the result.
        writeChildSession({
          parentSessionFile,
          cwd,
          name: `${displayModel()}: ${workflowStep?.id ?? title}`,
          prompt: resolveTaskText(request),
          resultText: finalResult ?? result,
          provider: adapter.command,
          model: displayModel(),
          effort: request.effort,
          startedAt,
          finishedAt: meta?.finishedAt ?? Date.now(),
          usage: finalUsage
        });
      } catch {}
      const denialWarning = sawPermissionDenial
        ? `\n\n**Warning:** ${adapter.permissionDeniedWarning}`
        : "";
      // Facts (no cost ceiling, auto-approved tools) plus the policy that
      // says what to do about them — both come from the adapter, so a CLI
      // that adds a limit teaches the card the new rule without touching
      // this file.
      const capabilityNotices = formatNotices(
        warnings,
        adapter.describePolicy?.(validRequest, config) ?? []
      );
      const modelListNote =
        code !== 0 && !timedOut && !output.exceededOutputLimit ? `\n\nIf the model was rejected: Call help_pi_minion for the models usable here.` : "";
      let finalNote = "";
      try {
        const note = onFinalResult?.(finalResult);
        if (note) finalNote = `\n\n**Schedule stopped:** ${note}`;
      } catch {}
      const header = `${frontmatter(reportPath)}${denialWarning}${capabilityNotices}${modelListNote}${capNote}`;
      const stdinWarning = stdinError
        ? `\n\n**Warning:** the job's stdin channel broke mid-run (${stdinError}) — steering messages after that point were rejected.`
        : "";
      const zeroCap = (config.maxResultContextBytes ?? DEFAULT_MAX_RESULT_CONTEXT_BYTES) <= 0;
      const readHint = reportPath && !zeroCap ? "\n\nIf you need more detail, see the report linked above and any files it references." : "";
      postResult(
        `${header}${stdinWarning}\n\n${contextResult}${readHint}${finalNote}\n\n---`,
        {
          id,
          code,
          signal,
          jobDir,
          permissionDenied: sawPermissionDenial,
          ...usageFields(finalUsage)
        },
        !onFinalResult || finalNote !== "",
        `${header}${stdinWarning}\n\n${result}${finalNote}\n\n---`
      );
    } finally {
      settle({ finalResult, reportPath, ok: clean, errorReason: failureReason });
    }
  });

  proc.on("error", async (error) => {
    if (
      !beginFinalize(
        "errored",
        `error=${truncate(error.message.replace(/\r?\n/g, " "), 200)}`
      )
    )
      return;
    let failureReason: string | undefined;
    try {
      markJobFinished(id, "errored");
      clearJobViews(jobUI, id);
      output.writeStderr(error.stack ?? error.message);
      const outputError = await output.close();
      const notFoundHint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `\n\n**${adapter.command}** was not found on PATH. ${adapter.installHint}`
          : "";
      failureReason = `Pi minion failed: ${error.message}${
        outputError ? `\nOutput capture failed: ${outputError.message}` : ""
      }${notFoundHint}`;
      postResult(
        `${frontmatter()}\n\n${failureReason}\n\n---`,
        { id, jobDir }
      );
    } finally {
      settle({ ok: false, errorReason: failureReason });
    }
  });

  return id;
}
