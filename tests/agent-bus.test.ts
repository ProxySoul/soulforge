import { describe, expect, test } from "bun:test";
import {
  AgentBus,
  normalizePath,
  type BusFinding,
  type SharedCache,
} from "../src/core/agents/agent-bus.js";

describe("normalizePath", () => {
  test("strips leading ./", () => {
    expect(normalizePath("./src/index.ts")).toBe("src/index.ts");
  });

  test("strips repeated leading ./", () => {
    expect(normalizePath("././foo.ts")).toBe("foo.ts");
  });

  test("collapses duplicate slashes", () => {
    expect(normalizePath("src//core///file.ts")).toBe("src/core/file.ts");
  });

  test("leaves clean paths alone", () => {
    expect(normalizePath("src/core/file.ts")).toBe("src/core/file.ts");
  });
});

// Battle-hardening — these inputs reach normalizePath through dispatch's
// targetFiles pipeline (subagent-tools.ts:539,541,737,763 + agent-runner.ts:344,351).
// Schema *should* block them at z.array(z.string()), but internal callers,
// programmatic invocation, and the auto-merge mutation at subagent-tools.ts:590-596
// can punch through. Crash signature for any failure here:
//   "undefined is not an object (evaluating 'n.startsWith')"  ← issue #59
describe("normalizePath — adversarial inputs (issue #59)", () => {
  // ── Non-string inputs: the literal #59 crash class ────────────────────
  test("undefined → empty string (no crash)", () => {
    expect(normalizePath(undefined as unknown as string)).toBe("");
  });
  test("null → empty string", () => {
    expect(normalizePath(null as unknown as string)).toBe("");
  });
  test("number → empty string", () => {
    expect(normalizePath(42 as unknown as string)).toBe("");
  });
  test("boolean → empty string", () => {
    expect(normalizePath(true as unknown as string)).toBe("");
  });
  test("object → empty string", () => {
    expect(normalizePath({} as unknown as string)).toBe("");
  });
  test("array → empty string", () => {
    expect(normalizePath([] as unknown as string)).toBe("");
  });
  test("Symbol → empty string", () => {
    expect(normalizePath(Symbol("x") as unknown as string)).toBe("");
  });
  test("NaN → empty string", () => {
    expect(normalizePath(Number.NaN as unknown as string)).toBe("");
  });

  // ── Empty-ish strings ─────────────────────────────────────────────────
  test("empty string → empty string", () => {
    expect(normalizePath("")).toBe("");
  });
  test("just './' → empty string (./ stripped, nothing left)", () => {
    expect(normalizePath("./")).toBe("");
  });
  test("'.' alone is left as-is (not a './' prefix)", () => {
    expect(normalizePath(".")).toBe(".");
  });
  test("'..' is left as-is — we don't resolve parent refs", () => {
    expect(normalizePath("..")).toBe("..");
  });

  // ── Windows / WSL path separators ─────────────────────────────────────
  test("Windows backslash path → forward slash", () => {
    expect(normalizePath("src\\core\\file.ts")).toBe("src/core/file.ts");
  });
  test("Windows drive letter preserved", () => {
    expect(normalizePath("C:\\Users\\eru\\foo.ts")).toBe("C:/Users/eru/foo.ts");
  });
  test("UNC path — leading double-backslash collapses to single slash", () => {
    // \\server\share\foo.ts → //server/share/foo.ts → /server/share/foo.ts
    // (We don't preserve UNC roots; tests asserts the normalization, not UNC semantics.)
    expect(normalizePath("\\\\server\\share\\foo.ts")).toBe("/server/share/foo.ts");
  });
  test("mixed separators normalize", () => {
    expect(normalizePath("src\\core/file.ts")).toBe("src/core/file.ts");
  });
  test("Windows './' equivalent '.\\'  is stripped", () => {
    expect(normalizePath(".\\src\\foo.ts")).toBe("src/foo.ts");
  });
  test("repeated Windows './' equivalents stripped", () => {
    expect(normalizePath(".\\.\\foo.ts")).toBe("foo.ts");
  });

  // ── POSIX absolute paths and macOS specifics ──────────────────────────
  test("POSIX absolute path preserved", () => {
    expect(normalizePath("/usr/local/bin/sf")).toBe("/usr/local/bin/sf");
  });
  test("macOS Library path preserved", () => {
    expect(normalizePath("/Users/eru/dev/bugRepro/main.swift")).toBe(
      "/Users/eru/dev/bugRepro/main.swift",
    );
  });
  test("absolute path with duplicate slashes collapses (root keeps single slash)", () => {
    expect(normalizePath("//usr//local///bin/sf")).toBe("/usr/local/bin/sf");
  });

  // ── Pathological strings that have crashed similar normalizers ────────
  test("very long path doesn't blow stack/regex", () => {
    const deep = `${"a/".repeat(2000)}leaf.ts`;
    expect(normalizePath(deep)).toBe(deep);
  });
  test("leading './' chain of 100 doesn't loop forever", () => {
    const chained = `${"./".repeat(100)}foo.ts`;
    expect(normalizePath(chained)).toBe("foo.ts");
  });
  test("string with embedded null byte stays intact (caller's job to validate)", () => {
    expect(normalizePath("src/foo\0.ts")).toBe("src/foo\0.ts");
  });
  test("unicode path preserved", () => {
    expect(normalizePath("src/café/файл.ts")).toBe("src/café/файл.ts");
  });
  test("emoji path preserved", () => {
    expect(normalizePath("src/🔥/foo.ts")).toBe("src/🔥/foo.ts");
  });
  test("path with spaces preserved", () => {
    expect(normalizePath("/Users/eru/My Documents/foo.ts")).toBe(
      "/Users/eru/My Documents/foo.ts",
    );
  });
  test("query-string-ish suffix preserved (we don't parse URLs)", () => {
    expect(normalizePath("./foo.ts?v=1")).toBe("foo.ts?v=1");
  });

  // ── The actual issue #59 trigger: array containing non-strings ────────
  // Mirrors what dispatch's subagent-tools.ts:541 does.
  test("array.map(normalizePath) survives undefined entries (sparse array)", () => {
    // sparse array — JSON-style hole that Zod doesn't catch reliably
    const sparse = ["src/a.ts", undefined as unknown as string, "src/b.ts"];
    const out = sparse.map((f) => normalizePath(f));
    expect(out).toEqual(["src/a.ts", "", "src/b.ts"]);
  });
  test("array with null entries doesn't throw", () => {
    const arr = [null as unknown as string, "src/b.ts", null as unknown as string];
    expect(() => arr.map((f) => normalizePath(f))).not.toThrow();
  });
  test("array with mixed types doesn't throw", () => {
    const arr = ["./src/a.ts", 0, false, "", "src/b.ts"] as unknown as string[];
    const out = arr.map((f) => normalizePath(f));
    expect(out).toEqual(["src/a.ts", "", "", "", "src/b.ts"]);
  });

  // ── Idempotency — normalize(normalize(x)) === normalize(x) ────────────
  test("idempotent on POSIX paths", () => {
    const inputs = ["./src/foo.ts", "src//foo.ts", "/abs/path.ts", "src/foo.ts"];
    for (const i of inputs) {
      expect(normalizePath(normalizePath(i))).toBe(normalizePath(i));
    }
  });
  test("idempotent on Windows paths", () => {
    const inputs = ["src\\foo.ts", "C:\\x\\y.ts", ".\\foo.ts"];
    for (const i of inputs) {
      expect(normalizePath(normalizePath(i))).toBe(normalizePath(i));
    }
  });
  test("idempotent on garbage", () => {
    const inputs = [undefined, null, 42, {}, []] as unknown[];
    for (const i of inputs) {
      const once = normalizePath(i as string);
      expect(normalizePath(once)).toBe(once);
    }
  });
});

