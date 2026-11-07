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
# The task arrives as the first stdin line now (a stream-json user frame), so
# MODE:<x> is read from there instead of from the last argv entry.
echo run >> "$HOME/spawned"
printf '%s\\n' "$@" > "$HOME/argv.txt"
echo "LANG=\${LANG:-unset}" >> "$HOME/langprobe"
IFS= read -r line
printf '%s\\n' "$line" > "$HOME/stdin.txt"
case "$line" in
  *MODE:fail*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; echo "boom on stderr" >&2; exit 3 ;;
  *MODE:argv*)
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"result","result":"ARGS OK","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     exit 0 ;;
  *MODE:empty*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; exit 0 ;;
  *MODE:slow*) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'; exec sleep 30 ;;
  *MODE:eof*)
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"result","result":"STDIN CLOSED OK","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     while IFS= read -r l; do printf '%s\\n' "$l" >> "$HOME/stdin.txt"; done
     echo eof >> "$HOME/eof.txt"
     exit 0 ;;
  *MODE:long*)
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     printf '%s\\n' '{"type":"result","result":"head line\\nline2\\nline3","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     exit 0 ;;
  *MODE:late*)
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     printf '%s\\n' '{"type":"result","result":"first\\nsecond\\nthird","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     exit 4 ;;
  *MODE:streamturns*)
     # One turn at a time, each opened by its own message_start — the boundary a
     # cap counts. Turn one streams and completes; turn two is only OPENED, then
     # the child blocks for the interrupt, so a cap that still counted at
     # completion time would let turn two run (and hang here) instead.
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}'
     echo '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"turn one"}}}'
     echo '{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-fake-1","content":[{"type":"text","text":"turn one"}]}}'
     echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_2"}}}'
     IFS= read -r cmd
     printf '%s\\n' "$cmd" >> "$HOME/stdin.txt"
     echo '{"type":"result","subtype":"success","result":"","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     while IFS= read -r l; do :; done
     exit 0 ;;
  *MODE:turns*)
     # Two assistant turns, then block until the runner's cap stop reaches the
     # channel. The interrupt frame is logged, then the run ends as claude's
     # terminal result, which is also its runSettled.
     echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}'
     echo '{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-fake-1","content":[{"type":"text","text":"turn one"}]}}'
     echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_2"}}}'
     echo '{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"claude-fake-1","content":[{"type":"text","text":"turn two"}]}}'
     IFS= read -r cmd
     printf '%s\\n' "$cmd" >> "$HOME/stdin.txt"
     echo '{"type":"result","subtype":"success","result":"","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     while IFS= read -r l; do :; done
     exit 0 ;;
  *) echo '{"type":"system","subtype":"init","model":"claude-fake-1"}'
     echo '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}'
     echo '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"working"}}}'
     echo '{"type":"result","result":"FINAL ANSWER","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":2}}'
     exit 0 ;;
esac
`
);
chmodSync(join(bin, "claude"), 0o755);
// Fake pi CLI: same stdin-frame contract as the real `--mode rpc` child — an
// ack record for the prompt, events, agent_settled, then exit on stdin EOF.
// MODE:wait blocks for a second line (a steer), so a test can prove the
// channel stays open mid-run.
writeFileSync(
  join(bin, "pi"),
  `#!/bin/sh
