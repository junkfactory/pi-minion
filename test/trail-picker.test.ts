import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "../src/adapters/claude.js";
import { createJobUI } from "../src/agent.ui.js";
import { openPiMinionsPicker } from "../src/modal.js";
import { jobMeta } from "../src/job-store.js";
import type { JobMetaEntry } from "../src/job-types.js";
import {
  countFinishedTrails,
  finishedWorkflowTrails,
  formatStandaloneTrailLabel,
  formatStepTrailLabel,
  formatWorkflowTrailLabel,
  recentStandaloneTrails,
  runTrailBrowser,
  trailSentinelLabel,
  TRAIL_SENTINEL_ID
} from "../src/trail-picker.js";
import { workflows, type MinionWorkflow } from "../src/workflow-store.js";
import { fakeCtx, fakeTheme, fakeTui } from "./fakes.js";

type BrowserComponent = {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  dispose?: () => void;
};

// Invokes the most-recently-stored ctx.ui.custom factory with the test's
// tui/theme/done and returns helpers to drive + close the resulting
// component. close() presses Esc on the component so the browser's own
// exitOneLevel path runs (it calls the browser's done → which the factory
// wrapped to invoke state.customResolve → runTrailBrowser awaits that and
// returns). Until close() runs, the test can drive input/render freely.
function openBrowser(state: { customFactory: any; customResolve: any }, rows = 40): {
  component: BrowserComponent;
  drive: (input: string) => void;
  // Promise resolves when runTrailBrowser's custom promise resolves —
  // i.e. when the browser exits and the factory's done callback fires.
  close: () => Promise<void>;
} {
  let resolveDone: ((r?: unknown) => void) | undefined;
  // The factory's done argument routes here; until the test wires
  // resolveDone, an accidental done call is a no-op.
  const factoryDone = (r?: unknown) => resolveDone?.(r);
  const component = state.customFactory!(fakeTui(rows), fakeTheme(), {}, factoryDone) as BrowserComponent;
  return {
    component,
    drive: (input: string) => component.handleInput(input),
    close: () =>
      new Promise<void>((resolve) => {
        resolveDone = (r) => {
          state.customResolve?.(r);
          resolve();
        };
        // Run the browser's exit path through Esc — verifies the keyboard
        // route wires correctly (vs. only the done callback being invoked
        // directly from test code).
        component.handleInput("\x1b");
      })
  };
}

const SESSION = "test-session";
const WORKSPACE = "/tmp/workspace";

function fakeMeta(overrides: Partial<JobMetaEntry> & Pick<JobMetaEntry, "title" | "model" | "status">): JobMetaEntry {
  return {
    prompt: "",
    workspace: WORKSPACE,
    sessionId: SESSION,
    ...overrides
  };
}

function fakeWorkflow(overrides: Partial<MinionWorkflow> = {}): MinionWorkflow {
  return {
    title: "Title",
    context: "",
    maxResultPreviewBytes: 50_000,
    cwd: WORKSPACE,
    sessionId: SESSION,
    steps: [],
    startedAt: 0,
    cancelled: false,
    ...overrides
  };
}

function renderText(component: BrowserComponent, width = 80): string {
  return component.render(width).join("\n");
}

async function waitForDetail(component: BrowserComponent): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const text = renderText(component);
    if (/Esc close/.test(text)) return text;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`detail view did not open:\n${renderText(component)}`);
}

// Sessions are shared by every test, and the browser reads module-level
// jobMeta/workflows when it opens. Wipe them between tests.
afterEach(() => {
  jobMeta.clear();
  workflows.clear();
});

