import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// MINION_DIR is resolved from $HOME when the loader module is first evaluated,
// so this file overrides HOME and only then imports it. node --test runs each
// file in its own process, so the override cannot leak into another file and
// no real user directory is ever read or written.
const home = await mkdtemp(join(tmpdir(), "pi-minion-home-"));
process.env.HOME = home;

const { MINION_DIR, listMinions, resolveMinion } = await import("../src/minions.js");

type Logged = { event: string; id: string; model: string; detail?: string };
const logs: Logged[] = [];
const log = (...args: [Logged["event"], Omit<Logged, "event">]): void => {
  logs.push({ event: args[0], ...args[1] });
};

const FILE = (description: string) => `---
description: ${description}
model: sonnet
---
body
`;

const MINIONS = join(home, ".pi", "agent", "pi-minion", "minions");
const AGENTS = join(home, ".pi", "agent", "pi-minion", "agents");

describe("default definition directory", () => {
  before(async () => {
    await mkdir(MINIONS, { recursive: true });
    await mkdir(AGENTS, { recursive: true });
    await writeFile(join(MINIONS, "review.md"), FILE("From the minions directory"), "utf8");
    await writeFile(join(AGENTS, "legacy.md"), FILE("From the legacy agents directory"), "utf8");
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("points at ~/.pi/agent/pi-minion/minions/", () => {
    assert.equal(MINION_DIR, MINIONS);
  });

  it("reads definitions from the minions/ directory", async () => {
    assert.deepEqual(await listMinions(undefined, log), [
      { name: "review", description: "From the minions directory" }
    ]);
    assert.equal((await resolveMinion("review", undefined, log)).body, "body");
  });

  it("ignores definitions left in the legacy agents/ directory", async () => {
    const names = (await listMinions(undefined, log)).map((minion) => minion.name);
    assert.ok(!names.includes("legacy"), "agents/ definitions must not be listed");
    await assert.rejects(resolveMinion("legacy", undefined, log), (error: Error) => {
      assert.match(error.message, /Unknown minion "legacy"/);
      assert.match(error.message, /Available minions: review\./);
      return true;
    });
    // Ignored means not even scanned: nothing under agents/ is reported broken.
    assert.deepEqual(logs, []);
  });
});
