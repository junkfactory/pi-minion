// End-to-end coverage for the three shipped behaviors around a live child:
// steering through the registered steer_pi_minion tool, the maxTurns cap, and
// the natural-completion teardown (stdin close -> child exit).
//
// The child is a fake `pi` on PATH speaking the real `--mode rpc` wire format,
// keyed off MODE:<x> in the prompt frame — same pattern as
// test/job-runner.start.test.ts, which this file deliberately leaves alone.
// node --test runs each file in its own process, so HOME and PATH are
// redirected here, before the (dynamic) imports: JOB_ROOT comes from
// homedir() at module load.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const realHome = process.env.HOME;
const realPath = process.env.PATH;
const root = mkdtempSync(join(tmpdir(), "pi-minion-steer-e2e-"));
const home = join(root, "home");
const bin = join(root, "bin");
const workspace = join(root, "ws");
for (const dir of [home, bin, workspace]) mkdirSync(dir, { recursive: true });

// Fake pi child. It acks the prompt, then picks its behavior from the prompt
// frame. Each mode records the frames it read on $HOME/pi-stdin.txt and writes
// an EOF marker only after its stdin is closed, so the marker is the close
// observed from the child's side (never a self-imposed exit).
writeFileSync(
  join(bin, "pi"),
  `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/pi-argv.txt"
IFS= read -r line
printf '%s\\n' "$line" > "$HOME/pi-stdin.txt"
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
case "$line" in
  *MODE:steer*)
     # First draft, then block for the steer frame. The run cannot settle
     # before the steer arrives, so a tool call made now always lands mid-run.
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"FIRST DRAFT"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}},"stopReason":"stop"}}'
     IFS= read -r steer
     printf '%s\\n' "$steer" >> "$HOME/pi-stdin.txt"
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"STEERED FINAL"}],"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.02}},"stopReason":"stop"}}'
     echo '{"type":"agent_settled","aborted":false}'
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/steer-eof.txt"
     exit 0 ;;
  *MODE:cap*)
     # A cycling run: two turns announced, then the child waits on the command
     # channel. The runner's cap must answer with pi's abort frame, which the
     # child logs here; agent_settled (aborted) then ends the run as usual.
     echo '{"type":"turn_start"}'
     echo '{"type":"turn_start"}'
     while IFS= read -r l; do
        printf '%s\\n' "$l" >> "$HOME/pi-stdin.txt"
        case "$l" in
          *'"abort"'*) echo '{"type":"agent_settled","aborted":true}'; break ;;
        esac
     done
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/cap-eof.txt"
     exit 0 ;;
  *MODE:settle*)
     # A clean completion. The child exits only on stdin EOF, so its marker and
     # exit are proof the runner closed the channel after the run settled. The
     # TERM trap writes a second marker only if the runner escalated to a
     # signal — which it must not need to.
     trap 'echo term >> "$HOME/settle-term.txt"' TERM
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"SETTLED FINAL"}],"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}},"stopReason":"stop"}}'
     echo '{"type":"agent_settled","aborted":false}'
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/settle-eof.txt"
     exit 0 ;;
  *MODE:race*)
     # A pre-settle write failure whose error surfaces only after the run
     # settled. The child closes its own stdin end (so the cap's abort frame
     # cannot land), then announces BOTH turns and agent_settled in one write:
     # the runner consumes the cap boundary and the settle from the same stdout
     # chunk, so the EPIPE is delivered only after the channel was closed. It
     # still came from a pre-settle write, so it must be reported and must still
     # escalate to a signal.
     exec 0<&-
     trap 'echo term >> "$HOME/race-term.txt"; exit 0' TERM
     printf '%s\n%s\n%s\n' '{"type":"turn_start"}' '{"type":"turn_start"}' '{"type":"agent_settled","aborted":false}'
     while :; do sleep 0.05; done ;;
  *MODE:broken*)
     # A cycling run whose command channel dies mid-run: two turns announced,
     # then the child closes its own stdin end so the runner's cap frame can
     # never land (EPIPE). The cap must escalate to stopping the process — the
     # TERM trap is the proof it did, instead of writing to the dead channel
     # and waiting for the run timeout.
     # Close the channel BEFORE announcing the turns, so the cap's frame
     # cannot race the close: the write is guaranteed to hit a closed pipe.
     exec 0<&-
     echo '{"type":"turn_start"}'
     echo '{"type":"turn_start"}'
     trap 'echo term >> "$HOME/broken-term.txt"; exit 0' TERM
     while :; do sleep 0.05; done ;;
esac
echo '{"type":"agent_settled","aborted":false}'
while IFS= read -r l; do :; done
exit 0
`
);
chmodSync(join(bin, "pi"), 0o755);
process.env.HOME = home;
process.env.PATH = `${bin}:${realPath}`;

