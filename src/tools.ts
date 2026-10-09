import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { Type, type Static } from "typebox";
import type { AgentCliAdapter, MinionConfig } from "./adapters/types.js";
import {
  ensureRegistry,
  getAdapter,
  listAdapterNames,
  listAdapters
} from "./adapters/registry.js";
import { DEFAULT_MAX_RESULT_PREVIEW_BYTES, loadConfig } from "./config.js";
import { confirmWorkflow } from "./agent.ui.js";
import { startWorkflowSession } from "./child-session.js";
import { glyph } from "./glyphs.js";
import { deriveJobTitle, distinctModels } from "./format.js";
import { startJob, validateRequest } from "./job-runner.js";
import {
  clearJobViews,
  getJobUI,
  jobMeta,
  jobs,
  markJobFinished,
  peekJobUI,
  relevantJobsForSession,
  resolveOwnedJob,
  stopJob
} from "./job-store.js";
import { logJobEvent } from "./log.js";
import {
  formatNextRun,
  hasStopMarker,
  resolveOwnedSchedule,
  scheduleIdsOwnedBySession,
  scheduleModel,
  scheduleResolvedModel,
  schedules,
  STOP_SCHEDULE_INSTRUCTION,
  STOP_SCHEDULE_MARKER,
  stopSchedule
} from "./schedule-store.js";
import {
  cancelWorkflow,
  defaultWorkflowDeps,
  startWorkflow,
  tickWorkflowSchedule,
  type WorkflowDeps
} from "./workflow-runner.js";
import {
  formatWorkflowConfirm,
  formatWorkflowPlan,
  formatWorkflowScheduleLines,
  MAX_WORKFLOW_STEPS,
  newWorkflow,
  resolveOwnedWorkflow,
  unenforcedStepIds,
  withEffectiveBudgets,
  isWorkflowRunning,
  validateScheduledWorkflowGraph,
  validateWorkflowGraph,
  workflowBudget,
  workflowIdsOwnedBySession,
  workflowStatus,
  workflows
} from "./workflow-store.js";

// Keep in sync with README.md's "Using pi-minion" section — these are the
// human-facing example prompts, echoed here (via help_pi_minion) so an agent
// asked "how do I use pi minion?" has something concrete to relay instead of
// improvising.
export const PI_MINION_EXAMPLES = [
  "Run a pi minion to explore this code base and summarize it",
  "Run a sonnet pi minion to debug this ticket",
  "Run an opus pi minion to review current changes at medium effort; budget $5",
  "Use a workflow: two sonnet agents review the current changes for bugs and performance, then a gpt-6-luna agent verifies their findings"
];

// Agent-facing (not human-facing): what the caller itself needs to know
// before invoking run_pi_minion, beyond that tool's own parameter
// descriptions.
export const PI_MINION_USAGE_NOTES = [
  "task must be fully self-contained — each run_pi_minion job is stateless and has no access to this conversation or any prior job's result.",
  "effort is required — pick the level that fits the task (see run_pi_minion's effort description); maxBudgetUsd is optional and defaults to the configured maxBudgetUsd.",
  "model must be one of `models` above — already filtered to what's installed on this machine.",
  'If the user names a model vaguely or ambiguously (a brand like "gemini", a partial or outdated id, an old alias), filter `models` above for similar entries, present them to the user, and run only the id they approve — don\'t guess.',
  "schedule_pi_minion takes the same fields plus a cron expression and runs the task on that schedule until cancel_pi_minion_schedule or this session quits; a tick is skipped while the previous run is still going.",
  "run_pi_minion_workflow runs a small DAG of steps (task, model, dependsOn) after the user confirms in a dialog; a step may embed an earlier step's output as {{steps.<id>.result}} (list that id in dependsOn). Steps post no end-of-job message; one summary at the end starts a turn; track it with list_pi_minion_workflows and cancel_pi_minion_workflow.",
  "schedule_pi_minion_workflow takes run_pi_minion_workflow's fields plus a cron expression; the user approves once when it is scheduled, then each tick starts a fresh run (skipped while the previous run is still going) whose summary posts quietly. It needs exactly one final step (one no other step depends on); only that step may end the schedule by finishing its reply with the stop marker; stop it with cancel_pi_minion_schedule (a run in progress is cancelled separately with cancel_pi_minion_workflow and the schedule's lastWorkflowId)."
];

