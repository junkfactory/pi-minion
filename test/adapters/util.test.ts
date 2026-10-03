import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandExists, truncate } from "../../src/adapters/util.js";

describe("commandExists", () => {
  it("resolves true for a binary guaranteed present on PATH", async () => {
    assert.equal(await commandExists("sh"), true);
  });

  it("resolves false for a name that isn't a real command", async () => {
    assert.equal(await commandExists("definitely-not-a-real-binary-xyz"), false);
  });
});

describe("truncate", () => {
  it("returns the input unchanged when it fits", () => {
    assert.equal(truncate("hello", 10), "hello");
  });

  it("truncates to exactly maxLength, ending in an ellipsis", () => {
    const result = truncate("hello world", 5);
    assert.equal(result, "hell…");
    assert.equal(result.length, 5);
  });
});