describe("AgentBus — file cache", () => {
  test("miss → release → hit cycle", () => {
    const bus = new AgentBus();
    const r1 = bus.acquireFileRead("a1", "src/foo.ts");
    expect(r1.cached).toBe(false);
    if (r1.cached === false) {
      bus.releaseFileRead("src/foo.ts", "content-a", r1.gen);
    }

    const r2 = bus.acquireFileRead("a2", "src/foo.ts");
    expect(r2.cached).toBe(true);
    if (r2.cached === true) {
      expect(r2.content).toBe("content-a");
    }
  });

  test("waiter resolves when reader completes", async () => {
    const bus = new AgentBus();
    const r1 = bus.acquireFileRead("a1", "src/foo.ts");
    expect(r1.cached).toBe(false);

    const r2 = bus.acquireFileRead("a2", "src/foo.ts");
    expect(r2.cached).toBe("waiting");

    if (r1.cached === false) {
      bus.releaseFileRead("src/foo.ts", "hello", r1.gen);
    }

    if (r2.cached === "waiting") {
      const content = await r2.content;
      expect(content).toBe("hello");
    }
  });

  test("same agent re-acquiring own read returns miss with gen -1", () => {
    const bus = new AgentBus();
    bus.acquireFileRead("a1", "src/foo.ts");
    const r2 = bus.acquireFileRead("a1", "src/foo.ts");
    expect(r2.cached).toBe(false);
    if (r2.cached === false) {
      expect(r2.gen).toBe(-1);
    }
  });

  test("failFileRead clears entry and notifies waiters with null", async () => {
    const bus = new AgentBus();
    const r1 = bus.acquireFileRead("a1", "src/foo.ts");
    const r2 = bus.acquireFileRead("a2", "src/foo.ts");

    if (r1.cached === false) {
      bus.failFileRead("src/foo.ts", r1.gen);
    }

    if (r2.cached === "waiting") {
      const content = await r2.content;
      expect(content).toBeNull();
    }

    const r3 = bus.acquireFileRead("a3", "src/foo.ts");
    expect(r3.cached).toBe(false);
  });

  test("invalidateFile bumps gen and clears cache", () => {
    const bus = new AgentBus();
    const r1 = bus.acquireFileRead("a1", "src/foo.ts");
    if (r1.cached === false) {
      bus.releaseFileRead("src/foo.ts", "old", r1.gen);
    }

    bus.invalidateFile("src/foo.ts");

    const r2 = bus.acquireFileRead("a2", "src/foo.ts");
    expect(r2.cached).toBe(false);
  });

  test("updateFile makes subsequent reads hit cache", () => {
    const bus = new AgentBus();
    bus.updateFile("src/foo.ts", "new-content", "a1");

    const r = bus.acquireFileRead("a2", "src/foo.ts");
    expect(r.cached).toBe(true);
    if (r.cached === true) {
      expect(r.content).toBe("new-content");
    }
  });

  test("stale gen release is ignored", () => {
    const bus = new AgentBus();
    const r1 = bus.acquireFileRead("a1", "src/foo.ts");
    if (r1.cached === false) {
      bus.invalidateFile("src/foo.ts");
      bus.releaseFileRead("src/foo.ts", "stale", r1.gen);
    }

    const r2 = bus.acquireFileRead("a2", "src/foo.ts");
    expect(r2.cached).toBe(false);
  });

  test("getFileContent returns cached content", () => {
    const bus = new AgentBus();
    expect(bus.getFileContent("src/foo.ts")).toBeNull();
    bus.updateFile("src/foo.ts", "hello");
    expect(bus.getFileContent("src/foo.ts")).toBe("hello");
  });

  test("eviction removes oldest entries when byte limit exceeded", () => {
    const bus = new AgentBus();
    const bigContent = "x".repeat(40 * 1024 * 1024);
    bus.updateFile("src/old.ts", bigContent, "a1");
    bus.updateFile("src/new.ts", bigContent, "a1");

    expect(bus.getFileContent("src/old.ts")).toBeNull();
    expect(bus.getFileContent("src/new.ts")).toBe(bigContent);
  });
});