const { startJob } = await import("../src/job-runner.js");
const { bindSessionApi, jobMeta, jobs } = await import("../src/job-store.js");
const { setAdaptersForTest } = await import("../src/adapters/registry.js");
const { createClaudeAdapter } = await import("../src/adapters/claude.js");
const { createPiAdapter, setModelRegistry } = await import("../src/adapters/pi.js");
const { createFakeAdapter, fakeConfig, fakeModelRegistry } = await import("./fakes.js");
const { registerTools } = await import("../src/tools.js");

const MODEL = "opencode-go/crouton-alpha-free";

type Post = { content: string; triggerTurn: boolean };
const noop = () => {};
// Every JobUI method is a no-op, so the fake survives JobUI growing new methods.
const fakeUI = new Proxy({}, { get: () => noop }) as unknown as Parameters<typeof startJob>[5];

let sessionCounter = 0;
function newSession() {
  const sessionId = `steer-e2e-${++sessionCounter}`;
  const posts: Post[] = [];
  const pi = {
    appendEntry: noop,
    sendMessage: (msg: { content: string }, opts: { triggerTurn: boolean }) =>
      posts.push({ content: msg.content, triggerTurn: opts.triggerTurn })
  } as unknown as ExtensionAPI;
  bindSessionApi(sessionId, pi);
  return { sessionId, posts };
}

// The registered tool surface, exercised through its real execute path rather
// than by calling steerJob() directly: this is what the agent sees.
const registered: ToolDefinition[] = [];
registerTools({
  registerTool: (definition: ToolDefinition) => {
    registered.push(definition);
  }
} as unknown as ExtensionAPI);
const tools = new Map(registered.map((definition) => [definition.name, definition]));

const frames = () =>
  existsSync(join(home, "pi-stdin.txt"))
    ? readFileSync(join(home, "pi-stdin.txt"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error("timeout")) : setTimeout(tick, 10));
    tick();
  });
}

before(() => {
  // Pin config-bound adapters so ensureRegistry no-ops: the run resolves
  // against these instead of whatever CLIs are installed on this machine.
  const permissive = () => fakeConfig({ models: { allowed: [], blocked: [] } });
  setAdaptersForTest([createClaudeAdapter(permissive()), createPiAdapter(permissive()), createFakeAdapter(permissive())]);
  // The pi adapter owns a model by catalog lookup, so seed the row it routes on.
  setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
});

after(() => {
  setModelRegistry(undefined);
  setAdaptersForTest();
  process.env.HOME = realHome;
  process.env.PATH = realPath;
  rmSync(root, { recursive: true, force: true });
});