describe("recentStandaloneTrails", () => {
  it("drops running standalone jobs from the trail list", () => {
    const meta = new Map<string, JobMetaEntry>([
      ["running", fakeMeta({ title: "R", model: "sonnet", status: "running" })],
      ["done", fakeMeta({ title: "D", model: "sonnet", status: "done", finishedAt: 1 })]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.deepEqual(rows.map((r) => r.id), ["done"]);
  });

  it("drops standalone jobs that belong to a workflow (step-owned metas)", () => {
    const meta = new Map<string, JobMetaEntry>([
      [
        "step",
        fakeMeta({
          title: "Step",
          model: "sonnet",
          status: "done",
          finishedAt: 1,
          workflowId: "wf1"
        })
      ],
      [
        "standalone",
        fakeMeta({ title: "Standalone", model: "sonnet", status: "done", finishedAt: 2 })
      ]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.deepEqual(rows.map((r) => r.id), ["standalone"]);
  });

  it("includes old-style metas that have no workflowId field", () => {
    const meta = new Map<string, JobMetaEntry>([
      ["old", fakeMeta({ title: "Old", model: "sonnet", status: "done", finishedAt: 1 })]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.deepEqual(rows.map((r) => r.id), ["old"]);
  });

  it("sorts standalone trails by finishedAt descending", () => {
    const meta = new Map<string, JobMetaEntry>([
      ["a", fakeMeta({ title: "A", model: "sonnet", status: "done", finishedAt: 1 })],
      ["b", fakeMeta({ title: "B", model: "sonnet", status: "done", finishedAt: 5 })],
      ["c", fakeMeta({ title: "C", model: "sonnet", status: "done", finishedAt: 3 })]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.deepEqual(rows.map((r) => r.id), ["b", "c", "a"]);
  });

  it("caps the standalone list at 10 entries", () => {
    const meta = new Map<string, JobMetaEntry>();
    for (let i = 0; i < 15; i++) {
      meta.set(`id${i}`, fakeMeta({ title: `T${i}`, model: "sonnet", status: "done", finishedAt: i }));
    }
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.equal(rows.length, 10);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["id14", "id13", "id12", "id11", "id10", "id9", "id8", "id7", "id6", "id5"]
    );
  });

  it("renders the standalone status prefix and 'done/errored/cancelled' for each terminal status", () => {
    const t = Date.now() - 5 * 60 * 1000;
    const meta = new Map<string, JobMetaEntry>([
      ["done", fakeMeta({ title: "D", model: "sonnet", status: "done", finishedAt: t })],
      ["err", fakeMeta({ title: "E", model: "sonnet", status: "errored", finishedAt: t })],
      ["can", fakeMeta({ title: "C", model: "sonnet", status: "cancelled", finishedAt: t })]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    const labels = new Map(rows.map((r) => [r.id, r.label]));
    assert.match(labels.get("done")!, /^✓ D · sonnet · done \d+m ago$/);
    assert.match(labels.get("err")!, /^✗ E · sonnet · errored \d+m ago$/);
    // The plan calls for '−' (U+2212) on cancelled standalone rows.
    assert.match(labels.get("can")!, /^− C · sonnet · cancelled \d+m ago$/);
  });

  it("prefers resolvedModel over the requested alias in the trail label", () => {
    const meta = new Map<string, JobMetaEntry>([
      [
        "r",
        fakeMeta({
          title: "R",
          model: "opus",
          resolvedModel: "claude-opus-5-5",
          status: "done",
          finishedAt: Date.now() - 60 * 1000
        })
      ]
    ]);
    const { ctx } = fakeCtx();
    const rows = recentStandaloneTrails(ctx as any, meta);
    assert.match(rows[0]!.label, /· claude-opus-5-5 · /);
  });
});

describe("finishedWorkflowTrails", () => {
  it("drops running workflows (any pending/running step counts)", () => {
    const wfMap = new Map<string, MinionWorkflow>([
      [
        "running",
        fakeWorkflow({
          sessionId: SESSION,
          steps: [{ id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "running" }]
        })
      ],
      [
        "done",
        fakeWorkflow({
          sessionId: SESSION,
          finishedAt: 5,
          steps: [
            {
              id: "a",
              task: "t",
              model: "sonnet",
              effort: "low",
              dependsOn: [],
              status: "done",
              reportPath: "/r"
            }
          ]
        })
      ]
    ]);
    const { ctx } = fakeCtx();
    const rows = finishedWorkflowTrails(ctx as any, wfMap);
    assert.deepEqual(rows.map((r) => r.id), ["done"]);
  });

  it("includes done, failed, and cancelled workflows (any terminal status counts)", () => {
    const t = Date.now() - 60 * 1000;
    const wfMap = new Map<string, MinionWorkflow>([
      [
        "doneWf",
        fakeWorkflow({
          sessionId: SESSION,
          finishedAt: t,
          steps: [
            {
              id: "a",
              task: "t",
              model: "sonnet",
              effort: "low",
              dependsOn: [],
              status: "done",
              reportPath: "/r"
            }
          ]
        })
      ],
      [
        "failedWf",
        fakeWorkflow({
          sessionId: SESSION,
          finishedAt: t,
          steps: [{ id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "failed" }]
        })
      ],
      ["cancelledWf", fakeWorkflow({ sessionId: SESSION, finishedAt: t, cancelled: true })]
    ]);
    const { ctx } = fakeCtx();
    const rows = finishedWorkflowTrails(ctx as any, wfMap);
    const labels = new Map(rows.map((r) => [r.id, r.label]));
    assert.match(labels.get("doneWf")!, / · done · /);
    assert.match(labels.get("failedWf")!, / · failed · /);
    assert.match(labels.get("cancelledWf")!, / · cancelled · /);
  });

  it("renders the counts line for a done/failed/skipped mix", () => {
    const wfMap = new Map<string, MinionWorkflow>([
      [
        "mix",
        fakeWorkflow({
          sessionId: SESSION,
          finishedAt: Date.now() - 60 * 1000,
          steps: [
            { id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", reportPath: "/r" },
            { id: "b", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", reportPath: "/r" },
            { id: "c", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "failed" },
            { id: "d", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "skipped" }
          ]
        })
      ]
    ]);
    const { ctx } = fakeCtx();
    const rows = finishedWorkflowTrails(ctx as any, wfMap);
    assert.match(rows[0]!.label, /2 done, 1 failed, 1 skipped/);
  });

  it("sorts finished workflows by finishedAt descending (replaces v1 union)", () => {
    const wfMap = new Map<string, MinionWorkflow>([
      ["old", fakeWorkflow({ sessionId: SESSION, finishedAt: 1 })],
      ["new", fakeWorkflow({ sessionId: SESSION, finishedAt: 5 })],
      ["mid", fakeWorkflow({ sessionId: SESSION, finishedAt: 3 })]
    ]);
    const { ctx } = fakeCtx();
    const rows = finishedWorkflowTrails(ctx as any, wfMap);
    assert.deepEqual(rows.map((r) => r.id), ["new", "mid", "old"]);
  });

  it("caps the finished-workflow list at 10 entries", () => {
    const wfMap = new Map<string, MinionWorkflow>();
    for (let i = 0; i < 15; i++) {
      wfMap.set(`wf${i}`, fakeWorkflow({ sessionId: SESSION, finishedAt: i }));
    }
    const { ctx } = fakeCtx();
    const rows = finishedWorkflowTrails(ctx as any, wfMap);
    assert.equal(rows.length, 10);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["wf14", "wf13", "wf12", "wf11", "wf10", "wf9", "wf8", "wf7", "wf6", "wf5"]
    );
  });

  it("omits the glyph prefix when showGlyphs is disabled", () => {
    const { setShowGlyphs } = require("../src/glyphs.js") as typeof import("../src/glyphs.js");
    setShowGlyphs(false);
    try {
      const wfMap = new Map<string, MinionWorkflow>([
        [
          "wf",
          fakeWorkflow({
            sessionId: SESSION,
            finishedAt: Date.now() - 60 * 1000,
            steps: [
              {
                id: "a",
                task: "t",
                model: "sonnet",
                effort: "low",
                dependsOn: [],
                status: "done",
                reportPath: "/r"
              }
            ]
          })
        ]
      ]);
      const { ctx } = fakeCtx();
      const rows = finishedWorkflowTrails(ctx as any, wfMap);
      assert.ok(!rows[0]!.label.startsWith("⇉"), `expected no ⇉ prefix, got: ${rows[0]!.label}`);
      assert.match(rows[0]!.label, /^Title · done · /);
    } finally {
      setShowGlyphs(undefined);
    }
  });
});

describe("countFinishedTrails + sentinel", () => {
  it("returns 0 with empty maps", () => {
    const { ctx } = fakeCtx();
    assert.equal(countFinishedTrails(ctx as any, new Map(), new Map()), 0);
  });

  it("sums finished standalone + finished workflows", () => {
    const meta = new Map<string, JobMetaEntry>([
      ["a", fakeMeta({ title: "A", model: "sonnet", status: "done", finishedAt: 1 })],
      ["b", fakeMeta({ title: "B", model: "sonnet", status: "done", finishedAt: 2 })]
    ]);
    const wfMap = new Map<string, MinionWorkflow>([
      ["w", fakeWorkflow({ sessionId: SESSION, finishedAt: 3 })]
    ]);
    const { ctx } = fakeCtx();
    assert.equal(countFinishedTrails(ctx as any, meta, wfMap), 3);
  });

  it("trailSentinelLabel formats the count with correct pluralization", () => {
    assert.equal(trailSentinelLabel(1), "✓ Completed · 1 trail");
    assert.equal(trailSentinelLabel(5), "✓ Completed · 5 trails");
  });

  it("TRAIL_SENTINEL_ID is a stable string the picker can route by", () => {
    assert.equal(typeof TRAIL_SENTINEL_ID, "string");
    assert.ok(TRAIL_SENTINEL_ID.length > 0);
  });
});

describe("openPiMinionsPicker sentinel routing", () => {
  it("does NOT surface the sentinel row when there are no finished trails", async () => {
    const { ctx, state } = fakeCtx();
    await openPiMinionsPicker(ctx as any);
    const labels = state.selectOptions ?? [];
    assert.ok(
      !labels.some((l) => /Completed ·/.test(l)),
      `expected no sentinel row, got: ${labels.join(" | ")}`
    );
  });

  it("surfaces the sentinel row with N = finished-standalone + finished-workflow count", async () => {
    jobMeta.set("j", fakeMeta({ title: "J", model: "sonnet", status: "done", finishedAt: 1 }));
    workflows.set(
      "w",
      fakeWorkflow({ sessionId: SESSION, finishedAt: 2 })
    );
    const { ctx, state } = fakeCtx();
    await openPiMinionsPicker(ctx as any);
    const labels = state.selectOptions ?? [];
    const sentinel = labels.find((l) => /Completed ·/.test(l));
    assert.ok(sentinel, `expected sentinel row, got: ${labels.join(" | ")}`);
    assert.match(sentinel!, /Completed · 2 trails/);
  });

  it("routes sentinel pick into runTrailBrowser and re-presentse the top picker (loop continues)", async () => {
    jobMeta.set("j", fakeMeta({ title: "J", model: "sonnet", status: "done", finishedAt: 1 }));
    const { ctx, state } = fakeCtx();
    // First pick: the sentinel id → runTrailBrowser opens.
    // Second pick: undefined → picker loop exits.
    let picks = 0;
    (ctx.ui as any).select = async (_title: string, options: string[]) => {
      state.selectOptions = options;
      picks++;
      if (picks === 1) {
        const sentinel = options.find((l) => /Completed ·/.test(l));
        return sentinel!;
      }
      return undefined;
    };
    // Don't await the picker directly — runTrailBrowser is blocked on
    // ctx.ui.custom (which the fake's promise hangs until we resolve
    // customResolve). Close the browser via the helper, which routes
    // Esc → browser.done → factoryDone → customResolve → custom promise
    // resolves → runTrailBrowser returns → loop continues to a second
    // pick → returns undefined → picker exits.
    const pickerPromise = openPiMinionsPicker(ctx as any);
    await new Promise<void>((resolve) => setImmediate(resolve)); // allow the picker continuation to enter the browser
    assert.ok(state.customFactory, "browser should have opened");
    const { close } = openBrowser(state);
    await close();
    await pickerPromise;
    assert.ok(picks >= 2, `expected loop to re-present, got ${picks} picks`);
  });
});

describe("runTrailBrowser — list view", () => {
  it("opens the browser as a single custom overlay and renders both sections with headings", () => {
    jobMeta.set("j1", fakeMeta({ title: "JobOne", model: "sonnet", status: "done", finishedAt: 1 }));
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 2,
        steps: [{ id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", reportPath: "/r" }]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    const text = renderText(component);
    assert.match(text, /Completed trails/);
    assert.match(text, /Completed jobs/);
    assert.match(text, /Completed workflows/);
    assert.match(text, /JobOne/);
    assert.match(text, /Title/);
  });

  it("renders '(none)' placeholders when both sections are empty", () => {
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    const text = renderText(component);
    assert.match(text, /No finished jobs or workflows yet\.|  \(none\)/);
  });

  it("moves the cursor section-aware: down past the last job row drops onto the first workflow row", () => {
    jobMeta.set("j1", fakeMeta({ title: "J1", model: "sonnet", status: "done", finishedAt: 5 }));
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 1,
        steps: [{ id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", reportPath: "/r" }]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B"); // down — wraps into workflows section
    const text = renderText(component);
    // The first workflow row should now carry the cursor glyph.
    const workflowRow = text.split("\n").find((l) => l.includes("Title"));
    assert.ok(workflowRow?.includes("❯"), `expected workflow row to have cursor, got: ${workflowRow}`);
  });

  it("wraps from the bottom of workflows back to the top of jobs on further down", () => {
    jobMeta.set("j1", fakeMeta({ title: "J1", model: "sonnet", status: "done", finishedAt: 5 }));
    workflows.set("w1", fakeWorkflow({ sessionId: SESSION, finishedAt: 1 }));
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B"); // → first workflow
    component.handleInput("\x1b[B"); // → wrap to first job
    const text = renderText(component);
    const jobRow = text.split("\n").find((l) => l.includes("J1"));
    assert.ok(jobRow?.includes("❯"), `expected job row to have cursor after wrap, got: ${jobRow}`);
  });
});

describe("runTrailBrowser — steps view", () => {
  it("enters steps view on Enter over a finished workflow and lists its steps with cursor", async () => {
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 1,
        steps: [
          { id: "alpha", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "ja", reportPath: "/r" },
          { id: "beta", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "failed", jobId: "jb" }
        ]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B"); // cursor onto the workflow row
    component.handleInput("\r"); // enter → steps view
    const text = renderText(component);
    assert.match(text, /Title/);
    assert.match(text, /❯ › alpha/);
    assert.match(text, /  › beta/);
  });

  it("skips steps with no jobId defensively in the steps view", async () => {
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 1,
        steps: [
          { id: "alpha", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "ja", reportPath: "/r" },
          { id: "skip", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "skipped" },
          { id: "beta", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "jb", reportPath: "/r" }
        ]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    const text = renderText(component);
    assert.match(text, /❯ › alpha/);
    assert.match(text, /  › beta/);
    assert.ok(!/› skip/.test(text), "steps without jobId must be filtered");
  });

  it("Esc at steps view returns to list view with cursor intact", async () => {
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 1,
        steps: [
          { id: "alpha", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "ja", reportPath: "/r" },
          { id: "beta", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "jb", reportPath: "/r" }
        ]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B"); // → workflow row
    component.handleInput("\r"); // → steps view
    assert.match(renderText(component), /Steps/);
    component.handleInput("\x1b"); // Esc → list view
    assert.match(renderText(component), /Completed trails/);
    // Cursor should be back on the workflow row (not reset to top of jobs).
    const text = renderText(component);
    const workflowRow = text.split("\n").find((l) => l.includes("Title"));
    assert.ok(workflowRow?.includes("❯"), `expected cursor on workflow after Esc, got: ${workflowRow}`);
  });

  it("presses q at steps view to return to list (same as Esc)", async () => {
    workflows.set(
      "w1",
      fakeWorkflow({
        sessionId: SESSION,
        finishedAt: 1,
        steps: [
          { id: "alpha", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", jobId: "ja", reportPath: "/r" }
        ]
      })
    );
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    component.handleInput("q");
    assert.match(renderText(component), /Completed trails/);
  });
});

describe("runTrailBrowser — detail view", () => {
  it("seeds the modal with a 'stream log pruned' text block + reportPath when stdout.json is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      // No stdout.json — simulates pruneOldJobs having reaped the dir.
      jobMeta.set(
        "trail1",
        fakeMeta({
          title: "Trail",
          model: "sonnet",
          status: "done",
          finishedAt: 1,
          reportPath: "/tmp/report.md"
        })
      );
      const { ctx, state } = fakeCtx();
      void runTrailBrowser(ctx as any, createJobUI(ctx as any), undefined, dir);
      const { component } = openBrowser(state);
      // Open detail on the first row (the only one).
      component.handleInput("\r");
      // stat() is asynchronous; wait for the detail component to replace the list.
      const text = await waitForDetail(component);
      assert.match(text, /stream log pruned/);
      assert.match(text, /\/tmp\/report\.md/);
      // Terminal meta → ModalState.finished === true → header badge.
      assert.match(text, /finished/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("falls back to '(none)' in the pruned text when reportPath is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      jobMeta.set(
        "trail1",
        fakeMeta({ title: "Trail", model: "sonnet", status: "done", finishedAt: 1 })
      );
      const { ctx, state } = fakeCtx();
      void runTrailBrowser(ctx as any, createJobUI(ctx as any), undefined, dir);
      const { component } = openBrowser(state);
      component.handleInput("\r");
      const text = await waitForDetail(component);
      assert.match(text, /\(none\)/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("replays stdout.json and marks the detail finished when the log file is present and the meta is terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await mkdir(join(dir, "trail1"), { recursive: true });
      await writeFile(
        join(dir, "trail1", "stdout.json"),
        JSON.stringify({
          type: "stream_event",
          event: { delta: { type: "text_delta", text: "replayed text" } }
        })
      );
      jobMeta.set(
        "trail1",
        fakeMeta({ title: "Trail", model: "sonnet", status: "done", finishedAt: 1 })
      );
      const { ctx, state } = fakeCtx();
      void runTrailBrowser(ctx as any, createJobUI(ctx as any), undefined, dir);
      const { component } = openBrowser(state);
      component.handleInput("\r");
      const text = await waitForDetail(component);
      assert.match(text, /replayed text/);
      assert.match(text, /finished/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("opens the detail without the 'finished' badge when meta.status is 'running' (live stream keeps appending)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      // Empty stdout.json so backfill is a no-op — the test is about the
      // finished-flag routing only. recentStandaloneTrails would filter
      // this status: "running" entry out of the list, so we inject a
      // custom lists snapshot that bypasses the live filter.
      jobMeta.set("trail1", fakeMeta({ title: "Live", model: "sonnet", status: "running" }));
      const { ctx, state } = fakeCtx();
      const lists = {
        jobs: [{ id: "trail1", label: "Live · sonnet · running · just now", finishedAt: 0 }],
        workflows: []
      };
      void runTrailBrowser(ctx as any, createJobUI(ctx as any), lists, dir);
      const { component } = openBrowser(state);
      component.handleInput("\r");
      const text = await waitForDetail(component);
      assert.ok(
        !/finished/.test(text),
        `expected no 'finished' badge for a running meta, got:\n${text}`
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("Esc on detail returns to list view (or steps view) with cursor preserved", async () => {
    jobMeta.set("j1", fakeMeta({ title: "J1", model: "sonnet", status: "done", finishedAt: 5 }));
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component } = openBrowser(state);
    component.handleInput("\r"); // open detail on j1
    assert.match(await waitForDetail(component), /J1/);
    component.handleInput("\x1b"); // Esc → back to list
    const text = renderText(component);
    assert.match(text, /Completed trails/);
    // Cursor still on j1 (the first/only row).
    const jobRow = text.split("\n").find((l) => l.includes("J1"));
    assert.ok(jobRow?.includes("❯"), `expected cursor on j1 after detail-back, got: ${jobRow}`);
  });

  it("routes applyModalText into the detail state via setActiveDetail (live stream still works)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      jobMeta.set("trail1", fakeMeta({ title: "Live", model: "sonnet", status: "running" }));
      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      const lists = {
        jobs: [{ id: "trail1", label: "Live · sonnet · running · just now", finishedAt: 0 }],
        workflows: []
      };
      void runTrailBrowser(ctx as any, jobUI, lists, dir);
      const { component } = openBrowser(state);
      component.handleInput("\r"); // open detail
      await waitForDetail(component);
      // Stream events for trail1 must route into the browser's detail state.
      jobUI.appendModalText("trail1", "streamed content");
      const text = renderText(component);
      assert.match(text, /streamed content/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("routes tool-call stream events into the detail state via setActiveDetail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      jobMeta.set("trail1", fakeMeta({ title: "Live", model: "sonnet", status: "running" }));
      const { ctx, state } = fakeCtx();
      const jobUI = createJobUI(ctx as any);
      const lists = {
        jobs: [{ id: "trail1", label: "Live · sonnet · running · just now", finishedAt: 0 }],
        workflows: []
      };
      void runTrailBrowser(ctx as any, jobUI, lists, dir);
      const { component } = openBrowser(state);
      component.handleInput("\r"); // open detail
      await waitForDetail(component);
      jobUI.startModalToolCall("trail1", "call-1", "Bash");
      jobUI.finishModalToolCall("trail1", "call-1", { isError: false });
      const text = renderText(component);
      assert.match(text, /Bash/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("Esc at list level resolves the browser promise (runTrailBrowser returns)", async () => {
    jobMeta.set("j1", fakeMeta({ title: "J1", model: "sonnet", status: "done", finishedAt: 5 }));
    const { ctx, state } = fakeCtx();
    const promise = runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component, close } = openBrowser(state);
    void component; // already opened
    await close();
    // After close, runTrailBrowser's custom promise resolved; the inner
    // await promise also resolves once resolvePromise() fires.
    await promise;
  });
});

describe("runTrailBrowser — defensive empty state", () => {
  it("opens without rows when both sections are empty and Esc still exits", async () => {
    const { ctx, state } = fakeCtx();
    void runTrailBrowser(ctx as any, createJobUI(ctx as any));
    const { component, close } = openBrowser(state);
    const text = renderText(component);
    assert.match(text, /No finished jobs or workflows yet\.|  \(none\)/);
    // Enter / arrow / Esc must all be no-ops without rows.
    component.handleInput("\r");
    component.handleInput("\x1b[B");
    await close();
  });
});

describe("label formatters", () => {
  it("formatStandaloneTrailLabel prefers resolvedModel and renders status glyph", () => {
    const label = formatStandaloneTrailLabel(
      fakeMeta({
        title: "T",
        model: "opus",
        resolvedModel: "claude-opus-5-5",
        status: "errored",
        finishedAt: Date.now() - 60_000
      })
    );
    assert.match(label, /^✗ T · claude-opus-5-5 · errored \d+m ago$/);
  });

  it("formatWorkflowTrailLabel renders the counts line and the workflow status", () => {
    const wf = fakeWorkflow({
      sessionId: SESSION,
      finishedAt: Date.now() - 60_000,
      steps: [
        { id: "a", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "done", reportPath: "/r" },
        { id: "b", task: "t", model: "sonnet", effort: "low", dependsOn: [], status: "failed" }
      ]
    });
    const label = formatWorkflowTrailLabel(wf);
    assert.match(label, / · failed · /);
    assert.match(label, /1 done, 1 failed/);
  });

  it("formatStepTrailLabel reads the model's resolved alias when its meta has one", () => {
    jobMeta.set(
      "ja",
      fakeMeta({
        title: "step",
        model: "opus",
        resolvedModel: "claude-opus-5-5",
        status: "done",
        finishedAt: Date.now() - 60_000
      })
    );
    const label = formatStepTrailLabel({
      id: "alpha",
      task: "t",
      model: "opus",
      effort: "low",
      dependsOn: [],
      status: "done",
      jobId: "ja",
      finishedAt: Date.now() - 60_000
    });
    assert.match(label, /^› alpha · done · claude-opus-5-5 · /);
  });
});

// Reference unused exports so tsconfig doesn't drop them — they're part
// of the v2 public surface for the trail browser tests below.
void claudeAdapter;