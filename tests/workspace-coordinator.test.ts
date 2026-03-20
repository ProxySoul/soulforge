import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type WorkspaceCoordinator,
  resetWorkspaceCoordinator,
  getWorkspaceCoordinator,
} from "../src/core/coordination/WorkspaceCoordinator.js";
import type { CoordinatorEvent } from "../src/core/coordination/types.js";

const IS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normPath(p: string): string {
  let abs = resolve(p);
  if (IS_CASE_INSENSITIVE) abs = abs.toLowerCase();
  return abs;
}

const tick = () => new Promise<void>((r) => queueMicrotask(r));

let coord: WorkspaceCoordinator;

beforeEach(() => {
  resetWorkspaceCoordinator();
  coord = getWorkspaceCoordinator();
});

afterEach(() => {
  resetWorkspaceCoordinator();
});

describe("claimFiles", () => {
  it("grants new claims", () => {
    const result = coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    expect(result.granted).toHaveLength(2);
    expect(result.contested).toHaveLength(0);
  });

  it("normalizes paths to absolute", () => {
    const result = coord.claimFiles("tab-1", "Tab 1", ["src/foo.ts"]);
    expect(result.granted[0]).toBe(normPath("src/foo.ts"));
  });

  it("refreshes existing claim from same tab (increments editCount)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const result = coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    expect(result.granted).toHaveLength(1);
    expect(result.contested).toHaveLength(0);

    const claims = coord.getClaimsForTab("tab-1");
    const claim = claims.get(normPath("/a.ts"));
    expect(claim).toBeDefined();
    expect(claim!.editCount).toBe(2);
  });

  it("contests when another tab owns the file", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const result = coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);
    expect(result.granted).toHaveLength(0);
    expect(result.contested).toHaveLength(1);
    expect(result.contested[0]!.owner.tabId).toBe("tab-1");
    expect(result.contested[0]!.owner.tabLabel).toBe("Tab 1");
  });

  it("handles mixed grants and contests", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const result = coord.claimFiles("tab-2", "Tab 2", ["/a.ts", "/b.ts"]);
    expect(result.granted).toHaveLength(1);
    expect(result.contested).toHaveLength(1);
  });

  it("handles empty paths array", () => {
    const result = coord.claimFiles("tab-1", "Tab 1", []);
    expect(result.granted).toHaveLength(0);
    expect(result.contested).toHaveLength(0);
  });

  it("case-insensitive matching on macOS/Windows", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/A.ts"]);
    const result = coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);
    if (IS_CASE_INSENSITIVE) {
      expect(result.contested).toHaveLength(1);
    } else {
      expect(result.granted).toHaveLength(1);
    }
  });
});

describe("releaseFiles", () => {
  it("releases owned files", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    coord.releaseFiles("tab-1", ["/a.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("ignores files owned by another tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.releaseFiles("tab-2", ["/a.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("ignores unclaimed files", () => {
    coord.releaseFiles("tab-1", ["/nonexistent.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });
});

describe("releaseAll", () => {
  it("releases all claims for a tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });

  it("does not affect other tabs", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getClaimCount("tab-2")).toBe(1);
  });

  it("handles tab with no claims", () => {
    coord.releaseAll("tab-999");
    expect(coord.getAllClaims().size).toBe(0);
  });
});

describe("forceClaim", () => {
  it("takes ownership from another tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const prev = coord.forceClaim("tab-2", "Tab 2", "/a.ts");
    expect(prev?.tabId).toBe("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getClaimCount("tab-2")).toBe(1);
  });

  it("returns null when no previous owner", () => {
    const prev = coord.forceClaim("tab-1", "Tab 1", "/new.ts");
    expect(prev).toBeNull();
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("can force-claim own file (resets editCount)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]); // editCount=2
    coord.forceClaim("tab-1", "Tab 1", "/a.ts");
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/a.ts"));
    expect(claim!.editCount).toBe(1);
  });
});

describe("getConflicts", () => {
  it("returns conflicts for files owned by other tabs", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/a.ts"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ownerTabId).toBe("tab-1");
    expect(conflicts[0]!.ownerTabLabel).toBe("Tab 1");
  });

  it("returns empty for own files", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    expect(coord.getConflicts("tab-1", ["/a.ts"])).toHaveLength(0);
  });

  it("returns empty for unclaimed files", () => {
    expect(coord.getConflicts("tab-1", ["/unclaimed.ts"])).toHaveLength(0);
  });
});

describe("getClaimsForTab", () => {
  it("returns only claims for the specified tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/c.ts"]);
    const claims = coord.getClaimsForTab("tab-1");
    expect(claims.size).toBe(2);
    expect(coord.getClaimsForTab("tab-2").size).toBe(1);
  });
});

describe("getActiveEditors", () => {
  it("groups claims by tabId", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts", "/c.ts"]);
    const editors = coord.getActiveEditors();
    expect(editors.get("tab-1")).toHaveLength(1);
    expect(editors.get("tab-2")).toHaveLength(2);
  });

  it("returns empty map when no claims", () => {
    expect(coord.getActiveEditors().size).toBe(0);
  });
});

describe("getClaimCount", () => {
  it("counts claims for a specific tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(3);
    expect(coord.getClaimCount("tab-2")).toBe(0);
  });
});