describe("AgentBus — shared cache constructor", () => {
  test("does NOT seed file cache from SharedCache (always read from disk)", () => {
    const shared: SharedCache = {
      files: new Map([["src/foo.ts", "pre-seeded"]]),
      toolResults: new Map(),
      findings: [],
    };
    const bus = new AgentBus(shared);
    const r = bus.acquireFileRead("a1", "src/foo.ts");
    // File content is never seeded — must always read from disk
    expect(r.cached).toBe(false);
    });

  test("pre-seeds findings from SharedCache", () => {
    const shared: SharedCache = {
      files: new Map(),
      toolResults: new Map(),
      findings: [{ agentId: "a1", label: "bug", content: "found it", timestamp: 1 }],
    };
    const bus = new AgentBus(shared);
    expect(bus.getFindings()).toHaveLength(1);
    expect(bus.getFindings()[0]?.label).toBe("bug");
  });
});

describe("AgentBus — edit lock", () => {
  test("first acquire is immediate", async () => {
    const bus = new AgentBus();
    const lock = await bus.acquireEditLock("a1", "src/foo.ts");
    expect(lock.owner).toBeNull();
    lock.release();
  });

  test("second acquire queues until first releases", async () => {
    const bus = new AgentBus();
    const lock1 = await bus.acquireEditLock("a1", "src/foo.ts");

    let lock2Resolved = false;
    const lock2Promise = bus.acquireEditLock("a2", "src/foo.ts").then((l) => {
      lock2Resolved = true;
      return l;
    });

    await Promise.resolve();
    expect(lock2Resolved).toBe(false);

    lock1.release();
    const lock2 = await lock2Promise;
    expect(lock2Resolved).toBe(true);
    expect(lock2.owner).toBe("a1");
    lock2.release();
  });

  test("double release is safe (idempotent)", async () => {
    const bus = new AgentBus();
    const lock = await bus.acquireEditLock("a1", "src/foo.ts");
    lock.release();
    lock.release();

    const lock2 = await bus.acquireEditLock("a2", "src/foo.ts");
    expect(lock2.owner).toBe("a1");
    lock2.release();
  });

  test("different files don't block each other", async () => {
    const bus = new AgentBus();
    const lock1 = await bus.acquireEditLock("a1", "src/foo.ts");
    const lock2 = await bus.acquireEditLock("a2", "src/bar.ts");
    expect(lock1.owner).toBeNull();
    expect(lock2.owner).toBeNull();
    lock1.release();
    lock2.release();
  });
});

