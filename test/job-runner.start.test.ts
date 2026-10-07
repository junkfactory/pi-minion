// Direct tests for startJob. node --test runs each file in its own process, so
// HOME and PATH are redirected here, before the (dynamic) imports: JOB_ROOT is
// computed from homedir() at module load. The "claude" on PATH is a fake sh
// script; the last argv is the prompt, and "MODE:<x>" in the task picks the
// behavior (ok | fail). Every run appends a line to $HOME/spawned.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StepRunStats } from "../src/agent.ui.js";

const realHome = process.env.HOME;
const realPath = process.env.PATH;
const root = mkdtempSync(join(tmpdir(), "pi-minion-start-"));
const home = join(root, "home");
const bin = join(root, "bin");
const emptyBin = join(root, "empty-bin");
const workspace = join(root, "ws");
for (const dir of [home, bin, emptyBin, workspace]) mkdirSync(dir, { recursive: true });
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh
for last; do :; done
echo run >> "$HOME/spawned"
echo "LANG=\${LANG:-unset}" >> "$HOME/langprobe"
case "$last" in
  *MODE:fail*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; echo "boom on stderr" >&2; exit 3 ;;
  *MODE:empty*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; exit 0 ;;
  *MODE:slow*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; exec sleep 30 ;;
  *) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}'
     echo '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"working"}}}'
     echo '{"type":"result","result":"FINAL ANSWER","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     exit 0 ;;
