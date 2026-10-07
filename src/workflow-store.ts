import { pathToFileURL } from "node:url";
import type { MinionConfig } from "./adapters/types.js";
import { resolveAdapterForModel } from "./adapters/registry.js";
import type {
  ConfirmLine,
  StepRunStats,
  WorkflowConfirm,
  WorkflowStepStatus,
  WorkflowWidgetStatus
} from "./agent.ui.js";
import { formatTokenUsage } from "./agent.ui.js";
import { deriveJobTitle, formatCostUsd, truncateResultForContext } from "./format.js";
import { glyph } from "./glyphs.js";
import type { WorkflowSession } from "./child-session.js";
import { jobMeta } from "./job-store.js";
import { formatNextRun } from "./schedule-store.js";

export const MAX_WORKFLOW_STEPS = 10;
export const MAX_PARALLEL_STEPS = 4;

export type WorkflowStepDef = {
  id: string;
  // May contain {{steps.<id>.result}}; each referenced id must be in dependsOn.
  task: string;
  model: string;
  effort: string;
  dependsOn?: string[];
  maxBudgetUsd?: number;
};

export type WorkflowDef = {
  title: string;
  context: string;
  maxBudgetUsd?: number;
  steps: WorkflowStepDef[];
};

export type WorkflowStep = Omit<WorkflowStepDef, "dependsOn"> & {
  dependsOn: string[];
  status: WorkflowStepStatus;
  jobId?: string;
  reportPath?: string;
  // The step's full final result, kept to fill later steps' placeholders.
  result?: string;
} & Partial<StepRunStats>;

// Session-lifetime only (never persisted), like schedules. Every step runs
// through job-runner.ts's startJob(), so a step is an ordinary job
// everywhere else (widget, picker, modal, result post, child session).
export type MinionWorkflow = {
  title: string;
  context: string;
  maxBudgetUsd?: number;
  // pi-minion.json's maxResultPreviewBytes at creation.
  maxResultPreviewBytes: number;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  steps: WorkflowStep[];
  startedAt: number;
  cancelled: boolean;
  finishedAt?: number;
  // Set on a run started by a schedule tick: the final summary posts quietly,
  // and a final step ending its reply with the stop marker calls `stop`.
  scheduled?: { stop: () => boolean };
  // Its own /resume session (see child-session.ts's startWorkflowSession).
  session?: WorkflowSession;
  stopRequested?: boolean;
};

export const workflows = new Map<string, MinionWorkflow>();

// The one place a run is built — run_pi_minion_workflow and every schedule
// tick alike — so one-off and scheduled runs can't drift apart.
export function newWorkflow(
  def: WorkflowDef,
  env: Pick<MinionWorkflow, "maxResultPreviewBytes" | "cwd" | "sessionId" | "sessionFile" | "scheduled">
): MinionWorkflow {
  return {
    title: def.title,
    context: def.context,
    maxBudgetUsd: def.maxBudgetUsd,
    ...env,
    steps: def.steps.map((step) => ({ ...step, dependsOn: step.dependsOn ?? [], status: "pending" as const })),
    startedAt: Date.now(),
    cancelled: false
  };
}

// Same retention as job-store.ts's pruneJobMeta: finished workflows back
// list_pi_minion_workflows, but a frequent workflow schedule would otherwise
// grow this map for the life of the session.
export function pruneWorkflows(days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const [id, wf] of workflows) {
    if (wf.finishedAt !== undefined && wf.finishedAt < cutoff) workflows.delete(id);
  }
}

export type WorkflowStatus = "running" | "done" | "failed" | "cancelled";

const PLACEHOLDER = /\{\{\s*steps\.([a-z0-9-]+)\.result\s*\}\}/g;

