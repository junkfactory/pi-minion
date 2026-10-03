import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  confirmWorkflow,
  createJobUI,
  renderWorkflowConfirmBody,
  renderWorkflowConfirmLines,
  type WorkflowConfirm,
  type WorkflowConfirmResult,
  type JobStatusUpdate, type WorkflowWidgetStatus } from "../src/agent.ui.js";
import { fakeCtx, fakeTheme, fakeTui, type WidgetFactory } from "./fakes.js";

function job(overrides: Partial<JobStatusUpdate> = {}): JobStatusUpdate {
  return {
    title: "Explore the repo",
    model: "sonnet",
    effort: "medium",
    startedAt: Date.now(),
    previewLine: "Reading files...",
    ...overrides
  };
}

describe("widget", () => {
  it("renders a header + activity line per running job", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ startedAt: Date.now() - 5000 }));

    assert.ok(state.widgetFactory, "setJob should register the widget");
    const component = state.widgetFactory!(fakeTui(), fakeTheme());
    const [root, ...lines] = component.render(80);

    assert.match(root!, /^π minions · 1 job$/);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Explore the repo/);
    assert.match(lines[0], /\(sonnet\/medium\)/);
    assert.match(lines[0], /5s/);
    assert.match(lines[1], /Reading files/);
  });

  it("omits the token usage segment until a message_delta has been observed", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job());

    const component = state.widgetFactory!(fakeTui(), fakeTheme());
    const [, ...lines] = component.render(80);

    assert.ok(!/[↑↓→←]/.test(lines[0]!), `expected no token usage arrows, got: ${lines[0]}`);
  });

  it("renders the input/output/cache-write/cache-read token breakdown once present", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob(
      "job1",
      job({
        tokenUsage: { input: 9600, output: 800, cacheWrite: 116_000, cacheRead: 1_331_500 }
      })
    );

    const component = state.widgetFactory!(fakeTui(), fakeTheme());
    const [, ...lines] = component.render(80);

    assert.match(lines[0]!, /↑9\.6K ↓0\.8K →116\.0K ←1331\.5K/);
  });

  it("caps output at maxWidgetLines and adds an overflow summary row", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any, { maxWidgetLines: 12 });
    for (let i = 1; i <= 10; i++) {
      jobUI.setJob(`job${i}`, job({ title: `Task ${i}` }));
    }
    const component = state.widgetFactory!(fakeTui(), fakeTheme());
    const lines = component.render(80);

    assert.ok(lines.length <= 12, `expected <=12 lines, got ${lines.length}`);
    assert.ok(lines.some((l) => /more running/.test(l)), "expected an overflow summary row");
  });

  it("removes the widget once the last job clears", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job());
    jobUI.clearJob("job1");

    assert.equal(state.widgetRemoved, true);
  });

  it("recovers from a stale ctx (e.g. post-reload) once setCtx() supplies a working one", () => {
    const { ctx, state } = fakeCtx();
    let shouldThrow = true;
    const realSetWidget = ctx.ui.setWidget;
    ctx.ui.setWidget = ((key: string, content: WidgetFactory | undefined) => {
      if (shouldThrow) throw new Error("ctx is stale after session replacement or reload");
      return realSetWidget(key, content);
    }) as typeof realSetWidget;
    const jobUI = createJobUI(ctx as any);

    jobUI.setJob("job1", job());
    assert.equal(
      state.widgetFactory,
      undefined,
      "a stale-ctx registration attempt must not throw out of setJob, and must leave the guard unset"
    );

    shouldThrow = false;
    jobUI.setCtx(ctx as any);

    assert.ok(
      state.widgetFactory,
      "setCtx should re-register the widget immediately once ctx.ui.setWidget stops throwing"
    );
  });

  it("truncates each rendered line to the given visible width", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ title: "A".repeat(200), previewLine: "B".repeat(200) }));
    const component = state.widgetFactory!(fakeTui(), fakeTheme());
    const lines = component.render(40);

    // truncateToWidth appends a trailing ANSI reset even on plain text, so
    // raw .length isn't the right check — visibleWidth() strips it first.
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 40, `line exceeded width 40: ${visibleWidth(line)}`);
    }
  });
});

