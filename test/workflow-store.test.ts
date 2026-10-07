import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setModelRegistry } from "../src/adapters/pi.js";
import { fakeModelRegistry } from "./fakes.js";
import {
  formatWorkflowConfirm,
  formatWorkflowLabel,
  workflowPickerRows,
  workflowStepTitle,
  formatWorkflowPlan,
  formatWorkflowScheduleLines,
  isWorkflowRunning,
  pruneWorkflows,
  formatWorkflowSummary,
  MAX_WORKFLOW_STEPS,
  referencedStepIds,
  rehomeWorkflows,
  renderStepTask,
  terminalStepIds,
  resolveOwnedWorkflow,
  validateScheduledWorkflowGraph,
  validateWorkflowGraph,
  workflowIdsOwnedBySession,
  workflowStages,
  workflowStatus,
  workflows,
  workflowWidgetStatus,
  workflowBudget,
  unenforcedStepIds,
  withEffectiveBudgets,
  type MinionWorkflow,
  type WorkflowStepDef
} from "../src/workflow-store.js";

const config = { maxBudgetUsd: 5 };

// ownsModel routes against the captured catalog — seed one covering the
// pi-adapter models these tests reference (files run in isolated test
// processes, so no cleanup needed).
setModelRegistry(fakeModelRegistry([{ id: "gpt-5", provider: "openai-codex" }]));

function def(...steps: Array<Partial<WorkflowStepDef> & { id: string }>): WorkflowStepDef[] {
  return steps.map(
    (step) => ({ task: `Task ${step.id}`, model: "sonnet", effort: "medium", ...step }) as WorkflowStepDef
  );
}

function fakeWorkflow(overrides: Partial<MinionWorkflow> = {}): MinionWorkflow {
  return {
    title: "Review MR",
    context: "No prior context.",
    maxResultPreviewBytes: 50_000,
    cwd: "/w",
    sessionId: "s1",
    steps: [
      { id: "bugs", task: "t", model: "sonnet", effort: "medium", dependsOn: [], status: "done", reportPath: "/r/bugs.md" },
      { id: "verify", task: "t", model: "luna", effort: "low", dependsOn: ["bugs"], status: "running", jobId: "j2" }
    ],
    startedAt: 0,
    cancelled: false,
    ...overrides
  };
}

describe("validateWorkflowGraph", () => {
  it("accepts a valid graph", () => {
    validateWorkflowGraph(def({ id: "a" }, { id: "b", dependsOn: ["a"], task: "Use {{steps.a.result}}" }));
  });

  it("rejects a duplicate id", () => {
    assert.throws(() => validateWorkflowGraph(def({ id: "a" }, { id: "a" })), /Duplicate step id "a"/);
  });

  it("rejects an id outside [a-z0-9-]+", () => {
    assert.throws(() => validateWorkflowGraph(def({ id: "Bad_Id" })), /must match/);
  });

  it("rejects an unknown dependency", () => {
    assert.throws(() => validateWorkflowGraph(def({ id: "a", dependsOn: ["x"] })), /unknown step "x"/);
  });

  it("rejects a duplicate id in dependsOn", () => {
    assert.throws(
      () => validateWorkflowGraph(def({ id: "a" }, { id: "b", dependsOn: ["a", "a"] })),
      /lists "a" in dependsOn more than once/
    );
  });

  it("rejects a cycle", () => {
    assert.throws(
      () => validateWorkflowGraph(def({ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] })),
      /cycle: a, b/
    );
  });

  it("rejects a placeholder whose step is not in dependsOn", () => {
    assert.throws(
      () => validateWorkflowGraph(def({ id: "a" }, { id: "b", task: "Use {{steps.a.result}}" })),
      /does not list "a" in dependsOn/
    );
  });

  it("rejects an empty or oversized workflow", () => {
    assert.throws(() => validateWorkflowGraph([]), /at least one/);
    const many = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) => ({ id: `s${i}` }));
    assert.throws(() => validateWorkflowGraph(def(...many)), /at most 10/);
  });
});

describe("workflowStages", () => {
  it("groups steps into topological levels", () => {
    const stages = workflowStages(
      def(
        { id: "bugs" },
        { id: "perf" },
        { id: "verify", dependsOn: ["bugs", "perf"] },
        { id: "report", dependsOn: ["verify"] }
      )
    );
    assert.deepEqual(stages, [["bugs", "perf"], ["verify"], ["report"]]);
  });

  it("places a step one level past its deepest dependency", () => {
    const stages = workflowStages(
      def({ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["a", "b"] })
    );
    assert.deepEqual(stages, [["a"], ["b"], ["c"]]);
  });
});

