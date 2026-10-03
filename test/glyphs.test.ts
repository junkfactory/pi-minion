import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setShowGlyphs } from "../src/glyphs.js";
import { formatScheduleLabel } from "../src/schedule-store.js";
import { formatWorkflowLabel } from "../src/workflow-store.js";

describe("glyphs", () => {
  afterEach(() => setShowGlyphs(true));

  it("prefixes labels when showGlyphs is on (default)", () => {
    assert.equal(
      formatWorkflowLabel({ title: "Review MR", steps: [{ id: "verify", status: "running" } as never] }),
      "⇉ Review MR · 0/1 steps · verify"
    );
    assert.equal(
      formatScheduleLabel(
        { title: "Nightly review", cron: "0 9 * * 1-5", effort: "medium", kind: "job", request: { model: "haiku" } },
        null
      ),
      "⏱ Nightly review · haiku / medium · 0 9 * * 1-5 · next —"
    );
  });

  it("drops the glyphs when showGlyphs is off", () => {
    setShowGlyphs(false);
    assert.equal(
      formatWorkflowLabel({ title: "Review MR", steps: [{ id: "verify", status: "running" } as never] }),
      "Review MR · 0/1 steps · verify"
    );
    assert.equal(
      formatScheduleLabel(
        { title: "Nightly review", cron: "0 9 * * 1-5", effort: "medium", kind: "job", request: { model: "haiku" } },
        null
      ),
      "Nightly review · haiku / medium · 0 9 * * 1-5 · next —"
    );
    // undefined falls back to enabled (a config without the key keeps glyphs).
    setShowGlyphs(undefined);
    assert.match(formatWorkflowLabel({ title: "Review MR", steps: [] }), /^⇉ /);
  });
});