export const RUN_PI_MINION_PARAMETERS = Type.Object({
  task: Type.String({
    description: "The task to delegate without narrowing its scope."
  }),
  model: Type.String({
    description:
      "A model usable on this machine; call help_pi_minion to list them."
  }),
  effort: Type.String({
    description:
      "Required effort/thinking level that fits the task: low for simple, mechanical work; medium for ordinary coding; high for debugging, review, or risky changes (auth, money, data deletion, concurrency)."
  }),
  context: Type.String({
    description:
      'Prior findings, decisions, files, diffs, commands, or other evidence this task depends on — pass task-relevant evidence verbatim, with file paths for additional context, not the entire report. A reference to an earlier job id is not enough, since this job cannot look it up. If this is a genuinely fresh task with no prior context, the whole value must be just that (e.g. "No prior context.") — never combine it with other details. Required so context is never silently left out.'
  }),
  maxBudgetUsd: Type.Optional(
    Type.Number({
      description:
        "Override the minion's cost ceiling in USD for this run. Defaults to the configured maxBudgetUsd."
    })
  )
});

export const SCHEDULE_PI_MINION_PARAMETERS = Type.Object({
  ...RUN_PI_MINION_PARAMETERS.properties,
  cron: Type.String({
    description:
      'Cron expression in local time — 5 fields (minute hour day-of-month month day-of-week) or 6 with leading seconds, e.g. "0 9 * * 1-5".'
  })
});

export const RUN_PI_MINION_WORKFLOW_PARAMETERS = Type.Object({
  title: Type.String({
    description: "Short name shown in the confirm dialog and the status widget."
  }),
  context: Type.String({
    description:
      'Shared by every step, with the same rules as run_pi_minion\'s `context`: pass task-relevant evidence verbatim with file paths, or use exactly "No prior context." for a fresh task.'
  }),
  maxBudgetUsd: Type.Optional(
    Type.Number({
      description:
        "Default cost ceiling in USD per step. Defaults to the configured maxBudgetUsd."
    })
  ),
  steps: Type.Array(
    Type.Object({
      id: Type.String({
        description: "Unique id, lowercase letters, digits and hyphens only."
      }),
      task: Type.String({
        description:
          "Self-contained task for this step. May contain {{steps.<id>.result}}; every id it references must be listed in dependsOn."
      }),
      model: Type.String({
        description:
          "A model usable on this machine; call help_pi_minion to list them."
      }),
      effort: Type.String({
        description:
          "Required effort/thinking level that fits this step's task: low for simple, mechanical work; medium for ordinary coding; high for debugging, review, or risky changes."
      }),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Ids of steps that must finish successfully first. Their results are passed to this step — at a {{steps.<id>.result}} placeholder, or appended at the end if the task has none."
        })
      ),
      maxBudgetUsd: Type.Optional(
        Type.Number({ description: "Override the cost ceiling for this step." })
      )
    }),
    { minItems: 1, maxItems: MAX_WORKFLOW_STEPS }
  )
});

export const SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS = Type.Object({
  ...RUN_PI_MINION_WORKFLOW_PARAMETERS.properties,
  cron: SCHEDULE_PI_MINION_PARAMETERS.properties.cron
});

// Every step is validated before any dialog, so a bad model fails before the
// user is asked anything.
async function validateWorkflowSteps(
  request: Static<typeof RUN_PI_MINION_WORKFLOW_PARAMETERS>,
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  await ensureRegistry(config);
  validateWorkflowGraph(request.steps);
  for (const step of request.steps) {
    try {
      await validateRequest(
        {
          task: step.task,
          model: step.model,
          effort: step.effort,
          context: request.context,
          maxBudgetUsd: step.maxBudgetUsd ?? request.maxBudgetUsd,
          workspace: cwd
        },
        cwd,
        config
      );
    } catch (error) {
      throw new Error(`Step "${step.id}": ${(error as Error).message}`);
    }
  }
}