describe("AgentBus — file claims", () => {
  test("first claim succeeds", () => {
    const bus = new AgentBus();
    expect(bus.claimFile("a1", "src/foo.ts")).toBe(true);
  });

  test("same agent can re-claim", () => {
    const bus = new AgentBus();
    bus.claimFile("a1", "src/foo.ts");
    expect(bus.claimFile("a1", "src/foo.ts")).toBe(true);
  });

  test("different agent cannot claim owned file", () => {
    const bus = new AgentBus();
    bus.claimFile("a1", "src/foo.ts");
    expect(bus.claimFile("a2", "src/foo.ts")).toBe(false);
  });

  test("getFileOwner returns owner", () => {
    const bus = new AgentBus();
    expect(bus.getFileOwner("src/foo.ts")).toBeNull();
    bus.claimFile("a1", "src/foo.ts");
    expect(bus.getFileOwner("src/foo.ts")).toBe("a1");
  });
});

describe("AgentBus — file read/edit tracking", () => {
  test("recordFileRead tracks per-agent", () => {
    const bus = new AgentBus();
    bus.recordFileRead("a1", "src/foo.ts");
    bus.recordFileRead("a1", "src/bar.ts");
    bus.recordFileRead("a2", "src/foo.ts");

    const all = bus.getFilesRead();
    expect(all.get("a1")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(all.get("a2")).toEqual(["src/foo.ts"]);

    const a1Only = bus.getFilesRead("a1");
    expect(a1Only.size).toBe(1);
  });

  test("getFileReadRecords returns detail records", () => {
    const bus = new AgentBus();
    bus.recordFileRead("a1", "src/foo.ts", { tool: "navigate", target: "Foo", cached: true });
    const records = bus.getFileReadRecords("a1");
    expect(records).toHaveLength(1);
    expect(records[0]?.tool).toBe("navigate");
    expect(records[0]?.target).toBe("Foo");
    expect(records[0]?.cached).toBe(true);
  });

  test("checkEditConflict detects cross-agent edits", () => {
    const bus = new AgentBus();
    bus.recordFileEdit("a1", "src/foo.ts");
    expect(bus.checkEditConflict("a1", "src/foo.ts")).toBeNull();
    expect(bus.checkEditConflict("a2", "src/foo.ts")).toBe("a1");
  });

  test("getEditedFiles groups by path", () => {
    const bus = new AgentBus();
    bus.recordFileEdit("a1", "src/foo.ts");
    bus.recordFileEdit("a2", "src/foo.ts");
    const all = bus.getEditedFiles();
    expect(all.get("src/foo.ts")).toEqual(["a1", "a2"]);
  });
});

describe("AgentBus — findings", () => {
  const mkFinding = (agentId: string, label: string, content = "c"): BusFinding => ({
    agentId,
    label,
    content,
    timestamp: Date.now(),
  });

  test("post and retrieve findings", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "issue-1", "detail"));
    expect(bus.findingCount).toBe(1);
    expect(bus.getFindings()[0]?.content).toBe("detail");
  });

  test("duplicate key updates in place", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "issue-1", "v1"));
    bus.postFinding(mkFinding("a1", "issue-1", "v2"));
    expect(bus.findingCount).toBe(1);
    expect(bus.getFindings()[0]?.content).toBe("v2");
  });

  test("excludeAgentId filters findings", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "f1"));
    bus.postFinding(mkFinding("a2", "f2"));
    expect(bus.getFindings("a1")).toHaveLength(1);
    expect(bus.getFindings("a1")[0]?.agentId).toBe("a2");
  });

  test("getPeerFindings returns only that peer", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "f1"));
    bus.postFinding(mkFinding("a2", "f2"));
    expect(bus.getPeerFindings("a1")).toHaveLength(1);
    expect(bus.getPeerFindings("a1")[0]?.label).toBe("f1");
  });

  test("content truncated to max bytes", () => {
    const bus = new AgentBus();
    const longContent = "x".repeat(5000);
    bus.postFinding(mkFinding("a1", "big", longContent));
    const f = bus.getFindings()[0];
    expect(f!.content.length).toBeLessThanOrEqual(2049);
  });

  test("total bytes cap prevents unbounded growth", () => {
    const bus = new AgentBus();
    for (let i = 0; i < 200; i++) {
      bus.postFinding(mkFinding(`a${i}`, `f${i}`, "x".repeat(2000)));
    }
    expect(bus.findingCount).toBeLessThan(200);
  });

  test("drainUnseenFindings returns only new findings", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "f1"));
    const first = bus.drainUnseenFindings("observer");
    expect(first).toContain("f1");

    const second = bus.drainUnseenFindings("observer");
    expect(second).toBeNull();

    bus.postFinding(mkFinding("a2", "f2"));
    const third = bus.drainUnseenFindings("observer");
    expect(third).toContain("f2");
    expect(third).not.toContain("f1");
  });

  test("drainUnseenFindings excludes own findings", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "mine"));
    const drained = bus.drainUnseenFindings("a1");
    expect(drained).toBeNull();
  });

  test("summarizeFindings formats all findings", () => {
    const bus = new AgentBus();
    bus.postFinding(mkFinding("a1", "f1", "detail-1"));
    bus.postFinding(mkFinding("a2", "f2", "detail-2"));
    const summary = bus.summarizeFindings();
    expect(summary).toContain("[a1] f1");
    expect(summary).toContain("detail-1");
    expect(summary).toContain("[a2] f2");
  });

  test("summarizeFindings empty returns message", () => {
    const bus = new AgentBus();
    expect(bus.summarizeFindings()).toContain("No findings");
  });
});