describe("workflow widget", () => {
  function workflow(overrides: Partial<WorkflowWidgetStatus> = {}): WorkflowWidgetStatus {
    return {
      title: "Review MR",
      startedAt: Date.now() - 3000,
      stage: 2,
      stages: 2,
      steps: [
        { id: "bugs", status: "done", model: "sonnet", effort: "medium" },
        { id: "perf", status: "failed", model: "sonnet", effort: "medium" },
        { id: "verify", status: "running", model: "luna", effort: "low", jobId: "job1" },
        { id: "report", status: "pending", model: "luna", effort: "low" },
        { id: "extra", status: "skipped", model: "luna", effort: "low" }
      ],
      ...overrides
    };
  }

  it("nests steps under a workflow header and renders the running step's live row there", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ title: "Verify", model: "luna", previewLine: "Reading auth.ts" }));
    jobUI.setJob("job2", job({ title: "Explore codebase" }));
    jobUI.setWorkflow("wf", workflow());

    const [root, ...lines] = state.widgetFactory!(fakeTui(), fakeTheme()).render(100);

    // The claimed step job isn't counted as a standalone job.
    assert.match(root!, /^π minions · 1 job · 1 workflow$/);
    assert.match(lines[0]!, /^├─ ⇉ Review MR · stage 2\/2 · 1\/5 done · 3s/);
    assert.match(lines[1]!, /^│ {2}├─ ✓ bugs \(sonnet\/medium\)/);
    assert.match(lines[2]!, /✗ perf/);
    assert.match(lines[3]!, /^│ {2}├─ \S+ verify \(luna\/low\).* · Reading auth\.ts/);
    assert.match(lines[4]!, /○ report/);
    assert.match(lines[5]!, /^│ {2}└─ – extra/);
    assert.match(lines[6]!, /^└─ \S+ Explore codebase/);
    assert.ok(!lines.some((l) => /Verify/.test(l)), "claimed job is not also a top-level row");
  });

  it("renders finished steps in the job-row format with frozen elapsed, and pending ones without elapsed", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const wf = workflow();
    wf.steps[0] = {
      ...wf.steps[0],
      startedAt: 1_000,
      finishedAt: 13_000,
      tokenUsage: { input: 1_000, output: 2_000, cacheWrite: 0, cacheRead: 0 }
    };
    jobUI.setWorkflow("wf", wf);

    const [, ...lines] = state.widgetFactory!(fakeTui(), fakeTheme()).render(120);

    assert.match(lines[1]!, /✓ bugs \(sonnet\/medium\) · \S+.* · 12s$/);
    assert.match(lines[1]!, /2\.0K/);
    assert.match(lines[4]!, /○ report \(luna\/low\)$/);
  });

  it("shows the running job's resolved model id on its row, with the step's effort", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ title: "Verify", model: "gpt-6-luna", effort: "medium" }));
    jobUI.setWorkflow("wf", workflow());

    const [, ...lines] = state.widgetFactory!(fakeTui(), fakeTheme()).render(100);

    assert.match(lines[3]!, /verify \(gpt-6-luna\/low\)/);
  });

  it("keeps the widget up until both jobs and workflows are cleared", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setWorkflow("wf", workflow());
    jobUI.setJob("job1", job());
    jobUI.clearJob("job1");
    assert.equal(state.widgetRemoved, false);
    jobUI.clearWorkflow("wf");
    assert.equal(state.widgetRemoved, true);
  });

  it("counts workflow lines toward the overflow cap", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any, { maxWidgetLines: 12 });
    jobUI.setWorkflow("wf", workflow());
    for (let i = 1; i <= 5; i++) jobUI.setJob(`x${i}`, job({ title: `Task ${i}` }));

    const lines = state.widgetFactory!(fakeTui(), fakeTheme()).render(100);

    assert.ok(lines.length <= 12, `expected <=12 lines, got ${lines.length}`);
    assert.match(lines.at(-1)!, /\+\d+ more running/);
  });
});

