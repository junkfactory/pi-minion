import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { buildArgs, createClaudeAdapter } from "../src/adapters/claude.js";
import { MINION_OPERATIONAL_TAIL, MINION_PROMPT_BASE } from "../src/adapters/util.js";
import {
  AGENT_DIR,
  listAgents,
  resolveAgent,
  type AgentLog
} from "../src/agents.js";
import { validateRequest } from "../src/job-runner.js";
import { pinScheduleRequest } from "../src/tools.js";
import { createFakeAdapter, fakeConfig, fakeRequest } from "./fakes.js";

type Logged = { event: string; id: string; model: string; detail?: string };

// Each case gets its own temp dir standing in for AGENT_DIR plus a collecting
// logger, so nothing touches the user's real agent files or log.
async function withAgents(
  files: Record<string, string>,
  run: (dir: string, logs: Logged[], log: AgentLog) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-minion-agents-"));
  const logs: Logged[] = [];
  const log: AgentLog = (event, info) => logs.push({ event, ...info });
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf8");
    }
    await run(dir, logs, log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REVIEW = `---
description: Reviews changes for correctness and security
model: qwen-flash
effort: high
tools: [Bash, Glob, Grep]
maxTurns: 100
maxBudgetUsd: 2
timeoutMs: 600000
reviewed: true
---
You are a code review specialist.
Report findings as a list.
`;

const MINIMAL = `---
description: Prompt-only agent
---
Do the thing.
`;

describe("AGENT_DIR", () => {
  it("points at the pi-minion agent directory under the user's pi home", () => {
    assert.equal(AGENT_DIR, join(homedir(), ".pi", "agent", "pi-minion", "agents"));
  });
});

describe("listAgents", () => {
  it("returns name and description only, sorted, for valid .md files", async () => {
    await withAgents({ "zebra.md": MINIMAL, "review.md": REVIEW }, async (dir, _logs, log) => {
      assert.deepEqual(await listAgents(dir, log), [
        { name: "review", description: "Reviews changes for correctness and security" },
        { name: "zebra", description: "Prompt-only agent" }
      ]);
    });
  });

  it("returns an empty list (no error) when the directory is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-agents-"));
    try {
      assert.deepEqual(await listAgents(join(dir, "missing")), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rescans on every call — a new file is picked up with no cache", async () => {
    await withAgents({}, async (dir, _logs, log) => {
      assert.deepEqual(await listAgents(dir, log), []);
      await writeFile(join(dir, "fresh.md"), MINIMAL, "utf8");
      assert.deepEqual(await listAgents(dir, log), [{ name: "fresh", description: "Prompt-only agent" }]);
    });
  });

  it("skips and warns a non-.md file", async () => {
    await withAgents({ "README.md.bak": REVIEW, "notes.txt": MINIMAL }, async (dir, logs, log) => {
      assert.deepEqual(await listAgents(dir, log), []);
      assert.equal(logs.length, 2);
      assert.equal(logs[0].event, "agent_invalid");
      assert.equal(logs[0].id, "README.md.bak");
      assert.match(logs[0].detail ?? "", /\.md/);
      assert.equal(logs[1].id, "notes.txt");
    });
  });

  it("skips dotfiles silently — editor swap files are not agent mistakes", async () => {
    await withAgents(
      { ".notes.md.swp": REVIEW, ".gitkeep": "", "fresh.md": MINIMAL },
      async (dir, logs, log) => {
        assert.deepEqual(await listAgents(dir, log), [
          { name: "fresh", description: "Prompt-only agent" }
        ]);
        assert.equal(logs.length, 0);
      }
    );
  });

  it("skips and warns a non-kebab-case file name", async () => {
    await withAgents({ "Bad_Name.md": REVIEW }, async (dir, logs, log) => {
      assert.deepEqual(await listAgents(dir, log), []);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, "agent_invalid");
      assert.equal(logs[0].id, "Bad_Name.md");
      assert.match(logs[0].detail ?? "", /kebab-case/);
    });
  });
});

