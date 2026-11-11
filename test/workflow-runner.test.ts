import assert from "node:assert/strict";
import { after, before, afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MinionRequest } from "../src/adapters/types.js";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { validateRequest } from "../src/job-runner.js";
import { createFakeAdapter, fakeConfig } from "./fakes.js";
import {
  cancelWorkflow,
  startWorkflow,
  STEP_RESULT_INSTRUCTION,
  tickWorkflowSchedule,
  type StepOutcome,
  type WorkflowDeps
} from "../src/workflow-runner.js";
import { schedules, STOP_SCHEDULE_INSTRUCTION, STOP_SCHEDULE_MARKER, type MinionSchedule } from "../src/schedule-store.js";
import {
  MAX_PARALLEL_STEPS,
  STEP_BLOCKED_INSTRUCTION,
  STEP_BLOCKED_MARKER,
  newWorkflow,
  withEffectiveLimits,
  workflows,
  type MinionWorkflow
} from "../src/workflow-store.js";

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
  it("passes a step's named agent to the job, leaving model/effort to it", async () => {
    const h = harness([{ id: "a" }]);
    h.wf.steps[0].agent = "code-reviewer";
    h.wf.steps[0].model = "";
    h.wf.steps[0].effort = "";
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.equal(h.started[0].request.agent, "code-reviewer");
    assert.equal(h.started[0].request.model, "", "an explicit model must not override the agent's default");
    assert.equal(h.started[0].request.effort, "");
  });

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
    assert.equal(h.started[2].request.task, `Check A\n\nResult of step b:\nB${STEP_BLOCKED_INSTRUCTION}`);
    assert.equal(h.started[2].request.context, "No prior context.");
    assert.equal(h.wf.steps[2].jobId, "job-2");
  });

  it("appends the TLDR-first instruction to a step something depends on", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    // a is non-terminal (b depends on it), so its result feeds b.
    assert.equal(h.started[0].request.task, `task a${STEP_BLOCKED_INSTRUCTION}${STEP_RESULT_INSTRUCTION}`);
    assert.ok(h.started[0].request.task.endsWith(STEP_RESULT_INSTRUCTION));
    h.started[0].settle(h.ok("A"));
    await h.flush();
    // b is terminal (nothing depends on it), so it keeps the concise prompt.
    assert.ok(!h.started[1].request.task.includes(STEP_RESULT_INSTRUCTION));
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

  it("aborts the whole run when a step fails: dependents skip, independent branches cancel", async () => {
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
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "cancelled", "skipped", "skipped", "skipped"]);
    assert.deepEqual(h.stopped, ["job-1"], "the independent branch's job is stopped");
    assert.equal(h.started.length, 2, "e never starts");
    assert.equal(h.posts.length, 1, "one summary, no interim alert");
    assert.match(h.posts[0].content, /workflow failed/);
    assert.match(
      h.posts[0].content,
      /\*\*Needs attention:\*\* Step a failed: no reason reported\. Workflow aborted; 1 step\(s\) cancelled\./
    );
    assert.match(h.posts[0].content, /- c: skipped/);
    assert.equal(h.posts[0].triggerTurn, true);

    // The stopped branch still exits and reports; the run is already over.
    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.started.length, 2);
    assert.equal(h.wf.steps[1].status, "cancelled");
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

  it("stores a spawned failure's reason on the step for the summary", async () => {
    const h = harness([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "Pi minion failed (exit 1)." });
    await h.flush();
    assert.equal(h.wf.steps[0].status, "failed");
    assert.equal(h.wf.steps[0].result, "Pi minion failed (exit 1).");
  });

  it("carries the step's timeoutMs, else the workflow's, else none", async () => {
    const h = harness([{ id: "a" }, { id: "b" }]);
    h.wf.timeoutMs = 900_000;
    h.wf.steps[0]!.timeoutMs = 120_000;
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.deepEqual(h.started.map((started) => started.request.timeoutMs), [120_000, 900_000]);

    const plain = harness([{ id: "a" }]);
    startWorkflow("wf", plain.deps);
    await plain.flush();
    assert.equal(plain.started[0]!.request.timeoutMs, undefined);
  });

  it("carries the step's maxTurns, else the workflow's, else none", async () => {
    const h = harness([{ id: "a" }, { id: "b" }]);
    h.wf.maxTurns = 50;
    h.wf.steps[0]!.maxTurns = 1;
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.deepEqual(h.started.map((started) => started.request.maxTurns), [1, 50]);

    const plain = harness([{ id: "a" }]);
    startWorkflow("wf", plain.deps);
    await plain.flush();
    assert.equal(plain.started[0]!.request.maxTurns, undefined);
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

describe("abort on failure", () => {
  it("posts one summary that starts a turn with the abort note, not an interim alert", async () => {
    const h = harness([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /workflow failed/);
    assert.doesNotMatch(h.posts[0].content, /workflow step failed/, "the interim alert is gone");
    assert.match(
      h.posts[0].content,
      /\*\*Needs attention:\*\* Step a failed: boom\. Workflow aborted; 1 step\(s\) cancelled\./
    );
    assert.match(h.posts[0].content, /- a: failed/);
    assert.match(h.posts[0].content, /- c: skipped/);

    const aborts = h.logs.filter((l) => l.event === "workflow_aborted");
    assert.equal(aborts.length, 1);
    assert.match(aborts[0].info.detail ?? "", /step=a failed reason="boom"/);
  });

  it("posts only the summary when the failure settles the run", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "skipped"]);
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0].content, /\*\*Needs attention:\*\* Step a failed: boom\. Workflow aborted\./);
    assert.equal(h.posts[0].triggerTurn, true);
  });

  it("ignores a second failure once the run is aborted: no second post, no double stop", async () => {
    const h = harness([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "a broke" });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.stopped, ["job-1"]);

    // b was cancelled mid-flight; its job still exits and reports.
    h.started[1].settle({ ok: false, errorReason: "b broke" });
    await h.flush();
    assert.equal(h.posts.length, 1, "the abort is idempotent");
    assert.deepEqual(h.stopped, ["job-1"], "no second stopStep");
    assert.equal(h.wf.steps[1].status, "cancelled");
    assert.match(h.posts[0].content, /Step a failed: a broke/);
    assert.equal(h.logs.filter((l) => l.event === "workflow_aborted").length, 1);
  });

  it("cancels a step that is still running when another fails, stopping its job", async () => {
    const h = harness([{ id: "a" }, { id: "b" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.equal(h.wf.steps[1].status, "cancelled");
    assert.deepEqual(h.stopped, ["job-1"]);
    assert.equal(h.wf.steps[1].finishedAt, undefined);
  });

  it("aborts on a pre-spawn failure, naming its reason on the step and in the summary", async () => {
    const h = harness([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }]);
    h.failNext();
    startWorkflow("wf", h.deps);
    await h.flush();
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "cancelled", "skipped"]);
    assert.equal(h.wf.steps[0].result, "spawn failed");
    assert.deepEqual(h.stopped, ["job-0"], "the parallel branch is stopped");
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0].content, /\*\*Needs attention:\*\* Step a failed: spawn failed\./);
    const stepFailures = h.logs.filter((l) => l.event === "step_failed");
    assert.equal(stepFailures.length, 1);
    assert.match(stepFailures[0].info.detail ?? "", /spawn failed/);
  });

  it("marks still-pending steps skipped when a step aborts the run", async () => {
    const h = harness([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[1].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["cancelled", "skipped", "failed"]);
    assert.deepEqual(h.stopped, ["job-0"]);
  });

  it("aborts when an ok reply ends with the blocked marker, stripping it from the result", async () => {
    const h = harness([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({
      ok: true,
      finalResult: `Cannot: the file the packet names is missing\n${STEP_BLOCKED_MARKER}`,
      reportPath: "/r/a.md"
    });
    await h.flush();
    assert.equal(h.wf.steps[0].status, "failed");
    assert.equal(h.wf.steps[0].result, "Cannot: the file the packet names is missing");
    assert.deepEqual(h.wf.steps.map((s) => s.status), ["failed", "cancelled", "skipped"]);
    assert.equal(h.posts.length, 1);
    assert.match(
      h.posts[0].content,
      /\*\*Needs attention:\*\* Step a blocked: Cannot: the file the packet names is missing\. The packet needs revision; workflow aborted; 1 step\(s\) cancelled\./
    );
    assert.doesNotMatch(h.posts[0].content, /STEP_BLOCKED/);
    const aborts = h.logs.filter((l) => l.event === "workflow_aborted");
    assert.equal(aborts.length, 1);
    assert.match(aborts[0].info.detail ?? "", /step=a blocked reason="Cannot: the file the packet names is missing"/);
  });

  it("says the run aborted even when the reason line is missing", async () => {
    const h = harness([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok(STEP_BLOCKED_MARKER));
    await h.flush();
    assert.equal(h.wf.steps[0].status, "failed");
    assert.equal(h.wf.steps[0].result, undefined);
    assert.match(h.posts[0].content, /Step a blocked: packet reported unworkable\./);
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

  it("stops an in-flight spawn that lands after an abort and starts nothing more", async () => {
    const h = harness([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["b"] }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps: WorkflowDeps = {
      ...h.deps,
      // a is still spawning when b fails and aborts the run.
      startStep: async (request, wf, settle, step, isCancelled) => {
        if (step.id === "a") return (await gate, "job-late");
        return h.deps.startStep(request, wf, settle, step, isCancelled);
      }
    };
    startWorkflow("wf", deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.wf.steps[0].status, "cancelled", "a was cancelled before it had a job");
    release();
    await h.flush();
    assert.deepEqual(h.stopped, ["job-late"], "the late job is stopped, not left running");
    assert.equal(h.started.length, 1, "nothing behind the abort starts");
    assert.equal(h.posts.length, 1, "the late spawn posts nothing");
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
    assert.equal(h.started[0].request.task, `task a${STEP_BLOCKED_INSTRUCTION}${STEP_RESULT_INSTRUCTION}`);
    h.started[0].settle(h.ok("A"));
    await h.flush();
    // The appended dependency result comes before both trailing instructions.
    assert.equal(
      h.started[1].request.task,
      `task b\n\nResult of step a:\nA${STOP_SCHEDULE_INSTRUCTION}${STEP_BLOCKED_INSTRUCTION}`
    );
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

  it("aborts a tick's failure and starts a turn with the abort note, keeping the schedule", async () => {
    const h = scheduled([{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, true, "the abort note drives the turn");
    assert.match(h.posts[0].content, /workflow failed/);
    assert.match(
      h.posts[0].content,
      /\*\*Needs attention:\*\* Step a failed: boom\. Workflow aborted; 1 step\(s\) cancelled\./
    );
    assert.equal(h.stops(), 0, "the schedule itself keeps running");

    // The cancelled branch still reports; nothing more posts.
    h.started[1].settle(h.ok("B"));
    await h.flush();
    assert.equal(h.posts.length, 1);
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

  it("starts a turn, and says so, when a scheduled run aborts with no step done", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /Needs attention:\*\* Step a failed: no reason reported\. Workflow aborted\. no step of this scheduled run succeeded\./);
    assert.equal(h.stops(), 0);
  });

  it("starts a turn on an abort even when another step already finished", async () => {
    const h = scheduled([{ id: "a" }, { id: "b" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok("A"));
    h.started[1].settle({ ok: false, errorReason: "boom" });
    await h.flush();
    assert.equal(h.wf.steps[0].status, "done");
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0].content, /\*\*Needs attention:\*\* Step b failed: boom\./);
    assert.equal(h.posts[0].triggerTurn, true, "the abort note drives the turn, not only 'no step done'");
  });

  it("stays quiet only for a cancelled tick", async () => {
    const cancelled = scheduled([{ id: "a" }]);
    startWorkflow("wf", cancelled.deps);
    await cancelled.flush();
    cancelWorkflow("wf", cancelled.deps);
    assert.equal(cancelled.posts[0].triggerTurn, false);
    assert.doesNotMatch(cancelled.posts[0].content, /Needs attention/);
  });

  it("a one-off (unscheduled) failed run starts its turn with the abort note, not the scheduled note", async () => {
    const h = harness([{ id: "a" }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle({ ok: false });
    await h.flush();
    assert.equal(h.posts[0].triggerTurn, true);
    assert.match(h.posts[0].content, /Step a failed: no reason reported\./);
    assert.doesNotMatch(h.posts[0].content, /no step of this scheduled run succeeded/);
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
      def: withEffectiveLimits(
        {
          title: "T",
          context: "No prior context.",
          maxBudgetUsd: 3,
          steps: [
            { id: "a", task: "t", model: "sonnet", effort: "medium" },
            { id: "b", task: "t", model: "sonnet", effort: "medium", maxBudgetUsd: 1 }
          ]
        },
        { maxBudgetUsd: 99, timeoutMs: 600_000 }
      ),
      runs: 0,
      skipped: 0
    } as unknown as MinionSchedule);
    tickWorkflowSchedule("sch", h.deps);
    await h.flush();
    assert.deepEqual(h.started.map((started) => started.request.maxBudgetUsd), [3, 1]);
  });

  it("never honors the stop marker on a blocked reply, even from a scheduled final step", async () => {
    const h = scheduled([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    startWorkflow("wf", h.deps);
    await h.flush();
    h.started[0].settle(h.ok("A"));
    await h.flush();
    h.started[1].settle({
      ok: true,
      finalResult: `A is done\nstop the schedule\n${STOP_SCHEDULE_MARKER}\ncannot verify the change\n${STEP_BLOCKED_MARKER}`,
      reportPath: "/r/b.md"
    });
    await h.flush();
    assert.equal(Boolean(h.wf.stopRequested), false, "the blocked marker outranks the stop marker");
    assert.equal(h.stops(), 0);
    assert.equal(h.wf.steps[1].status, "failed");
    assert.match(h.posts[0].content, /Step b blocked: cannot verify the change\./);
    assert.equal(h.posts[0].triggerTurn, true, "the abort note drives the turn");
    assert.doesNotMatch(h.posts[0].content, /Schedule stopped/);
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

describe("scheduled agent steps", () => {
  before(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));
  after(() => setAdaptersForTest());

  it("lets agent frontmatter beat the config defaults on a scheduled tick", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-minion-wf-agent-"));
    try {
      const agents = join(workspace, "agents");
      await mkdir(agents);
      await writeFile(
        join(agents, "reviewer.md"),
        "---\ndescription: Reviews changes\nmodel: opus\neffort: high\nmaxTurns: 5\nmaxBudgetUsd: 2\ntimeoutMs: 60000\n---\nYou review.\n"
      );
      const config = fakeConfig({ maxTurns: 400, maxBudgetUsd: 50, timeoutMs: 300_000 });
      // As tools.ts stores a scheduled workflow: limits pinned at creation.
      const def = withEffectiveLimits(
        {
          title: "T",
          context: "No prior context.",
          steps: [{ id: "a", task: "Review it", model: "", effort: "", agent: "reviewer" }]
        },
        config
      );
      workflows.set("wf", newWorkflow(def, { maxResultPreviewBytes: 1_000, cwd: workspace, sessionId: "s1" }));
      const started: MinionRequest[] = [];
      startWorkflow("wf", {
        startStep: async (request) => {
          started.push(request);
          return "job-1";
        },
        stopStep: () => {},
        ui: () => undefined,
        post: () => {},
        log: () => {}
      });
      await new Promise((resolve) => setImmediate(resolve));
      const valid = await validateRequest(started[0]!, workspace, config, agents);
      assert.deepEqual(
        [valid.model, valid.effort, valid.maxTurns, valid.maxBudgetUsd, valid.timeoutMs],
        ["opus", "high", 5, 2, 60_000],
        "frontmatter beats the config defaults 400 / 50 / 300000"
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the no-cap sentinel on non-agent steps of a mixed scheduled def", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-minion-wf-mixed-"));
    try {
      const agents = join(workspace, "agents");
      await mkdir(agents);
      await writeFile(
        join(agents, "reviewer.md"),
        "---\ndescription: Reviews changes\nmodel: opus\neffort: high\n---\nYou review.\n"
      );
      // No config.maxTurns anywhere: the plain step's pinned sentinel (null)
      // must survive the step request's lookup — `step.maxTurns ?? wf.maxTurns`
      // would drop it and let a later config edit retarget the step.
      const config = fakeConfig();
      const def = withEffectiveLimits(
        {
          title: "T",
          context: "No prior context.",
          steps: [
            { id: "agent-step", task: "Review it", model: "", effort: "", agent: "reviewer" },
            { id: "plain", task: "Do a thing", model: "sonnet", effort: "medium" }
          ]
        },
        config
      );
      assert.equal(def.maxTurns, undefined);
      assert.equal(def.steps[0].maxTurns, undefined);
      assert.equal(def.steps[1].maxTurns, null, "non-agent step keeps the null sentinel");
      workflows.set("wf", newWorkflow(def, { maxResultPreviewBytes: 1_000, cwd: workspace, sessionId: "s1" }));
      const started: MinionRequest[] = [];
      startWorkflow("wf", {
        startStep: async (request) => {
          started.push(request);
          return "job-1";
        },
        stopStep: () => {},
        ui: () => undefined,
        post: () => {},
        log: () => {}
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(started[0].maxTurns, undefined, "agent step: no pinned cap");
      assert.equal(started[1].maxTurns, null, "plain step: sentinel survives the step request");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