describe("pick()", () => {
  it("notifies and returns undefined when no jobs are running", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);

    const result = await jobUI.pick();

    assert.equal(result, undefined);
    assert.equal(state.notifications.length, 1);
    assert.match(state.notifications[0]!.msg, /No pi-minion jobs running or scheduled/);
  });

  it("lists extra rows after jobs and returns the chosen extra id", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ title: "Running" }));

    state.selectReturn = "⏱ Nightly - haiku · next 09:00";
    const picked = await jobUI.pick([{ id: "sched1", label: "⏱ Nightly - haiku · next 09:00" }]);

    assert.deepEqual(state.selectOptions, ["Running - sonnet", "⏱ Nightly - haiku · next 09:00"]);
    assert.equal(picked, "sched1");
  });

  it("hides jobs that an extra row already lists, keeping extra order", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("job1", job({ title: "Step job" }));
    jobUI.setJob("job2", job({ title: "Standalone" }));

    state.selectReturn = "  › a - haiku";
    const picked = await jobUI.pick([
      { id: "wf", label: "⛓ Flow" },
      { id: "job1", label: "  › a - haiku" }
    ]);

    assert.deepEqual(state.selectOptions, ["Standalone - sonnet", "⛓ Flow", "  › a - haiku"]);
    assert.equal(picked, "job1");
  });

  it("shows extra rows even when no jobs are running", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);

    state.selectReturn = "⏱ Nightly - haiku · next 09:00";
    const picked = await jobUI.pick([{ id: "sched1", label: "⏱ Nightly - haiku · next 09:00" }]);

    assert.equal(picked, "sched1");
    assert.equal(state.notifications.length, 0);
  });

  it("disambiguates identical 'title - model' labels so the right id comes back", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("dupA", job({ title: "Same Title" }));
    jobUI.setJob("dupB", job({ title: "Same Title" }));

    state.selectReturn = "Same Title - sonnet #2";
    const picked = await jobUI.pick();

    assert.deepEqual(state.selectOptions, ["Same Title - sonnet", "Same Title - sonnet #2"]);
    assert.equal(picked, "dupB");
  });

  it("returns the sole id unambiguously when there is no collision", async () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.setJob("only", job({ title: "Unique" }));

    state.selectReturn = "Unique - sonnet";
    const picked = await jobUI.pick();

    assert.equal(picked, "only");
  });
});

