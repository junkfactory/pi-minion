import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Cron } from "croner";
import {
  formatNextRun,
  formatScheduleLabel,
  hasStopMarker,
  rehomeSchedules,
  resolveOwnedSchedule,
  scheduleIdsOwnedBySession,
  scheduleModel,
  scheduleResolvedModel,
  schedules,
  STOP_SCHEDULE_MARKER,
  stopSchedule,
  type MinionSchedule
} from "../src/schedule-store.js";

describe("scheduleIdsOwnedBySession", () => {
  it("returns only the given session's schedule ids", () => {
    const map = new Map([
      ["a", { sessionId: "s1" }],
      ["b", { sessionId: "s2" }],
      ["c", { sessionId: "s1" }]
    ]);
    assert.deepEqual(scheduleIdsOwnedBySession(map, "s1"), ["a", "c"]);
  });
});

describe("resolveOwnedSchedule", () => {
  const map = new Map([["a", { sessionId: "s1" }]]);

  it("is true only for the owning session", () => {
    assert.equal(resolveOwnedSchedule(map, "a", "s1"), true);
    assert.equal(resolveOwnedSchedule(map, "a", "s2"), false);
    assert.equal(resolveOwnedSchedule(map, "missing", "s1"), false);
  });
});

describe("formatNextRun", () => {
  const now = new Date(2026, 8, 30, 8, 0);

  it("shows only the time for later today", () => {
    assert.equal(formatNextRun(new Date(2026, 8, 30, 14, 5), now), "14:05");
  });

  it("includes the date for another day", () => {
    assert.equal(formatNextRun(new Date(2026, 9, 2, 9, 0), now), "Oct 2 09:00");
  });

  it("shows a dash when there is no next run", () => {
    assert.equal(formatNextRun(null, now), "—");
  });
});

describe("stopSchedule", () => {
  it("stops the cron and removes the entry", () => {
    const job = new Cron("0 9 * * *", () => {});
    schedules.set("x", { job, sessionId: "s1" } as unknown as MinionSchedule);

    assert.equal(stopSchedule("x"), true);
    assert.equal(schedules.has("x"), false);
    assert.equal(job.isStopped(), true);
    assert.equal(stopSchedule("x"), false);
  });
});

describe("formatScheduleLabel", () => {
  const schedule = {
    title: "Nightly review",
    cron: "0 9 * * 1-5",
    effort: "medium",
    request: { task: "t", workspace: "/w", model: "haiku" }
  };
  const now = new Date(2026, 8, 30, 8, 0);
  const next = new Date(2026, 8, 30, 9, 0);

  it("shows the alias before any run has resolved a model", () => {
    assert.equal(
      formatScheduleLabel(schedule, next, undefined, now),
      "⏱ Nightly review · haiku / medium · 0 9 * * 1-5 · next 09:00"
    );
  });

  it("prefers the latest run's resolved model", () => {
    assert.equal(
      formatScheduleLabel(schedule, next, "claude-haiku-4-5", now),
      "⏱ Nightly review · claude-haiku-4-5 / medium · 0 9 * * 1-5 · next 09:00"
    );
  });
});

describe("scheduleResolvedModel", () => {
  it("prefers the latest run's resolved model", () => {
    const lastRun = { resolvedModel: "claude-haiku-4-5" } as any;
    assert.equal(scheduleResolvedModel({ lastRun, resolvedModel: "older" }), "claude-haiku-4-5");
  });

  it("falls back to the carried-over model while the latest run hasn't reported one", () => {
    assert.equal(scheduleResolvedModel({ lastRun: {} as any, resolvedModel: "claude-haiku-4-5" }), "claude-haiku-4-5");
  });

  it("is undefined before any run has reported a model", () => {
    assert.equal(scheduleResolvedModel({}), undefined);
  });
});

describe("rehomeSchedules", () => {
  it("moves only the replaced session's schedules and their session file", () => {
    schedules.set("r1", { sessionId: "old", sessionFile: "/old.jsonl" } as unknown as MinionSchedule);
    schedules.set("r2", { sessionId: "other", sessionFile: "/other.jsonl" } as unknown as MinionSchedule);
    rehomeSchedules("old", "new", "/new.jsonl");
    assert.equal(schedules.get("r1")!.sessionId, "new");
    assert.equal(schedules.get("r1")!.sessionFile, "/new.jsonl");
    assert.equal(schedules.get("r2")!.sessionId, "other");
    schedules.delete("r1");
    schedules.delete("r2");
  });
});

describe("hasStopMarker", () => {
  it("is true when the marker is alone on the last non-empty line", () => {
    assert.equal(hasStopMarker(`Done.\n${STOP_SCHEDULE_MARKER}`), true);
    assert.equal(hasStopMarker(`Done.\n  ${STOP_SCHEDULE_MARKER}  \n\n`), true);
  });

  it("is false for a marker mid-text, quoted, or absent", () => {
    assert.equal(hasStopMarker(`${STOP_SCHEDULE_MARKER}\nNot done yet.`), false);
    assert.equal(hasStopMarker(`I will write \`${STOP_SCHEDULE_MARKER}\` when done.`), false);
    assert.equal(hasStopMarker("Still waiting."), false);
    assert.equal(hasStopMarker(undefined), false);
  });
});

describe("workflow schedules", () => {
  const schedule = {
    kind: "workflow" as const,
    title: "Nightly review",
    cron: "0 9 * * 1-5",
    effort: "medium",
    def: {
      title: "Nightly review",
      context: "c",
      steps: [
        { id: "a", task: "t", model: "sonnet" },
        { id: "b", task: "t", model: "sonnet" },
        { id: "c", task: "t", model: "luna" }
      ]
    }
  };

  it("labels with a chain marker and the step count", () => {
    assert.equal(
      formatScheduleLabel(schedule, new Date(2026, 8, 30, 9, 0), undefined, new Date(2026, 8, 30, 8, 0)),
      "⏱⇉ Nightly review · 3 steps · 0 9 * * 1-5 · next 09:00"
    );
  });

  it("names its distinct step models", () => {
    assert.equal(scheduleModel(schedule as unknown as MinionSchedule), "sonnet,luna");
    assert.equal(scheduleModel({ request: { model: "haiku" } } as unknown as MinionSchedule), "haiku");
  });
});
