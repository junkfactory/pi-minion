import assert from "node:assert/strict";
import { describe, it } from "node:test";
import entry from "../extensions/index.js";
import source from "../src/pi-minion.js";

describe("package entry", () => {
  it("re-exports the extension factory pi loads", () => {
    assert.equal(entry, source);
    assert.equal(typeof entry, "function");
  });
});