describe("modal", () => {
  it("renders a bordered box with header, body, and footer", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "line1\nline2\nline3" });

    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
      handleInput(data: string): void;
      dispose(): void;
    };
    const lines = component.render(60);

    assert.ok(lines[0]!.startsWith("╭"), "first line should be the top border");
    assert.ok(lines.at(-1)!.startsWith("╰"), "last line should be the bottom border");
    assert.ok(lines.some((l) => l.includes("Modal Job") && l.includes("opus")));
    assert.ok(lines.some((l) => l.includes("line1")));
    assert.ok(lines.some((l) => l.includes("scroll")), "expected the footer hint");
  });

  it("shows the prompt above a muted horizontal rule, separate from the streamed response", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", {
      title: "Modal Job",
      model: "opus",
      prompt: "Investigate the flaky login test",
      text: "Looking into it now"
    });

    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    const lines = component.render(60);

    const promptIndex = lines.findIndex((l) => l.includes("Investigate the flaky login test"));
    const separatorIndex = lines.findIndex(
      (l, i) => i > promptIndex && /^│\s*─{5,}/.test(l)
    );
    const responseIndex = lines.findIndex((l) => l.includes("Looking into it now"));

    assert.ok(promptIndex >= 0, "expected the prompt to be rendered");
    assert.ok(separatorIndex > promptIndex, "expected the separator after the prompt");
    assert.ok(responseIndex > separatorIndex, "expected the streamed response after the separator");
  });

  it("renders a horizontal divider right after the title - model header", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "line1" });

    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    const lines = component.render(60);

    const headerIndex = lines.findIndex((l) => l.includes("Modal Job") && l.includes("opus"));
    assert.ok(headerIndex >= 0, "expected a header line");
    assert.ok(lines[headerIndex + 1]!.startsWith("├"), "expected a divider line after the header");
    assert.ok(lines[headerIndex + 1]!.trimEnd().endsWith("┤"), "expected the divider to close with ┤");
  });

  it("shows the resolved thinking level in the header, right-aligned alongside the model", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "hi", effort: "high" });

    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    const headerLine = component.render(60).find((l) => l.includes("Modal Job"));

    assert.match(headerLine!, /thinking: high/);
    // model comes before the thinking badge, both right of the title.
    assert.ok(headerLine!.indexOf("opus") < headerLine!.indexOf("thinking: high"));
  });

  it("colors the border by the minion job's own resolved effort, defaulting to off when unset", () => {
    const levelsSeen: string[] = [];
    const spyTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      getThinkingBorderColor: (level: string) => {
        levelsSeen.push(level);
        return (text: string) => text;
      }
    };

    const { ctx, state } = fakeCtx(spyTheme);
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "hi", effort: "high" });
    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    component.render(60);

    assert.deepEqual(levelsSeen, ["high"]);

    jobUI.openModal("noEffortJob", { title: "No Effort Job", model: "opus", prompt: "",
      text: "hi" });
    levelsSeen.length = 0;
    const component2 = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    component2.render(60);

    assert.deepEqual(levelsSeen, ["off"]);
  });

  it("sizes its line budget from the terminal rows (rows*0.7, minus 4 chrome lines)", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    const longText = Array.from({ length: 200 }, (_, i) => `output line ${i}`).join("\n");
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: longText });

    const component = state.customFactory!(fakeTui(40), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };
    const lines = component.render(60);

    // 40 rows * 0.7 height ratio = 28; the component's own chrome (top/header/footer/bottom) is 4 lines.
    assert.equal(lines.length, 28);
  });

  it("feeds appendModalText into the currently open modal only", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "start" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.appendModalText("someOtherJob", " ignored");
    jobUI.appendModalText("modalJob", " appended");

    const rendered = component.render(60).join("\n");
    assert.match(rendered, /start appended/);
    assert.doesNotMatch(rendered, /ignored/);
  });

  it("shows a finished marker once finishModalJob is called for the open job", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "hi" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.finishModalJob("modalJob");

    assert.ok(component.render(60).some((l) => l.includes("finished")));
  });

  it("distinguishes Escape from an Up-arrow sequence and only closes on Escape", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "l1\nl2\nl3" });

    let doneResult: unknown = "not called";
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, (result) => {
      doneResult = result;
    }) as { handleInput(data: string): void };

    component.handleInput("\x1b[A"); // Up arrow
    assert.equal(doneResult, "not called", "an arrow key should not close the modal");

    component.handleInput("\x1b"); // plain Escape
    assert.equal(doneResult, undefined, "Escape should call done(undefined)");
  });

  it("replaces the header's model alias once setModalModel reports the real id", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.setModalModel("otherJob", "claude-sonnet-5");
    assert.ok(component.render(80)[1]!.includes("opus"));

    jobUI.setModalModel("modalJob", "claude-opus-5-5");
    assert.ok(component.render(80)[1]!.includes("claude-opus-5-5"));
  });

  it("pages up and down by the visible body height on shift+up/shift+down", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") });

    let doneResult: unknown = "not called";
    const component = state.customFactory!(fakeTui(12), fakeTheme(), {}, (result) => {
      doneResult = result;
    }) as { render(width: number): string[]; handleInput(data: string): void };

    // fakeTui(12) -> 8 modal rows - 6 chrome = 2 body rows; auto-scrolled to the bottom.
    const body = () => component.render(60).slice(3, 5).join("\n");
    assert.match(body(), /line18[\s\S]*line19/);

    component.handleInput("\x1b[1;2A"); // shift+up
    assert.equal(doneResult, "not called");
    assert.match(body(), /line16[\s\S]*line17/);

    component.handleInput("\x1b[1;2B"); // shift+down
    assert.match(body(), /line18[\s\S]*line19/);
  });

  it("renders a running tool call with its truncated args snippet", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.startModalToolCall("modalJob", "call-1", "search_web");
    jobUI.updateModalToolCallArgs("modalJob", "call-1", { query: "GitLab AST_ENABLE_MR_PIPELINES" });

    const rendered = component.render(60).join("\n");
    assert.match(rendered, /search_web/);
    assert.match(rendered, /GitLab AST_ENABLE_MR_PIPELINES/);
    assert.match(rendered, /running…/);
  });

  it("renders a finished tool call with duration, status, and output snippet", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.startModalToolCall("modalJob", "call-1", "view_file");
    jobUI.updateModalToolCallArgs("modalJob", "call-1", { AbsolutePath: "/tmp/SKILL.md" });
    jobUI.finishModalToolCall("modalJob", "call-1", {
      durationMs: 4379,
      output: "56 lines, 3023 bytes",
      isError: false
    });

    const rendered = component.render(60).join("\n");
    assert.match(rendered, /view_file/);
    assert.match(rendered, /4\.4s/);
    assert.match(rendered, /56 lines, 3023 bytes/);
    assert.doesNotMatch(rendered, /running…/);
  });

  it("marks a failed tool call distinctly from a successful one", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.startModalToolCall("modalJob", "call-1", "read_url_content");
    jobUI.finishModalToolCall("modalJob", "call-1", { isError: true, output: "403 Forbidden" });

    const rendered = component.render(60).join("\n");
    assert.match(rendered, /✗/);
    assert.doesNotMatch(rendered, /✓/);
  });

  it("interleaves tool-call rows with surrounding text in the order they were emitted", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.appendModalText("modalJob", "Before");
    jobUI.startModalTextBlock("modalJob");
    jobUI.startModalToolCall("modalJob", "call-1", "Bash");
    jobUI.finishModalToolCall("modalJob", "call-1", { isError: false });
    jobUI.startModalTextBlock("modalJob");
    jobUI.appendModalText("modalJob", "After");

    const lines = component.render(60);
    const beforeIndex = lines.findIndex((l) => l.includes("Before"));
    const toolIndex = lines.findIndex((l) => l.includes("Bash"));
    const afterIndex = lines.findIndex((l) => l.includes("After"));

    assert.ok(beforeIndex >= 0 && toolIndex > beforeIndex && afterIndex > toolIndex);
  });

  it("ignores tool-call mutators targeting a job with no open modal, or an untracked call id", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
    };

    jobUI.startModalToolCall("someOtherJob", "call-1", "Bash");
    jobUI.updateModalToolCallArgs("modalJob", "unknown-call", { x: 1 });
    jobUI.finishModalToolCall("modalJob", "unknown-call", { isError: false });

    assert.doesNotMatch(component.render(60).join("\n"), /Bash/);
  });

  it("dispose() clears the active-modal reference (finishModalJob becomes a no-op after)", () => {
    const { ctx, state } = fakeCtx();
    const jobUI = createJobUI(ctx as any);
    jobUI.openModal("modalJob", { title: "Modal Job", model: "opus", prompt: "",
      text: "hi" });
    const component = state.customFactory!(fakeTui(), fakeTheme(), {}, () => {}) as {
      render(width: number): string[];
      dispose(): void;
    };

    component.dispose();
    jobUI.finishModalJob("modalJob"); // should be a no-op now — nothing to assert but "must not throw"

    assert.ok(component.render(60).every((l) => !l.includes("finished")));
  });
});

