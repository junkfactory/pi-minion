import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRequest } from "../src/job-runner.js";
import { fakeConfig, fakeRequest } from "./fakes.js";

describe("validateRequest", () => {
  it("rejects a workspace that doesn't match cwd", async () => {
    await assert.rejects(
      validateRequest(fakeRequest({ workspace: "/tmp/a" }), "/tmp/b", fakeConfig()),
      /must be the current Pi workspace/
    );
  });

  it("rejects a workspace that isn't a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    try {
      await assert.rejects(validateRequest(fakeRequest({ workspace: file }), file, fakeConfig()), /not a directory/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a model outside allowedModels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, model: "not-allowed" }), dir, fakeConfig()),
        /Model is not allowed/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("allows any model when allowedModels is empty (allow-all default)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await validateRequest(
        fakeRequest({ workspace: dir, model: "any-catalog-id" }),
        dir,
        fakeConfig({ allowedModels: [] })
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects a non-positive maxBudgetUsd override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: 0 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, maxBudgetUsd: -5 }), dir, fakeConfig()),
        /maxBudgetUsd must be a positive number/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects an empty task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(fakeRequest({ workspace: dir, task: "   " }), dir, fakeConfig()),
        /task is required/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("resolves the workspace to an absolute path on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(fakeRequest({ workspace: dir }), dir, fakeConfig());
      assert.equal(result.workspace, dir);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rejects context that combines the \"no prior context\" escape hatch with other details", async () => {
    // Regression: an orchestrator once submitted a follow-up job whose
    // context opened with "No prior context for this run, but this is a
    // follow-up to..." — self-contradictory, and a sign the real context was
    // reconstructed from memory rather than restated from the prior job.
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      await assert.rejects(
        validateRequest(
          fakeRequest({
            workspace: dir,
            context:
              "No prior context for this run, but this is a follow-up to a previous read-only Sonnet review of Nomad MR !133."
          }),
          dir,
          fakeConfig()
        ),
        /combines "no prior context" with other details/
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts the bare \"No prior context.\" escape hatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({ workspace: dir, context: "No prior context." }),
        dir,
        fakeConfig()
      );
      assert.equal(result.context, "No prior context.");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("accepts genuine follow-up context that doesn't use the escape-hatch phrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const result = await validateRequest(
        fakeRequest({
          workspace: dir,
          context: "Prior review of MR !133 found no issues; verify the Cognito teardown fix landed at HEAD."
        }),
        dir,
        fakeConfig()
      );
      assert.match(result.context ?? "", /Cognito teardown/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
