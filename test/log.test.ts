import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logJobEvent, rotateLogIfOversized } from "../src/log.js";

describe("rotateLogIfOversized", () => {
  it("leaves the log alone when it's under the size cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const logPath = join(dir, "pi-minion.log");
      const rotatedPath = join(dir, "pi-minion.log.1");
      await writeFile(logPath, "small\n");

      await rotateLogIfOversized(logPath, rotatedPath, 1_000);

      assert.equal(await readFile(logPath, "utf8"), "small\n");
      await assert.rejects(stat(rotatedPath));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("rotates the oversized log to .1 and leaves a fresh file for the next write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const logPath = join(dir, "pi-minion.log");
      const rotatedPath = join(dir, "pi-minion.log.1");
      await writeFile(logPath, "old content\n");

      await rotateLogIfOversized(logPath, rotatedPath, 1);

      assert.equal(await readFile(rotatedPath, "utf8"), "old content\n");
      await assert.rejects(stat(logPath));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("overwrites an existing .1 rather than accumulating a .2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const logPath = join(dir, "pi-minion.log");
      const rotatedPath = join(dir, "pi-minion.log.1");
      await writeFile(rotatedPath, "stale backup\n");
      await writeFile(logPath, "newer content\n");

      await rotateLogIfOversized(logPath, rotatedPath, 1);

      assert.equal(await readFile(rotatedPath, "utf8"), "newer content\n");
      await assert.rejects(stat(join(dir, "pi-minion.log.2")));
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("no-ops when there's no log file yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const logPath = join(dir, "pi-minion.log");
      const rotatedPath = join(dir, "pi-minion.log.1");

      await assert.doesNotReject(rotateLogIfOversized(logPath, rotatedPath, 1));
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("logJobEvent", () => {
  it("appends one terse line with status/job_id/model, and an optional detail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-minion-test-"));
    try {
      const logPath = join(dir, "pi-minion.log");
      const rotatedPath = join(dir, "pi-minion.log.1");

      await logJobEvent(
        "exited",
        { id: "job-1", model: "sonnet", detail: "exit_code=0 signal=none" },
        logPath,
        rotatedPath
      );

      const content = await readFile(logPath, "utf8");
      assert.match(content, /status=exited job_id=job-1 model=sonnet exit_code=0 signal=none\n$/);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("never throws, even when the log path is unwritable", async () => {
    await assert.doesNotReject(
      logJobEvent(
        "started",
        { id: "job-1", model: "sonnet" },
        "/nonexistent-dir/that/cannot/exist/pi-minion.log",
        "/nonexistent-dir/that/cannot/exist/pi-minion.log.1"
      )
    );
  });
});