export function referencedStepIds(task: string): string[] {
  return [...new Set([...task.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

// Throws a readable error for the first problem found.
export function validateWorkflowGraph(steps: WorkflowStepDef[]): void {
  if (steps.length === 0) throw new Error("A workflow needs at least one step");
  if (steps.length > MAX_WORKFLOW_STEPS) {
    throw new Error(`A workflow has at most ${MAX_WORKFLOW_STEPS} steps, got ${steps.length}`);
  }
  const ids = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z0-9-]+$/.test(step.id)) {
      throw new Error(`Step id "${step.id}" must match [a-z0-9-]+`);
    }
    if (ids.has(step.id)) throw new Error(`Duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of steps) {
    const dependsOn = step.dependsOn ?? [];
    for (const [index, dep] of dependsOn.entries()) {
      if (dependsOn.indexOf(dep) !== index) {
        throw new Error(`Step "${step.id}" lists "${dep}" in dependsOn more than once`);
      }
      if (!ids.has(dep)) throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
      if (dep === step.id) throw new Error(`Step "${step.id}" depends on itself`);
    }
    for (const ref of referencedStepIds(step.task)) {
      if (!dependsOn.includes(ref)) {
        throw new Error(
          `Step "${step.id}" uses {{steps.${ref}.result}} but does not list "${ref}" in dependsOn`
        );
      }
    }
  }
  // Kahn's algorithm: anything never reached sits on a cycle.
  const stages = stageIds(steps);
  if (stages.flat().length < steps.length) {
    const reached = new Set(stages.flat());
    const stuck = steps.filter((step) => !reached.has(step.id)).map((step) => step.id);
    throw new Error(`Workflow steps form a dependency cycle: ${stuck.join(", ")}`);
  }
}

function stageIds(steps: Array<Pick<WorkflowStepDef, "id" | "dependsOn">>): string[][] {
  const level = new Map<string, number>();
  const stages: string[][] = [];
  let remaining = steps;
  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      (step.dependsOn ?? []).every((dep) => level.has(dep) && level.get(dep)! < stages.length)
    );
    if (ready.length === 0) break;
    for (const step of ready) level.set(step.id, stages.length);
    stages.push(ready.map((step) => step.id));
    remaining = remaining.filter((step) => !level.has(step.id));
  }
  return stages;
}

// Topological levels: stage 0 has no dependencies, each later step sits one
// level past its deepest dependency. Display grouping only — the runner
// starts a step as soon as its own dependencies are done.
export function workflowStages(steps: Array<Pick<WorkflowStepDef, "id" | "dependsOn">>): string[][] {
  return stageIds(steps);
}

// Fills {{steps.<id>.result}} from the finished steps. A large result
// becomes a preview plus a pointer to its file, like a posted job result.
// A dependency the task never references by placeholder is appended at the
// end, so dependsOn alone still hands the step its inputs; placeholders only
// choose where a result goes. maxResultPreviewBytes is split across the
// step's dependencies so inlined results total about one preview, not one each.
export function renderStepTask(
  task: string,
  steps: ReadonlyArray<Pick<WorkflowStep, "id" | "result" | "reportPath">>,
  maxResultPreviewBytes: number,
  dependsOn: readonly string[] = []
): string {
  const perResultBytes = Math.floor(maxResultPreviewBytes / Math.max(1, new Set(dependsOn).size));
  const resultOf = (id: string): string | undefined => {
    const step = steps.find((candidate) => candidate.id === id);
    if (step?.result === undefined) return undefined;
    return step.reportPath
      ? truncateResultForContext(step.result, step.reportPath, perResultBytes)
      : step.result;
  };
  const rendered = task.replace(PLACEHOLDER, (match, id: string) => resultOf(id) ?? match);
  const referenced = new Set(referencedStepIds(task));
  const appended = dependsOn
    .filter((id) => !referenced.has(id))
    .flatMap((id) => {
      const result = resultOf(id);
      return result === undefined ? [] : [`Result of step ${id}:\n${result}`];
    });
  return appended.length ? `${rendered}\n\n${appended.join("\n\n")}` : rendered;
}

function stepBudget(
  step: Pick<WorkflowStepDef, "maxBudgetUsd">,
  def: Pick<WorkflowDef, "maxBudgetUsd">,
  config: Pick<MinionConfig, "maxBudgetUsd">
): number {
  return step.maxBudgetUsd ?? def.maxBudgetUsd ?? config.maxBudgetUsd;
}

// pi and agy don't enforce maxBudgetUsd (adapter capabilities), so a step on
// them has no real cost ceiling. An unresolvable model counts as enforced:
// validation reports it before any dialog.
export function modelEnforcesBudget(model: string): boolean {
  try {
    return resolveAdapterForModel(model).capabilities.supportsMaxBudgetUsd;
  } catch {
    return true;
  }
}

// Sum of the caps that are actually enforced; see unenforcedStepIds for the rest.
export function workflowBudget(
  def: WorkflowDef,
  config: Pick<MinionConfig, "maxBudgetUsd">,
  enforces: (model: string) => boolean = modelEnforcesBudget
): number {
  return def.steps
    .filter((step) => enforces(step.model))
    .reduce((sum, step) => sum + stepBudget(step, def, config), 0);
}

export function unenforcedStepIds(
  def: Pick<WorkflowDef, "steps">,
  enforces: (model: string) => boolean = modelEnforcesBudget
): string[] {
  return def.steps.filter((step) => !enforces(step.model)).map((step) => step.id);
}

// "budget cap $12.00", plus a note for steps whose adapter ignores the cap.
function formatBudgetCap(total: number, unenforced: number): string {
  const steps = `${unenforced} step${unenforced === 1 ? "" : "s"} with no cost ceiling`;
  if (unenforced === 0) return `budget cap $${total.toFixed(2)}`;
  return total > 0 ? `budget cap $${total.toFixed(2)} + ${steps}` : steps;
}

// Pins each step's effective cap (step, else workflow, else config) into the
// definition, so a schedule's later runs use what the user approved rather
// than whatever pi-minion.json says by then.
export function withEffectiveBudgets(def: WorkflowDef, config: Pick<MinionConfig, "maxBudgetUsd">): WorkflowDef {
  return { ...def, steps: def.steps.map((step) => ({ ...step, maxBudgetUsd: stepBudget(step, def, config) })) };
}

// Steps nothing depends on: a scheduled workflow's last word, so only these
// are told they may end the schedule.
export function terminalStepIds(steps: ReadonlyArray<Pick<WorkflowStepDef, "id" | "dependsOn">>): Set<string> {
  const needed = new Set(steps.flatMap((step) => step.dependsOn ?? []));
  return new Set(steps.filter((step) => !needed.has(step.id)).map((step) => step.id));
}

// A scheduled workflow needs exactly one final step: it alone is told it can
// end the schedule with the stop marker, so "is the goal met?" has one owner.
export function validateScheduledWorkflowGraph(steps: ReadonlyArray<Pick<WorkflowStepDef, "id" | "dependsOn">>): void {
  const finals = [...terminalStepIds(steps)];
  if (finals.length !== 1) {
    throw new Error(
      `A scheduled workflow needs exactly one final step (one no other step depends on), got ${finals.length}: ${finals.join(", ")}. Add a final step that dependsOn ${finals.join(", ")} and decides whether the goal is met.`
    );
  }
}

// A schedule tick is skipped while its previous workflow is still going.
export function isWorkflowRunning(
  workflows: ReadonlyMap<string, Pick<MinionWorkflow, "finishedAt">>,
  id: string | undefined
): boolean {
  const wf = id === undefined ? undefined : workflows.get(id);
  return wf !== undefined && wf.finishedAt === undefined;
}

// The extra confirm lines for schedule_pi_minion_workflow.
export function formatWorkflowScheduleLines(
  cron: string,
  nextRun: Date | null,
  total: number,
  now: Date = new Date(),
  unenforced = 0
): string[] {
  return [
    `Runs on "${cron}" — next run ${formatNextRun(nextRun, now)}`,
    `${formatBudgetCap(total, unenforced).replace(/^budget/, "Budget")} per run`,
    "Stops itself when the final step reports done, or with cancel_pi_minion_schedule."
  ];
}

function joinIds(ids: string[]): string {
  return ids.join(", ");
}

// Longer than a job title: the confirm dialog is the user's only look at what each step does.
const CONFIRM_STEP_TITLE_LENGTH = 80;

// The workflow session's opening message in /resume: each step with its
// model/effort, what it waits for, and its task.
export function formatWorkflowPlan(wf: Pick<MinionWorkflow, "title" | "context" | "steps">): string {
  return [
    `Workflow: ${wf.title}`,
    "",
    `Context: ${wf.context}`,
    "",
    ...wf.steps.flatMap((step) => [
      `## ${step.id} (${step.model}/${step.effort})${step.dependsOn.length ? ` after ${step.dependsOn.join(", ")}` : ""}`,
      "",
      step.task,
      ""
    ])
  ].join("\n").trimEnd();
}