echo run >> "$HOME/spawned"
printf '%s\\n' "$@" > "$HOME/pi-argv.txt"
IFS= read -r line
printf '%s\\n' "$line" > "$HOME/pi-stdin.txt"
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
case "$line" in
  *MODE:wait*)
     IFS= read -r second
     printf '%s\\n' "$second" >> "$HOME/pi-stdin.txt" ;;
  *MODE:steered*)
     # First draft, then block for a steer frame; the final answer and
     # agent_settled only follow once that frame arrives, so a posted result
     # would prove the runner finalized before the run was over.
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"FIRST DRAFT"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}},"stopReason":"stop"}}'
     IFS= read -r second
     printf '%s\\n' "$second" >> "$HOME/pi-stdin.txt"
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"STEERED FINAL"}],"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.02}},"stopReason":"stop"}}'
     echo '{"type":"agent_settled","aborted":false}'
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/pi-eof.txt"
     exit 0 ;;
  *MODE:fail*)
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[],"stopReason":"error","errorMessage":"provider exploded"}}'
     echo '{"type":"agent_settled","aborted":false}'
     while IFS= read -r l; do :; done
     exit 0 ;;
  *MODE:turns*)
     # A cycling run: two turns announced back-to-back, then the child waits on
     # the command channel. The runner's maxTurns cap must answer with the rpc
     # abort frame; agent_settled (aborted) then ends the run as usual.
     echo '{"type":"turn_start"}'
     echo '{"type":"turn_start"}'
     while IFS= read -r l; do
        printf '%s\\n' "$l" >> "$HOME/pi-stdin.txt"
        case "$l" in
          *'"abort"'*) echo '{"type":"agent_settled","aborted":true}'; break ;;
        esac
     done
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/pi-eof.txt"
     exit 0 ;;
  *MODE:multi*)
     # Three turns with no cap in sight: the unlimited default must let them all
     # run and still finish cleanly.
     echo '{"type":"turn_start"}'
     echo '{"type":"turn_start"}'
     echo '{"type":"turn_start"}'
     echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"MANY TURNS"}],"usage":{"input":2,"output":4,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.02}},"stopReason":"stop"}}'
     echo '{"type":"agent_settled","aborted":false}'
     while IFS= read -r l; do :; done
     echo eof >> "$HOME/pi-eof.txt"
     exit 0 ;;