describe("AgentBus — agent results & dependencies", () => {
  test("setResult and getResult", () => {
    const bus = new AgentBus();
    bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "done", success: true });
    const r = bus.getResult("a1");
    expect(r?.success).toBe(true);
    expect(r?.result).toBe("done");
  });

  test("getAllResults returns all", () => {
    const bus = new AgentBus();
    bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "r1", success: true });
    bus.setResult({ agentId: "a2", role: "code", task: "t", result: "r2", success: true });
    expect(bus.getAllResults()).toHaveLength(2);
  });

  test("waitForAgent resolves immediately if result exists", async () => {
    const bus = new AgentBus();
    bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "ok", success: true });
    const r = await bus.waitForAgent("a1");
    expect(r.result).toBe("ok");
  });

  test("waitForAgent waits for completion", async () => {
    const bus = new AgentBus();
    const promise = bus.waitForAgent("a1");

    setTimeout(() => {
      bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "done", success: true });
    }, 10);

    const r = await promise;
    expect(r.result).toBe("done");
  });

  test("waitForAgent rejects on failed dependency", () => {
    const bus = new AgentBus();
    bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "err", success: false, error: "boom" });
    expect(bus.waitForAgent("a1")).rejects.toThrow("boom");
  });

  test("waitForAgent rejects on timeout", () => {
    const bus = new AgentBus();
    expect(bus.waitForAgent("a1", 50)).rejects.toThrow("Timed out");
  });

  test("completedAgentIds tracks completed agents", () => {
    const bus = new AgentBus();
    expect(bus.completedAgentIds).toEqual([]);
    bus.setResult({ agentId: "a1", role: "explore", task: "t", result: "ok", success: true });
    expect(bus.completedAgentIds).toEqual(["a1"]);
  });
});