// "<workflow title> › <step id>": a step job's title in the picker, modal
// header, child session name and result frontmatter.
export function workflowStepTitle(workflowTitle: string, stepId: string): string {
  return `${workflowTitle} › ${stepId}`;
}

// Picker rows for a running workflow: its ⇉ row (⇉ is present in common
// monospace fonts; ⛓ and ⏱ are not), then each running step's
// job indented beneath it.
export function workflowPickerRows(id: string, wf: MinionWorkflow): Array<{ id: string; label: string }> {
  return [
    { id, label: formatWorkflowLabel(wf) },
    ...wf.steps.flatMap((step) =>
      step.status === "running" && step.jobId
        ? [{ id: step.jobId, label: `  › ${step.id} - ${step.model}` }]
        : []
    )
  ];
}

// Structured confirm content for agent.ui.ts's confirmWorkflow overlay.
// Stages are display-only groups; each step line names exactly what it waits for.
export function formatWorkflowConfirm(
  def: WorkflowDef,
  config: Pick<MinionConfig, "maxBudgetUsd">,
  // Extra lines for a scheduled workflow; also swaps the closing question.
  scheduleLines?: string[],
  enforces: (model: string) => boolean = modelEnforcesBudget
): WorkflowConfirm {
  const stages = workflowStages(def.steps);
  const byId = new Map(def.steps.map((step) => [step.id, step]));
  const total = workflowBudget(def, config, enforces);
  const count = def.steps.length;
  const title = `${def.title} — ${count} pi minion${count === 1 ? "" : "s"} in ${stages.length} stage${stages.length === 1 ? "" : "s"}, ${formatBudgetCap(total, unenforcedStepIds(def, enforces).length)}`;
  const text = (value: string, muted = false): ConfirmLine[] =>
    value.split("\n").map((line) => [{ text: line, ...(muted ? { style: "muted" as const } : {}) }]);
  const lines: ConfirmLine[] = [[]];
  stages.forEach((ids, index) => {
    const heading =
      index === 0
        ? `Stage 1 (start right away${ids.length > 1 ? ", in parallel" : ""})`
        : `Stage ${index + 1}`;
    lines.push([{ text: heading, style: "muted" }]);
    for (const id of ids) {
      const step = byId.get(id)!;
      const line: ConfirmLine = [
        { text: `  • ${id}: ${deriveJobTitle(step.task, CONFIRM_STEP_TITLE_LENGTH)} — ` },
        { text: `${step.model}, ${step.effort} effort`, style: "effort", effort: step.effort }
      ];
      if (!enforces(step.model)) line.push({ text: " · no cost ceiling", style: "muted" });
      const deps = step.dependsOn ?? [];
      if (deps.length > 0) {
        let wait = ` · starts when ${joinIds(deps)} ${deps.length === 1 ? "finishes" : "finish"}`;
        const refs = referencedStepIds(step.task);
        if (refs.length > 0) wait += `; uses ${refs.length === 1 ? "its result" : "their results"}`;
        line.push({ text: wait, style: "muted" });
      }
      lines.push(line);
    }
  });
  lines.push(
    [],
    ...(scheduleLines
      ? [
          ...text(
            "Each agent works in the background in this workspace. Each run posts one\nquiet summary when all its steps finish.",
            true
          ),
          [],
          ...scheduleLines.flatMap((line) => text(line)),
          [],
          ...text("Schedule this workflow?")
        ]
      : [
          ...text(
            "Each agent works in the background in this workspace. You'll get one summary\nwhen all finish; cancel anytime with \"cancel the workflow\".",
            true
          ),
          [],
          ...text("Run this workflow?")
        ])
  );
  return { title, lines };
}

