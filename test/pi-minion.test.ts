import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDisposeJobUI, ensureRegistryReady } from "../src/pi-minion.js";
import { listAdapters } from "../src/adapters/registry.js";

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
