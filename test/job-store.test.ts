import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindSessionApi,
  holdPostsFor,
  jobIdsOwnedBySession,
  jobMeta,
  jobs,
  postToSession,
  rehomeJobs,
  releaseSessionApi,
  relevantJobsForSession,
  resolveOwnedJob,
  resolveSessionId,
  sessionApi
} from "../src/job-store.js";
import type { JobMetaEntry } from "../src/job-types.js";

describe("jobIdsOwnedBySession", () => {
  it("selects only jobs started by the given session", () => {
    const jobs = new Map([
      ["job-a", { sessionId: "session-1", status: "running" }],
      ["job-b", { sessionId: "session-2", status: "running" }],
      ["job-c", { sessionId: "session-1", status: "running" }]
    ]);
    assert.deepEqual(jobIdsOwnedBySession(jobs, "session-1"), ["job-a", "job-c"]);
  });

  it("returns nothing when no job belongs to the disposing session", () => {
    // Regression: a subagent's own short-lived session firing "quit" once its
    // turn ends must not reap a job started by a different, still-running
    // session — extensions load once per process and the jobs map is shared
    // across every session.
    const jobs = new Map([["job-a", { sessionId: "owner-session", status: "running" }]]);
    assert.deepEqual(jobIdsOwnedBySession(jobs, "unrelated-subagent-session"), []);
  });

  it("returns an empty array for an empty jobs map", () => {
    assert.deepEqual(jobIdsOwnedBySession(new Map(), "session-1"), []);
  });

  it("excludes a job that has exited and is finalizing its result", () => {
    // Regression: a job whose process already closed but hasn't posted its
    // result yet must not be swept as if it were still running.
    const jobs = new Map([["job-a", { sessionId: "session-1", status: "finalizing" }]]);
    assert.deepEqual(jobIdsOwnedBySession(jobs, "session-1"), []);
  });
});

function fakeJobMetaEntry(overrides: Partial<JobMetaEntry> = {}): JobMetaEntry {
  return {
    title: "pi minion task",
    model: "sonnet",
    prompt: "task text",
    workspace: "/tmp/workspace",
    sessionId: "session-1",
    status: "running",
    ...overrides
  };
}

describe("relevantJobsForSession", () => {
  it("includes both running and recently finished jobs owned by the session in the workspace", () => {
    const jobMeta = new Map([
      ["job-running", fakeJobMetaEntry({ status: "running" })],
      [
        "job-done",
        fakeJobMetaEntry({
          status: "done",
          finishedAt: Date.now(),
          reportPath: "/tmp/workspace-job/result.md"
        })
      ]
    ]);
    const result = relevantJobsForSession(jobMeta, "session-1", "/tmp/workspace");
    assert.deepEqual(
      result.map((job) => job.id),
      ["job-running", "job-done"]
    );
    assert.equal(result[1].reportPath, "/tmp/workspace-job/result.md");
  });

  it("excludes jobs owned by a different session", () => {
    const jobMeta = new Map([["job-a", fakeJobMetaEntry({ sessionId: "other-session" })]]);
    assert.deepEqual(relevantJobsForSession(jobMeta, "session-1", "/tmp/workspace"), []);
  });

  it("excludes jobs started in a different workspace", () => {
    const jobMeta = new Map([["job-a", fakeJobMetaEntry({ workspace: "/tmp/other-workspace" })]]);
    assert.deepEqual(relevantJobsForSession(jobMeta, "session-1", "/tmp/workspace"), []);
  });

  it("returns an empty array for an empty jobMeta map", () => {
    assert.deepEqual(relevantJobsForSession(new Map(), "session-1", "/tmp/workspace"), []);
  });
});

describe("resolveOwnedJob", () => {
  it("returns true when the job exists, is owned by the given session, and is running", () => {
    const jobs = new Map([["job-a", { sessionId: "session-1", status: "running" }]]);
    assert.equal(resolveOwnedJob(jobs, "job-a", "session-1"), true);
  });

  it("returns false when the job exists but is owned by a different session", () => {
    const jobs = new Map([["job-a", { sessionId: "session-1", status: "running" }]]);
    assert.equal(resolveOwnedJob(jobs, "job-a", "session-2"), false);
  });

  it("returns false when the job id doesn't exist in the map", () => {
    const jobs = new Map([["job-a", { sessionId: "session-1", status: "running" }]]);
    assert.equal(resolveOwnedJob(jobs, "job-missing", "session-1"), false);
  });

  it("returns false for an empty jobs map", () => {
    assert.equal(resolveOwnedJob(new Map(), "job-a", "session-1"), false);
  });

  it("returns false when the job has exited and is finalizing its result", () => {
    // Regression: a job in the gap between process exit and result posting
    // is no longer cancellable — it's not "not found", it's just done.
    const jobs = new Map([["job-a", { sessionId: "session-1", status: "finalizing" }]]);
    assert.equal(resolveOwnedJob(jobs, "job-a", "session-1"), false);
  });
});

describe("session api registry", () => {
  it("returns the bound handle and releases only the same one", () => {
    const oldPi = {} as any;
    const newPi = {} as any;
    bindSessionApi("s-reg", oldPi);
    bindSessionApi("s-reg", newPi); // /reload keeps the id, rebinds a fresh pi
    releaseSessionApi("s-reg", oldPi); // late shutdown from the old instance
    assert.equal(sessionApi("s-reg"), newPi);
    releaseSessionApi("s-reg", newPi);
    assert.equal(sessionApi("s-reg"), undefined);
  });
});