describe("renderStepTask", () => {
  const steps = [
    { id: "a", result: "found 2 bugs", reportPath: "/r/a.md" },
    { id: "b", result: undefined, reportPath: undefined }
  ];

  it("substitutes a finished step's result", () => {
    assert.equal(renderStepTask("Verify: {{steps.a.result}}", steps, 1000), "Verify: found 2 bugs");
    assert.equal(renderStepTask("{{ steps.a.result }}", steps, 1000), "found 2 bugs");
  });

  it("truncates a large result to a preview plus a pointer to its file", () => {
    const big = [{ id: "a", result: "line\n".repeat(100), reportPath: "/r/a.md" }];
    const out = renderStepTask("{{steps.a.result}}", big, 50);
    assert.match(out, /Full result at \/r\/a\.md/);
    assert.ok(out.length < 400);
  });

  it("splits the preview budget across dependencies so the inlined total stays capped", () => {
    const two = [
      { id: "a", result: "line\n".repeat(500), reportPath: "/r/a.md" },
      { id: "b", result: "line\n".repeat(500), reportPath: "/r/b.md" }
    ];
    const lines = (text: string) => text.split("\n").filter((l) => l === "line").length;
    const alone = renderStepTask("{{steps.a.result}}", two, 100, ["a"]);
    const split = renderStepTask("{{steps.a.result}} and more", two, 100, ["a", "b"]);
    assert.equal(lines(split), lines(alone), "two results together inline about one budget");
    assert.match(split, /Full result at \/r\/a\.md/);
    assert.match(split, /Result of step b:\n\[Showing/);
    assert.match(split, /Full result at \/r\/b\.md/);
    // Placeholders and appended results share the same split.
    const placed = renderStepTask("{{steps.a.result}} {{steps.b.result}}", two, 100, ["a", "b"]);
    assert.equal(lines(placed), lines(split));
  });

  it("leaves an unresolved placeholder alone", () => {
    assert.equal(renderStepTask("{{steps.b.result}}", steps, 1000), "{{steps.b.result}}");
  });

  it("appends a dependency's result when the task has no placeholder for it", () => {
    assert.equal(renderStepTask("Verify the findings.", steps, 1000, ["a"]), "Verify the findings.\n\nResult of step a:\nfound 2 bugs");
  });

  it("doesn't append a dependency already placed by placeholder", () => {
    assert.equal(renderStepTask("Verify: {{steps.a.result}}", steps, 1000, ["a"]), "Verify: found 2 bugs");
  });
});

describe("referencedStepIds", () => {
  it("lists each referenced id once", () => {
    assert.deepEqual(referencedStepIds("{{steps.a.result}} {{steps.b.result}} {{steps.a.result}}"), ["a", "b"]);
  });
});

const plain = (lines: Array<Array<{ text: string }>>) =>
  lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");

describe("formatWorkflowConfirm", () => {
  it("renders stages, per-step waits, and the budget total", () => {
    const { title, lines } = formatWorkflowConfirm(
      {
        title: "Review MR",
        context: "No prior context.",
        steps: def(
          { id: "bugs", task: "Find bugs in the auth changes", effort: "medium" },
          { id: "perf", task: "Find performance issues", effort: "high", maxBudgetUsd: 2 },
          { id: "verify", task: "Verify each finding: {{steps.bugs.result}}", model: "luna", effort: "low", dependsOn: ["bugs", "perf"] }
        )
      },
      config,
      undefined,
      () => true
    );
    assert.equal(title, "Review MR — 3 pi minions in 2 stages, budget cap $12.00");
    assert.equal(
      plain(lines),
      [
        "",
        "Stage 1 (start right away, in parallel)",
        "  • bugs: Find bugs in the auth changes — sonnet, medium effort",
        "  • perf: Find performance issues — sonnet, high effort",
        "Stage 2",
        "  • verify: Verify each finding: {{steps.bugs.result}} — luna, low effort · starts when bugs, perf finish; uses its result",
        "",
        "Each agent works in the background in this workspace. You'll get one summary",
        "when all finish; cancel anytime with \"cancel the workflow\".",
        "",
        "Run this workflow?"
      ].join("\n")
    );
  });

  it("tags headings and waits muted and colors each step's model and effort", () => {
    const { lines } = formatWorkflowConfirm(
      {
        title: "T",
        context: "c",
        steps: def(
          { id: "a", task: "Do a", effort: "high" },
          { id: "b", task: "Do b {{steps.a.result}}", dependsOn: ["a"] }
        )
      },
      config
    );
    const find = (prefix: string) => lines.find((line) => line[0]?.text.startsWith(prefix))!;
    assert.equal(find("Stage 1")[0]!.style, "muted");
    assert.deepEqual(find("  • a:")[1], { text: "sonnet, high effort", style: "effort", effort: "high" });
    const b = find("  • b:");
    assert.equal(b[1]!.effort, "medium");
    assert.equal(b[2]!.style, "muted");
    assert.match(b[2]!.text, /starts when a finishes; uses its result/);
    assert.equal(find("Run this workflow?")[0]!.style, undefined);
  });
});

describe("budget display with unenforced adapters", () => {
  const steps = def({ id: "a", maxBudgetUsd: 2 }, { id: "b", model: "gpt-5" }, { id: "c", model: "gpt-5", maxBudgetUsd: 9 });
  const enforces = (model: string) => model !== "gpt-5";
  const workflow = { title: "T", context: "c", steps };

  it("sums only enforced caps and names the steps with none", () => {
    assert.equal(workflowBudget(workflow, config, enforces), 2);
    assert.deepEqual(unenforcedStepIds(workflow, enforces), ["b", "c"]);
  });

  it("marks those steps and the title in the confirm dialog", () => {
    const { title, lines } = formatWorkflowConfirm(workflow, config, undefined, enforces);
    assert.equal(title, "T — 3 pi minions in 1 stage, budget cap $2.00 + 2 steps with no cost ceiling");
    const text = plain(lines);
    assert.match(text, /• b: Task b — gpt-5, medium effort · no cost ceiling/);
    assert.doesNotMatch(text.split("\n").find((l) => l.includes("• a:"))!, /no cost ceiling/);
    const marker = lines.find((line) => line[0]?.text.startsWith("  • b:"))!.at(-1)!;
    assert.equal(marker.style, "muted");
  });

  it("says only 'no cost ceiling' when no step is enforced, and adds it to the schedule line", () => {
    const { title } = formatWorkflowConfirm({ title: "T", context: "c", steps: [steps[1]] }, config, undefined, enforces);
    assert.match(title, /1 stage, 1 step with no cost ceiling$/);
    const lines = formatWorkflowScheduleLines("0 9 * * *", null, 2, new Date(), 2);
    assert.equal(lines[1], "Budget cap $2.00 + 2 steps with no cost ceiling per run");
  });

  it("the default lookup follows the adapters' capabilities", () => {
    // claude enforces maxBudgetUsd; pi (gpt-*) does not.
    assert.deepEqual(unenforcedStepIds({ steps: def({ id: "a", model: "sonnet" }, { id: "b", model: "gpt-5" }) }), ["b"]);
  });
});

describe("withEffectiveBudgets", () => {
  it("pins step ?? workflow ?? config caps into each step", () => {
    const pinned = withEffectiveBudgets(
      { title: "T", context: "c", maxBudgetUsd: 3, steps: def({ id: "a" }, { id: "b", maxBudgetUsd: 1 }) },
      config
    );
    assert.deepEqual(pinned.steps.map((step) => step.maxBudgetUsd), [3, 1]);
    const noWorkflowCap = withEffectiveBudgets({ title: "T", context: "c", steps: def({ id: "a" }) }, config);
    assert.equal(noWorkflowCap.steps[0].maxBudgetUsd, 5);
  });
});

describe("formatWorkflowConfirm step descriptions", () => {
  it("allows ~80 characters per step description", () => {
    const task = "List the three largest files in the repository and report their sizes in bytes please";
    const { lines } = formatWorkflowConfirm(
      { title: "T", context: "c", steps: [{ id: "a", task, model: "sonnet", effort: "medium" }] },
      { maxBudgetUsd: 5 }
    );
    assert.match(plain(lines), /• a: List the three largest files in the repository and report their sizes in bytes/);
    assert.ok(!plain(lines).includes("please"));
  });
});

describe("workflow step naming and picker rows", () => {
  it("joins workflow title and step id", () => {
    assert.equal(workflowStepTitle("Review MR", "bugs"), "Review MR › bugs");
  });

  it("lists the workflow row then only its running step jobs", () => {
    const wf = fakeWorkflow();
    wf.steps[0]!.status = "running";
    wf.steps[0]!.jobId = "job-a";
    wf.steps[0]!.model = "haiku";
    wf.steps[1]!.status = "pending";
    const rows = workflowPickerRows("wf1", wf);
    assert.deepEqual(rows, [
      { id: "wf1", label: formatWorkflowLabel(wf) },
      { id: "job-a", label: `  › ${wf.steps[0]!.id} - haiku` }
    ]);
  });
});

describe("workflow status helpers", () => {
  it("derives status from steps", () => {
    assert.equal(workflowStatus(fakeWorkflow()), "running");
    assert.equal(workflowStatus(fakeWorkflow({ cancelled: true })), "cancelled");
    const allDone = fakeWorkflow();
    allDone.steps.forEach((s) => (s.status = "done"));
    assert.equal(workflowStatus(allDone), "done");
    allDone.steps[1].status = "skipped";
    assert.equal(workflowStatus(allDone), "failed");
  });

  it("formats the summary with one line per step and its reportPath", () => {
    const wf = fakeWorkflow();
    wf.steps[1].status = "failed";
    const text = formatWorkflowSummary(wf);
    assert.match(text, /workflow failed: Review MR/);
    assert.match(text, /1 done, 1 failed/);
    assert.match(text, /- bugs: done · sonnet · \[\/r\/bugs\.md\]\(file:\/\/\/r\/bugs\.md\)/);
    assert.match(text, /- verify: failed · luna$/m);
  });

  it("adds token usage and cost to a step's line when it reported usage", () => {
    const wf = fakeWorkflow();
    wf.steps[1].status = "failed";
    wf.steps[0].tokenUsage = { input: 15_900, output: 3_700, cacheWrite: 0, cacheRead: 96_400 };
    wf.steps[0].totalCostUsd = 0.0049;
    const text = formatWorkflowSummary(wf);
    assert.ok(text.includes("- bugs: done · sonnet · ↑15.9K ↓3.7K →0.0K ←96.4K · \\$0.0049 · [/r/bugs.md](file:///r/bugs.md)"));
    assert.match(text, /- verify: failed · luna$/m);
  });

  it("shows a pre-spawn failure reason inline and drops the reportPath note when no step has one", () => {
    const wf = fakeWorkflow();
    wf.steps[0].status = "failed";
    wf.steps[0].result = 'Unknown model "opencode-go/luna". Call help_pi_minion for the models usable here.';
    wf.steps[1].status = "skipped";
    delete wf.steps[0].reportPath;
    const text = formatWorkflowSummary(wf);
    assert.match(text, /- bugs: failed · sonnet · Unknown model "opencode-go\/luna"/);
    assert.match(text, /- verify: skipped · luna$/m);
    assert.doesNotMatch(text, /Read each step's reportPath/);
  });

  it("formats the picker label with progress and running step ids", () => {
    assert.equal(formatWorkflowLabel(fakeWorkflow()), "⇉ Review MR · 1/2 steps · verify");
  });

  it("builds the widget status with current stage and resolved effort", () => {
    const status = workflowWidgetStatus(fakeWorkflow());
    assert.equal(status.stage, 2);
    assert.equal(status.stages, 2);
    assert.deepEqual(
      status.steps.map((s) => [s.id, s.status, s.effort, s.jobId]),
      [["bugs", "done", "medium", undefined], ["verify", "running", "low", "j2"]]
    );
  });

  it("shows a step's resolved model id once its job reports one, the alias before", () => {
    const status = workflowWidgetStatus(fakeWorkflow(), (jobId) => (jobId === "j2" ? "gpt-6-luna" : undefined));
    assert.deepEqual(
      status.steps.map((s) => [s.id, s.model]),
      [["bugs", fakeWorkflow().steps[0].model], ["verify", "gpt-6-luna"]]
    );
  });
});

describe("session ownership", () => {
  it("selects and resolves only the owning session's workflows", () => {
    const map = new Map([["a", { sessionId: "s1" }], ["b", { sessionId: "s2" }]]);
    assert.deepEqual(workflowIdsOwnedBySession(map, "s1"), ["a"]);
    assert.equal(resolveOwnedWorkflow(map, "a", "s1"), true);
    assert.equal(resolveOwnedWorkflow(map, "a", "s2"), false);
    assert.equal(resolveOwnedWorkflow(map, "missing", "s1"), false);
  });

  it("rehomes only the replaced session's workflows", () => {
    workflows.set("r1", fakeWorkflow({ sessionId: "old" }));
    workflows.set("r2", fakeWorkflow({ sessionId: "other" }));
    rehomeWorkflows("old", "new", "/new.jsonl");
    assert.equal(workflows.get("r1")!.sessionId, "new");
    assert.equal(workflows.get("r1")!.sessionFile, "/new.jsonl");
    assert.equal(workflows.get("r2")!.sessionId, "other");
    workflows.delete("r1");
    workflows.delete("r2");
  });
});

describe("scheduled workflow helpers", () => {
  it("terminalStepIds returns only steps nothing depends on", () => {
    const ids = terminalStepIds([
      { id: "a" },
      { id: "b" },
      { id: "c", dependsOn: ["a", "b"] },
      { id: "d" }
    ]);
    assert.deepEqual([...ids].sort(), ["c", "d"]);
  });

  it("isWorkflowRunning is true only for a known, unfinished workflow", () => {
    const map = new Map([["run", {}], ["over", { finishedAt: 1 }]]);
    assert.equal(isWorkflowRunning(map, "run"), true);
    assert.equal(isWorkflowRunning(map, "over"), false);
    assert.equal(isWorkflowRunning(map, "gone"), false);
    assert.equal(isWorkflowRunning(map, undefined), false);
  });

  it("confirm text includes the cron, next run, per-run budget and self-stop line", () => {
    const now = new Date(2026, 8, 30, 8, 0);
    const scheduleLines = formatWorkflowScheduleLines("0 9 * * 1-5", new Date(2026, 8, 30, 9, 0), 7.5, now);
    const { lines } = formatWorkflowConfirm(
      { title: "T", context: "c", steps: [{ id: "a", task: "Do a thing", model: "sonnet", effort: "medium" }] },
      { maxBudgetUsd: 5 },
      scheduleLines
    );
    assert.match(plain(lines), /Runs on "0 9 \* \* 1-5" — next run 09:00/);
    assert.match(plain(lines), /Budget cap \$7\.50 per run/);
    assert.match(plain(lines), /cancel_pi_minion_schedule/);
    assert.match(plain(lines), /Schedule this workflow\?$/);
  });
});

describe("pruneWorkflows", () => {
  it("drops only workflows that finished before the cutoff", () => {
    const day = 24 * 60 * 60 * 1000;
    const base = { finishedAt: undefined } as unknown as MinionWorkflow;
    workflows.set("old", { ...base, finishedAt: Date.now() - 4 * day });
    workflows.set("recent", { ...base, finishedAt: Date.now() - day });
    workflows.set("running", { ...base });
    pruneWorkflows(3);
    assert.deepEqual([...workflows.keys()].filter((id) => ["old", "recent", "running"].includes(id)), ["recent", "running"]);
    for (const id of ["recent", "running"]) workflows.delete(id);
  });
});

describe("validateScheduledWorkflowGraph", () => {
  it("accepts exactly one final step", () => {
    validateScheduledWorkflowGraph(def({ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a", "b"] }));
  });
  it("rejects several final steps and names them", () => {
    assert.throws(
      () => validateScheduledWorkflowGraph(def({ id: "a" }, { id: "b" })),
      /exactly one final step.*got 2: a, b/
    );
  });
});

describe("formatWorkflowPlan", () => {
  it("lists each step's model/effort, what it waits for, and its task", () => {
    const plan = formatWorkflowPlan({
      title: "Review MR",
      context: "No prior context.",
      steps: [
        { id: "bugs", task: "Find bugs", model: "sonnet", effort: "medium", dependsOn: [], status: "pending" },
        { id: "verify", task: "Verify them", model: "luna", effort: "low", dependsOn: ["bugs"], status: "pending" }
      ]
    });
    assert.equal(
      plan,
      "Workflow: Review MR\n\nContext: No prior context.\n\n## bugs (sonnet/medium)\n\nFind bugs\n\n## verify (luna/low) after bugs\n\nVerify them"
    );
  });
});