describe("resolveAgent", () => {
  it("resolves a fully specified file with every optional field typed", async () => {
    await withAgents({ "review.md": REVIEW }, async (dir, _logs, log) => {
      assert.deepEqual(await resolveAgent("review", dir, log), {
        name: "review",
        description: "Reviews changes for correctness and security",
        model: "qwen-flash",
        effort: "high",
        tools: ["Bash", "Glob", "Grep"],
        maxTurns: 100,
        maxBudgetUsd: 2,
        timeoutMs: 600000,
        body: "You are a code review specialist.\nReport findings as a list."
      });
    });
  });

  it("leaves absent optional fields undefined and accepts a body-only prompt", async () => {
    await withAgents({ "minimal.md": MINIMAL }, async (dir, _logs, log) => {
      const agent = await resolveAgent("minimal", dir, log);
      assert.deepEqual(agent, {
        name: "minimal",
        description: "Prompt-only agent",
        model: undefined,
        effort: undefined,
        tools: undefined,
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        timeoutMs: undefined,
        body: "Do the thing."
      });
    });
  });

  it("normalizes a comma-separated tools string to a trimmed string array", async () => {
    await withAgents(
      { "t.md": "---\ndescription: d\ntools: Bash, Glob ,  Grep\n---\nbody\n" },
      async (dir, _logs, log) => {
        assert.deepEqual((await resolveAgent("t", dir, log)).tools, ["Bash", "Glob", "Grep"]);
      }
    );
  });

  it("throws with the available names for an unknown agent", async () => {
    await withAgents({ "alpha.md": MINIMAL, "beta.md": MINIMAL }, async (dir, _logs, log) => {
      await assert.rejects(resolveAgent("gamma", dir, log), (error: Error) => {
        assert.match(error.message, /Unknown agent "gamma"/);
        assert.match(error.message, /Available agents: alpha, beta\./);
        assert.match(error.message, /help_pi_minion/);
        return true;
      });
    });
  });

  it("treats an invalid file as unknown while still logging why it was skipped", async () => {
    await withAgents(
      { "good.md": MINIMAL, "broken.md": "---\nmodel: x\n---\nbody\n" },
      async (dir, logs, log) => {
        await assert.rejects(resolveAgent("broken", dir, log), /Unknown agent "broken"/);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "agent_invalid");
        assert.equal(logs[0].id, "broken.md");
        assert.match(logs[0].detail ?? "", /description/);
      }
    );
  });

  it("reports no-available-agents when the directory is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-agents-"));
    try {
      await assert.rejects(resolveAgent("x", join(dir, "missing")), (error: Error) => {
        assert.match(error.message, /Unknown agent "x"/);
        assert.match(error.message, /No agent files are defined/);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// End to end: a written agent file is resolved by the real request validator
// and lands in a real adapter's argv — the seams steps 1-4 built, exercised
// together rather than one unit at a time.
describe("agent flow (end to end)", () => {
  const BODY = "You are a code review specialist.\nReport real bugs, not style nits.";
  const FILE = `---
description: Reviews changes for correctness and security
model: sonnet
effort: high
tools: [Bash, Read]
---
${BODY}
`;
  // config.allowedTools is deliberately wider than the agent's list, so the
  // argv assertion proves the narrowing happened.
  const config = fakeConfig({ allowedTools: ["Bash", "Read", "Grep"] });

  // A non-claude model: only claude consumes `tools`, so this path is where
  // the ignored-tools log line (and its dedupe) is observable.
  const fakeModelConfig = fakeConfig({
    models: { allowed: ["sonnet", "opus", "fake-model"], blocked: [] },
    allowedTools: ["Bash", "Read", "Grep"]
  });
  const NON_CLAUDE = `---
description: Runs on a non-claude adapter
model: fake-model
effort: high
tools: [Bash]
---
${BODY}
`;

  // Pin a fake adapter so ensureRegistry never discovers the machine's CLIs.
  // Its config owns fake-model too, so the non-claude path resolves; the real
  // claude adapter owns sonnet, so the argv/narrowing path resolves too.
  before(() => setAdaptersForTest([createFakeAdapter(fakeModelConfig), createClaudeAdapter(fakeModelConfig)]));
  after(() => setAdaptersForTest());

  // The temp dir doubles as the workspace: validateRequest requires
  // workspace === cwd, and the agent dir is injected positionally.
  it("turns a file into a validated request whose argv carries its model, prompt, and tools", async () => {
    await withAgents({ "code-review.md": FILE }, async (dir) => {
      const request = await validateRequest(
        fakeRequest({ workspace: dir, agent: "code-review", model: "", effort: "" }),
        dir,
        config,
        dir
      );
      const args = buildArgs(request, config);
      assert.equal(args[args.indexOf("--model") + 1], "sonnet");
      assert.equal(args[args.indexOf("--effort") + 1], "high");
      assert.equal(
        args[args.indexOf("--append-system-prompt") + 1],
        `${BODY}\n\n${MINION_OPERATIONAL_TAIL}`
      );
      assert.deepEqual(
        args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 3),
        ["--allowedTools", "Bash", "Read"]
      );
      assert.ok(!args.includes(MINION_PROMPT_BASE), "the generic prompt is replaced, not appended");
    });
  });

  it("replays a captured schedule request through the tick's re-validation", async () => {
    await withAgents({ "code-review.md": FILE }, async (dir) => {
      // The handler stores the merged request for display/logs and the raw
      // pre-merge one for ticks (tools.ts schedules.set): the raw capture is
      // what makes frontmatter model/effort/limit edits reach the next run.
      const raw = fakeRequest({ workspace: dir, agent: "code-review", model: "", effort: "" });
      const captured = pinScheduleRequest(
        await validateRequest(raw, dir, config, dir),
        { timeoutMs: 60_000, maxTurns: 3 }
      );
      assert.equal(captured.agent, "code-review");
      // Ticks replay the raw request (startJob re-validates it), so a file
      // edit between ticks — prompt, model, or limits — reaches the next run.
      await writeFile(
        join(dir, "code-review.md"),
        FILE.replace("Report real bugs", "Report only real bugs").replace("model: sonnet", "model: opus")
      );
      const tick = await validateRequest({ ...raw, task: `${raw.task}\n\nreplayed` }, dir, config, dir);
      assert.equal(tick.agent, "code-review");
      assert.equal(tick.model, "opus");
      assert.match(tick.systemPrompt ?? "", /Report only real bugs/);
      assert.ok(tick.systemPrompt?.endsWith(MINION_OPERATIONAL_TAIL));
      assert.equal(buildArgs(tick, config)[buildArgs(tick, config).indexOf("--model") + 1], "opus");
    });
  });

  it("applies the agent once per run, so a re-validated merged request logs agent_tools_ignored only once", async () => {
    await withAgents({ "fake-tools.md": NON_CLAUDE }, async (dir, logs, log) => {
      const raw = fakeRequest({ workspace: dir, agent: "fake-tools", model: "", effort: "" });
      const merged = await validateRequest(raw, dir, fakeModelConfig, dir, log);
      assert.deepEqual(
        logs.map((entry) => entry.event),
        ["agent_tools_ignored"]
      );
      // run_pi_minion validates first, then hands the merged request to
      // startJob, which re-validates: that second pass must not merge again.
      const again = await validateRequest(merged, dir, fakeModelConfig, dir, log);
      assert.equal(logs.length, 1);
      assert.equal(again.agent, "fake-tools");
      assert.equal(again.model, "fake-model");
      assert.equal(again.systemPrompt, merged.systemPrompt);
    });
  });

  it("reports an invalid agent file through the injected log seam, not the real log", async () => {
    await withAgents(
      { "broken.md": "---\nmodel: sonnet\n---\nbody\n" },
      async (dir, logs, log) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace: dir, agent: "broken" }), dir, config, dir, log),
          /Unknown agent "broken"/
        );
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "agent_invalid");
        assert.equal(logs[0].id, "broken.md");
      }
    );
  });

  it("fails instructively when the agent defines no model and the caller names none", async () => {
    await withAgents({ "prompt-only.md": MINIMAL }, async (dir) => {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, agent: "prompt-only", model: "" }),
          dir,
          config,
          dir
        ),
        /agent 'prompt-only' defines no model — pass `model` explicitly/
      );
    });
  });

  it("rejects an agent whose tools intersect config.allowedTools to nothing", async () => {
    await withAgents(
      { "locked.md": "---\ndescription: Locked down\nmodel: sonnet\ntools: [WebFetch]\n---\nbody\n" },
      async (dir) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace: dir, agent: "locked" }), dir, config, dir),
          /none of which config\.allowedTools permits/
        );
      }
    );
  });

  it("lets the model gate win over a tools error for a blocked model", async () => {
    // Narrowing runs after the model gates, so a gated model fails with the
    // model error even when its tools list would also have failed.
    const blockedConfig = fakeConfig({
      models: { allowed: [], blocked: ["ghost*"] },
      allowedTools: ["Bash", "Read", "Grep"]
    });
    await withAgents(
      { "locked.md": "---\ndescription: Locked down\nmodel: ghost\ntools: [WebFetch]\n---\nbody\n" },
      async (dir) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace: dir, agent: "locked", model: "" }),
            dir,
            blockedConfig,
            dir
          ),
          /Model is blocked: ghost/
        );
      }
    );
  });
});