esac
echo '{"type":"turn_start"}'
echo '{"type":"message_update","usage":{"input":1,"output":1},"assistantMessageEvent":{"type":"text_start"}}'
echo '{"type":"message_update","usage":{"input":1,"output":1},"assistantMessageEvent":{"type":"text_delta","delta":"PI RPC ANSWER"}}'
echo '{"type":"message_end","message":{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"PI RPC ANSWER"}],"usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.01}},"stopReason":"stop"}}'
echo '{"type":"agent_end","messages":[{"role":"assistant","model":"pi-fake-1","content":[{"type":"text","text":"PI RPC ANSWER"}],"usage":{"input":1,"output":2},"stopReason":"stop"}]}'
echo '{"type":"agent_settled","aborted":false}'
while IFS= read -r l; do printf '%s\\n' "$l" >> "$HOME/pi-stdin.txt"; done
echo eof >> "$HOME/pi-eof.txt"
exit 0
`
);
chmodSync(join(bin, "pi"), 0o755);
process.env.HOME = home;
process.env.PATH = `${bin}:${realPath}`;

const { startJob, validateRequest } = await import("../src/job-runner.js");
const { validateWorkflowSteps } = await import("../src/tools.js");
const { JOB_ROOT, bindSessionApi, jobMeta, jobs, markJobFinished, pruneOldJobs, steerJob, stopJob } = await import("../src/job-store.js");
const { startWorkflowSession } = await import("../src/child-session.js");
const { setAdaptersForTest } = await import("../src/adapters/registry.js");
const { createClaudeAdapter, userMessageFrame } = await import("../src/adapters/claude.js");
const { abortFrame, promptFrame, setModelRegistry, steerFrame } = await import("../src/adapters/pi.js");
const { createPiAdapter } = await import("../src/adapters/pi.js");
const { createFakeAdapter, fakeConfig, fakeModelRegistry } = await import("./fakes.js");

// Pin config-bound adapters so ensureRegistry no-ops: validateRequest and
// startJob resolve against these instead of whatever CLIs happen to be
// installed on this machine. Permissive configs — the gates each call applies
// come from the config it passes in, not the adapter's own.
const permissive = () => fakeConfig({ models: { allowed: [], blocked: [] } });
setAdaptersForTest([
  createClaudeAdapter(permissive()),
  createPiAdapter(permissive()),
  createFakeAdapter(permissive())
]);

type Post = { content: string; triggerTurn: boolean };
type Outcome = { finalResult?: string; reportPath?: string; errorReason?: string; ok: boolean } & Partial<StepRunStats>;

let sessionCounter = 0;
function newSession() {
  const sessionId = `start-test-${++sessionCounter}`;
  const posts: Post[] = [];
  const entries: string[] = [];
  const pi = {
    appendEntry: (_type: string, entry: { content: string }) => entries.push(entry.content),
    sendMessage: (msg: { content: string }, opts: { triggerTurn: boolean }) =>
      posts.push({ content: msg.content, triggerTurn: opts.triggerTurn })
  } as unknown as ExtensionAPI;
  bindSessionApi(sessionId, pi);
  return { sessionId, posts, entries };
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

describe("validateRequest providers gate", () => {
  // Minimal well-formed MinionConfig for the provider gate (mirrors test/fakes.ts).
  const configWith = (providers: { allowed?: string[]; blocked?: string[] }) => ({
    models: { allowed: ["sonnet"], blocked: [] },
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000,
    providers
  });
  const request = { task: "x", workspace, model: "sonnet", effort: "medium" };

  it("rejects a model whose provider is blocked", () =>
    assert.rejects(
      validateRequest(request, workspace, configWith({ blocked: ["claude"] })),
      /excluded by the providers config \(providers: claude\)/
    ));

  it("rejects a model whose provider is outside a non-empty allowlist", () =>
    assert.rejects(
      validateRequest(request, workspace, configWith({ allowed: ["antigravity"] })),
      /excluded by the providers config/
    ));

  it("keeps a model whose provider passes the filter", async () => {
    await validateRequest(request, workspace, configWith({ blocked: ["antigravity"] }));
  });

  it("enforces every backing provider of a shared alias", async () => {
    const { setModelRegistry } = await import("../src/adapters/pi.js");
    const { fakeModelRegistry } = await import("./fakes.js");
    setModelRegistry(
      fakeModelRegistry([
        { id: "gpt-6-luna", provider: "opencode-go" },
        { id: "gpt-5.6-luna", provider: "amazon-bedrock" }
      ])
    );
    try {
      // One blocked backing provider must reject the whole alias — help hides
      // it under the same config (isModelProviderAllowed uses .every), so this
      // must not slip through validateRequest.
      await assert.rejects(
        validateRequest(
          { ...request, model: "luna" },
          workspace,
          { ...configWith({ blocked: ["opencode-go"] }), models: { allowed: [] } }
        ),
        /excluded by the providers config/
      );
      await validateRequest(
        { ...request, model: "luna" },
        workspace,
        { ...configWith({ blocked: ["antigravity"] }), models: { allowed: [] } }
      );
      // Order: a string blocked at BOTH the provider and model level reports
      // the providers message — the providers gate runs before models.blocked.
      await assert.rejects(
        validateRequest(
          { ...request, model: "luna" },
          workspace,
          { ...configWith({ blocked: ["opencode-go"] }), models: { allowed: [], blocked: ["luna*"] } }
        ),
        /excluded by the providers config/
      );
    } finally {
      setModelRegistry(undefined);
    }
  });
});

describe("validateRequest timeoutMs", () => {
  const config = {
    models: { allowed: ["sonnet"], blocked: [] },
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000
  };
  const request = { task: "x", workspace, model: "sonnet", effort: "medium" };

  it("rejects zero, a negative value, NaN and Node's setTimeout overflow", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, 2_147_483_648]) {
      await assert.rejects(
        validateRequest({ ...request, timeoutMs }, workspace, config),
        /timeoutMs must be a positive number of milliseconds/
      );
    }
  });

  it("accepts a positive limit up to the setTimeout maximum", async () => {
    await validateRequest({ ...request, timeoutMs: 250 }, workspace, config);
    await validateRequest({ ...request, timeoutMs: 2_147_483_647 }, workspace, config);
  });
});

describe("validateRequest maxTurns", () => {
  const config = {
    models: { allowed: ["sonnet"], blocked: [] },
    allowedTools: [],
    maxBudgetUsd: 5,
    timeoutMs: 900_000
  };
  const request = { task: "x", workspace, model: "sonnet", effort: "medium" };

  it("rejects zero, a negative value, a cap above the limit, a fraction and NaN", async () => {
    for (const maxTurns of [0, -1, 100_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        validateRequest({ ...request, maxTurns }, workspace, config),
        /maxTurns must be a whole number from 1 to 100000/
      );
    }
  });

  it("accepts both bounds and treats an omitted cap as unlimited", async () => {
    await validateRequest({ ...request, maxTurns: 1 }, workspace, config);
    await validateRequest({ ...request, maxTurns: 100_000 }, workspace, config);
    const validated = await validateRequest(request, workspace, config);
    assert.equal(validated.maxTurns, undefined);
  });

  it("rejects a cap on an adapter that reports no turn boundaries", async () => {
    // The pinned fake adapter declares no emitsTurnEvents: the runner would
    // have nothing to count, so the cap must fail fast instead of running
    // silently unenforced.
    const permissive = fakeConfig({ models: { allowed: [], blocked: [] } });
    await assert.rejects(
      validateRequest({ ...request, model: "fake-model", maxTurns: 3 }, workspace, permissive),
      /maxTurns is not supported for the fake-cli adapter/
    );
    // Only the unenforceable combination is refused — the same adapter is
    // accepted without a cap.
    await validateRequest({ ...request, model: "fake-model" }, workspace, permissive);
  });
});

describe("validateWorkflowSteps timeoutMs preflight", () => {
  const config = permissive();
  const step = (extra: object = {}) => [
    { id: "a", task: "Do a thing", model: "sonnet", effort: "medium", ...extra }
  ];

  it("rejects a step or workflow limit that startJob would reject", async () => {
    for (const timeoutMs of [0, -1, 2_147_483_648]) {
      await assert.rejects(
        validateWorkflowSteps(
          { title: "T", context: "No prior context.", steps: step({ timeoutMs }) },
          workspace,
          config
        ),
        /Step "a": timeoutMs must be a positive number/
      );
      await assert.rejects(
        validateWorkflowSteps(
          { title: "T", context: "No prior context.", timeoutMs, steps: step() },
          workspace,
          config
        ),
        /Step "a": timeoutMs must be a positive number/
      );
    }
  });

  it("accepts valid step and workflow limits", async () => {
    await validateWorkflowSteps(
      { title: "T", context: "No prior context.", steps: step({ timeoutMs: 120_000 }) },
      workspace,
      config
    );
    await validateWorkflowSteps(
      { title: "T", context: "No prior context.", timeoutMs: 900_000, steps: step() },
      workspace,
      config
    );
  });
});

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

  it("caps the model-facing post while the display entry keeps the full preview", async () => {
    const overrideDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "pi-minion.json");
    writeFileSync(override, JSON.stringify({ maxResultContextBytes: 10 }));
    try {
      const { sessionId, posts, entries } = newSession();
      const id = await startJob(request("long"), workspace, sessionId, undefined, noop, fakeUI);
      await waitFor(() => posts.length > 0);
      // Context: head-only + pointer notices + read instruction.
      assert.match(posts[0].content, /Showing lines 1-1 of 3/);
      assert.match(posts[0].content, /see the report linked above and any files it references/);
      assert.doesNotMatch(posts[0].content, /line3/);
      // Display entry: full result, no read hint, never truncated at 50KB.
      assert.match(entries[0], /line3/);
      assert.doesNotMatch(entries[0], /see the report linked above and any files it references/);
      assert.equal(readFileSync(join(JOB_ROOT, id, "result.md"), "utf8"), "head line\nline2\nline3");
    } finally {
      rmSync(override, { force: true });
    }
  });

  it("zero context cap suppresses the read hint behind the pointer-only body", async () => {
    const overrideDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "pi-minion.json");
    writeFileSync(override, JSON.stringify({ maxResultContextBytes: 0 }));
    try {
      const { sessionId, posts, entries } = newSession();
      const id = await startJob(request("long"), workspace, sessionId, undefined, noop, fakeUI);
      await waitFor(() => posts.length > 0);
      assert.match(posts[0].content, /\[Omitted: 0-byte context limit\. Full result at/);
      // The pointer notice's own "read it only when necessary" must be the only
      // one: a second occurrence means the read hint was appended on top of it.
      assert.equal(posts[0].content.split("read it only when necessary").length - 1, 1);
      assert.doesNotMatch(posts[0].content, /see the report linked above and any files it references/);
      // Display entry still holds the untruncated preview.
      assert.match(entries[0], /line3/);
      assert.equal(readFileSync(join(JOB_ROOT, id, "result.md"), "utf8"), "head line\nline2\nline3");
    } finally {
      rmSync(override, { force: true });
    }
  });

  it("scheduled run: a returned note flips triggerTurn and lands after the read hint", async () => {
    const { sessionId, posts, entries } = newSession();
    await startJob(
      request("ok"), workspace, sessionId, undefined, noop, fakeUI,
      (finalResult) => (finalResult?.includes("FINAL ANSWER") ? "watch ended" : undefined)
    );
    await waitFor(() => posts.length > 0);
    assert.equal(posts[0].triggerTurn, true);
    assert.match(posts[0].content, /\*\*Schedule stopped:\*\* watch ended/);
    const hintAt = posts[0].content.indexOf("see the report linked above and any files it references");
    const noteAt = posts[0].content.indexOf("**Schedule stopped:** watch ended");
    assert.ok(hintAt >= 0, "model post carries the read hint");
    assert.ok(noteAt > hintAt, "schedule note follows the read hint");
    assert.doesNotMatch(entries[0], /see the report linked above and any files it references/);
  });

  it("a result captured before a non-zero exit is inlined with the read hint", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(request("late"), workspace, sessionId, undefined, noop, fakeUI);
    await waitFor(() => posts.length > 0);
    assert.match(posts[0].content, /Pi minion failed \(exit 4\)/);
    assert.match(posts[0].content, /\*\*Note:\*\* a result was captured before the failure/);
    assert.match(posts[0].content, /first/);
    assert.match(posts[0].content, /see the report linked above and any files it references/);
    assert.equal(readFileSync(join(JOB_ROOT, id, "result.md"), "utf8"), "first\nsecond\nthird");
  });

  it("short result: the display entry omits the read hint while the model post carries it", async () => {
    const { sessionId, posts, entries } = newSession();
    await startJob(request("ok"), workspace, sessionId, undefined, noop, fakeUI);
    await waitFor(() => posts.length > 0);
    assert.doesNotMatch(entries[0], /see the report linked above and any files it references/);
    assert.match(posts[0].content, /see the report linked above and any files it references/);
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
      await startJob(request("argv"), workspace, sessionId, undefined, noop, fakeUI);
      await waitFor(() => posts.length > 0);
      assert.equal(readFileSync(join(home, "langprobe"), "utf8").trim().split("\n").at(-1), "LANG=unset");
      // env re-execs claude with claude as argv[0] (the shebang discards it),
      // so the captured $@ starts at claude's own first flag — the wrapper
      // chain delivered the command with no stray tokens before its flags.
      const argv = readFileSync(join(home, "argv.txt"), "utf8").trim().split("\n");
      assert.match(argv[0] ?? "", /^-/);
      // The task is no longer an argv entry: it is the first stdin frame.
      assert.match(readFileSync(join(home, "stdin.txt"), "utf8"), /MODE:argv/);
    } finally {
      process.env.LANG = prevLang;
      rmSync(override, { force: true });
    }
  });

  it("without preExec the adapter command is not injected as a stray argv entry", async () => {
    const { sessionId, posts } = newSession();
    await startJob(request("argv"), workspace, sessionId, undefined, noop, fakeUI);
    await waitFor(() => posts.length > 0);
    const argv = readFileSync(join(home, "argv.txt"), "utf8").trim().split("\n");
    // Regression: the default (empty preExec) spawn used to prepend
    // adapter.command, and claude read that stray "claude" positional as
    // the whole prompt ("Your message was just claude").
    assert.equal(argv.includes("claude"), false);
    assert.match(argv[0] ?? "", /^-/);
    assert.match(readFileSync(join(home, "stdin.txt"), "utf8"), /MODE:argv/);
  });

  it("pi spawns in rpc mode: the task is the first stdin frame and the channel stays open", async () => {
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    try {
      const { sessionId, posts } = newSession();
      const id = await startJob(
        { task: "Do a thing MODE:wait", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium" },
        workspace, sessionId, undefined, noop, fakeUI
      );
      // The fake child blocks on a second stdin line, so the job is provably
      // still running here and its channel is live.
      const job = jobs.get(id);
      assert.ok(job?.stdin, "a steering-capable job exposes its stdin handle");
      job.stdin.write(steerFrame("also say steered"));
      await waitFor(() => posts.length > 0);
      await waitFor(() => existsSync(join(home, "pi-eof.txt")));
      const argv = readFileSync(join(home, "pi-argv.txt"), "utf8").trim().split("\n");
      assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
      assert.ok(!argv.includes("Do a thing MODE:wait"), "the task is not in argv");
      const frames = readFileSync(join(home, "pi-stdin.txt"), "utf8").trim().split("\n");
      assert.equal(frames[0], promptFrame("Do a thing MODE:wait").trim());
      assert.equal(frames[1], steerFrame("also say steered").trim());
      assert.match(posts[0].content, /PI RPC ANSWER/);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("a steered job keeps running until runSettled and posts the post-steer result", async () => {
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    try {
      const { sessionId, posts } = newSession();
      const id = await startJob(
        { task: "Do a thing MODE:steered", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium" },
        workspace, sessionId, undefined, noop, fakeUI
      );
      const stdoutText = () =>
        existsSync(join(JOB_ROOT, id, "stdout.json")) ? readFileSync(join(JOB_ROOT, id, "stdout.json"), "utf8") : "";
      await waitFor(() => stdoutText().includes("FIRST DRAFT"));
      // The first answer already streamed, but the run has not settled: the
      // job must stay open (no post, still steerable) until it does.
      assert.equal(posts.length, 0, "a result line alone must not finalize the job");
      assert.equal(jobMeta.get(id)?.status, "running");
      await steerJob(id, sessionId, "check the edge case");
      await waitFor(() => posts.length > 0);
      assert.equal(jobMeta.get(id)?.status, "done");
      assert.match(posts[0].content, /STEERED FINAL/);
      assert.doesNotMatch(posts[0].content, /FIRST DRAFT/);
      const frames = readFileSync(join(home, "pi-stdin.txt"), "utf8").trim().split("\n");
      assert.equal(frames[1], steerFrame("check the edge case").trim());
      await waitFor(() => existsSync(join(home, "pi-eof.txt")));
      // Settled and cleaned up: the same job accepts no more steering.
      await assert.rejects(steerJob(id, sessionId, "too late"), /No running pi minion job/);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("claude takes the task as a stream-json user frame and gets stdin closed on completion", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(request("eof"), workspace, sessionId, undefined, noop, fakeUI);
    // MODE:eof reads stdin to EOF before exiting, so the job is still running.
    assert.ok(jobs.get(id)?.stdin, "claude exposes a stdin channel");
    await waitFor(() => posts.length > 0);
    await waitFor(() => existsSync(join(home, "eof.txt")));
    const argv = readFileSync(join(home, "argv.txt"), "utf8").trim().split("\n");
    assert.equal(argv[argv.indexOf("--input-format") + 1], "stream-json");
    assert.ok(!argv.includes("Do a thing MODE:eof"), "the task is not in argv");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "stdin.txt"), "utf8").trim()), {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Do a thing MODE:eof" }] },
      parent_tool_use_id: null
    });
    assert.match(posts[0].content, /STDIN CLOSED OK/);
  });

  it("maxTurns stops a cycling pi run: abort frame, cancelled status, cap note", async () => {
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    try {
      const { sessionId, posts } = newSession();
      const outcomes: Outcome[] = [];
      const id = await startJob(
        { task: "Do a thing MODE:turns", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium", maxTurns: 1 },
        workspace, sessionId, undefined, noop, fakeUI,
        undefined, (o) => outcomes.push(o), { title: "wf › capped", id: "capped", workflowId: "wf" }
      );
      await waitFor(() => outcomes.length > 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].ok, false);
      assert.match(outcomes[0].errorReason ?? "", /maxTurns=1 reached/);
      assert.equal(jobMeta.get(id)?.status, "cancelled");
      // Exactly one stop request went out, after the prompt frame.
      const frames = readFileSync(join(home, "pi-stdin.txt"), "utf8").trim().split("\n");
      assert.equal(frames[0], promptFrame("Do a thing MODE:turns").trim());
      assert.equal(frames[1], abortFrame().trim());
      assert.equal(frames.length, 2);
      assert.deepEqual(posts, []);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("maxTurns stops a cycling claude run with an interrupt control request", async () => {
    const { sessionId, posts } = newSession();
    const id = await startJob(
      { ...request("turns"), maxTurns: 1 }, workspace, sessionId, undefined, noop, fakeUI
    );
    await waitFor(() => posts.length > 0);
    assert.equal(jobMeta.get(id)?.status, "cancelled");
    assert.match(posts[0].content, /maxTurns=1 reached/);
    const frames = readFileSync(join(home, "stdin.txt"), "utf8").trim().split("\n");
    const interrupt = JSON.parse(frames[1]) as { type: string; subtype: string; request_id: string };
    assert.equal(interrupt.type, "control_request");
    assert.equal(interrupt.subtype, "interrupt");
    assert.equal(typeof interrupt.request_id, "string");
    assert.ok(interrupt.request_id.length > 0);
    assert.equal(frames.length, 2, "the cap wrote exactly one stop frame");
  });

  it("maxTurns interrupts claude's next turn at its message_start, before it can stream", async () => {
    // Regression (F1): turnStart used to fire on the consolidated assistant
    // message, i.e. when a turn had already finished, so with maxTurns=1 turn
    // two streamed in full before the cap counted it. The boundary is now the
    // message_start that opens the turn.
    const { sessionId, posts } = newSession();
    const id = await startJob({ ...request("streamturns"), maxTurns: 1 }, workspace, sessionId, undefined, noop, fakeUI);
    try {
      await waitFor(() => posts.length > 0, 5_000);
      assert.equal(jobMeta.get(id)?.status, "cancelled");
      assert.match(posts[0].content, /maxTurns=1 reached/);
      const frames = readFileSync(join(home, "stdin.txt"), "utf8").trim().split("\n");
      assert.equal(frames.length, 2, "exactly the prompt frame and one interrupt reached the child");
      assert.equal(frames[0], userMessageFrame("Do a thing MODE:streamturns").trim());
      assert.equal((JSON.parse(frames[1]) as { subtype?: string }).subtype, "interrupt");
      const stdout = readFileSync(join(JOB_ROOT, id, "stdout.json"), "utf8");
      const completions = stdout.split('"type":"assistant"').length - 1;
      assert.equal(completions, 1, "turn two never completed: the cap interrupted it first");
      assert.doesNotMatch(stdout, /"text":"turn two"/);
    } finally {
      stopJob(id);
    }
  });

  it("rejects a config-derived maxTurns on an adapter that reports no turn boundaries", async () => {
    // Regression (F2): the capability check only looked at request.maxTurns, so
    // a config default reached a CLI that counts no turns and was silently
    // unenforced.
    const config = { ...permissive(), maxTurns: 5 };
    setAdaptersForTest([createFakeAdapter(permissive())]);
    try {
      await assert.rejects(
        validateRequest({ task: "x", workspace, model: "fake-model", effort: "medium" }, workspace, config),
        /maxTurns is not supported for the fake-cli adapter/
      );
    } finally {
      setAdaptersForTest([createClaudeAdapter(permissive()), createPiAdapter(permissive()), createFakeAdapter(permissive())]);
    }
  });

  it("accepts the same config-derived cap on an adapter that emits turn boundaries", async () => {
    const noTurns = createFakeAdapter(permissive());
    const withTurns = { ...noTurns, capabilities: { ...noTurns.capabilities, emitsTurnEvents: true } };
    const config = { ...permissive(), maxTurns: 5 };
    setAdaptersForTest([withTurns]);
    try {
      const request = await validateRequest(
        { task: "x", workspace, model: "fake-model", effort: "medium" },
        workspace,
        config
      );
      assert.equal(request.maxTurns, undefined, "the cap comes from the config default, not the request");
    } finally {
      setAdaptersForTest([createClaudeAdapter(permissive()), createPiAdapter(permissive()), createFakeAdapter(permissive())]);
    }
  });

  it("omitting maxTurns leaves a multi-turn run uncapped and clean", async () => {
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    try {
      const { sessionId, posts } = newSession();
      const id = await startJob(
        { task: "Do a thing MODE:multi", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium" },
        workspace, sessionId, undefined, noop, fakeUI
      );
      await waitFor(() => posts.length > 0);
      assert.equal(jobMeta.get(id)?.status, "done");
      assert.match(posts[0].content, /MANY TURNS/);
      assert.doesNotMatch(posts[0].content, /maxTurns/);
      // All three turns reached the runner: nothing stopped the run early.
      const stdout = readFileSync(join(JOB_ROOT, id, "stdout.json"), "utf8");
      assert.equal(stdout.split('"turn_start"').length - 1, 3);
    } finally {
      setModelRegistry(undefined);
    }
  });

  it("config maxTurns is the default when the request omits one", async () => {
    const overrideDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "pi-minion.json");
    writeFileSync(override, JSON.stringify({ maxTurns: 1 }));
    try {
      const { sessionId, posts } = newSession();
      const id = await startJob(request("turns"), workspace, sessionId, undefined, noop, fakeUI);
      await waitFor(() => posts.length > 0);
      assert.equal(jobMeta.get(id)?.status, "cancelled");
      assert.match(posts[0].content, /maxTurns=1 reached/);
    } finally {
      rmSync(override, { force: true });
    }
  });

  it("a pinned no-cap request stays uncapped after config.maxTurns is set", async () => {
    // Regression (F5): a schedule that had no cap anywhere pinned it as
    // undefined, so a later config.maxTurns silently capped its runs.
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    const overrideDir = join(home, ".pi", "agent", "extensions");
    mkdirSync(overrideDir, { recursive: true });
    const override = join(overrideDir, "pi-minion.json");
    writeFileSync(override, JSON.stringify({ maxTurns: 1 }));
    try {
      const { sessionId, posts } = newSession();
      const id = await startJob(
        { task: "Do a thing MODE:multi", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium", maxTurns: null },
        workspace, sessionId, undefined, noop, fakeUI
      );
      await waitFor(() => posts.length > 0);
      assert.equal(jobMeta.get(id)?.status, "done");
      assert.doesNotMatch(posts[0].content, /maxTurns/);
      // A pinned number is just as final: config 1 must not win over 5.
      const { sessionId: session2, posts: posts2 } = newSession();
      const id2 = await startJob(
        { task: "Do a thing MODE:multi", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium", maxTurns: 5 },
        workspace, session2, undefined, noop, fakeUI
      );
      await waitFor(() => posts2.length > 0);
      assert.equal(jobMeta.get(id2)?.status, "done");
      assert.match(posts2[0].content, /MANY TURNS/);
    } finally {
      rmSync(override, { force: true });
      setModelRegistry(undefined);
    }
  });

  it("a failed pi turn still ends at agent_settled instead of waiting for another command", async () => {
    setModelRegistry(fakeModelRegistry([{ id: "crouton-alpha-free", provider: "opencode-go" }]));
    try {
      const { sessionId, posts } = newSession();
      const outcomes: Outcome[] = [];
      await startJob(
        { task: "Do a thing MODE:fail", workspace, model: "opencode-go/crouton-alpha-free", effort: "medium" },
        workspace, sessionId, undefined, noop, fakeUI,
        undefined, (o) => outcomes.push(o), { title: "wf › pi-fail", id: "pi-fail", workflowId: "wf" }
      );
      await waitFor(() => outcomes.length > 0);
      assert.equal(outcomes[0].ok, false);
      assert.match(outcomes[0].errorReason ?? "", /provider exploded/);
      assert.deepEqual(posts, []);
    } finally {
      setModelRegistry(undefined);
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
    // The failure message flows to the workflow step (its post is suppressed).
    assert.match(outcomes[0].errorReason ?? "", /Pi minion failed \(exit 3\)/);
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
        assert.match(outcomes[0].errorReason ?? "", /was not found on PATH/);
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
    assert.match(outcomes[0].errorReason ?? "", /exited without producing a result/);
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

  it("a run that outlives its timeoutMs settles not-ok and marks the job errored", async () => {
    const { sessionId } = newSession();
    const outcomes: Outcome[] = [];
    const id = await startJob(
      { ...request("slow"), timeoutMs: 200 }, workspace, sessionId, undefined, noop, fakeUI,
      undefined, (o) => outcomes.push(o), { title: "wf › slow-timeout", id: "slow-timeout", workflowId: "wf" }
    );
    await waitFor(() => outcomes.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].ok, false);
    assert.match(outcomes[0].errorReason ?? "", /timed out before finishing/);
    assert.equal(jobMeta.get(id)?.status, "errored");
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
    // The lifecycle log now lives in JOB_ROOT; directory pruning must skip it.
    const logFile = join(JOB_ROOT, "pi-minion.log");
    writeFileSync(logFile, "status=started job_id=probe model=x\n");
    utimesSync(join(JOB_ROOT, id), old, old);
    await pruneOldJobs(1);
    assert.ok(!existsSync(join(JOB_ROOT, id)), "job dir pruned");
    assert.ok(existsSync(logFile), "plain file in JOB_ROOT survives pruning");
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
