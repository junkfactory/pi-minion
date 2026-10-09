import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { canDisposeJobUI, ensureRegistryReady, warnActiveSchedules } from "../src/pi-minion.js";
import { listAdapters } from "../src/adapters/registry.js";
import { schedules, type MinionSchedule } from "../src/schedule-store.js";
import { fakeCtx } from "./fakes.js";

describe("ensureRegistryReady", () => {
  it("registers adapters even when session_start beats the startup chain's loadConfig()", async () => {
    // Fresh module import: the default export never ran, so bootstrappedConfig
    // is unset — exactly the state session_start sees when /reload fires it
    // before the startup chain resolves. Pre-fix this skipped registration,
    // the startSession loop ran over an empty registry, pi's model registry
    // stayed unseeded, and the whole session answered "models: []" +
    // "Unknown model" for everything.
    await ensureRegistryReady();
    // Detection shells out to the environment (same accepted dependence as
    // registry.test): any dev machine with an agent CLI on PATH registers it.
    assert.ok(listAdapters().length >= 1, "expected the machine's CLIs to register");
  });
});

describe("canDisposeJobUI", () => {
  it("disposes only with no jobs and no unfinished workflow", () => {
    assert.equal(canDisposeJobUI(0, []), true);
    assert.equal(canDisposeJobUI(0, [{ finishedAt: 1 }]), true);
    assert.equal(canDisposeJobUI(1, []), false);
  });

  it("keeps the UI while a workflow is between steps (no job, still running)", () => {
    assert.equal(canDisposeJobUI(0, [{ finishedAt: 1 }, {}]), false);
  });
});

describe("warnActiveSchedules", () => {
  afterEach(() => {
    schedules.clear();
  });

  it("returns true without prompting when there are no schedules", async () => {
    const { ctx, state } = fakeCtx();
    const result = await warnActiveSchedules("s1", ctx as any);
    assert.equal(result, true);
    assert.equal(state.confirmCalls.length, 0);
  });

  it("prompts and returns true when the user confirms", async () => {
    const { ctx, state } = fakeCtx(undefined, { confirmReturn: true });
    schedules.set("a", {
      title: "Nightly review",
      cron: "0 9 * * 1-5",
      sessionId: "s1"
    } as unknown as MinionSchedule);
    schedules.set("b", {
      title: "Watch PR",
      cron: "*/5 * * * *",
      sessionId: "s2"
    } as unknown as MinionSchedule);

    const result = await warnActiveSchedules("s1", ctx as any);
    assert.equal(result, true);
    assert.equal(state.confirmCalls.length, 1);
    assert.match(state.confirmCalls[0].title, /Active pi-minion schedules/);
    assert.match(state.confirmCalls[0].body, /Nightly review/);
    assert.doesNotMatch(state.confirmCalls[0].body, /Watch PR/);
    assert.match(state.confirmCalls[0].body, /Quitting/);
  });

  it("prompts and returns false when the user declines", async () => {
    const { ctx, state } = fakeCtx(undefined, { confirmReturn: false });
    schedules.set("a", {
      title: "Nightly review",
      cron: "0 9 * * 1-5",
      sessionId: "s1"
    } as unknown as MinionSchedule);

    const result = await warnActiveSchedules("s1", ctx as any);
    assert.equal(result, false);
    assert.equal(state.confirmCalls.length, 1);
  });
});