describe("steering / maxTurns / teardown end to end", () => {
  it("steer: the steer_pi_minion tool writes a steer frame the fake pi child receives on stdin", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { task: "Do a thing MODE:steer", workspace, model: MODEL, effort: "medium" },
      workspace, sessionId, undefined, noop, fakeUI
    );
    const job = jobs.get(id);
    assert.ok(job?.stdin, "a steering-capable job exposes its stdin handle");
    assert.equal(job.status, "running");
    const tool = tools.get("steer_pi_minion");
    assert.ok(tool, "steer_pi_minion is registered");
    const result = await tool.execute(
      "call-steer",
      { id, message: "check the edge case", deliverAs: "steer" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionToolContext
    );
    assert.equal((result.details as { delivered: boolean }).delivered, true, "the tool reports delivery");
    await waitFor(() => posts.length > 0);
    await waitFor(() => existsSync(join(home, "steer-eof.txt")));
    const sent = frames();
    assert.equal(sent[0].type, "prompt");
    assert.deepEqual(sent[1], { type: "steer", message: "check the edge case" });
    assert.equal(jobMeta.get(id)?.status, "done");
    assert.match(posts[0].content, /STEERED FINAL/, "the post-steer result is what got posted");
  });

  it("cap: maxTurns=1 stops the cycling run as cancelled with 'maxTurns=1 reached'", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { task: "Do a thing MODE:cap", workspace, model: MODEL, effort: "medium", maxTurns: 1 },
      workspace, sessionId, undefined, noop, fakeUI
    );
    await waitFor(() => posts.length > 0);
    assert.equal(jobMeta.get(id)?.status, "cancelled");
    assert.match(posts[0].content, /maxTurns=1 reached/);
    // The cap went out over the child's own command channel, not as a kill.
    const sent = frames();
    assert.equal(sent[0].type, "prompt");
    assert.deepEqual(sent.slice(1).map((frame) => frame.type), ["abort"], "exactly one stop frame, after the prompt");
    await waitFor(() => existsSync(join(home, "cap-eof.txt")));
  });

  it("teardown: a settled run closes the child's stdin promptly and the child exits without escalation", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { task: "Do a thing MODE:settle", workspace, model: MODEL, effort: "medium" },
      workspace, sessionId, undefined, noop, fakeUI
    );
    const stdin = jobs.get(id)?.stdin;
    assert.ok(stdin, "the rpc child's stdin is a live pipe while the run is open");
    assert.equal(stdin.writableEnded, false, "the channel is open at start, not closed on spec");
    // The close itself stays prompt: the runner ends the channel as soon as the
    // run settles, and the child's marker proves the EOF reached it.
    await waitFor(() => stdin.writableEnded, 5_000);
    await waitFor(() => existsSync(join(home, "settle-eof.txt")), 5_000);
    // The child-exit bound gets headroom for scheduler delays under load (the
    // 5 s SIGTERM grace plus margin); the escalation chain itself is pinned by
    // the markers: the child writes its EOF marker only when stdin close (not
    // a signal) ended it, and its TERM trap leaves a marker if the runner ever
    // escalated — a SIGKILL would leave neither.
    await waitFor(() => !jobs.has(id), 10_000);
    assert.ok(!existsSync(join(home, "settle-term.txt")), "the child exited on stdin EOF, not on a SIGTERM");
    assert.match(posts[0].content, /SETTLED FINAL/);
    assert.equal(jobMeta.get(id)?.status, "done");
  });

  it("cap: a write error that surfaces after runSettled still warns and still stops the child", async () => {
    // Regression (F4): the failure used to be classified by when the 'error'
    // event arrived, so an EPIPE from a write issued BEFORE the run settled was
    // swallowed once settle closed the channel — the result claimed nothing
    // broke and the child was left running until its timeout.
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { task: "Do a thing MODE:race", workspace, model: MODEL, effort: "medium", maxTurns: 1, timeoutMs: 20_000 },
      workspace, sessionId, undefined, noop, fakeUI
    );
    await waitFor(() => posts.length > 0, 5_000);
    assert.equal(jobMeta.get(id)?.status, "cancelled");
    assert.match(posts[0].content, /stdin channel broke mid-run/, "the broken channel is reported");
    assert.match(posts[0].content, /maxTurns=1 reached/);
    await waitFor(() => existsSync(join(home, "race-term.txt")), 10_000);
  });

  it("cap: a broken stdin channel still stops the child by signal, not by the dead channel", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { task: "Do a thing MODE:broken", workspace, model: MODEL, effort: "medium", maxTurns: 1 },
      workspace, sessionId, undefined, noop, fakeUI
    );
    // The child closed its own stdin end, so the cap's abort frame fails with
    // EPIPE; the runner must fall back to stopProcess() rather than leave the
    // child running until its timeout.
    await waitFor(() => posts.length > 0, 15_000);
    assert.equal(jobMeta.get(id)?.status, "cancelled");
    assert.match(posts[0].content, /maxTurns=1 reached/);
    assert.match(posts[0].content, /stdin channel broke mid-run/, "the broken channel is reported");
    await waitFor(() => existsSync(join(home, "broken-term.txt")), 10_000);
    assert.deepEqual(frames().map((frame) => frame.type), ["prompt"], "no abort frame could reach the closed channel");
  });
});