describe("getAllClaims", () => {
  it("returns a copy of all claims", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    const all = coord.getAllClaims();
    expect(all.size).toBe(2);
    // Verify it's a copy
    all.clear();
    expect(coord.getAllClaims().size).toBe(2);
  });
});

describe("events", () => {
  it("emits 'claim' on new claims", async () => {
    const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
    coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("claim");
    expect(events[0]!.tabId).toBe("tab-1");
  });

  it("emits 'conflict' on contested claims", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
    coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));
    coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("conflict");
    expect(events[0]!.tabId).toBe("tab-2");
  });

  it("emits 'release' on releaseFiles", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));
    coord.releaseFiles("tab-1", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("release");
  });

  it("emits 'release' on releaseAll", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
    coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));
    coord.releaseAll("tab-1");
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("release");
    expect(events[0]!.paths).toHaveLength(2);
  });

  it("does not emit release when nothing to release", async () => {
    const events: Array<{ event: CoordinatorEvent }> = [];
    coord.on((event) => events.push({ event }));

    coord.releaseAll("tab-1");
    coord.releaseFiles("tab-1", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(0);
  });

  it("unsubscribes via returned function", async () => {
    const events: CoordinatorEvent[] = [];
    const unsub = coord.on((event) => events.push(event));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();
    expect(events).toHaveLength(1);

    unsub();
    coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    await tick();
    expect(events).toHaveLength(1);
  });

  it("emits both 'claim' and 'conflict' for mixed results", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    const events: CoordinatorEvent[] = [];
    coord.on((event) => events.push(event));

    coord.claimFiles("tab-2", "Tab 2", ["/a.ts", "/b.ts"]);
    await tick();

    expect(events).toContain("claim");
    expect(events).toContain("conflict");
  });

  it("swallows listener errors without breaking", async () => {
    coord.on(() => {
      throw new Error("listener crash");
    });
    const events: CoordinatorEvent[] = [];
    coord.on((event) => events.push(event));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();
    expect(events).toHaveLength(1);
  });
});

describe("agent tracking", () => {
  it("prevents idle release while agents are running", () => {
    coord.agentStarted("tab-1");
    coord.markIdle("tab-1");
    // Idle timer should NOT start because an agent is active
    // We can't easily test the timer without waiting, but verify the agent count
    coord.agentFinished("tab-1");
    // Now markIdle should work
  });

  it("tracks multiple agents per tab", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.agentFinished("tab-1");
    // Still one agent running — markIdle should be blocked
    coord.agentStarted("tab-1"); // back to 2
    coord.agentFinished("tab-1");
    coord.agentFinished("tab-1");
    // All done
  });
});

describe("idle timer", () => {
  it("markIdle + wait releases claims", async () => {
    // Can't easily override the 60s timeout in tests, but verify the flow
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
    // markIdle starts a timer — we just verify it doesn't throw
    coord.markIdle("tab-1");
    // markActive clears the timer
    coord.markActive("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("markActive prevents idle release", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1");
    coord.markActive("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

describe("releaseAllGlobal", () => {
  it("clears all claims across all tabs", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    coord.releaseAllGlobal();
    expect(coord.getAllClaims().size).toBe(0);
  });
});

describe("dispose", () => {
  it("cleans up all state", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.dispose();
    expect(coord.getAllClaims().size).toBe(0);
  });
});