// Shared by run_pi_minion and run_pi_minion_workflow (per step).
const MODEL_EFFORT_GUIDELINE =
  "Cheap model + low effort for simple work; stronger model + higher effort for complex/risky work; the user's choice wins.";

// The confirm dialog shows only the first ~80 characters of each step's task.
const STEP_TASK_GUIDELINE =
  'Start each step\'s task with what the step does: lead with the action, no boilerplate like "From the current working directory"; the confirm dialog shows only its first line.';

// Steps read the workflow's session, not the registering call's: rehomeWorkflows
// moves it to the replacement session after /new, fork, or resume.
function workflowStepDeps(
  notify: (message: string) => void,
  ui: () => ReturnType<typeof getJobUI>
): WorkflowDeps {
  return {
    ...defaultWorkflowDeps,
    // Steps nest under the workflow's own session when it has one.
    startStep: (stepRequest, wf, onSettled, step, isCancelled) =>
      startJob(
        stepRequest,
        wf.cwd,
        wf.sessionId,
        wf.session?.file ?? wf.sessionFile,
        notify,
        ui(),
        undefined,
        onSettled,
        step,
        isCancelled
      ),
    startSession: (wf) =>
      startWorkflowSession({
        parentSessionFile: wf.sessionFile,
        cwd: wf.cwd,
        name: `${glyph("⇉ ")}${wf.title}`,
        plan: formatWorkflowPlan(wf),
        startedAt: wf.startedAt
      })
  };
}

// ctx.ui.notify for background work that outlives this call: the ctx goes
// stale on a session replacement, but the job/tick must still run.
function safeNotify(ctx: ExtensionContext): (message: string) => void {
  return (message) => {
    try {
      ctx.ui.notify(message, "info");
    } catch {
      // ctx invalidated by a session replacement.
    }
  };
}

// Without a typed reason, steer the agent to ask rather than guess a retry.
function declinedResult(what: string, message?: string) {
  const text = message
    ? `User declined the ${what}: ${message}`
    : `User declined the ${what} without giving a reason. Don't retry it; ask the user why they declined and what to change.`;
  return textResult(text, { declined: true, message });
}

// Shared opening of run_/schedule_pi_minion_workflow: refuse without a UI,
// validate every step, then ask the user. `declined` carries their optional reason.
async function confirmWorkflowRequest(
  toolName: string,
  request: Static<typeof RUN_PI_MINION_WORKFLOW_PARAMETERS>,
  ctx: ExtensionContext,
  // Scheduled workflows only; may throw (e.g. a bad cron) before the dialog.
  scheduleLines?: (config: MinionConfig) => string[]
): Promise<
  | { declined?: false; id: string; config: MinionConfig; deps: WorkflowDeps }
  | { declined: true; message?: string }
> {
  if (!ctx.hasUI) {
    throw new Error(
      `${toolName} needs an interactive session: no one is here to approve it.`
    );
  }
  const config = await loadConfig();
  await validateWorkflowSteps(request, ctx.cwd, config);
  const id = randomUUID();
  const answer = await confirmWorkflow(
    ctx,
    formatWorkflowConfirm(request, config, scheduleLines?.(config))
  );
  if (!answer.approved) {
    void logJobEvent("workflow_declined", {
      id,
      model: distinctModels(request.steps),
      detail: `title="${request.title}"`
    });
    return { declined: true, message: answer.message };
  }
  // Created now so steps and ticks can use peekJobUI() instead of this
  // call's ctx, which goes stale on /reload, /new, fork, or switchSession.
  getJobUI(ctx);
  return {
    id,
    config,
    deps: workflowStepDeps(safeNotify(ctx), () => peekJobUI() ?? getJobUI(ctx))
  };
}