esac
`
);
chmodSync(join(bin, "claude"), 0o755);
process.env.HOME = home;
process.env.PATH = `${bin}:${realPath}`;

const { startJob } = await import("../src/job-runner.js");
const { JOB_ROOT, bindSessionApi, jobMeta, jobs, markJobFinished, pruneOldJobs, stopJob } = await import("../src/job-store.js");
const { startWorkflowSession } = await import("../src/child-session.js");

type Post = { content: string; triggerTurn: boolean };
type Outcome = { finalResult?: string; reportPath?: string; ok: boolean } & Partial<StepRunStats>;

let sessionCounter = 0;
function newSession() {
  const sessionId = `start-test-${++sessionCounter}`;
  const posts: Post[] = [];
  const pi = {
    appendEntry: () => {},
    sendMessage: (msg: { content: string }, opts: { triggerTurn: boolean }) =>
      posts.push({ content: msg.content, triggerTurn: opts.triggerTurn })
  } as unknown as ExtensionAPI;
  bindSessionApi(sessionId, pi);
  return { sessionId, posts };
}

const noop = () => {};
// Every JobUI method is a no-op, so the fake survives JobUI growing new methods.
const fakeUI = new Proxy({}, { get: () => noop }) as unknown as Parameters<typeof startJob>[5];

const request = (mode: string) => ({ task: `Do a thing MODE:${mode}`, workspace, model: "sonnet", effort: "medium" });
const spawnCount = () =>
  existsSync(join(home, "spawned")) ? readFileSync(join(home, "spawned"), "utf8").trim().split("\n").length : 0;

function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error("timeout")) : setTimeout(tick, 10));
    tick();
  });
}

describe("startJob", () => {
  before(() => assert.ok(JOB_ROOT.startsWith(home), `JOB_ROOT ${JOB_ROOT} must live under the temp HOME`));
  after(() => {
    process.env.HOME = realHome;
    process.env.PATH = realPath;
    for (const job of jobs.values()) job.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("plain job posts the full result with triggerTurn and writes result.md", async () => {
    const { sessionId, posts } = newSession();
    const notes: string[] = [];
    const id = await startJob(request("ok"), workspace, sessionId, undefined, (m) => notes.push(m), fakeUI);
    await waitFor(() => posts.length > 0);
    assert.equal(posts[0].triggerTurn, true);
    assert.match(posts[0].content, /FINAL ANSWER/);
    assert.doesNotMatch(posts[0].content, /Step finished/);
    assert.equal(readFileSync(join(JOB_ROOT, id, "result.md"), "utf8"), "FINAL ANSWER");
    assert.equal(jobMeta.get(id)?.status, "done");
    assert.equal(jobMeta.get(id)?.reportPath, join(JOB_ROOT, id, "result.md"));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /started/);
  });

  it("preExec wraps the spawned binary (env -u reaches the child)", async () => {
    const overrideDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "pi-minion.json");
    writeFileSync(override, JSON.stringify({ adapterArgs: { claude: { args: [], preExec: ["env", "-u", "LANG"] } } }));
    const prevLang = process.env.LANG;
    process.env.LANG = "SENTINEL_PREEXEC";
    try {
      const { sessionId, posts } = newSession();
      await startJob(request("ok"), workspace, sessionId, undefined, noop, fakeUI);
      await waitFor(() => posts.length > 0);
      assert.equal(readFileSync(join(home, "langprobe"), "utf8").trim().split("\n").at(-1), "LANG=unset");
    } finally {
      process.env.LANG = prevLang;
      rmSync(override, { force: true });
    }
  });

  it("workflow step posts nothing at its end and settles once with ok", async () => {
    const { sessionId, posts } = newSession();
    const notes: string[] = [];
    const outcomes: Outcome[] = [];
    const id = await startJob(
      request("ok"), workspace, sessionId, undefined, (m) => notes.push(m), fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › step1", id: "step1", workflowId: "wf" }
    );
    await waitFor(() => outcomes.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(posts, []);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[0].finalResult, "FINAL ANSWER");
    assert.equal(outcomes[0].reportPath, join(JOB_ROOT, id, "result.md"));
    assert.equal(jobMeta.get(id)?.title, "wf › step1");
    assert.deepEqual(notes, []);
    // What the finished step's widget row keeps: run time and tokens.
    assert.ok(outcomes[0].startedAt! <= outcomes[0].finishedAt!);
    assert.ok(outcomes[0].tokenUsage, "expected token usage from the run");
    assert.equal(outcomes[0].totalCostUsd, 0.01);
    assert.equal(jobs.get(id), undefined);
  });

  it("workflow step exiting non-zero without a result settles not-ok with full diagnostics", async () => {
    const { sessionId, posts } = newSession();
    const outcomes: Outcome[] = [];
    const id = await startJob(
      request("fail"), workspace, sessionId, undefined, noop, fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › bad", id: "bad", workflowId: "wf" }
    );
    await waitFor(() => outcomes.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(outcomes[0].finalResult, undefined);
    assert.equal(jobMeta.get(id)?.status, "errored");
    assert.deepEqual(posts, []);
    // Diagnostics still land on disk even though nothing posts.
    assert.match(readFileSync(join(JOB_ROOT, id, "stderr.log"), "utf8"), /boom on stderr/);
  });

  describe("spawn error (binary missing)", () => {
    const withoutClaude = async (fn: () => Promise<void>) => {
      process.env.PATH = emptyBin;
      try {
        await fn();
      } finally {
        process.env.PATH = `${bin}:${realPath}`;
      }
    };

    it("with onSettled: settles once not-ok and posts nothing", () =>
      withoutClaude(async () => {
        const { sessionId, posts } = newSession();
        const outcomes: Outcome[] = [];
        const id = await startJob(
          request("ok"), workspace, sessionId, undefined, noop, fakeUI,
          undefined, (o) => outcomes.push(o), { title: "wf › missing", id: "missing", workflowId: "wf" }
        );
        await waitFor(() => outcomes.length > 0);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].ok, false);
        assert.deepEqual(posts, []);
        assert.equal(jobMeta.get(id)?.status, "errored");
        assert.equal(jobs.get(id), undefined);
      }));

    it("without onSettled: triggers a turn", () =>
      withoutClaude(async () => {
        const { sessionId, posts } = newSession();
        await startJob(request("ok"), workspace, sessionId, undefined, noop, fakeUI);
        await waitFor(() => posts.length > 0);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].triggerTurn, true);
      }));
  });

  it("a clean exit without a result marks the job errored and settles not-ok", async () => {
    const { sessionId } = newSession();
    const outcomes: Outcome[] = [];
    const id = await startJob(
      request("empty"), workspace, sessionId, undefined, noop, fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › empty", id: "empty", workflowId: "wf" }
    );
    await waitFor(() => outcomes.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(outcomes[0].finalResult, undefined);
    assert.equal(jobMeta.get(id)?.status, "errored");
  });

  it("a mid-run cancellation keeps status cancelled after the process closes", async () => {
    const { sessionId } = newSession();
    const outcomes: Outcome[] = [];
    const id = await startJob(
      request("slow"), workspace, sessionId, undefined, noop, fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › slow", id: "slow", workflowId: "wf" }
    );
    // Same sequence cancel_pi_minion runs: stop the process, record cancelled.
    stopJob(id);
    markJobFinished(id, "cancelled");
    await waitFor(() => outcomes.length > 0);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.equal(jobMeta.get(id)?.status, "cancelled");
  });

  it("isCancelled rejects before spawning and marks the job cancelled", async () => {
    const { sessionId, posts } = newSession();
    const before = spawnCount();
    const outcomes: Outcome[] = [];
    await assert.rejects(
      startJob(
        request("ok"), workspace, sessionId, undefined, noop, fakeUI,
        undefined, (o) => outcomes.push(o), { title: "wf › cancelled", id: "cancelled", workflowId: "wf" }, () => true
      ),
      /Cancelled before the pi minion started/
    );
    assert.equal(spawnCount(), before);
    const cancelled = [...jobMeta.values()].filter((m) => m.sessionId === sessionId);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].status, "cancelled");
    assert.deepEqual(posts, []);
    assert.deepEqual(outcomes, []);
  });

  it("threads a step's session under its workflow session, and job pruning leaves both sessions alone", async () => {
    const { sessionId } = newSession();
    const sessionsDir = join(home, ".pi", "agent", "sessions", "start-test");
    mkdirSync(sessionsDir, { recursive: true });
    const parent = join(sessionsDir, "parent.jsonl");
    const workflow = startWorkflowSession({ parentSessionFile: parent, cwd: workspace, name: "⛓ wf", plan: "PLAN", startedAt: Date.now() });
    const outcomes: Outcome[] = [];
    const id = await startJob(
      request("ok"), workspace, sessionId, workflow.file, noop, fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › step1", id: "step1", workflowId: "wf" }
    );
    await waitFor(() => outcomes.length > 0);
    workflow.finish("SUMMARY");
    const header = (file: string) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
    const stepSession = readdirSync(sessionsDir)
      .map((name) => join(sessionsDir, name))
      .find((file) => file !== workflow.file && file !== parent)!;
    assert.equal(header(workflow.file!).parentSession, parent);
    assert.equal(header(stepSession).parentSession, workflow.file);
    assert.match(readFileSync(stepSession, "utf8"), /"name":"claude-fake-1: step1"/);

    // Age the job's directory past the cutoff: pruning removes it, not the sessions.
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(JOB_ROOT, id), old, old);
    await pruneOldJobs(1);
    assert.ok(!existsSync(join(JOB_ROOT, id)), "job dir pruned");
    assert.ok(existsSync(workflow.file!), "workflow session kept");
    assert.ok(existsSync(stepSession), "step session kept");
    assert.match(readFileSync(workflow.file!, "utf8"), /SUMMARY/);
  });

  it("a failure before spawn leaves the job errored, not running", async () => {
    const { sessionId } = newSession();
    // Make ~/.pi a plain file so mkdir(JOB_ROOT, recursive) fails with ENOTDIR.
    const dotPi = join(home, ".pi");
    const parked = join(home, ".pi.parked");
    renameSync(dotPi, parked);
    writeFileSync(dotPi, "not a dir");
    try {
      await assert.rejects(startJob(request("ok"), workspace, sessionId, undefined, noop, fakeUI));
    } finally {
      rmSync(dotPi);
      renameSync(parked, dotPi);
    }
    const metas = [...jobMeta.values()].filter((m) => m.sessionId === sessionId);
    assert.equal(metas.length, 1);
    assert.equal(metas[0].status, "errored");
  });
});