describe("rehomeJobs", () => {
  it("moves only the replaced session's jobs and metadata", () => {
    jobs.set("j-a", { sessionId: "old" } as any);
    jobs.set("j-b", { sessionId: "other" } as any);
    jobMeta.set("j-a", { sessionId: "old" } as any);
    rehomeJobs("old", "new");
    assert.equal(jobs.get("j-a")!.sessionId, "new");
    assert.equal(jobs.get("j-b")!.sessionId, "other");
    assert.equal(jobMeta.get("j-a")!.sessionId, "new");
    jobs.delete("j-a");
    jobs.delete("j-b");
    jobMeta.delete("j-a");
  });
});

describe("postToSession", () => {
  it("appends a display entry and sends the message through the session's current handle", () => {
    const calls: unknown[][] = [];
    bindSessionApi("ps1", {
      appendEntry: (...args: unknown[]) => calls.push(["entry", ...args]),
      sendMessage: (...args: unknown[]) => calls.push(["message", ...args])
    } as any);
    postToSession("ps1", "hello", { id: "x" }, false);
    assert.equal(calls.length, 2);
    assert.deepEqual((calls[1][2] as any).triggerTurn, false);
    assert.equal((calls[1][1] as any).content, "hello");
  });

  it("splits the display entry's content from the model-facing message", () => {
    const calls: unknown[][] = [];
    bindSessionApi("ps-split", {
      appendEntry: (...args: unknown[]) => calls.push(["entry", ...args]),
      sendMessage: (...args: unknown[]) => calls.push(["message", ...args])
    } as any);
    postToSession("ps-split", "context body", { id: "y" }, false, "display body");
    const entry = calls.find((c) => c[0] === "entry")!;
    const message = calls.find((c) => c[0] === "message")!;
    assert.equal((entry[2] as any).content, "display body");
    assert.equal((message[1] as any).content, "context body");
  });

  it("is a no-op without a handle and swallows a stale handle's throw", () => {
    postToSession("no-such-session", "x", {}, true);
    bindSessionApi("ps2", {
      appendEntry: () => {
        throw new Error("stale");
      }
    } as any);
    postToSession("ps2", "x", {}, true);
  });
});

describe("posts during a session replacement", () => {
  const recorder = () => {
    const sent: Array<{ content: string; triggerTurn: boolean }> = [];
    const pi = {
      appendEntry: () => {},
      sendMessage: (message: any, opts: any) => sent.push({ content: message.content, triggerTurn: opts.triggerTurn })
    } as any;
    return { sent, pi };
  };

  it("holds a post made between shutdown and the replacement's start, then delivers it there", () => {
    const old = recorder();
    bindSessionApi("old-1", old.pi);
    releaseSessionApi("old-1", old.pi);
    holdPostsFor("old-1");
    postToSession("old-1", "summary", {}, true);
    rehomeJobs("old-1", "new-1");
    const next = recorder();
    bindSessionApi("new-1", next.pi);
    assert.deepEqual(next.sent, [{ content: "summary", triggerTurn: true }]);
    assert.equal(old.sent.length, 0);
  });

  it("resolves a replaced session id to its replacement, so a late post follows the user", () => {
    rehomeJobs("chain-a", "chain-b");
    rehomeJobs("chain-b", "chain-c");
    assert.equal(resolveSessionId("chain-a"), "chain-c");
    const next = recorder();
    bindSessionApi("chain-c", next.pi);
    postToSession("chain-a", "late", {}, false);
    assert.deepEqual(next.sent, [{ content: "late", triggerTurn: false }]);
  });

  it("holds and flushes across /reload, where the session id doesn't change", () => {
    const first = recorder();
    bindSessionApi("reload-1", first.pi);
    releaseSessionApi("reload-1", first.pi);
    holdPostsFor("reload-1");
    postToSession("reload-1", "during reload", {}, true);
    rehomeJobs("reload-1", "reload-1");
    assert.equal(resolveSessionId("reload-1"), "reload-1");
    const second = recorder();
    bindSessionApi("reload-1", second.pi);
    assert.deepEqual(second.sent, [{ content: "during reload", triggerTurn: true }]);
  });

  it("carries a distinct display content through a held post", () => {
    const held = { pi: { appendEntry: () => {}, sendMessage: () => {} } as any };
    bindSessionApi("hold-d", held.pi);
    releaseSessionApi("hold-d", held.pi);
    holdPostsFor("hold-d");
    postToSession("hold-d", "ctx", {}, true, "disp");
    const received: string[] = [];
    const sent: string[] = [];
    bindSessionApi("hold-d", {
      appendEntry: (_t: any, entry: any) => received.push(entry.content),
      sendMessage: (msg: any) => sent.push(msg.content)
    } as any);
    assert.deepEqual(received, ["disp"]);
    assert.deepEqual(sent, ["ctx"]);
  });

  it("drops a post for a session that ended rather than queueing it forever", () => {
    const ended = recorder();
    bindSessionApi("quit-1", ended.pi);
    releaseSessionApi("quit-1", ended.pi);
    postToSession("quit-1", "too late", {}, true);
    const rebound = recorder();
    bindSessionApi("quit-1", rebound.pi);
    assert.equal(rebound.sent.length, 0);
  });
});
