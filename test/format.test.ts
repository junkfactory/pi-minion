import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTokenCount, formatTokenUsage } from "../src/agent.ui.js";
import { deriveJobTitle, describeJobResult, formatCostUsd, formatJobFrontmatter, formatModelBreakdown, formatRelative, formatTokenModelBreakdown, thinkingPlaceholder, tokenCountsFromUsage, truncateResultForContext } from "../src/format.js";

function fakeOutcome(overrides: Partial<Parameters<typeof describeJobResult>[0]> = {}) {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    exceededOutputLimit: false,
    finalResult: undefined,
    stderrTail: "",
    stdoutPath: "/tmp/job/stdout.json",
    rawOutputHint: "fake raw-output hint.",
    ...overrides
  };
}

describe("describeJobResult", () => {
  it("returns the final result on a clean exit", () => {
    assert.equal(describeJobResult(fakeOutcome({ code: 0, finalResult: "done" })), "done");
  });

  it("falls back to a placeholder when a clean exit produced no result event", () => {
    assert.equal(
      describeJobResult(fakeOutcome({ code: 0 })),
      "Pi minion finished without a result event."
    );
  });

  it("reports a plain failure with the stderr tail on a non-zero exit", () => {
    const message = describeJobResult(fakeOutcome({ code: 1, stderrTail: "boom" }));
    assert.match(message, /Pi minion failed \(exit 1\)\.\nboom/);
  });

  it("omits the trailing newline when there's no stderr to show", () => {
    const message = describeJobResult(fakeOutcome({ code: 1, stderrTail: "" }));
    assert.equal(message, "Pi minion failed (exit 1).");
  });

  it("includes the signal name when the process died from one", () => {
    const message = describeJobResult(fakeOutcome({ code: null, signal: "SIGKILL" }));
    assert.match(message, /exit unknown, signal SIGKILL/);
  });

  it("points at stdoutPath instead of a bare exit code when the run timed out", () => {
    // Regression: a `claude` process killed by our own timeout typically
    // self-reports as a generic non-zero exit (e.g. 143) with no stderr,
    // which used to surface as an uninformative "Pi minion failed (exit
    // 143)." with nothing for the caller to act on.
    const message = describeJobResult(
      fakeOutcome({ code: 143, timedOut: true, stdoutPath: "/tmp/job/stdout.json" })
    );
    assert.match(message, /timed out before finishing/);
    assert.match(message, /\/tmp\/job\/stdout\.json/);
    assert.doesNotMatch(message, /exit 143/);
  });

  it("includes the adapter's raw-output hint for a cut-off run", () => {
    const message = describeJobResult(
      fakeOutcome({ timedOut: true, rawOutputHint: "look under step_update.text_delta." })
    );
    assert.match(message, /look under step_update\.text_delta\. Read it directly/);
  });

  it("prefers the output-limit message over timedOut when both are set", () => {
    const message = describeJobResult(fakeOutcome({ timedOut: true, exceededOutputLimit: true }));
    assert.match(message, /exceeded the configured limit/);
  });

  it("appends a captured result to a non-zero exit's failure message, flagged as possibly incomplete", () => {
    const message = describeJobResult(
      fakeOutcome({ code: 1, stderrTail: "boom", finalResult: "partial answer" })
    );
    assert.match(message, /Pi minion failed \(exit 1\)\.\nboom/);
    assert.match(message, /may be incomplete/);
    assert.match(message, /partial answer/);
  });
});