// Shared by help_pi_minion's execute(): what the agent may pick from today.
// Adapters are config-bound — each availableModels() already applies its own
// provider and isModelAllowed gates (the same ones validateRequest enforces)
// against the config the adapter was built with, and an adapter whose binary
// isn't installed never enters the registry in the first place. An empty
// models.allowed means "allow all", so the union is each adapter's full
// self-declared offer (claude's alias names, agy's exact catalog ids, the pi
// adapter's exact ids and provider/id pairs from its model registry). This
// just dedups across adapters; everything else lives in the adapters.
export function buildHelpModelList(adapters: AgentCliAdapter[]): string[] {
  return [...new Set(adapters.flatMap((adapter) => adapter.availableModels()))];
}

function textResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_pi_minion",
    label: "Run Pi Minion",
    description:
      "Run any user-requested task in a background minion process; its result posts automatically to this transcript when it finishes. Each job is stateless — `context` is required on every call so prior context is never silently left out. Use cancel_pi_minion to terminate the run, nothing else.",
    promptSnippet:
      "Delegate a user-requested task to a background minion process",
    promptGuidelines: [
      MODEL_EFFORT_GUIDELINE,
      "Track jobs only with list_pi_minions and cancel_pi_minion — don't poll.",
      "For long-result tasks, tell the minion to lead with a concise TLDR — the posted summary may be truncated.",
      "Fill `context` every call — not just on retries.",
      "For follow-ups, read relevant sections of the prior report (list_pi_minions gives its reportPath), expanding only when needed — never reconstruct findings from memory."
    ],
    parameters: RUN_PI_MINION_PARAMETERS,
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      // workspace is never taken from the model: it's the one field
      // validateRequest requires to exactly equal ctx.cwd, so asking the
      // caller to relay it themselves just invited drift (stale memory,
      // case differences, a subdirectory instead of the root) that surfaced
      // as an intermittent "workspace must be the current Pi workspace"
      // error. Filling it in here makes that whole failure class impossible.
      const id = await startJob(
        { ...request, workspace: ctx.cwd },
        ctx.cwd,
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
        (message) => ctx.ui.notify(message, "info"),
        getJobUI(ctx)
      );
      return textResult(
        `Pi minion job ${id} (${request.model}) is running in the background. Its result will post automatically to this transcript when it finishes — don't poll; track it only with list_pi_minions and cancel_pi_minion.`,
        { id }
      );
    }
  });

  pi.registerTool({
    name: "cancel_pi_minion",
    label: "Cancel Pi Minion",
    description:
      "Cancel a background pi-minion job previously started with run_pi_minion, if it is still running. This is the only way to terminate it.",
    promptSnippet: "Cancel a pi-minion job you started with run_pi_minion",
    promptGuidelines: [
      "E.g. the user asks to stop a job, or the task was superseded.",
      "Another session's id returns not found — only this session's jobs can be cancelled.",
      "If the job id dropped out of context, call list_pi_minions to look it up."
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The job id returned by run_pi_minion." })
    }),
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!resolveOwnedJob(jobs, request.id, sessionId)) {
        return textResult(
          `No running pi minion job ${request.id} owned by this session was found.`,
          { id: request.id }
        );
      }
      stopJob(request.id);
      void logJobEvent("cancelled", {
        id: request.id,
        model: jobMeta.get(request.id)?.model ?? "unknown"
      });
      markJobFinished(request.id, "cancelled");
      clearJobViews(getJobUI(ctx), request.id);
      return textResult(`Pi minion job ${request.id} was cancelled.`, {
        id: request.id
      });
    }
  });

  pi.registerTool({
    name: "list_pi_minions",
    label: "List Pi Minions",
    description:
      "List this session's pi-minion jobs in this workspace — running and recently finished (id, title, model, effort, status, reportPath). Use this to recover a job id you no longer have — e.g. after context compaction — before calling cancel_pi_minion, and to find a finished job's reportPath before writing `context` for a follow-up: read that file and restate its real findings instead of reconstructing them from memory.",
    promptSnippet:
      "List this session's running and recently finished pi-minion jobs",
    parameters: Type.Object({}),
    async execute(_toolCallId, _request, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const relevant = relevantJobsForSession(jobMeta, sessionId, ctx.cwd).map(
        (meta) => ({
          id: meta.id,
          title: meta.title,
          model: meta.resolvedModel ?? meta.model,
          effort: meta.effort,
          status: meta.status,
          reportPath: meta.reportPath
        })
      );
      return textResult(
        relevant.length
          ? JSON.stringify(relevant, null, 2)
          : "No running or recently finished pi-minion jobs owned by this session in this workspace.",
        { jobs: relevant }
      );
    }
  });

  pi.registerTool({
    name: "schedule_pi_minion",
    label: "Schedule Pi Minion",
    description: `Run a pi-minion task repeatedly on a cron schedule. Takes the same fields as run_pi_minion plus \`cron\`. Each tick starts an ordinary run_pi_minion job whose result posts to this transcript without starting a turn (you see it on the user's next prompt); a tick is skipped while the previous run is still going. Each run is told it can end the schedule itself by finishing its reply with ${STOP_SCHEDULE_MARKER} once the goal is fully complete, and that run's result does start a turn; otherwise schedules last until cancel_pi_minion_schedule or this session quits.`,
    promptSnippet: "Schedule a recurring pi-minion task with a cron expression",
    promptGuidelines: [
      "Use schedule_pi_minion only when the user asks for a pi-minion task to recur or run at a later time; use run_pi_minion for a one-off run.",
      "Every scheduled run gets the same task and context captured at schedule time, so `context` must be self-contained for all future runs.",
      'For a "watch X until Y" task, state the completion condition in `task`: a run that finds it met ends the schedule itself, so you don\'t need to cancel it.'
    ],
    parameters: SCHEDULE_PI_MINION_PARAMETERS,
    async execute(_toolCallId, { cron, ...rest }, _signal, _onUpdate, ctx) {
      // Validate up front so a bad model/context fails now, not on the first tick.
      const config = await loadConfig();
      const request = await validateRequest(
        { ...rest, workspace: ctx.cwd },
        ctx.cwd,
        config
      );
      const id = randomUUID();
      const title = deriveJobTitle(request.task);
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const notify = safeNotify(ctx);
      // Created now so ticks can use peekJobUI() instead of this call's ctx,
      // which goes stale on /reload, /new, fork, or switchSession.
      getJobUI(ctx);
      const job = new Cron(cron, async () => {
        const schedule = schedules.get(id);
        if (!schedule || schedule.kind === "workflow") return;
        if (schedule.lastJobId && jobs.has(schedule.lastJobId)) {
          schedule.skipped++;
          void logJobEvent("skipped", {
            id,
            model: request.model,
            detail: `running_job_id=${schedule.lastJobId}`
          });
          return;
        }
        schedule.resolvedModel = scheduleResolvedModel(schedule);
        try {
          // Read from the schedule, not this closure: rehomeSchedules moves
          // it to the replacement session after /new, fork, or resume.
          const jobId: string = await startJob(
            { ...request, task: request.task + STOP_SCHEDULE_INSTRUCTION },
            schedule.cwd,
            schedule.sessionId,
            schedule.sessionFile,
            notify,
            peekJobUI() ?? getJobUI(ctx),
            (finalResult) => {
              if (!hasStopMarker(finalResult) || !stopSchedule(id))
                return undefined;
              void logJobEvent("unscheduled", {
                id,
                model: request.model,
                detail: `self_stop job_id=${jobId}`
              });
              return `${id} "${title}" ended itself; the minion reported the task complete.`;
            }
          );
          schedule.lastJobId = jobId;
          schedule.lastRun = jobMeta.get(schedule.lastJobId);
          schedule.runs++;
        } catch (error) {
          notify(
            `Scheduled pi minion "${title}" failed to start: ${(error as Error).message}`
          );
        }
      });
      schedules.set(id, {
        title,
        cron,
        request,
        effort: request.effort,
        cwd: ctx.cwd,
        sessionId,
        sessionFile,
        job,
        runs: 0,
        skipped: 0
      });
      void logJobEvent("scheduled", {
        id,
        model: request.model,
        detail: `cron="${cron}"`
      });
      return textResult(
        `Scheduled pi minion ${id} "${title}" (${cron}), next run ${formatNextRun(job.nextRun())}. Each run's result posts to this transcript quietly; the run that ends the schedule starts a turn.`,
        { id, nextRun: job.nextRun()?.toISOString() }
      );
    }
  });

  pi.registerTool({
    name: "list_pi_minion_schedules",
    label: "List Pi Minion Schedules",
    description:
      "List this session's pi-minion schedules (id, kind, title, cron, model, effort, nextRun, runs, skipped, lastJobId or lastWorkflowId). Use it to recover a schedule id before calling cancel_pi_minion_schedule.",
    promptSnippet: "List this session's pi-minion schedules",
    parameters: Type.Object({}),
    async execute(_toolCallId, _request, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const relevant = scheduleIdsOwnedBySession(schedules, sessionId).map(
        (id) => {
          const schedule = schedules.get(id)!;
          return {
            id,
            title: schedule.title,
            cron: schedule.cron,
            kind: schedule.kind ?? "job",
            model: scheduleModel(schedule),
            effort: schedule.effort,
            nextRun: schedule.job.nextRun()?.toISOString(),
            runs: schedule.runs,
            skipped: schedule.skipped,
            lastJobId:
              schedule.kind === "workflow" ? undefined : schedule.lastJobId,
            lastWorkflowId:
              schedule.kind === "workflow" ? schedule.lastWorkflowId : undefined
          };
        }
      );
      return textResult(
        relevant.length
          ? JSON.stringify(relevant, null, 2)
          : "No pi-minion schedules owned by this session.",
        { schedules: relevant }
      );
    }
  });

  pi.registerTool({
    name: "cancel_pi_minion_schedule",
    label: "Cancel Pi Minion Schedule",
    description:
      "Stop a pi-minion schedule created with schedule_pi_minion or schedule_pi_minion_workflow so it fires no more runs. A run already in progress keeps going — cancel it separately with cancel_pi_minion and the schedule's lastJobId, or cancel_pi_minion_workflow and its lastWorkflowId.",
    promptSnippet: "Stop a pi-minion schedule",
    parameters: Type.Object({
      id: Type.String({
        description:
          "The schedule id returned by schedule_pi_minion or schedule_pi_minion_workflow."
      })
    }),
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      const schedule = schedules.get(request.id);
      if (
        !schedule ||
        !resolveOwnedSchedule(
          schedules,
          request.id,
          ctx.sessionManager.getSessionId()
        )
      ) {
        return textResult(
          `No pi minion schedule ${request.id} owned by this session was found.`,
          { id: request.id }
        );
      }
      stopSchedule(request.id);
      void logJobEvent("unscheduled", {
        id: request.id,
        model: scheduleModel(schedule)
      });
      if (schedule.kind === "workflow") {
        const running = isWorkflowRunning(workflows, schedule.lastWorkflowId);
        return textResult(
          `Pi minion schedule ${request.id} was stopped.${
            running
              ? ` Its current run ${schedule.lastWorkflowId} is still going; use cancel_pi_minion_workflow to stop it.`
              : ""
          }`,
          { id: request.id, lastWorkflowId: schedule.lastWorkflowId }
        );
      }
      const running = schedule.lastJobId && jobs.has(schedule.lastJobId);
      return textResult(
        `Pi minion schedule ${request.id} was stopped.${
          running
            ? ` Its current run ${schedule.lastJobId} is still going; use cancel_pi_minion to stop it.`
            : ""
        }`,
        { id: request.id, lastJobId: schedule.lastJobId }
      );
    }
  });

  pi.registerTool({
    name: "run_pi_minion_workflow",
    label: "Run Pi Minion Workflow",
    description:
      "Run several pi-minion steps as a dependency graph in the background: steps with no unfinished dependencies run in parallel (up to 4 at once), and a step can embed an earlier step's output with {{steps.<id>.result}}. The user approves the plan in a confirm dialog first. Steps post no result of their own; one summary at the end starts a turn. Returns at once with the workflow id.",
    promptSnippet:
      "Run a multi-step pi-minion workflow (parallel steps, then verify/synthesize)",
    promptGuidelines: [
      "Propose a workflow (steps, models, budget) for 2+ independent subtasks or a produce→verify / research→synthesize chain — never single-step (that's run_pi_minion); call only after the user agrees.",
      '"use/create/run a workflow" counts as agreement — call directly, no proposal.',
      "Never call speculatively — the confirm dialog asks the user.",
      MODEL_EFFORT_GUIDELINE,
      "Steps are stateless — write each task self-contained.",
      STEP_TASK_GUIDELINE,
      "Track only with list_pi_minion_workflows and cancel_pi_minion_workflow — don't poll."
    ],
    parameters: RUN_PI_MINION_WORKFLOW_PARAMETERS,
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      const confirmed = await confirmWorkflowRequest(
        "run_pi_minion_workflow",
        request,
        ctx
      );
      if (confirmed.declined)
        return declinedResult("workflow", confirmed.message);
      const { id, config, deps } = confirmed;
      workflows.set(
        id,
        newWorkflow(request, {
          maxResultPreviewBytes:
            config.maxResultPreviewBytes ?? DEFAULT_MAX_RESULT_PREVIEW_BYTES,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile()
        })
      );
      startWorkflow(id, deps);
      return textResult(
        `Workflow ${id} "${request.title}" started with ${request.steps.length} steps. No per-step results post; one summary posts when all finish. Track it only with list_pi_minion_workflows and cancel_pi_minion_workflow — don't poll.`,
        { id }
      );
    }
  });

  pi.registerTool({
    name: "schedule_pi_minion_workflow",
    label: "Schedule Pi Minion Workflow",
    description: `Run a pi-minion workflow repeatedly on a cron schedule. Takes the same fields as run_pi_minion_workflow plus \`cron\`. The user approves the plan and schedule once, in a confirm dialog; later ticks never ask again. Each tick starts a fresh workflow (skipped while the previous one is still going) whose summary posts to this transcript without starting a turn. It must have exactly one final step (one no other step depends on); only that step is told it can end the schedule by finishing its reply with ${STOP_SCHEDULE_MARKER}, and that run's summary does start a turn. Otherwise it lasts until cancel_pi_minion_schedule or this session quits.`,
    promptSnippet:
      "Schedule a recurring multi-step pi-minion workflow with a cron expression",
    promptGuidelines: [
      "Use only for a multi-step workflow that recurs or runs later; run_pi_minion_workflow for one-offs, schedule_pi_minion for a single recurring task.",
      "Never call speculatively; every tick reuses the steps and context captured now — make them self-contained.",
      'For "watch X until Y", put the completion condition in the final step\'s task — a run that finds it met ends the schedule.'
    ],
    parameters: SCHEDULE_PI_MINION_WORKFLOW_PARAMETERS,
    async execute(_toolCallId, { cron, ...request }, _signal, _onUpdate, ctx) {
      const confirmed = await confirmWorkflowRequest(
        "schedule_pi_minion_workflow",
        request,
        ctx,
        (config) => {
          // Runs after the graph is validated, still before the dialog.
          validateScheduledWorkflowGraph(request.steps);
          // No callback, so this only validates the expression and previews the next run.
          return formatWorkflowScheduleLines(
            cron,
            new Cron(cron).nextRun(),
            workflowBudget(request, config),
            new Date(),
            unenforcedStepIds(request).length
          );
        }
      );
      if (confirmed.declined)
        return declinedResult("scheduled workflow", confirmed.message);
      const { id, config, deps } = confirmed;
      const models = distinctModels(request.steps);
      const job = new Cron(cron, () => {
        tickWorkflowSchedule(id, deps);
      });
      schedules.set(id, {
        kind: "workflow",
        title: request.title,
        cron,
        // Caps pinned now: runs use the approved budget, not a later config value.
        def: withEffectiveBudgets(request, config),
        maxResultPreviewBytes:
          config.maxResultPreviewBytes ?? DEFAULT_MAX_RESULT_PREVIEW_BYTES,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        job,
        runs: 0,
        skipped: 0
      });
      void logJobEvent("scheduled", {
        id,
        model: models,
        detail: `cron="${cron}" workflow="${request.title}"`
      });
      return textResult(
        `Scheduled workflow ${id} "${request.title}" (${cron}), next run ${formatNextRun(job.nextRun())}. Each run's summary posts to this transcript quietly; the run that ends the schedule starts a turn. Stop it with cancel_pi_minion_schedule.`,
        { id, nextRun: job.nextRun()?.toISOString() }
      );
    }
  });

  pi.registerTool({
    name: "list_pi_minion_workflows",
    label: "List Pi Minion Workflows",
    description:
      "List this session's pi-minion workflows (id, title, status, and every step's status, jobId and reportPath). Use it to recover a workflow id before calling cancel_pi_minion_workflow, or to find a step's reportPath.",
    promptSnippet: "List this session's pi-minion workflows",
    parameters: Type.Object({}),
    async execute(_toolCallId, _request, _signal, _onUpdate, ctx) {
      const relevant = workflowIdsOwnedBySession(
        workflows,
        ctx.sessionManager.getSessionId()
      ).map((id) => {
        const wf = workflows.get(id)!;
        return {
          id,
          title: wf.title,
          status: workflowStatus(wf),
          steps: wf.steps.map((step) => ({
            id: step.id,
            status: step.status,
            jobId: step.jobId,
            reportPath: step.reportPath
          }))
        };
      });
      return textResult(
        relevant.length
          ? JSON.stringify(relevant, null, 2)
          : "No pi-minion workflows owned by this session.",
        { workflows: relevant }
      );
    }
  });

  pi.registerTool({
    name: "cancel_pi_minion_workflow",
    label: "Cancel Pi Minion Workflow",
    description:
      "Cancel a pi-minion workflow started with run_pi_minion_workflow: pending steps are cancelled and running steps are stopped. The summary posts quietly.",
    promptSnippet: "Cancel a pi-minion workflow",
    promptGuidelines: [],
    parameters: Type.Object({
      id: Type.String({
        description: "The workflow id returned by run_pi_minion_workflow."
      })
    }),
    async execute(_toolCallId, request, _signal, _onUpdate, ctx) {
      if (
        !resolveOwnedWorkflow(
          workflows,
          request.id,
          ctx.sessionManager.getSessionId()
        ) ||
        !cancelWorkflow(request.id, defaultWorkflowDeps)
      ) {
        return textResult(
          `No running pi minion workflow ${request.id} owned by this session was found.`,
          { id: request.id }
        );
      }
      return textResult(`Pi minion workflow ${request.id} was cancelled.`, {
        id: request.id
      });
    }
  });

  pi.registerTool({
    name: "help_pi_minion",
    label: "Help Pi Minion",
    description:
      "List the pi-minion models usable on this machine, example prompts, and usage notes for run_pi_minion. Use this to pick a valid model for run_pi_minion instead of guessing, or to answer a user's question about how to use pi-minion.",
    promptSnippet: "List usable pi-minion models and usage examples",
    parameters: Type.Object({}),
    async execute() {
      const config = await loadConfig();
      await ensureRegistry(config);
      // Opportunistic live-catalog refresh over every registered adapter —
      // whatever subprocess or registry lookup enumerates models, it happens
      // inside the adapter. A failed refresh keeps the previous snapshot.
      await Promise.all(
        listAdapterNames().map((id) => getAdapter(id).refreshCatalog?.())
      );
      const payload = {
        models: buildHelpModelList(listAdapters()),
        examples: PI_MINION_EXAMPLES,
        usageNotes: PI_MINION_USAGE_NOTES
      };
      return textResult(JSON.stringify(payload, null, 2), payload);
    }
  });
}
