import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import type { AgentCliAdapter } from "../src/adapters/types.js";
import {
  createJobUI,
  stepNavFor,
  stepPreviewNavKeys,
  type JobUI,
  type ModalState,
  type StepNav
} from "../src/minion.ui.js";
import {
  applyModalEvent,
  backfillModal,
  cancelWorkflowMessage,
  loadJobIntoModal,
  openJobPreview
} from "../src/modal.js";
import { JOB_ROOT, jobMeta } from "../src/job-store.js";
import { Viewport } from "../src/modal-shell.js";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { fakeConfig, fakeCtx, fakeTheme, fakeTui } from "./fakes.js";

// backfillModal only consumes the adapter's parseLine; a permissive
// config-bound instance replaces the deleted static export.
const claudeAdapter = createClaudeAdapter(fakeConfig({ models: { allowed: [], blocked: [] } }));

function renderReopenedModalLines(state: { customFactory: any }): string[] {
  const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
    render(width: number): string[];
  };
  return component.render(60);
}

function renderReopenedModal(state: { customFactory: any }): string {
  return renderReopenedModalLines(state).join("\n");
}

describe("backfillModal", () => {
  it("does nothing when stdout.json doesn't exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, claudeAdapter, jobUI, "job1");

      assert.match(renderReopenedModal(state), /Working…/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("replaces the header's model alias with the model id from the init event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await writeFile(
        join(dir, "stdout.json"),
        JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" })
      );

      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, claudeAdapter, jobUI, "job1");

      assert.match(renderReopenedModalLines(state)[1]!, /claude-opus-5-5/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("concatenates streamed text deltas across lines, skipping non-text events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const lines = [
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } }),
        JSON.stringify({ type: "other_event" }),
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: ", world" } } }),
        JSON.stringify({ type: "result", result: "Hello, world" })
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "stdout.json"), lines.join("\n"));

      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, claudeAdapter, jobUI, "job1");

      assert.match(renderReopenedModal(state), /Hello, world/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("separates adjacent text blocks with a blank line, without one before the first block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const lines = [
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "First" } } }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "tool_use" } }
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "text", text: "" } }
        }),
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Second" } } })
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "stdout.json"), lines.join("\n"));

      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, claudeAdapter, jobUI, "job1");

      const contentLines = renderReopenedModalLines(state);
      const firstIndex = contentLines.findIndex((l) => l.includes("First"));
      const secondIndex = contentLines.findIndex((l) => l.includes("Second"));
      assert.ok(firstIndex >= 0 && secondIndex > firstIndex);
      assert.equal(secondIndex, firstIndex + 2, "expected exactly one blank line between First and Second");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("replays tool-call rows (id, args, result) so they survive modal close/reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const lines = [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }
          }
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] }
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "file.txt", is_error: false }]
          }
        })
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "stdout.json"), lines.join("\n"));

      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, claudeAdapter, jobUI, "job1");

      const rendered = renderReopenedModal(state);
      assert.match(rendered, /Bash/);
      assert.match(rendered, /ls/);
      assert.match(rendered, /file\.txt/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("skips a line whose parse throws and still replays the remaining lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const lines = [
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Before" } } }),
        "{ not json",
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "After" } } })
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "stdout.json"), lines.join("\n"));

      const throwingAdapter: AgentCliAdapter = {
        ...claudeAdapter,
        parseLine: (line: string) => {
          if (line === "{ not json") throw new SyntaxError("malformed line");
          return claudeAdapter.parseLine(line);
        }
      };

      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      jobUI.openModal("job1", { title: "Job", model: "opus", prompt: "" });

      await backfillModal(dir, throwingAdapter, jobUI, "job1");

      const rendered = renderReopenedModal(state);
      assert.match(rendered, /Before/);
      assert.match(rendered, /After/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("openJobPreview", () => {
  // openJobPreview resolves the job dir from JOB_ROOT itself, so the replay
  // fixtures live there under unique ids and are removed after each test.
  const createdIds: string[] = [];
  const createdDirs: string[] = [];
  let seq = 0;

  afterEach(async () => {
    setAdaptersForTest();
    for (const id of createdIds.splice(0)) jobMeta.delete(id);
    for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  // openJobPreview resolves the adapter from its (empty in tests) registry,
  // so pin the permissive claude fixture both replay and header come from.
  function pinAdapter(): void {
    setAdaptersForTest([claudeAdapter]);
  }

  function nextId(): string {
    const id = `pi-minion-test-preview-${process.pid}-${seq++}`;
    createdIds.push(id);
    return id;
  }

  // Wraps the real jobUI so the modal still renders (and replayed events
  // still land in its state) while calls are recorded.
  function captureJobUI(jobUI: JobUI) {
    const openModalCalls: Array<{ id: string; initial: Record<string, unknown>; nav?: StepNav }> = [];
    const finishCalls: string[] = [];
    const realOpenModal = jobUI.openModal;
    const realFinishModalJob = jobUI.finishModalJob;
    jobUI.openModal = (id, initial, nav, loadJob) => {
      openModalCalls.push({ id, initial, nav });
      return realOpenModal.call(jobUI, id, initial, nav, loadJob);
    };
    jobUI.finishModalJob = (id) => {
      finishCalls.push(id);
      realFinishModalJob.call(jobUI, id);
    };
    return { openModalCalls, finishCalls };
  }

  async function writeStdout(id: string, lines: string[]): Promise<void> {
    const dir = join(JOB_ROOT, id);
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    await writeFile(join(dir, "stdout.json"), lines.join("\n"));
  }

  function setMeta(
    id: string,
    status: "running" | "done",
    resolvedModel?: string,
    turns?: { current: number; max?: number }
  ): void {
    jobMeta.set(id, {
      title: "Step one",
      model: "opus",
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      prompt: "do the thing",
      workspace: "/tmp/workspace",
      sessionId: "test-session",
      status,
      ...(turns ? { turnsSeen: turns.current, maxTurns: turns.max } : {})
    });
  }

  it("opens a finished job's modal on its resolved model, replays events, and marks it finished", async () => {
    const id = nextId();
    setMeta(id, "done", "claude-opus-5-5");
    await writeStdout(id, [
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello, world" } } }),
      JSON.stringify({ type: "result", result: "Hello, world" })
    ]);

    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const { openModalCalls, finishCalls } = captureJobUI(jobUI);

    await openJobPreview(jobUI, id, jobMeta.get(id)!);

    assert.equal(openModalCalls.length, 1);
    assert.equal(openModalCalls[0]!.id, id);
    assert.equal(openModalCalls[0]!.initial.title, "Step one");
    assert.equal(openModalCalls[0]!.initial.model, "claude-opus-5-5");
    assert.deepEqual(finishCalls, [id]);
    assert.match(renderReopenedModal(state), /Hello, world/);
  });

  it("shows a finished job's turn badge from its frozen jobMeta when the live registry has dropped it", async () => {
    const id = nextId();
    setMeta(id, "done", undefined, { current: 3, max: 20 });
    await writeStdout(id, [
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello, world" } } })
    ]);

    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);

    await openJobPreview(jobUI, id, jobMeta.get(id)!);

    // The job is finished, so nothing lives in the live jobs map any more.
    assert.match(renderReopenedModalLines(state)[1]!, /turn: 3\/20/);
  });

  it("leaves a running job's modal unfinished", async () => {
    const id = nextId();
    setMeta(id, "running");
    await writeStdout(id, [
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello, world" } } })
    ]);

    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const { openModalCalls, finishCalls } = captureJobUI(jobUI);

    await openJobPreview(jobUI, id, jobMeta.get(id)!);

    assert.equal(openModalCalls.length, 1);
    assert.equal(openModalCalls[0]!.initial.model, "opus");
    assert.deepEqual(finishCalls, []);
    assert.match(renderReopenedModal(state), /Hello, world/);
  });

  it("opens a placeholder modal for an unknown id without marking it finished", async () => {
    const id = nextId();
    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const { openModalCalls, finishCalls } = captureJobUI(jobUI);

    await openJobPreview(jobUI, id, { title: "pi minion task", model: "?", prompt: "" });

    assert.equal(openModalCalls.length, 1);
    assert.equal(openModalCalls[0]!.id, id);
    assert.equal(openModalCalls[0]!.initial.title, "pi minion task");
    assert.deepEqual(finishCalls, []);
    assert.match(renderReopenedModal(state), /Working…/);
  });

  it("opens a workflow step with its sibling nav context", async () => {
    const first = nextId();
    const second = nextId();
    for (const id of [first, second]) {
      setMeta(id, "running");
      await writeStdout(id, [
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: `Output ${id}` } } })
      ]);
    }

    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const { openModalCalls } = captureJobUI(jobUI);
    const nav = stepNavFor(
      [
        { id: "build", jobId: first },
        { id: "test", jobId: second }
      ],
      first
    )!;

    await openJobPreview(jobUI, first, jobMeta.get(first)!, nav);

    assert.equal(openModalCalls[0]!.nav, nav);
    // The stored nav reaches the mounted state: the footer names the step.
    assert.match(renderReopenedModal(state), /← → step build · 1\/2/);
  });

  it("opens a standalone job without a nav context", async () => {
    const id = nextId();
    setMeta(id, "running");
    await writeStdout(id, [
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello, world" } } })
    ]);

    pinAdapter();
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const { openModalCalls } = captureJobUI(jobUI);

    await openJobPreview(jobUI, id, jobMeta.get(id)!);

    assert.equal(openModalCalls[0]!.nav, undefined);
    assert.doesNotMatch(renderReopenedModal(state), /← → step/);
  });
});

