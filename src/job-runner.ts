import { spawn } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobUI, StepRunStats } from "./agent.ui.js";
import type { MinionConfig, MinionRequest, TokenCounts, UsageTotals } from "./adapters/types.js";
import { resolveTaskText, truncate } from "./adapters/util.js";
import { resolveAdapterForModel } from "./adapters/registry.js";
import { writeChildSession } from "./child-session.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_RESULT_PREVIEW_BYTES,
  DEFAULT_PRUNE_AFTER_DAYS,
  isModelAllowed,
  isModelBlocked,
  loadConfig
} from "./config.js";
import {
  deriveJobTitle,
  describeJobResult,
  formatJobFrontmatter,
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

const MAX_PREVIEW_BYTES = 8_192;
const MAX_PREVIEW_LINE_LENGTH = 64;
const STATUS_UPDATE_INTERVAL_MS = 1_000;

export async function validateRequest(
  request: MinionRequest,
  cwd: string,
  config: MinionConfig
): Promise<MinionRequest> {
  const workspace = resolve(request.workspace);
  if (workspace !== resolve(cwd)) {
    throw new Error("workspace must be the current Pi workspace");
  }
  if (!(await stat(workspace)).isDirectory())
    throw new Error("workspace is not a directory");
  if (!isModelAllowed(config, request.model))
    throw new Error(
      isModelBlocked(config, request.model)
        ? `Model is blocked: ${request.model} (blockedModels). Call help_pi_minion for the models usable here.`
        : `Model is not allowed: ${request.model}. Call help_pi_minion for the models usable here.`
    );
  if (
    request.maxBudgetUsd !== undefined &&
    (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0)
  ) {
    throw new Error("maxBudgetUsd must be a positive number");
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
  onSettled?: (outcome: { finalResult?: string; reportPath?: string; ok: boolean } & StepRunStats) => void,
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
  const adapter = resolveAdapterForModel(validRequest.model);
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
      return spawn(adapter.command, adapter.buildArgs(validRequest, config), {
        cwd: validRequest.workspace,
        env: adapter.environment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      if (jobMeta.get(id)?.status === "running") markJobFinished(id, "errored");
      throw error;
    }
  };
  const proc = await spawnProcess();
  const startedAt = Date.now();
  let forceKillTimeout: NodeJS.Timeout | undefined;
  const stopProcess = () => {
    proc.kill("SIGTERM");
    forceKillTimeout ??= setTimeout(() => proc.kill("SIGKILL"), 5_000);
    forceKillTimeout.unref();
  };

  let previewText = "";
  let finalResult: string | undefined;
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
    for (const event of adapter.parseLine(line)) {
      applyModalEvent(jobUI, id, event, toolDurationFallback);
      switch (event.kind) {
        case "permissionDenied":
          sawPermissionDenial = true;
          break;
        case "result":
          finalResult = event.result;
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
      }
    }
  };
  const output = createOutputCapture(
    proc,
    jobDir,
    config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    consumeLine,
    stopProcess
  );

  const timeout = setTimeout(() => {
    timedOut = true;
    stopProcess();
  }, config.timeoutMs);
  jobs.set(id, {
    process: proc,
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
  const settle = (outcome: { finalResult?: string; reportPath?: string; ok: boolean }) => {
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
      jobDir,
      reportPath,
      step: workflowStep?.title
    });
  const postResult = (
    content: string,
    details: Record<string, unknown>,
    triggerTurn = true
  ) => {
    // A workflow step posts nothing at its end: the workflow's one summary
    // carries each step's status, usage, cost and report. Registry cleanup
    // still runs here on every path — jobs.get(id) must not report "not
    // found" while the job is still finalizing its result.
    // Owner looked up now, not at start: the session may have been replaced
    // (rehomed) or quit since.
    if (!onSettled)
      postToSession(jobMeta.get(id)?.sessionId ?? sessionId, content, details, triggerTurn);
    jobs.delete(id);
  };

  proc.on("close", async (code, signal) => {
    if (
      !beginFinalize(
        "exited",
        `exit_code=${code ?? "null"} signal=${signal ?? "none"}${timedOut ? " timed_out=true" : ""}${output.exceededOutputLimit ? " exceeded_output_limit=true" : ""}`
      )
    )
      return;
    let reportPath: string | undefined;
    let outputError: Error | undefined;
    let clean = false;
    try {
      output.flush();
      clearJobViews(jobUI, id);
      outputError = await output.close();
      let resultForContext = finalResult;
      if (finalResult) {
        const resultPath = join(jobDir, "result.md");
        try {
          await writeFile(resultPath, finalResult, "utf8");
          reportPath = resultPath;
          resultForContext = truncateResultForContext(
            finalResult,
            resultPath,
            config.maxResultPreviewBytes ?? DEFAULT_MAX_RESULT_PREVIEW_BYTES
          );
        } catch {
          // Best-effort: if the full result can't be written to disk, fall
          // back to inlining it untruncated rather than pointing at a file
          // that doesn't exist.
        }
      }
      const meta = markJobFinished(id, "done", { reportPath });
      const result = outputError
        ? `Pi minion output capture failed: ${outputError.message}`
        : describeJobResult({
            code,
            signal,
            timedOut,
            exceededOutputLimit: output.exceededOutputLimit,
            finalResult: resultForContext,
            stderrTail: output.stderrTail,
            stdoutPath: output.stdoutPath,
            rawOutputHint: adapter.rawOutputHint
          });
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
      const capabilityWarning = warnings.length ? `\n\n**Warning:** ${warnings.join(" ")}` : "";
      const modelListNote =
        code !== 0 && !timedOut && !output.exceededOutputLimit ? `\n\nIf the model was rejected: Call help_pi_minion for the models usable here.` : "";
      let finalNote = "";
      try {
        const note = onFinalResult?.(finalResult);
        if (note) finalNote = `\n\n**Schedule stopped:** ${note}`;
      } catch {}
      postResult(
        `${frontmatter(reportPath)}${denialWarning}${capabilityWarning}${modelListNote}\n\n${result}${finalNote}\n\n---`,
        {
          id,
          code,
          signal,
          jobDir,
          permissionDenied: sawPermissionDenial,
          ...usageFields(finalUsage)
        },
        !onFinalResult || finalNote !== ""
      );
      clean = code === 0 && !timedOut && !output.exceededOutputLimit && !outputError && finalResult !== undefined;
    } finally {
      settle({ finalResult, reportPath, ok: clean });
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
    try {
      markJobFinished(id, "errored");
      clearJobViews(jobUI, id);
      output.writeStderr(error.stack ?? error.message);
      const outputError = await output.close();
      const notFoundHint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `\n\n**${adapter.command}** was not found on PATH. ${adapter.installHint}`
          : "";
      postResult(
        `${frontmatter()}\n\nPi minion failed: ${error.message}${
          outputError ? `\nOutput capture failed: ${outputError.message}` : ""
        }${notFoundHint}\n\n---`,
        { id, jobDir }
      );
    } finally {
      settle({ ok: false });
    }
  });

  return id;
}
