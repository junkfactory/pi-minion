import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { createJobUI, type JobUI } from "../src/minion.ui.js";
import { backfillModal, cancelWorkflowMessage, openJobPreview } from "../src/modal.js";
import { JOB_ROOT, jobMeta } from "../src/job-store.js";
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
    const openModalCalls: Array<{ id: string; initial: Record<string, unknown> }> = [];
    const finishCalls: string[] = [];
    const realOpenModal = jobUI.openModal;
    const realFinishModalJob = jobUI.finishModalJob;
    jobUI.openModal = (id, initial) => {
      openModalCalls.push({ id, initial });
      return realOpenModal.call(jobUI, id, initial);
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

  function setMeta(id: string, status: "running" | "done", resolvedModel?: string): void {
    jobMeta.set(id, {
      title: "Step one",
      model: "opus",
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      prompt: "do the thing",
      workspace: "/tmp/workspace",
      sessionId: "test-session",
      status
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
});

describe("cancelWorkflowMessage", () => {
  it("says cancelled only when cancelWorkflow actually cancelled it", () => {
    assert.equal(cancelWorkflowMessage("T", true), 'Pi minion workflow "T" cancelled.');
    assert.equal(cancelWorkflowMessage("T", false), 'Pi minion workflow "T" already finished.');
  });
});