describe("cancelWorkflowMessage", () => {
  it("says cancelled only when cancelWorkflow actually cancelled it", () => {
    assert.equal(cancelWorkflowMessage("T", true), 'Pi minion workflow "T" cancelled.');
    assert.equal(cancelWorkflowMessage("T", false), 'Pi minion workflow "T" already finished.');
  });
});

describe("stepPreviewNavKeys", () => {
  const ids = ["step-1", "step-2", "step-3"];

  // A nav context plus the swap/hook pair openModal composes, with the swap
  // moving nav.index in place the way the real one does.
  function setup(index: number) {
    const nav: StepNav = { ids, index, label: (id) => id };
    const swaps: number[] = [];
    const viewport = new Viewport();
    const api = { viewport, requestRender: () => {}, done: () => {} };
    const input = stepPreviewNavKeys(nav, (next) => {
      swaps.push(next);
      nav.index = next;
    });
    return { nav, swaps, viewport, api, input };
  }

  it("switches to the previous sibling and clamps at the first", () => {
    const { swaps, api, input } = setup(1);
    assert.equal(input("\x1b[D", api), true);
    assert.deepEqual(swaps, [0]);
    // Already at the first sibling — the arrow is claimed but does nothing.
    assert.equal(input("\x1b[D", api), true);
    assert.deepEqual(swaps, [0]);
  });

  it("switches to the next sibling and clamps at the last", () => {
    const { swaps, api, input } = setup(1);
    assert.equal(input("\x1b[C", api), true);
    assert.deepEqual(swaps, [2]);
    assert.equal(input("\x1b[C", api), true);
    assert.deepEqual(swaps, [2]);
  });

  it("delegates every other key to the job-detail scroll keys", () => {
    const { swaps, viewport, api, input } = setup(1);
    viewport.bodyRows = 10;
    viewport.total = 100;
    viewport.offset = 50;
    // ↑ is the job-detail scroll binding, not a step switch.
    assert.equal(input("\x1b[A", api), true);
    assert.equal(viewport.offset, 49);
    assert.deepEqual(swaps, []);
    // A key neither hook knows falls through to the shell defaults.
    assert.equal(input("x", api), false);
  });
});

