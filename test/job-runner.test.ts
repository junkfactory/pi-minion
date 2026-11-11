import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAdaptersForTest } from "../src/adapters/registry.js";
import { createClaudeAdapter } from "../src/adapters/claude.js";
import { MINION_OPERATIONAL_TAIL, MINION_PROMPT_BASE } from "../src/adapters/util.js";
import { validateRequest } from "../src/job-runner.js";
import { createFakeAdapter, fakeConfig, fakeRequest } from "./fakes.js";

describe("validateRequest", () => {
  // Pin a config-bound fake so ensureRegistry no-ops: no machine-CLI discovery
  // mid-suite, and providersOfModel() can't depend on what's installed here.
  before(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));
  after(() => setAdaptersForTest());

  it("rejects a workspace that doesn't match cwd", async () => {
    await assert.rejects(
      validateRequest(fakeRequest({ workspace: "/tmp/a" }), "/tmp/b", fakeConfig()),
      /must be the current Pi workspace/
    );
  });

  it("rejects a workspace that isn't a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    try {
      await assert.rejects(validateRequest(fakeRequest({ workspace: file }), file, fakeConfig()), /not a directory/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a model-less request with no agent instructively", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, model: "" }), dir, fakeConfig()),
        /model is required unless `agent` supplies one/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a model outside models.allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, model: "not-allowed" }), dir, fakeConfig()),
        /Model is not allowed/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a blocked model with the models.blocked message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, model: "gemini-pro" }),
          dir,
          fakeConfig({ models: { blocked: ["gemini*"] } })
        ),
        /Model is blocked:/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("distinguishes an allowlist miss from a blocked model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({ workspace: dir, model: "gemini-pro" }),
          dir,
          fakeConfig({ models: { allowed: ["sonnet"], blocked: [] } })
        ),
        /Model is not allowed:/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("allows any model when models.allowed is empty (allow-all default)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await validateRequest(
        fakeRequest({ workspace: dir, model: "any-catalog-id" }),
        dir,
        fakeConfig({ models: { allowed: [] } })
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a non-positive maxBudgetUsd override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: 0 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: -5 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects an empty task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, task: "   " }), dir, fakeConfig()),
        /task is required/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a missing effort with a hint that tells the agent how to pick one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, effort: undefined }), dir, fakeConfig()),
        /effort is required.*low.*medium.*high/s
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("resolves the workspace to an absolute path on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(fakeRequest({ workspace: dir }), dir, fakeConfig());
      assert.equal(result.workspace, dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects context that combines the \"no prior context\" escape hatch with other details", async () => {
    // Regression: an orchestrator once submitted a follow-up job whose
    // context opened with "No prior context for this run, but this is a
    // follow-up to..." — self-contradictory, and a sign the real context was
    // reconstructed from memory rather than restated from the prior job.
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({
            workspace: dir,
            context:
              "No prior context for this run, but this is a follow-up to a previous read-only Sonnet review of Nomad MR !133."
          }),
          dir,
          fakeConfig()
        ),
        /combines "no prior context" with other details/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts the bare \"No prior context.\" escape hatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({ workspace: dir, context: "No prior context." }),
        dir,
        fakeConfig()
      );
      assert.equal(result.context, "No prior context.");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts genuine follow-up context that doesn't use the escape-hatch phrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({
          workspace: dir,
          context: "Prior review of MR !133 found no issues; verify the Cognito teardown fix landed at HEAD."
        }),
        dir,
        fakeConfig()
      );
      assert.match(result.context ?? "", /Cognito teardown/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("validateRequest agent requests", () => {
  before(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));
  after(() => setAdaptersForTest());

  const BODY = "You are a code review specialist. Find real bugs, not style nits.";
  const agentFile = (frontmatter: string, body = BODY) => `---\n${frontmatter}\n---\n\n${body}\n`;

  // One temp root per test: `<root>/agents` is the agent dir, and `<root>`
  // itself is the workspace (validateRequest requires workspace === cwd).
  async function withAgentDir(
    files: Record<string, string>,
    run: (dirs: { workspace: string; agents: string }) => Promise<void>
  ): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const agents = join(workspace, "agents");
      await mkdir(agents);
      for (const [name, raw] of Object.entries(files)) await writeFile(join(agents, name), raw);
      await run({ workspace, agents });
    } finally {
      await rm(workspace, { recursive: true });
    }
  }

  it("lets explicit request values beat frontmatter defaults", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\nmodel: opus\neffort: high") },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "reviewer", model: "sonnet", effort: "medium" }),
          workspace,
          fakeConfig(),
          agents
        );
        assert.equal(result.model, "sonnet");
        assert.equal(result.effort, "medium");
      }
    );
  });

  it("fills the gaps the request leaves from frontmatter, ahead of config defaults", async () => {
    await withAgentDir(
      {
        "reviewer.md": agentFile(
          "description: Reviews changes\nmodel: opus\neffort: high\nmaxTurns: 5\nmaxBudgetUsd: 2\ntimeoutMs: 60000"
        )
      },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "reviewer", model: "", effort: "" }),
          workspace,
          fakeConfig({ maxTurns: 400 }),
          agents
        );
        assert.equal(result.agent, "reviewer");
        assert.equal(result.model, "opus");
        assert.equal(result.effort, "high");
        assert.equal(result.maxTurns, 5); // frontmatter beats config.maxTurns 400
        assert.equal(result.maxBudgetUsd, 2);
        assert.equal(result.timeoutMs, 60_000);
      }
    );
  });

  it("keeps a pinned no-cap maxTurns over the agent's default", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\nmodel: opus\nmaxTurns: 5") },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "reviewer", model: "" , effort: "medium", maxTurns: null }),
          workspace,
          fakeConfig(),
          agents
        );
        assert.equal(result.maxTurns, null);
      }
    );
  });

  it("composes the agent body with the operational tail, without the generic identity line", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\nmodel: sonnet") },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "reviewer", effort: "medium" }),
          workspace,
          fakeConfig(),
          agents
        );
        assert.equal(result.systemPrompt, `${BODY}\n\n${MINION_OPERATIONAL_TAIL}`);
        assert.ok(result.systemPrompt.startsWith(BODY));
        assert.ok(!result.systemPrompt.includes("You are an independent pi minion"));
        // The tail is exactly the shared prompt minus that identity line.
        assert.ok(MINION_PROMPT_BASE.endsWith(MINION_OPERATIONAL_TAIL));
      }
    );
  });

  it("names the agent when the merged model is empty", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Prompt-only agent") },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "reviewer", model: "" }),
            workspace,
            fakeConfig(),
            agents
          ),
          /agent 'reviewer' defines no model — pass `model` explicitly/
        );
      }
    );
  });

  it("names the agent when the merged effort is empty", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\nmodel: sonnet") },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "reviewer", effort: "" }),
            workspace,
            fakeConfig(),
            agents
          ),
          /agent 'reviewer' defines no effort/
        );
      }
    );
  });

  it("rejects an unknown agent with the available names", async () => {
    await withAgentDir(
      {
        "reviewer.md": agentFile("description: Reviews changes\nmodel: sonnet"),
        "researcher.md": agentFile("description: Researches\nmodel: sonnet")
      },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace, agent: "nope" }), workspace, fakeConfig(), agents),
          /Unknown agent "nope"\. Available agents: researcher, reviewer\./
        );
      }
    );
  });

  it("treats a blank agent as absent", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\nmodel: opus") },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "   " }),
          workspace,
          fakeConfig(),
          agents
        );
        assert.equal(result.agent, undefined);
        assert.equal(result.systemPrompt, undefined);
        assert.equal(result.allowedTools, undefined);
        assert.equal(result.model, "sonnet");
      }
    );
  });

  it("narrows frontmatter tools to config.allowedTools", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\ntools: [Bash, Grep, Read]") },
      async ({ workspace, agents }) => {
        const result = await validateRequest(
          fakeRequest({ workspace, agent: "reviewer" }),
          workspace,
          fakeConfig({ allowedTools: ["Bash", "Read"] }),
          agents
        );
        assert.deepEqual(result.allowedTools, ["Bash", "Read"]);
      }
    );
  });

  it("rejects frontmatter tools that config.allowedTools leaves empty", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\ntools: [Grep]") },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "reviewer" }),
            workspace,
            fakeConfig({ allowedTools: ["Read"] }),
            agents
          ),
          /none of which config.allowedTools permits/
        );
      }
    );
  });

  it("rejects an agent that lists no tools at all", async () => {
    await withAgentDir(
      { "reviewer.md": agentFile("description: Reviews changes\ntools: []") },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(fakeRequest({ workspace, agent: "reviewer" }), workspace, fakeConfig(), agents),
          /lists no tools/
        );
      }
    );
  });

  it("keeps the agent's own tools when config.allowedTools pins nothing, and inherits config when the agent omits tools", async () => {
    await withAgentDir(
      {
        "scoped.md": agentFile("description: Scoped\ntools: [Bash, Grep]"),
        "plain.md": agentFile("description: Plain")
      },
      async ({ workspace, agents }) => {
        const scoped = await validateRequest(
          fakeRequest({ workspace, agent: "scoped" }),
          workspace,
          fakeConfig({ allowedTools: [] }),
          agents
        );
        assert.deepEqual(scoped.allowedTools, ["Bash", "Grep"]);
        const plain = await validateRequest(
          fakeRequest({ workspace, agent: "plain" }),
          workspace,
          fakeConfig({ allowedTools: ["Bash"] }),
          agents
        );
        assert.equal(plain.allowedTools, undefined);
      }
    );
  });

  // Tools narrowing is claude-only: the fake adapter's command is not
  // "claude", so a request it owns (fake-model) must skip narrowing and log.
  it("ignores frontmatter tools for a known non-claude adapter and logs why", async () => {
    // Re-pin the fake bound to a config that owns fake-model, so resolution
    // lands on a KNOWN non-claude adapter rather than the conservative
    // unknown-model path.
    setAdaptersForTest([
      createFakeAdapter(fakeConfig({ models: { allowed: ["fake-model"], blocked: [] } }))
    ]);
    try {
      await withAgentDir(
        {
          "reviewer.md": agentFile(
            "description: Reviews changes\nmodel: fake-model\ntools: [bash, read]"
          )
        },
        async ({ workspace, agents }) => {
          const logs: Array<{ event: string; id: string; model: string; detail?: string }> = [];
          const result = await validateRequest(
            fakeRequest({ workspace, agent: "reviewer", model: "" }),
            workspace,
            fakeConfig({
              models: { allowed: ["fake-model"], blocked: [] },
              allowedTools: ["Bash", "Read"]
            }),
            agents,
            (event, info) => logs.push({ event, ...info })
          );
          assert.equal(result.allowedTools, undefined);
          assert.equal(logs.length, 1);
          assert.equal(logs[0].event, "agent_tools_ignored");
          assert.equal(logs[0].id, "reviewer");
          assert.match(logs[0].detail ?? "", /agent=reviewer/);
          assert.match(logs[0].detail ?? "", /adapter=fake-cli/);
          assert.match(logs[0].detail ?? "", /claude only/);
        }
      );
    } finally {
      setAdaptersForTest([createFakeAdapter(fakeConfig())]);
    }
  });

  // The claude path is unchanged: with a real claude adapter pinned, sonnet
  // resolves to it, so narrowing (and its empty-intersection reject) still runs.
  describe("claude adapter", () => {
    before(() =>
      setAdaptersForTest([createFakeAdapter(fakeConfig()), createClaudeAdapter(fakeConfig())])
    );
    after(() => setAdaptersForTest([createFakeAdapter(fakeConfig())]));

    it("still narrows frontmatter tools to config.allowedTools", async () => {
      await withAgentDir(
        { "reviewer.md": agentFile("description: Reviews changes\nmodel: sonnet\ntools: [Bash, Grep, Read]") },
        async ({ workspace, agents }) => {
          const logs: Array<{ event: string }> = [];
          const result = await validateRequest(
            fakeRequest({ workspace, agent: "reviewer" }),
            workspace,
            fakeConfig({ allowedTools: ["Bash", "Read"] }),
            agents,
            (event) => logs.push({ event })
          );
          assert.deepEqual(result.allowedTools, ["Bash", "Read"]);
          assert.equal(logs.length, 0);
        }
      );
    });

    it("still rejects an empty intersection", async () => {
      await withAgentDir(
        { "locked.md": agentFile("description: Locked\nmodel: sonnet\ntools: [WebFetch]") },
        async ({ workspace, agents }) => {
          await assert.rejects(
            validateRequest(
              fakeRequest({ workspace, agent: "locked" }),
              workspace,
              fakeConfig({ allowedTools: ["Read"] }),
              agents
            ),
            /none of which config\.allowedTools permits/
          );
        }
      );
    });
  });

  it("gates the merged model: frontmatter cannot launder a blocked or unlisted model", async () => {
    await withAgentDir(
      {
        "blocked.md": agentFile("description: Blocked model\nmodel: opus"),
        "unlisted.md": agentFile("description: Unlisted model\nmodel: other-model"),
        "fake.md": agentFile("description: Fake provider model\nmodel: fake-model")
      },
      async ({ workspace, agents }) => {
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "blocked", model: "" }),
            workspace,
            fakeConfig({ models: { allowed: [], blocked: ["opus"] } }),
            agents
          ),
          /Model is blocked: opus/
        );
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "unlisted", model: "" }),
            workspace,
            fakeConfig(),
            agents
          ),
          /Model is not allowed: other-model/
        );
        await assert.rejects(
          validateRequest(
            fakeRequest({ workspace, agent: "fake", model: "" }),
            workspace,
            fakeConfig({ providers: { allowed: [], blocked: ["fakeprovider"] } }),
            agents
          ),
          /excluded by the providers config/
        );
      }
    );
  });
});