describe("AgentBus — tool result cache", () => {
  test("miss → store → hit cycle", () => {
    const bus = new AgentBus();
    const key = JSON.stringify(["grep", "foo", ""]);

    const r1 = bus.acquireToolResult("a1", key);
    expect(r1.hit).toBe(false);

    bus.cacheToolResult("a1", key, "3 matches");

    const r2 = bus.acquireToolResult("a2", key);
    expect(r2.hit).toBe(true);
    if (r2.hit === true) {
      expect(r2.result).toBe("3 matches");
    }
  });

  test("tool result waiters get notified", async () => {
    const bus = new AgentBus();
    const key = JSON.stringify(["navigate", "Foo", ""]);

    bus.acquireToolResult("a1", key);

    const r2 = bus.acquireToolResult("a2", key);
    expect(r2.hit).toBe("waiting");

    bus.cacheToolResult("a1", key, "definition found");

    if (r2.hit === "waiting") {
      const result = await r2.result;
      expect(result).toBe("definition found");
    }
  });

  test("invalidateFile clears related tool results", () => {
    const bus = new AgentBus();
    const key = JSON.stringify(["analyze", "src/foo.ts"]);
    bus.acquireToolResult("a1", key);
    bus.cacheToolResult("a1", key, "analysis");

    bus.invalidateFile("src/foo.ts");

    const r = bus.acquireToolResult("a2", key);
    expect(r.hit).toBe(false);
  });
});