describe("truncateResultForContext", () => {
  it("returns the text unchanged when it fits within maxBytes", () => {
    const text = "line1\nline2\nline3";
    assert.equal(truncateResultForContext(text, "/tmp/result.md", 1_000), text);
  });

  it("truncates by line, pointing at the file with a header and footer notice", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const text = lines.join("\n");
    // Each "line N\n" is ~7-8 bytes; cap tight enough to force a cut partway through.
    const message = truncateResultForContext(text, "/tmp/result.md", 50);

    assert.match(message, /^\[Showing lines 1-\d+ of 20 \(0\.1KB limit\)\. Use offset=\d+ to continue\.\]/);
    assert.match(message, /\[Truncated: \d+ lines shown \(0\.1KB limit\)\. Full result at \/tmp\/result\.md/);
    assert.ok(!message.includes("line 19"), "expected the tail to be cut off");
  });

  it("always shows at least one line even if it alone exceeds maxBytes", () => {
    const text = "a".repeat(200);
    const message = truncateResultForContext(text, "/tmp/result.md", 10);
    assert.match(message, /^\[Showing lines 1-1 of 1 /);
    assert.ok(message.includes("a".repeat(200)));
  });
});

describe("deriveJobTitle", () => {
  it("uses only the first line, stripped of markdown characters", () => {
    assert.equal(deriveJobTitle("Explore the repo\nsecond line"), "Explore the repo");
    assert.equal(deriveJobTitle("**Bold** task"), "Bold task");
  });

  it("falls back to a placeholder for blank input", () => {
    assert.equal(deriveJobTitle("   \n  "), "pi minion task");
  });

  it("truncates a very long first line to 48 characters", () => {
    const title = deriveJobTitle("A".repeat(200));
    assert.equal(title.length, 48);
    assert.ok(title.endsWith("…"));
  });

  it("accepts a longer limit", () => {
    assert.equal(deriveJobTitle("A".repeat(200), 80).length, 80);
  });
});

describe("formatModelBreakdown", () => {
  const perModel = [
    { model: "claude-sonnet-5", costUsd: 0.3, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
    { model: "claude-haiku-4-5-20251001", costUsd: 0.9, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }
  ];

  it("renders a parenthesized breakdown sorted by value descending", () => {
    assert.equal(
      formatModelBreakdown(perModel, (e) => e.costUsd, formatCostUsd),
      " (claude-haiku-4-5-20251001 $0.9000 + claude-sonnet-5 $0.3000)"
    );
  });

  it("omits the breakdown for a single model or none", () => {
    assert.equal(formatModelBreakdown([perModel[0]], (e) => e.costUsd, formatCostUsd), "");
    assert.equal(formatModelBreakdown([], (e) => e.costUsd, formatCostUsd), "");
    assert.equal(formatModelBreakdown(undefined, (e) => e.costUsd, formatCostUsd), "");
  });
});

describe("formatTokenModelBreakdown", () => {
  const perModel = [
    { model: "claude-sonnet-5", costUsd: 0.3, inputTokens: 100, outputTokens: 900, cacheWriteTokens: 2000, cacheReadTokens: 7000 },
    { model: "claude-haiku-4-5-20251001", costUsd: 0.9, inputTokens: 1000, outputTokens: 6000, cacheWriteTokens: 10000, cacheReadTokens: 20000 }
  ];

  it("renders each model's full token breakdown, sorted by combined tokens descending", () => {
    assert.equal(
      formatTokenModelBreakdown(perModel),
      " (claude-haiku-4-5-20251001 ↑1.0K ↓6.0K →10.0K ←20.0K + claude-sonnet-5 ↑0.1K ↓0.9K →2.0K ←7.0K)"
    );
  });

  it("omits the breakdown for a single model or none", () => {
    assert.equal(formatTokenModelBreakdown([perModel[0]]), "");
    assert.equal(formatTokenModelBreakdown([]), "");
    assert.equal(formatTokenModelBreakdown(undefined), "");
  });
});

describe("formatTokenCount / formatTokenUsage / formatCostUsd", () => {
  it("formatTokenCount renders thousands with one decimal", () => {
    assert.equal(formatTokenCount(31650), "31.6K");
    assert.equal(formatTokenCount(0), "0.0K");
    assert.equal(formatTokenCount(undefined), "n/a");
  });

  it("formatTokenUsage renders the input/output/cache-write/cache-read breakdown", () => {
    assert.equal(
      formatTokenUsage(9600, 800, 116_000, 1_331_500),
      "↑9.6K ↓0.8K →116.0K ←1331.5K"
    );
    assert.equal(
      formatTokenUsage(undefined, undefined, undefined, undefined),
      "↑n/a ↓n/a →n/a ←n/a"
    );
  });

  it("formatCostUsd renders four decimal places", () => {
    assert.equal(formatCostUsd(0.0221861), "$0.0222");
    assert.equal(formatCostUsd(undefined), "n/a");
  });
});

describe("formatJobFrontmatter", () => {
  it("renders an agent heading followed by the stat fields, falling back to n/a for missing usage", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      totalCostUsd: 0.0221861,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: haiku\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑0.0K ↓0.0K →9.1K ←22.5K\ncost_usd: \\$0.0222\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\n\n---"
    );
  });

  it("adds a step line after job_id only for workflow steps", () => {
    const base = { jobId: "j1", agent: "claude", model: "haiku", maxBudgetUsd: 5, jobDir: "/tmp/j" };
    assert.ok(!formatJobFrontmatter(base).includes("step:"));
    assert.match(formatJobFrontmatter({ ...base, step: "Review MR › bugs" }), /job_id: j1\nstep: Review MR › bugs\ntoken_usage/);
  });

  it("reports n/a usage when the job was killed before a result event", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheWriteTokens: undefined,
      cacheReadTokens: undefined,
      totalCostUsd: undefined,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: haiku\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑n/a ↓n/a →n/a ←n/a\ncost_usd: n/a\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\n\n---"
    );
  });

  it("appends the effort level beside the model name when present", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      effort: "medium",
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      totalCostUsd: 0.0221861,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: haiku (medium)\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑0.0K ↓0.0K →9.1K ←22.5K\ncost_usd: \\$0.0222\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\n\n---"
    );
  });

  it("omits the effort suffix when effort is undefined", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      effort: undefined,
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      totalCostUsd: 0.0221861,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.ok(frontmatter.startsWith("# Pi Minion: claude\n---\nmodel: haiku\n"));
  });

  it("shows the resolved model id and full-id breakdowns when perModel has multiple entries", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000,
      outputTokens: 9_000,
      cacheWriteTokens: 17_000,
      cacheReadTokens: 20_000,
      totalCostUsd: 1.2,
      perModel: [
        { model: "claude-sonnet-5", costUsd: 0.3, inputTokens: 100, outputTokens: 900, cacheWriteTokens: 2000, cacheReadTokens: 7000 },
        { model: "claude-haiku-4-5-20251001", costUsd: 0.9, inputTokens: 1000, outputTokens: 6000, cacheWriteTokens: 10000, cacheReadTokens: 20000 }
      ],
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: claude-haiku-4-5-20251001\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑1.0K ↓9.0K →17.0K ←20.0K (claude-haiku-4-5-20251001 ↑1.0K ↓6.0K →10.0K ←20.0K + claude-sonnet-5 ↑0.1K ↓0.9K →2.0K ←7.0K)\ncost_usd: \\$1.2000 (claude-haiku-4-5-20251001 \\$0.9000 + claude-sonnet-5 \\$0.3000)\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\n\n---"
    );
  });

  it("omits both breakdowns when perModel has a single model", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      totalCostUsd: 0.0221861,
      perModel: [
        { model: "claude-haiku-4-5-20251001", costUsd: 0.0221861, inputTokens: 10, outputTokens: 39, cacheWriteTokens: 9140, cacheReadTokens: 22461 }
      ],
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: claude-haiku-4-5-20251001\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑0.0K ↓0.0K →9.1K ←22.5K\ncost_usd: \\$0.0222\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\n\n---"
    );
  });

  it("adds a report line pointing at result.md when the result was written to disk", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      inputTokens: 10,
      outputTokens: 39,
      cacheWriteTokens: 9140,
      cacheReadTokens: 22461,
      totalCostUsd: 0.0221861,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc",
      reportPath: "/tmp/job/abc/result.md"
    });
    assert.equal(
      frontmatter,
      "# Pi Minion: claude\n---\nmodel: haiku\njob_id: f66c0f52-f2e8-45bf-9a61-d40738af09fb\ntoken_usage: ↑0.0K ↓0.0K →9.1K ←22.5K\ncost_usd: \\$0.0222\nbudget_usd: \\$5\noutput_path: /tmp/job/abc\nreport: [result.md](file:///tmp/job/abc/result.md)\n\n---"
    );
  });

  it("omits the report line when the result was never written to disk", () => {
    const frontmatter = formatJobFrontmatter({
      jobId: "f66c0f52-f2e8-45bf-9a61-d40738af09fb",
      agent: "claude",
      model: "haiku",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheWriteTokens: undefined,
      cacheReadTokens: undefined,
      totalCostUsd: undefined,
      maxBudgetUsd: 5,
      jobDir: "/tmp/job/abc"
    });
    assert.ok(!frontmatter.includes("report:"));
  });
});