describe("workflow confirm overlay", () => {
  const confirm: WorkflowConfirm = {
    title: "Review MR",
    lines: [
      [],
      [{ text: "Stage 1", style: "muted" }],
      [
        { text: "  • a: " + "word ".repeat(40) + "— " },
        { text: "sonnet, high effort", style: "effort", effort: "high" }
      ],
      [{ text: "Run this workflow?" }]
    ]
  };
  const styledTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</>`,
    bold: (text: string) => `[${text}]`,
    getThinkingBorderColor: (level: string) => (text: string) => `<think:${level}>${text}</>`
  };

  function open(rows = 40) {
    const { ctx, state } = fakeCtx();
    void confirmWorkflow(ctx as any, confirm);
    const results: WorkflowConfirmResult[] = [];
    const component = state.customFactory!(fakeTui(rows), fakeTheme(), {}, (r) => results.push(r as WorkflowConfirmResult)) as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    return { component, results };
  }

  it("styles only the title accent+bold; headings muted, effort colored", () => {
    const lines = renderWorkflowConfirmBody(styledTheme as any, confirm, 200);
    assert.equal(lines[0], "<accent>[Review MR]</>");
    assert.ok(lines.includes("<muted>Stage 1</>"));
    assert.ok(lines.some((l) => l.endsWith("<think:high>sonnet, high effort</>")));
    assert.ok(lines.includes("Run this workflow?"));
    assert.equal(lines.filter((l) => l.includes("<accent>")).length, 1);
  });

  it("wraps long lines within the overlay width", () => {
    const body = renderWorkflowConfirmBody(fakeTheme() as any, confirm, 40);
    assert.ok(body.length > 5);
    for (const line of body) assert.ok(visibleWidth(line) <= 40, line);
    const { component } = open();
    for (const line of component.render(50)) assert.equal(visibleWidth(line), 50);
  });

  it("hangs wrapped step lines under the text after the bullet", () => {
    const rows = renderWorkflowConfirmLines(
      fakeTheme() as any,
      [[{ text: "  • step: one two three four five six seven eight nine ten" }]],
      24
    );
    assert.ok(rows.length > 1);
    assert.match(rows[0], /^ {2}• step:/);
    for (const row of rows.slice(1)) assert.match(row, /^ {4}\S/, row);
    for (const row of rows) assert.ok(visibleWidth(row) <= 24, row);
  });

  const YES = { approved: true };
  const NO = { approved: false };

  it("defaults to No: enter on the initial selection declines", () => {
    const { component, results } = open();
    assert.match(component.render(60).join("\n"), /→ No/);
    component.handleInput("\r");
    assert.deepEqual(results, [NO]);
  });

  it("up then enter approves; down returns to No", () => {
    const a = open();
    a.component.handleInput("\x1b[A");
    assert.match(a.component.render(60).join("\n"), /→ Yes/);
    a.component.handleInput("\r");
    assert.deepEqual(a.results, [YES]);
    const b = open();
    b.component.handleInput("\x1b[A");
    b.component.handleInput("j"); // j/k navigate on Yes
    assert.match(b.component.render(60).join("\n"), /→ No/);
    b.component.handleInput("\n");
    assert.deepEqual(b.results, [NO]);
  });

  it("types a reason on No and returns it on enter", () => {
    const { component, results } = open();
    assert.match(component.render(60).join("\n"), /→ No · reason:/);
    for (const ch of " too pricey, use haiku ") component.handleInput(ch);
    assert.match(component.render(60).join("\n"), /too pricey, use haiku/);
    component.handleInput("\r");
    assert.deepEqual(results, [{ approved: false, message: "too pricey, use haiku" }]);
  });

  it("returns no message for a blank reason", () => {
    const { component, results } = open();
    for (const ch of "   ") component.handleInput(ch);
    component.handleInput("\r");
    assert.deepEqual(results, [NO]);
  });

  it("shows the reason input only while No is selected", () => {
    const { component } = open();
    component.handleInput("\x1b[A");
    assert.doesNotMatch(component.render(60).join("\n"), /→ No · reason:/);
  });

  it("escape and ctrl+c decline without a reason; keys on Yes do nothing", () => {
    const a = open();
    a.component.handleInput("x");
    assert.deepEqual(a.results, []);
    a.component.handleInput("\x1b");
    assert.deepEqual(a.results, [NO]);
    const c = open();
    c.component.handleInput("\x1b[A");
    c.component.handleInput("x");
    c.component.handleInput("\x1b[B");
    assert.doesNotMatch(c.component.render(60).join("\n"), /\bx\b/);
    const b = open();
    b.component.handleInput("\x03");
    assert.deepEqual(b.results, [NO]);
  });

  const tall: WorkflowConfirm = {
    title: "Big plan",
    lines: Array.from({ length: 30 }, (_, i) => [{ text: `line ${i}` }])
  };

  function openTall(rows = 20) {
    const { ctx, state } = fakeCtx();
    void confirmWorkflow(ctx as any, tall);
    const results: WorkflowConfirmResult[] = [];
    const component = state.customFactory!(fakeTui(rows), fakeTheme(), {}, (r) => results.push(r as WorkflowConfirmResult)) as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    return { component, results };
  }
  const text = (c: { render(width: number): string[] }) => c.render(60).join("\n");

  it("shows no indicators or scroll hint when the body fits", () => {
    const out = text(open().component);
    assert.doesNotMatch(out, /more/);
    assert.doesNotMatch(out, /shift/);
  });

  it("shows a down indicator, scroll hint, title and options when overflowing", () => {
    const out = text(openTall().component);
    assert.match(out, /Big plan/);
    assert.doesNotMatch(out, /↑ \d+ more/);
    assert.match(out, /↓ \d+ more/);
    assert.match(out, /shift\+↑↓ scroll/);
    assert.match(out, /→ No/);
    assert.doesNotMatch(out, /line 29/);
  });

  it("pages with shift+↑/↓ like the detail modal, and with pageUp/pageDown, clamping at both ends", () => {
    const { component } = openTall();
    component.render(60);
    component.handleInput("\x1b[1;2B"); // shift+down
    let out = text(component);
    const paged = /↑ (\d+) more/.exec(out)?.[1];
    assert.ok(paged && Number(paged) > 1, "expected shift+down to scroll a full page");
    assert.doesNotMatch(out, /line 0\b/);
    component.handleInput("\x1b[1;2A"); // shift+up back to the top
    component.handleInput("\x1b[6~"); // pageDown moves the same page
    assert.match(text(component), new RegExp(`↑ ${paged} more`));
    component.render(60);
    for (let i = 0; i < 10; i++) component.handleInput("\x1b[6~");
    out = text(component);
    assert.match(out, /line 29/);
    assert.doesNotMatch(out, /↓ \d+ more/);
    for (let i = 0; i < 10; i++) component.handleInput("\x1b[5~"); // pageUp
    out = text(component);
    assert.match(out, /line 0\b/);
    assert.doesNotMatch(out, /↑ \d+ more/);
    component.handleInput("\x1b[1;2A"); // shift+up at top stays clamped
    assert.doesNotMatch(text(component), /↑ \d+ more/);
  });

  it("keeps Yes/No keys working without scrolling to the end", () => {
    const a = openTall();
    a.component.handleInput("\x1b[A");
    assert.match(text(a.component), /→ Yes/);
    a.component.handleInput("\r");
    assert.deepEqual(a.results, [YES]);
    const b = openTall();
    b.component.handleInput("\r");
    assert.deepEqual(b.results, [NO]);
  });

  it("declines when the ctx is stale", async () => {
    const ctx = {
      ui: {
        theme: fakeTheme(),
        custom: () => {
          throw new Error("stale");
        }
      }
    };
    assert.deepEqual(await confirmWorkflow(ctx as any, confirm), NO);
  });

  it("approves only for an approved result and passes a reason through", async () => {
    const cases = [
      [YES, YES],
      [NO, NO],
      [{ approved: false, message: "why" }, { approved: false, message: "why" }],
      [undefined, NO]
    ] as const;
    for (const [value, expected] of cases) {
      const ctx = { ui: { theme: fakeTheme(), custom: async () => value } };
      assert.deepEqual(await confirmWorkflow(ctx as any, confirm), expected);
    }
  });
});