describe("AgentBus — peer objectives", () => {
  test("getPeerObjectives excludes self", () => {
    const bus = new AgentBus();
    bus.registerTasks([
      { agentId: "a1", role: "explore", task: "find bugs" },
      { agentId: "a2", role: "code", task: "fix them" },
    ]);
    const peers = bus.getPeerObjectives("a1");
    expect(peers).toContain("a2");
    expect(peers).not.toContain("a1");
  });

  test("getPeerObjectives empty when solo", () => {
    const bus = new AgentBus();
    bus.registerTasks([{ agentId: "a1", role: "explore", task: "solo" }]);
    expect(bus.getPeerObjectives("a1")).toBe("");
  });
});

describe("AgentBus — circuit breaker", () => {
  test("trips after threshold failures in window", () => {
    const bus = new AgentBus();
    for (let i = 0; i < 5; i++) {
      expect(bus.recordProviderFailure()).toBe(false);
    }
    expect(bus.recordProviderFailure()).toBe(true);
    expect(bus.abortSignal.aborted).toBe(true);
  });
});

describe("AgentBus — dispose & abort", () => {
  test("abort signals all waiters", async () => {
    const bus = new AgentBus();
    bus.acquireFileRead("a1", "src/foo.ts");
    const r = bus.acquireFileRead("a2", "src/foo.ts");

    bus.abort("test");

    if (r.cached === "waiting") {
      const content = await r.content;
      expect(content).toBeNull();
    }
    expect(bus.abortSignal.aborted).toBe(true);
  });

  test("dispose drains edit lock queues", async () => {
    const bus = new AgentBus();
    await bus.acquireEditLock("a1", "src/foo.ts");

    let resolved = false;
    bus.acquireEditLock("a2", "src/foo.ts").then(() => {
      resolved = true;
    });

    bus.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

describe("AgentBus — exportCaches", () => {
  test("does NOT export file cache entries (always read from disk)", () => {
    const bus = new AgentBus();
    bus.updateFile("src/a.ts", "aaa");
    bus.updateFile("src/b.ts", "bbb");

    const exported = bus.exportCaches();
    // File content is never exported — prevents stale reads across dispatches
    expect(exported.files.size).toBe(0);
  });

  test("exports findings", () => {
    const bus = new AgentBus();
    bus.postFinding({ agentId: "a1", label: "f1", content: "c", timestamp: 1 });

    const exported = bus.exportCaches();
    expect(exported.findings).toHaveLength(1);
  });

  test("excludes expired tool results", () => {
    const bus = new AgentBus();
    const key = JSON.stringify(["grep", "foo", ""]);
    bus.acquireToolResult("a1", key);
    bus.cacheToolResult("a1", key, "result");

    const exported = bus.exportCaches();
    expect(exported.toolResults.size).toBe(1);
  });
});

describe("AgentBus — metrics", () => {
  test("tracks file cache hits and misses", () => {
    const bus = new AgentBus();
    bus.acquireFileRead("a1", "src/foo.ts");
    expect(bus.metrics.fileMisses).toBe(1);

    bus.releaseFileRead("src/foo.ts", "c", 0);
    bus.acquireFileRead("a2", "src/foo.ts");
    expect(bus.metrics.fileHits).toBe(1);
  });

  test("tracks file waits", () => {
    const bus = new AgentBus();
    bus.acquireFileRead("a1", "src/foo.ts");
    bus.acquireFileRead("a2", "src/foo.ts");
    expect(bus.metrics.fileWaits).toBe(1);
  });

  test("tracks tool cache hits and misses", () => {
    const bus = new AgentBus();
    const key = JSON.stringify(["grep", "x", ""]);
    bus.acquireToolResult("a1", key);
    expect(bus.metrics.toolMisses).toBe(1);
    bus.cacheToolResult("a1", key, "r");
    bus.acquireToolResult("a2", key);
    expect(bus.metrics.toolHits).toBe(1);
  });
});