export function workflowStatus(wf: Pick<MinionWorkflow, "cancelled" | "steps">): WorkflowStatus {
  if (wf.cancelled) return "cancelled";
  if (wf.steps.some((step) => step.status === "pending" || step.status === "running")) {
    return "running";
  }
  return wf.steps.every((step) => step.status === "done") ? "done" : "failed";
}

// The workflow's single end-of-run post: one line per step with its status,
// model, usage, cost and reportPath link rather than inlined results.
export function formatWorkflowSummary(wf: MinionWorkflow, note?: string, alert?: string): string {
  const status = workflowStatus(wf);
  const counts = (["done", "failed", "skipped", "cancelled"] as const)
    .map((name) => [name, wf.steps.filter((step) => step.status === name).length] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
  const stats = (step: WorkflowStep): string => {
    if (!step.tokenUsage) return "";
    const { input, output, cacheWrite, cacheRead } = step.tokenUsage;
    const cost = formatCostUsd(step.totalCostUsd).replaceAll("$", "\\$");
    return ` · ${formatTokenUsage(input, output, cacheWrite, cacheRead)} · ${cost}`;
  };
  // No reportPath but a result (pre-spawn failure reason, or a result.md
  // write that failed): show it inline so a failed step says why.
  const lines = wf.steps.map(
    (step) =>
      `- ${step.id}: ${step.status} · ${step.model}${stats(step)}${
        step.reportPath
          ? ` · [${step.reportPath}](${pathToFileURL(step.reportPath).href})`
          : step.result
            ? ` · ${step.result.replaceAll("\n", " ").slice(0, 300)}`
            : ""
      }`
  );
  return [
    `## Pi minion workflow ${status}: ${wf.title}`,
    "",
    counts,
    "",
    ...lines,
    ...(wf.steps.some((step) => step.reportPath)
      ? ["", "Read each step's reportPath for its full result."]
      : []),
    ...(note ? ["", `**Schedule stopped:** ${note}`] : []),
    ...(alert ? ["", `**Needs attention:** ${alert}`] : [])
  ].join("\n");
}

// Same as schedule-store.ts's rehomeSchedules, for workflows: later steps
// run under the replacement session and thread their child sessions under
// its file.
export function rehomeWorkflows(from: string, to: string, sessionFile: string | undefined): void {
  for (const wf of workflows.values()) {
    if (wf.sessionId !== from) continue;
    wf.sessionId = to;
    wf.sessionFile = sessionFile;
  }
}

// Same rationale as schedule-store.ts's scheduleIdsOwnedBySession.
export function workflowIdsOwnedBySession(
  workflows: ReadonlyMap<string, { sessionId: string }>,
  sessionId: string
): string[] {
  return [...workflows.entries()]
    .filter(([, wf]) => wf.sessionId === sessionId)
    .map(([id]) => id);
}

export function resolveOwnedWorkflow(
  workflows: ReadonlyMap<string, { sessionId: string }>,
  id: string,
  sessionId: string
): boolean {
  return workflows.get(id)?.sessionId === sessionId;
}

// The alt+j picker row.
export function formatWorkflowLabel(wf: Pick<MinionWorkflow, "title" | "steps">): string {
  const done = wf.steps.filter((step) => step.status === "done").length;
  const running = wf.steps.filter((step) => step.status === "running").map((step) => step.id);
  return `${glyph("⇉ ")}${wf.title} · ${done}/${wf.steps.length} steps${running.length ? ` · ${joinIds(running)}` : ""}`;
}

// A step's model shows as the CLI-reported id once its job has one (running
// or finished), and as the requested alias until then.
export function workflowWidgetStatus(
  wf: MinionWorkflow,
  resolvedModel: (jobId: string) => string | undefined = (jobId) => jobMeta.get(jobId)?.resolvedModel
): WorkflowWidgetStatus {
  const stages = workflowStages(wf.steps);
  const open = new Set(
    wf.steps
      .filter((step) => step.status === "pending" || step.status === "running")
      .map((step) => step.id)
  );
  const current = stages.findIndex((ids) => ids.some((id) => open.has(id)));
  return {
    title: wf.title,
    startedAt: wf.startedAt,
    stage: (current === -1 ? stages.length - 1 : current) + 1,
    stages: stages.length,
    steps: wf.steps.map((step) => ({
      id: step.id,
      status: step.status,
      model: (step.jobId && resolvedModel(step.jobId)) || step.model,
      effort: step.effort,
      jobId: step.jobId,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      tokenUsage: step.tokenUsage
    }))
  };
}