describe("loadJobIntoModal", () => {
  const createdIds: string[] = [];
  const createdDirs: string[] = [];
  let seq = 0;

  afterEach(async () => {
    setAdaptersForTest();
    for (const id of createdIds.splice(0)) jobMeta.delete(id);
    for (const dir of createdDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  function nextId(): string {
    const id = `pi-minion-test-load-${process.pid}-${seq++}`;
    createdIds.push(id);
    return id;
  }

  function setDoneMeta(id: string): void {
    jobMeta.set(id, {
      title: "Step one",
      model: "opus",
      prompt: "do the thing",
      workspace: "/tmp/workspace",
      sessionId: "test-session",
      status: "done"
    });
  }

  async function writeStdout(id: string): Promise<void> {
    const dir = join(JOB_ROOT, id);
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    await writeFile(join(dir, "stdout.json"), JSON.stringify({ type: "result", result: "done" }));
  }

  function captureFinish(jobUI: JobUI): string[] {
    const finishCalls: string[] = [];
    const realFinishModalJob = jobUI.finishModalJob;
    jobUI.finishModalJob = (id) => {
      finishCalls.push(id);
      realFinishModalJob.call(jobUI, id);
    };
    return finishCalls;
  }

  function freshState(jobId: string): ModalState {
    return { jobId, title: "", model: "", prompt: "", blocks: [], finished: false, requestRender: () => {} };
  }

  async function writeText(id: string, text: string): Promise<void> {
    const dir = join(JOB_ROOT, id);
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    await writeFile(
      join(dir, "stdout.json"),
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } })
    );
  }

  it("marks a terminal job finished after replaying it", async () => {
    const id = nextId();
    setDoneMeta(id);
    await writeStdout(id);
    setAdaptersForTest([claudeAdapter]);
    const { ctx } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const finishCalls = captureFinish(jobUI);
    const state = freshState(id);

    await loadJobIntoModal(jobUI, state, id, jobMeta.get(id)!);

    assert.deepEqual(finishCalls, [id]);
    assert.equal(state.title, "Step one");
  });

  it("drops a stale load whose jobId a later ←/→ press already replaced", async () => {
    const id = nextId();
    setDoneMeta(id);
    await writeStdout(id);
    setAdaptersForTest([claudeAdapter]);
    const { ctx } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const finishCalls = captureFinish(jobUI);
    const state = freshState(id);

    const load = loadJobIntoModal(jobUI, state, id, jobMeta.get(id)!);
    // A second ←/→ press retargets the modal before this backfill resolves.
    state.jobId = "other-step";
    await load;

    assert.deepEqual(finishCalls, [], "the stale load must not finish the modal");
  });

  it("holds live stream mutations behind a load's replay and drains them in arrival order", () => {
    const { ctx } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const state = freshState("held-job");
    jobUI.setActiveDetail(state);

    jobUI.appendModalText("held-job", "replayed history");
    jobUI.holdModalEvents("held-job");
    // Live events arrive while the load's file read is pending: queued, not applied.
    jobUI.appendModalText("held-job", " live chunk");
    jobUI.startModalToolCall("held-job", "toolu_live", "Bash");
    jobUI.setModalModel("held-job", "claude-opus-5-5");
    assert.deepEqual(state.blocks, [{ type: "text", text: "replayed history" }]);
    assert.equal(state.model, "");

    jobUI.flushModalEvents("held-job");

    assert.equal(state.holding, false);
    assert.deepEqual(state.blocks, [
      { type: "text", text: "replayed history live chunk" },
      { type: "toolCall", id: "toolu_live", name: "Bash" }
    ]);
    assert.equal(state.model, "claude-opus-5-5");
  });

  it("drops a queue stranded by a step swap instead of writing it into the new step", () => {
    const { ctx } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const state = freshState("step-a");
    jobUI.setActiveDetail(state);

    jobUI.holdModalEvents("step-a");
    jobUI.appendModalText("step-a", "stale step-a chunk");
    // ←/→ swaps the mounted state in place before step-a's load closes out.
    state.jobId = "step-b";
    state.blocks = [];

    jobUI.flushModalEvents("step-a");
    assert.deepEqual(state.blocks, [], "step-a's flush must not touch step-b");

    // step-b's own flush must not inherit step-a's queue either.
    jobUI.holdModalEvents("step-b");
    jobUI.flushModalEvents("step-b");
    assert.deepEqual(state.blocks, [], "step-a's queued chunk must self-invalidate");
  });

  it("replays a job's stored history ahead of live chunks that arrive during the load", async () => {
    const id = nextId();
    jobMeta.set(id, {
      title: "Step one",
      model: "opus",
      prompt: "do the thing",
      workspace: "/tmp/workspace",
      sessionId: "test-session",
      status: "running"
    });
    await writeText(id, "HISTORY");
    setAdaptersForTest([claudeAdapter]);
    const { ctx } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const state = freshState(id);
    jobUI.setActiveDetail(state);

    // The registered adapter's parseLine also fires a modal event of its own,
    // proving replay and live stream share the gated mutators.
    const base = createClaudeAdapter(fakeConfig({ models: { allowed: [], blocked: [] } }));
    const adapter: AgentCliAdapter = {
      ...base,
      parseLine: (line, parseState) => {
        if (line.includes("HISTORY")) applyModalEvent(jobUI, id, { kind: "text", text: "injected " });
        return base.parseLine(line, parseState);
      }
    };
    setAdaptersForTest([adapter]);

    const load = loadJobIntoModal(jobUI, state, id, jobMeta.get(id)!);
    // Live chunk for the same job while the stdout.json read is still pending.
    applyModalEvent(jobUI, id, { kind: "text", text: "LIVE" });
    await load;

    const text = state.blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /HISTORY/);
    assert.match(text, /LIVE/);
    assert.ok(
      text.indexOf("HISTORY") < text.indexOf("LIVE"),
      `replayed history must precede the live chunk, got ${JSON.stringify(text)}`
    );
    assert.ok(text.endsWith("LIVE"), `the live chunk lands last, got ${JSON.stringify(text)}`);
  });

  it("survives a modal torn down while its backfill is in flight", async () => {
    const id = nextId();
    setDoneMeta(id);
    await writeText(id, "late history");
    setAdaptersForTest([claudeAdapter]);
    const { ctx, state: fake } = fakeCtx();
    const jobUI = createJobUI(ctx as any);

    let captured: ModalState | undefined;
    let load: Promise<void> | undefined;
    void jobUI.openModal(id, { title: "Step one", model: "opus", prompt: "do the thing" }, undefined, (modalState, nextId) => {
      captured = modalState;
      load = loadJobIntoModal(jobUI, modalState, nextId, jobMeta.get(nextId)!);
      return load;
    });
    assert.ok(load, "openModal runs its loader synchronously");

    // Esc tears the overlay down while the read is still pending.
    fake.customResolve!(undefined);
    await load!;

    // Nothing replayed into the closed modal and nothing threw downstream.
    assert.deepEqual(captured!.blocks, []);
    assert.equal(captured!.finished, false);
  });

  it("swaps a mounted preview in place to the next step on →", async () => {
    const first = nextId();
    const second = nextId();
    for (const [id, text] of [
      [first, "First step output"],
      [second, "Second step output"]
    ] as const) {
      setDoneMeta(id);
      const dir = join(JOB_ROOT, id);
      await mkdir(dir, { recursive: true });
      createdDirs.push(dir);
      await writeFile(
        join(dir, "stdout.json"),
        JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text } } })
      );
    }
    setAdaptersForTest([claudeAdapter]);
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const nav: StepNav = { ids: [first, second], index: 0, label: (id) => (id === first ? "build" : "test") };

    await openJobPreview(jobUI, first, jobMeta.get(first)!, nav);

    const component = (state.customFactory! as any)(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    const render = () => component.render(60).join("\n");
    assert.match(render(), /First step output/);
    assert.match(render(), /← → step build · 1\/2/);

    component.handleInput("\x1b[C");
    // The swap's replay is fire-and-forget; let its file read land.
    for (let i = 0; i < 50 && !render().includes("Second step output"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.match(render(), /Second step output/);
    assert.doesNotMatch(render(), /First step output/);
    assert.match(render(), /← → step test · 2\/2/);
  });

  it("shows a placeholder header for a sibling whose jobMeta is gone, keeping the picker meta for the opened id", async () => {
    const first = nextId();
    const second = nextId();
    // Neither step has a jobMeta entry: the opened id falls back to the
    // picker's own object, but the sibling must not reuse that header.
    setAdaptersForTest([claudeAdapter]);
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const nav: StepNav = { ids: [first, second], index: 0, label: (id) => (id === first ? "build" : "test") };

    await openJobPreview(jobUI, first, { title: "picker task", model: "?", prompt: "" }, nav);

    const component = (state.customFactory! as any)(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    const render = () => component.render(60).join("\n");
    assert.match(render(), /picker task/);

    component.handleInput("\x1b[C");
    // The swap's load is fire-and-forget; let its (failed) read land.
    for (let i = 0; i < 50 && !render().includes("pi minion step"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.match(render(), /pi minion step/);
    assert.doesNotMatch(render(), /picker task/);
    assert.match(render(), /← → step test · 2\/2/);
  });
});