describe("thinkingPlaceholder", () => {
  it("pairs each known effort level with its quip", () => {
    assert.equal(thinkingPlaceholder("low"), "Thinking in low effort — barely trying...");
    assert.equal(thinkingPlaceholder("medium"), "Thinking in medium effort — mid, and proud of it...");
    assert.equal(thinkingPlaceholder("high"), "Thinking in high effort — putting in real work this time...");
    assert.equal(thinkingPlaceholder("xhigh"), "Thinking in xhigh effort — overthinking, on purpose...");
    assert.equal(thinkingPlaceholder("max"), "Thinking in max effort — shopping for Louis Vuitton bags...");
  });

  it("falls back to a plain label for an unrecognized effort", () => {
    assert.equal(thinkingPlaceholder("custom"), "Thinking in custom...");
  });

  it("has its own quip when effort is unset", () => {
    assert.equal(thinkingPlaceholder(undefined), "Thinking... or am I? No idea how hard, actually...");
  });
});

describe("tokenCountsFromUsage", () => {
  it("maps final usage totals to the widget's token counts", () => {
    assert.deepEqual(
      tokenCountsFromUsage({ totalCostUsd: 0, inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4, perModel: [] }),
      { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }
    );
  });
});

describe("formatRelative", () => {
  const now = 1_700_000_000_000;

  it("says 'just now' under 60 seconds", () => {
    assert.equal(formatRelative(now - 59_000, now), "just now");
  });

  it("crosses into whole minutes at the 60-second boundary", () => {
    assert.equal(formatRelative(now - 60_000, now), "1m ago");
  });

  it("renders a mid-range minute value", () => {
    assert.equal(formatRelative(now - 3 * 60_000, now), "3m ago");
  });

  it("crosses into whole hours at the 60-minute boundary", () => {
    assert.equal(formatRelative(now - 60 * 60_000, now), "1h ago");
  });

  it("renders a mid-range hour value", () => {
    assert.equal(formatRelative(now - 3 * 60 * 60_000, now), "3h ago");
  });

  it("crosses into whole days at the 24-hour boundary", () => {
    assert.equal(formatRelative(now - 24 * 60 * 60_000, now), "1d ago");
  });

  it("renders a mid-range day value", () => {
    assert.equal(formatRelative(now - 5 * 24 * 60 * 60_000, now), "5d ago");
  });
});