describe("invalid agent files", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["missing description", "---\nmodel: sonnet\n---\nbody\n", /description/],
    ["blank description", "---\ndescription: '   '\n---\nbody\n", /description/],
    ["non-string description", "---\ndescription: 42\n---\nbody\n", /description/],
    ["empty body", "---\ndescription: d\n---\n\n   \n", /empty body/],
    ["missing frontmatter", "# Just notes\n", /frontmatter/],
    ["non-mapping frontmatter", "---\n- a\n- b\n---\nbody\n", /mapping/],
    ["malformed YAML", "---\ndescription: [unclosed\n---\nbody\n", /YAML/],
    ["numeric model", "---\ndescription: d\nmodel: 5\n---\nbody\n", /model/],
    ["blank effort", "---\ndescription: d\neffort: ''\n---\nbody\n", /effort/],
    ["tools with a non-string entry", "---\ndescription: d\ntools: [Bash, 5]\n---\nbody\n", /tools/],
    ["fractional maxTurns", "---\ndescription: d\nmaxTurns: 2.5\n---\nbody\n", /maxTurns/],
    ["maxTurns above the cap", "---\ndescription: d\nmaxTurns: 100001\n---\nbody\n", /maxTurns/],
    ["non-positive maxBudgetUsd", "---\ndescription: d\nmaxBudgetUsd: 0\n---\nbody\n", /maxBudgetUsd/],
    ["string maxBudgetUsd", "---\ndescription: d\nmaxBudgetUsd: '2'\n---\nbody\n", /maxBudgetUsd/],
    ["timeoutMs above Node's setTimeout limit", "---\ndescription: d\ntimeoutMs: 2147483648\n---\nbody\n", /timeoutMs/],
    ["negative timeoutMs", "---\ndescription: d\ntimeoutMs: -1\n---\nbody\n", /timeoutMs/]
  ];

  for (const [label, content, reason] of cases) {
    it(`skips and warns: ${label}`, async () => {
      await withAgents({ "agent.md": content }, async (dir, logs, log) => {
        assert.deepEqual(await listAgents(dir, log), []);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].event, "agent_invalid");
        assert.equal(logs[0].id, "agent.md");
        assert.match(logs[0].detail ?? "", reason);
      });
    });
  }
});
