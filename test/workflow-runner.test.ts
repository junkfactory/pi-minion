import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MinionRequest } from "../src/adapters/types.js";
import {
  cancelWorkflow,
  startWorkflow,
  tickWorkflowSchedule,
  type StepOutcome,
  type WorkflowDeps
} from "../src/workflow-runner.js";
import { schedules, STOP_SCHEDULE_INSTRUCTION, STOP_SCHEDULE_MARKER, type MinionSchedule } from "../src/schedule-store.js";
import { MAX_PARALLEL_STEPS, withEffectiveBudgets, workflows, type MinionWorkflow } from "../src/workflow-store.js";

type Started = { request: MinionRequest; jobId: string; settle: (o: StepOutcome) => void };

function harness(stepSpecs: Array<{ id: string; dependsOn?: string[]; task?: string }>) {
  const wf: MinionWorkflow = {
    title: "T",
    context: "No prior context.",
    maxResultPreviewBytes: 50_000,
    cwd: "/w",
    sessionId: "s1",
    steps: stepSpecs.map((spec) => ({
      id: spec.id,
      task: spec.task ?? `task ${spec.id}`,
      model: "sonnet",
      effort: "medium",
      dependsOn: spec.dependsOn ?? [],
      status: "pending" as const
    })),
    startedAt: 0,
    cancelled: false
  };
  workflows.set("wf", wf);
  const started: Started[] = [];
  const posts: Array<{ content: string; triggerTurn: boolean }> = [];
  const stopped: string[] = [];
  const titles: string[] = [];
  const widgetCalls: string[] = [];
  const logs: Array<{ event: string; info: { id: string; model: string; detail?: string } }> = [];
  let failNext = false;
  const deps: WorkflowDeps = {
    startStep: async (request, _wf, settle, step) => {
      titles.push(step.title);
      if (failNext) {
        failNext = false;
        throw new Error("spawn failed");
      }
      const jobId = `job-${started.length}`;
      started.push({ request, jobId, settle });
      return jobId;
    },
    stopStep: (jobId) => stopped.push(jobId),
    ui: () =>
      ({
        setWorkflow: () => widgetCalls.push("set"),
        clearWorkflow: () => widgetCalls.push("clear")
      }) as any,
    post: (_session, content, _details, triggerTurn) => posts.push({ content, triggerTurn }),
    log: (event, info) => logs.push({ event, info })
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const ok = (result: string): StepOutcome => ({ ok: true, finalResult: result, reportPath: `/r/${result}.md` });
  return { wf, deps, titles, started, posts, stopped, widgetCalls, logs, flush, ok, failNext: () => (failNext = true) };
}

afterEach(() => workflows.clear());

describe("startWorkflow", () => {
  it("names each step job '<workflow title> › <step id>'", async () => {
    const h = harness([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.deepEqual(h.titles, [`${h.wf.title} › a`]);
  });

  it("starts independent steps together and a dependent one only after its deps are done", async () => {
    const h = harness([
      { id: "a" },
      { id: "b" },
      { id: "c", dependsOn: ["a", "b"], task: "Check {{steps.a.result}}" }
    ]);
    // c places a by placeholder; b has none, so its result is appended.
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.equal(h.started.length, 2);

    h.started[0].settle(h.ok("A"));
    await h.flush();
    assert.equal(h.started.length, 2, "c still waits for b");

    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.started.length, 3);
    assert.equal(h.started[2].request.task, "Check A\n\nResult of step b:\nB");
    assert.equal(h.started[2].request.context, "No prior context.");
    assert.equal(h.wf.steps[2].jobId, "job-2");
  });

  it("posts exactly one summary with triggerTurn, only after every step settles", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok("A"));
    await h.flush();
    assert.equal(h.posts.length, 0);
    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /workflow done/);
    assert.equal(h.widgetCalls.at(-1), "clear");
  });

  it("puts each step's token usage and cost on its summary line only when it reported usage", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({
      ...h.ok("A"),
      tokenUsage: { input: 15_900, output: 3_700, cacheWrite: 0, cacheRead: 96_400 },
      totalCostUsd: 0.0049
    });
    await h.flush();
    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.ok(h.posts[0].content.includes("- a: done · sonnet · ↑15.9K ↓3.7K →0.0K ←96.4K · \\$0.0049 · [/r/A.md](file:///r/A.md)"));
    assert.ok(h.posts[0].content.includes("- b: done · sonnet · [/r/B.md](file:///r/B.md)"));
  });

  it("skips dependents of a failed step but keeps independent branches going", async () => {
    const h = harness([
      { id: "a" },
      { id: "b" },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["c"] },
      { id: "e", dependsOn: ["b"] }
    ]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "running", "skipped", "skipped", "pending"]);

    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.started.length, 3, "e started");
    h.started[2].settle(h.ok("E"));
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0].content, /workflow failed/);
    assert.match(h.posts[0].content, /- c: skipped/);
  });

  it("treats a step that fails to spawn as failed instead of hanging", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    h.failNext();
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "skipped"]);
    // The pre-spawn rejection reason is recorded on the step and logged, so
    // the summary says why instead of a bare "failed".
    assert.equal(h.wf.steps[0].result, "spawn failed");
    const stepFailures = h.logs.filter((l) => l.event === "step_failed");
    assert.equal(stepFailures.length, 1);
    assert.equal(stepFailures[0].info.id, "a");
    assert.match(stepFailures[0].info.detail ?? "", /spawn failed/);
    assert.equal(h.posts.length, 1);
  });

  it("never runs more than MAX_PARALLEL_STEPS at once", async () => {
    const h = harness(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}` })));
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.equal(h.started.length, MAX_PARALLEL_STEPS);
    h.started[0].settle(h.ok("x"));
    await h.flush();
    assert.equal(h.started.length, MAX_PARALLEL_STEPS + 1);
  });
});

describe("cancelWorkflow", () => {
  it("cancels pending steps, stops running ones, and posts quietly once", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();

    assert.equal(cancelWorkflow("wf", h.deps), true);
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["cancelled", "cancelled"]);
    assert.deepEqual(h.stopped, ["job-0"]);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, false);

    // The stopped job still exits and reports; nothing more happens.
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.started.length, 1);
    assert.equal(cancelWorkflow("wf", h.deps), false);
  });
});

describe("cancel while a step is spawning", () => {
  it("tells startStep the step is cancelled right before it would spawn, and settles without a job", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spawned: string[] = [];
    let cancelledAtSpawn: boolean | undefined;
    const deps: WorkflowDeps = {
      ...h.deps,
      // Mimics startJob: awaits its setup, then checks isCancelled before spawning.
      startStep: async (_request, _wf, _settle, _title, isCancelled) => {
        await gate;
        cancelledAtSpawn = isCancelled();
        if (cancelledAtSpawn) throw new Error("Cancelled before the pi minion started");
        spawned.push("a");
        return "job-x";
      }
    };
    startWorkflow("wf", deps);
    await h.flush();
    assert.equal(cancelWorkflow("wf", deps), true);
    release();
    await h.flush();
    assert.equal(cancelledAtSpawn, true);
    assert.deepEqual(spawned, []);
    assert.deepEqual(h.stopped, [], "no job exists to stop");
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["cancelled", "cancelled"]);
    assert.equal(h.posts.length, 1);
  });

  it("isCancelled is false while the step is still running", async () => {
    const h = harness([{ id: "a" }]);
    let check: (() => boolean) | undefined;
    const deps: WorkflowDeps = {
      ...h.deps,
      startStep: async (_r, _w, _s, _t, isCancelled) => {
        check = isCancelled;
        return "job-0";
      }
    };
    startWorkflow("wf", deps);
    await h.flush();
    assert.equal(check!(), false);
  });

  it("stops a job that finished spawning after the cancel", async () => {
    const h = harness([{ id: "a" }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps: WorkflowDeps = { ...h.deps, startStep: async () => (await gate, "job-late") };
    startWorkflow("wf", deps);
    cancelWorkflow("wf", deps);
    release();
    await h.flush();
    assert.deepEqual(h.stopped, ["job-late"]);
  });
});

describe("scheduled workflows", () => {
  afterEach(() => schedules.clear());

  function scheduled(stepSpecs: Parameters<typeof harness>[0]) {
    const h = harness(stepSpecs);
    let stops = 0;
    h.wf.scheduled = { stop: () => (stops++, true) };
    return { ...h, stops: () => stops };
  }

  it("appends the stop instruction only to steps nothing depends on", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.equal(h.started[0].request.task, "task a");
    h.started[0].settle(h.ok("A"));
    await h.flush();
    // The appended dependency result comes before the stop instruction.
    assert.equal(h.started[1].request.task, `task b\n\nResult of step a:\nA${STOP_SCHEDULE_INSTRUCTION}`);
  });

  it("posts the summary quietly when no final step asks to stop", async () => {
    const h = scheduled([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok("A"));
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, false);
    assert.equal(h.stops(), 0);
  });

  it("stops the schedule when a terminal step ends with the marker, and starts a turn", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok(`A\n${STOP_SCHEDULE_MARKER}`));
    await h.flush();
    h.started[1].settle({ ok: true, finalResult: `done\n${STOP_SCHEDULE_MARKER}`, reportPath: "/r/b.md" });
    await h.flush();
    assert.equal(h.stops(), 1, "marker on the non-terminal step a was ignored");
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /Schedule stopped/);
  });

  it("starts a turn, and says so, when a scheduled run finishes with no step done", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /Needs attention:\*\* no step of this scheduled run succeeded/);
    assert.equal(h.stops(), 0);
  });

  it("stays quiet when some step succeeded, or the run was cancelled", async () => {
    const partial = scheduled([{ id: "a" }, { id: "b" }]);
    startWorkflow("wf", partial.deps);
    await partial.flush();
    partial.started[0].settle(partial.ok("A"));
    partial.started[1].settle({ ok: false });
    await partial.flush();
    assert.equal(partial.posts[0].triggerTurn, false);
    assert.doesNotMatch(partial.posts[0].content, /Needs attention/);

    workflows.clear();
    const cancelled = scheduled([{ id: "a" }]);
    startWorkflow("wf", cancelled.deps);
    await cancelled.flush();
    cancelWorkflow("wf", cancelled.deps);
    assert.equal(cancelled.posts[0].triggerTurn, false);
  });

  it("a one-off (unscheduled) failed run still starts its turn without the scheduled note", async () => {
    const h = harness([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.equal(h.posts[0].triggerTurn, true);
    assert.doesNotMatch(h.posts[0].content, /Needs attention/);
  });

  it("ticks run each step with the cap approved at schedule time", async () => {
    const h = harness([]);
    workflows.clear();
    schedules.set("sch", {
      kind: "workflow",
      title: "T",
      cron: "* * * * *",
      effort: "medium",
      cwd: "/w",
      sessionId: "s1",
      maxResultPreviewBytes: 1000,
      // As tools.ts stores it: withEffectiveBudgets already pinned each step's cap.
      def: withEffectiveBudgets(
        {
          title: "T",
          context: "No prior context.",
          maxBudgetUsd: 3,
          steps: [
            { id: "a", task: "t", model: "sonnet", effort: "medium" },
            { id: "b", task: "t", model: "sonnet", effort: "medium", maxBudgetUsd: 1 }
          ]
        },
        { maxBudgetUsd: 99 }
      ),
      runs: 0,
      skipped: 0
    } as unknown as MinionSchedule);
    tickWorkflowSchedule("sch", h.deps);
    await h.flush();
    assert.deepEqual(h.started.map((started) => started.request.maxBudgetUsd), [3, 1]);
  });

  it("ignores the marker from a non-terminal step", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok(`A\n${STOP_SCHEDULE_MARKER}`));
    await h.flush();
    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.stops(), 0);
    assert.equal(h.posts[0].triggerTurn, false);
  });

  it("tick skips while the last workflow is running, then starts a fresh one", async () => {
    const h = harness([]);
    workflows.clear();
    const logs: string[] = [];
    const deps = { ...h.deps, log: (event: string) => void logs.push(event) } as WorkflowDeps;
    schedules.set("sch", {
      kind: "workflow",
      title: "T",
      cron: "* * * * *",
      effort: "medium",
      cwd: "/w",
      sessionId: "s1",
      maxResultPreviewBytes: 1000,
      def: { title: "T", context: "No prior context.", steps: [{ id: "a", task: "t", model: "sonnet" }] },
      runs: 0,
      skipped: 0
    } as unknown as MinionSchedule);

    assert.equal(tickWorkflowSchedule("sch", deps), "started");
    await h.flush();
    assert.equal(h.started.length, 1);
    assert.equal(tickWorkflowSchedule("sch", deps), "skipped");
    const schedule = schedules.get("sch") as any;
    assert.equal(schedule.skipped, 1);
    assert.equal(schedule.runs, 1);
    assert.ok(logs.includes("skipped"));

    h.started[0].settle(h.ok("A"));
    await h.flush();
    assert.equal(tickWorkflowSchedule("sch", deps), "started");
    assert.equal(schedule.runs, 2);
  });
});

describe("workflow session", () => {
  it("starts one session per workflow and finishes it with the same summary that posts", async () => {
    const h = harness([{ id: "a" }]);
    const finished: string[] = [];
    let started = 0;
    const deps: WorkflowDeps = {
      ...h.deps,
      startSession: () => (started++, { file: "/s/wf.jsonl", finish: (summary) => void finished.push(summary) })
    };
    startWorkflow("wf", deps);
    await h.flush();
    assert.equal(started, 1);
    assert.equal(h.wf.session?.file, "/s/wf.jsonl");
    h.started[0].settle(h.ok("A"));
    await h.flush();
    assert.deepEqual(finished, [h.posts[0].content]);
  });

  it("still runs the workflow when the session can't be written", async () => {
    const h = harness([{ id: "a" }]);
    const deps: WorkflowDeps = { ...h.deps, startSession: () => { throw new Error("disk full"); } };
    startWorkflow("wf", deps);
    await h.flush();
    assert.equal(h.started.length, 1);
    assert.equal(h.wf.session, undefined);
  });
});
