import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDisposeJobUI } from "../src/pi-minion.js";

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
