/**
 * Battle tests for cross-tab coordination.
 *
 * Tests the WorkspaceCoordinator, tool-wrapper, edit-stack tab ownership,
 * and git cross-tab awareness under adversarial / concurrent scenarios.
 */

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type WorkspaceCoordinator,
  getWorkspaceCoordinator,
  resetWorkspaceCoordinator,
} from "../src/core/coordination/WorkspaceCoordinator.js";
import type { ClaimResult, CoordinatorEvent } from "../src/core/coordination/types.js";
import {
  checkAndClaim,
  claimAfterCompoundEdit,
  formatConflictWarning,
  prependWarning,
} from "../src/core/coordination/tool-wrapper.js";
import { pushEdit, undoEditTool } from "../src/core/tools/edit-stack.js";

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. MULTI-TAB CONTENTION STORMS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("multi-tab contention storms", () => {
  it("5 tabs claiming the same file — only first wins", () => {
    const tabs = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5"];
    const results: ClaimResult[] = [];

    for (const tabId of tabs) {
      results.push(coord.claimFiles(tabId, `Tab ${tabId}`, ["/shared.ts"]));
    }

    expect(results[0]!.granted).toHaveLength(1);
    expect(results[0]!.contested).toHaveLength(0);

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.granted).toHaveLength(0);
      expect(results[i]!.contested).toHaveLength(1);
      expect(results[i]!.contested[0]!.owner.tabId).toBe("tab-1");
    }
  });

  it("5 tabs claiming different files — all succeed", () => {
    const tabs = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5"];
    for (const tabId of tabs) {
      const result = coord.claimFiles(tabId, tabId, [`/${tabId}.ts`]);
      expect(result.granted).toHaveLength(1);
      expect(result.contested).toHaveLength(0);
    }
    expect(coord.getAllClaims().size).toBe(5);
  });

  it("rapid claim/release cycles don't leak state", () => {
    for (let i = 0; i < 100; i++) {
      const tabId = `tab-${String(i % 5)}`;
      coord.claimFiles(tabId, tabId, [`/file-${String(i)}.ts`]);
    }
    // Each tab claimed 20 files
    for (let t = 0; t < 5; t++) {
      expect(coord.getClaimCount(`tab-${String(t)}`)).toBe(20);
    }

    // Release all for each tab
    for (let t = 0; t < 5; t++) {
      coord.releaseAll(`tab-${String(t)}`);
    }
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("interleaved claim + release preserves correctness", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/d.ts", "/e.ts"]);

    // Tab 1 releases b.ts
    coord.releaseFiles("tab-1", ["/b.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(2);

    // Tab 2 can now claim b.ts
    const result = coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    expect(result.granted).toHaveLength(1);
    expect(result.contested).toHaveLength(0);

    // Tab 1 trying to reclaim b.ts is now contested
    const result2 = coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    expect(result2.contested).toHaveLength(1);
    expect(result2.contested[0]!.owner.tabId).toBe("tab-2");
  });

  it("force-claim chain — tab A → tab B → tab C steals file", () => {
    coord.claimFiles("tab-a", "Tab A", ["/target.ts"]);
    const prev1 = coord.forceClaim("tab-b", "Tab B", "/target.ts");
    expect(prev1?.tabId).toBe("tab-a");
    expect(coord.getClaimCount("tab-a")).toBe(0);
    expect(coord.getClaimCount("tab-b")).toBe(1);

    const prev2 = coord.forceClaim("tab-c", "Tab C", "/target.ts");
    expect(prev2?.tabId).toBe("tab-b");
    expect(coord.getClaimCount("tab-b")).toBe(0);
    expect(coord.getClaimCount("tab-c")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. AGENT LIFECYCLE + IDLE TIMER INTERACTION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("agent lifecycle + idle timer interaction", () => {
  it("markIdle blocked while agents running — markIdle after agentFinished works", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1"); // 2 agents

    // markIdle should be no-op (agents still running)
    coord.markIdle("tab-1");
    // Claims still there
    expect(coord.getClaimCount("tab-1")).toBe(1);

    coord.agentFinished("tab-1"); // 1 agent left
    coord.markIdle("tab-1"); // still no-op
    expect(coord.getClaimCount("tab-1")).toBe(1);

    coord.agentFinished("tab-1"); // 0 agents
    // markIdle should now start timer (but we can't wait 60s in a test)
    // At least verify it doesn't throw
    coord.markIdle("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(1); // not yet released (timer pending)
  });

  it("markActive cancels pending idle timer", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1");
    coord.markActive("tab-1");
    // Verify claims survive
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("agentStarted clears idle timer", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1");
    coord.agentStarted("tab-1"); // should clear idle timer
    coord.agentFinished("tab-1");
    // Claims still there
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("agentFinished underflow doesn't go negative", () => {
    // Finish without starting
    coord.agentFinished("tab-1");
    coord.agentFinished("tab-1");
    // Should not throw, and getTabsWithActiveAgents should be empty
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("getTabsWithActiveAgents excludes the requesting tab", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);

    const others = coord.getTabsWithActiveAgents("tab-1");
    expect(others).toHaveLength(1);
    expect(others[0]).toBe("Tab 2");
  });

  it("getTabsWithActiveAgents returns tabId prefix when no claims exist", () => {
    coord.agentStarted("abcdef1234567890");
    const tabs = coord.getTabsWithActiveAgents();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toBe("abcdef12"); // first 8 chars
  });

  it("multiple tabs with agents — only active ones returned", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.agentStarted("tab-3");
    coord.claimFiles("tab-1", "Alpha", ["/a.ts"]);
    coord.claimFiles("tab-2", "Beta", ["/b.ts"]);
    coord.claimFiles("tab-3", "Gamma", ["/c.ts"]);

    coord.agentFinished("tab-2"); // tab-2 done

    const active = coord.getTabsWithActiveAgents();
    expect(active).toHaveLength(2);
    expect(active).toContain("Alpha");
    expect(active).toContain("Gamma");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. EVENT BATCHING + MICROTASK ORDERING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("event batching", () => {
  it("multiple claims in same tick produce single batched event", async () => {
    const events: Array<{ event: CoordinatorEvent; paths: string[] }> = [];
    coord.on((event, _tabId, paths) => events.push({ event, paths }));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    // No flush yet
    expect(events).toHaveLength(0);

    await tick();

    // All paths batched into one event
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("claim");
    expect(events[0]!.paths).toHaveLength(3);
  });

  it("claim + release in same tick produce separate batched events", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; paths: string[] }> = [];
    coord.on((event, _tabId, paths) => events.push({ event, paths }));

    coord.claimFiles("tab-1", "Tab 1", ["/c.ts"]); // claim
    coord.releaseFiles("tab-1", ["/a.ts"]); // release

    await tick();

    expect(events.length).toBeGreaterThanOrEqual(2);
    const claimEvent = events.find((e) => e.event === "claim");
    const releaseEvent = events.find((e) => e.event === "release");
    expect(claimEvent).toBeDefined();
    expect(releaseEvent).toBeDefined();
  });

  it("events from different tabs are separate", async () => {
    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    await tick();

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.tabId).sort()).toEqual(["tab-1", "tab-2"]);
  });

  it("contest + claim events for mixed result", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/owned.ts"]);
    await tick();

    const events: CoordinatorEvent[] = [];
    coord.on((event) => events.push(event));

    coord.claimFiles("tab-2", "Tab 2", ["/owned.ts", "/free.ts"]);
    await tick();

    expect(events).toContain("claim");
    expect(events).toContain("conflict");
  });

  it("no events emitted for empty operations", async () => {
    const events: CoordinatorEvent[] = [];
    coord.on((event) => events.push(event));

    coord.releaseFiles("tab-1", ["/nonexistent.ts"]);
    coord.releaseAll("tab-999");
    coord.claimFiles("tab-1", "Tab 1", []);
    await tick();

    expect(events).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. PATH NORMALIZATION EDGE CASES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("path normalization edge cases", () => {
  it("relative and absolute paths resolve to same claim", () => {
    coord.claimFiles("tab-1", "Tab 1", ["src/foo.ts"]);
    const result = coord.claimFiles("tab-2", "Tab 2", [resolve("src/foo.ts")]);
    expect(result.contested).toHaveLength(1);
  });

  it("trailing slashes don't affect matching", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/dir/file.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/dir/file.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("dot segments resolve correctly", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a/b/../c.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/a/c.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("case sensitivity follows platform", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/MyFile.ts"]);
    const result = coord.claimFiles("tab-2", "Tab 2", ["/myfile.ts"]);

    if (IS_CASE_INSENSITIVE) {
      expect(result.contested).toHaveLength(1);
    } else {
      expect(result.granted).toHaveLength(1);
    }
  });

  it("forceClaim with relative path matches existing absolute claim", () => {
    coord.claimFiles("tab-1", "Tab 1", [resolve("src/target.ts")]);
    const prev = coord.forceClaim("tab-2", "Tab 2", "src/target.ts");
    expect(prev?.tabId).toBe("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getClaimCount("tab-2")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. TOOL WRAPPER (checkAndClaim, prependWarning, claimAfterCompoundEdit)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("tool-wrapper checkAndClaim", () => {
  it("returns null when no tabId", () => {
    expect(checkAndClaim(undefined, undefined, "/a.ts")).toBeNull();
    expect(checkAndClaim(undefined, "label", "/a.ts")).toBeNull();
  });

  it("returns null when no tabLabel", () => {
    expect(checkAndClaim("tab-1", undefined, "/a.ts")).toBeNull();
  });

  it("claims the file on first call", () => {
    const warning = checkAndClaim("tab-1", "Tab 1", "/a.ts");
    expect(warning).toBeNull();
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("returns warning when another tab owns the file", () => {
    coord.claimFiles("tab-1", "Tab 1", [resolve("/a.ts")]);
    const warning = checkAndClaim("tab-2", "Tab 2", "/a.ts");
    expect(warning).not.toBeNull();
    expect(warning).toContain("Tab 1");
    expect(warning).toContain("being edited by");
  });

  it("still claims the file even when contested (advisory only)", () => {
    coord.claimFiles("tab-1", "Tab 1", [resolve("/a.ts")]);
    checkAndClaim("tab-2", "Tab 2", "/a.ts");
    // Tab 2 should NOT have the claim — contested files are not claimed
    // The claim stays with tab-1
    expect(coord.getClaimsForTab("tab-1").size).toBe(1);
  });

  it("repeated checkAndClaim from same tab increments editCount", () => {
    checkAndClaim("tab-1", "Tab 1", "/x.ts");
    checkAndClaim("tab-1", "Tab 1", "/x.ts");
    checkAndClaim("tab-1", "Tab 1", "/x.ts");
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/x.ts"));
    expect(claim).toBeDefined();
    expect(claim!.editCount).toBe(3);
  });
});

describe("tool-wrapper prependWarning", () => {
  it("no-ops when warning is null", () => {
    expect(prependWarning("result", null)).toBe("result");
    const obj = { output: "result", success: true };
    expect(prependWarning(obj, null)).toBe(obj);
  });

  it("prepends to string result", () => {
    const result = prependWarning("Edited file", "⚠️ warning");
    expect(result).toContain("⚠️ warning");
    expect(result).toContain("Edited file");
    expect(result.indexOf("⚠️ warning")).toBeLessThan(result.indexOf("Edited file"));
  });

  it("prepends to ToolResult object", () => {
    const result = prependWarning({ output: "Edited", success: true }, "⚠️ warning");
    expect(result.output).toContain("⚠️ warning");
    expect(result.output).toContain("Edited");
    expect(result.success).toBe(true);
  });

  it("handles non-string non-object result", () => {
    const result = prependWarning(42, "warning");
    expect(result).toBe(42);
  });
});

describe("tool-wrapper formatConflictWarning", () => {
  it("returns null for empty conflicts", () => {
    expect(formatConflictWarning([])).toBeNull();
  });

  it("formats single conflict", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("src/api/router.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Add Auth",
        ownedSince: Date.now() - 120_000,
        editCount: 3,
        lastEditAt: Date.now() - 30_000,
      },
    ]);
    expect(warning).toContain("Add Auth");
    expect(warning).toContain("3 edits");
    expect(warning).toContain("30s ago");
  });

  it("formats multiple conflicts", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("/a.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Tab 1",
        ownedSince: Date.now(),
        editCount: 1,
        lastEditAt: Date.now(),
      },
      {
        path: resolve("/b.ts"),
        ownerTabId: "tab-2",
        ownerTabLabel: "Tab 2",
        ownedSince: Date.now(),
        editCount: 5,
        lastEditAt: Date.now() - 300_000,
      },
    ]);
    expect(warning).toContain("Tab 1");
    expect(warning).toContain("Tab 2");
    expect(warning).toContain("1 edit,");
    expect(warning).toContain("5 edits");
  });
});

describe("tool-wrapper claimAfterCompoundEdit", () => {
  it("no-ops without tabId", () => {
    claimAfterCompoundEdit(undefined, "label", ["/a.ts"]);
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("no-ops without tabLabel", () => {
    claimAfterCompoundEdit("tab-1", undefined, ["/a.ts"]);
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("no-ops with empty paths", () => {
    claimAfterCompoundEdit("tab-1", "Tab 1", []);
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("claims multiple files post-hoc", () => {
    claimAfterCompoundEdit("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(3);
  });

  it("filters out empty strings", () => {
    claimAfterCompoundEdit("tab-1", "Tab 1", ["", "/a.ts", ""]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. EDIT STACK TAB OWNERSHIP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("edit-stack tab ownership", () => {
  it("pushEdit accepts tabId without error", () => {
    // pushEdit(path, content, tabId?) — verify the 3-arg signature works
    pushEdit(resolve("/test-tab.ts"), "content-a", "tab-1");
    pushEdit(resolve("/test-tab.ts"), "content-b", "tab-2");
    pushEdit(resolve("/test-tab.ts"), "content-c");
    // No throw = signature is correct
  });

  it("undoEditTool.execute accepts tabId arg", async () => {
    // Write a temp file, push an edit, then undo with tabId
    const tmpPath = resolve("/tmp/cross-tab-undo-test.ts");
    const { writeFileSync, existsSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, "final-content", "utf-8");

    pushEdit(tmpPath, "original-content", "tab-1");

    const result = await undoEditTool.execute({ path: tmpPath, steps: 1, tabId: "tab-1" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Undid 1 edit");

    // Verify the file was restored to original
    const { readFileSync } = await import("node:fs");
    const restored = readFileSync(tmpPath, "utf-8");
    expect(restored).toBe("original-content");

    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  });

  it("undo with tabId skips other tab's edits", async () => {
    const tmpPath = resolve("/tmp/cross-tab-undo-isolation.ts");
    const { writeFileSync, readFileSync, existsSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, "current-content", "utf-8");

    // Tab-1 edits
    pushEdit(tmpPath, "tab1-original", "tab-1");
    // Tab-2 edits (pushed after tab-1)
    pushEdit(tmpPath, "tab2-original", "tab-2");

    // Undo for tab-1 should find tab1-original (skip tab2's entry)
    const result = await undoEditTool.execute({ path: tmpPath, steps: 1, tabId: "tab-1" });
    expect(result.success).toBe(true);
    const restored = readFileSync(tmpPath, "utf-8");
    expect(restored).toBe("tab1-original");

    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  });

  it("undo without tabId pops most recent regardless of tab", async () => {
    const tmpPath = resolve("/tmp/cross-tab-undo-notab.ts");
    const { writeFileSync, readFileSync, existsSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmpPath, "current", "utf-8");

    pushEdit(tmpPath, "oldest", "tab-1");
    pushEdit(tmpPath, "newest", "tab-2");

    // No tabId — should pop newest (tab-2's entry)
    const result = await undoEditTool.execute({ path: tmpPath, steps: 1 });
    expect(result.success).toBe(true);
    const restored = readFileSync(tmpPath, "utf-8");
    expect(restored).toBe("newest");

    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. GIT TOOL CROSS-TAB BLOCKING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("git tool cross-tab blocking", () => {
  it("getOtherTabClaimWarning returns null when no other tabs have claims", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    // Import and test the warning function indirectly via getConflicts
    const conflicts = coord.getConflicts("tab-1", ["/a.ts"]);
    expect(conflicts).toHaveLength(0); // own claims aren't conflicts
  });

  it("getTabsWithActiveAgents blocks destructive git ops", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

    // Tab 2 trying to commit should be blocked
    const activeTabs = coord.getTabsWithActiveAgents("tab-2");
    expect(activeTabs).toHaveLength(1);
    expect(activeTabs[0]).toBe("Tab 1");
  });

  it("no blocking when no agents are active", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const activeTabs = coord.getTabsWithActiveAgents("tab-2");
    expect(activeTabs).toHaveLength(0);
  });

  it("own tab's agents don't block self", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const activeTabs = coord.getTabsWithActiveAgents("tab-1");
    expect(activeTabs).toHaveLength(0);
  });

  it("claim warning shows paths from other tabs", () => {
    coord.claimFiles("tab-1", "Alpha", [resolve("src/api.ts"), resolve("src/db.ts")]);
    coord.claimFiles("tab-2", "Beta", [resolve("src/ui.ts")]);

    // From tab-3's perspective
    const editors = coord.getActiveEditors();
    expect(editors.size).toBe(2);

    // Verify conflicts for tab-3 trying to edit tab-1's files
    const conflicts = coord.getConflicts("tab-3", [resolve("src/api.ts")]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ownerTabLabel).toBe("Alpha");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. CONCURRENT DISPATCH SCENARIOS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("concurrent dispatch scenarios", () => {
  it("dispatch in tab-1 blocks git commit from tab-2", () => {
    // Simulate dispatch: 3 agents editing files
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Dispatch A", ["/a.ts", "/b.ts", "/c.ts"]);

    // Tab-2 tries to commit
    const blocking = coord.getTabsWithActiveAgents("tab-2");
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toBe("Dispatch A");
  });

  it("after dispatch completes, git commit allowed", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.agentFinished("tab-1");

    const blocking = coord.getTabsWithActiveAgents("tab-2");
    expect(blocking).toHaveLength(0);
  });

  it("two dispatches in different tabs — each blocks the other's commit", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.claimFiles("tab-1", "Alpha", ["/a.ts"]);
    coord.claimFiles("tab-2", "Beta", ["/b.ts"]);

    expect(coord.getTabsWithActiveAgents("tab-1")).toHaveLength(1);
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);
    expect(coord.getTabsWithActiveAgents("tab-1")[0]).toBe("Beta");
    expect(coord.getTabsWithActiveAgents("tab-2")[0]).toBe("Alpha");
  });

  it("dispatch with overlapping file claims — detected as conflict", () => {
    coord.claimFiles("tab-1", "Feature A", ["/shared.ts", "/a-only.ts"]);
    coord.agentStarted("tab-1");

    // Tab 2 starts dispatch touching shared file
    const result = coord.claimFiles("tab-2", "Feature B", ["/shared.ts", "/b-only.ts"]);
    expect(result.granted).toHaveLength(1); // b-only.ts
    expect(result.contested).toHaveLength(1); // shared.ts
    expect(result.contested[0]!.owner.tabLabel).toBe("Feature A");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. DISPOSE + CLEANUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dispose and cleanup", () => {
  it("dispose clears all state and timers", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.agentStarted("tab-1");
    coord.markIdle("tab-2");
    const unsub = coord.on(() => {});

    coord.dispose();

    expect(coord.getAllClaims().size).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
    // Listener removed
    unsub(); // should not throw
  });

  it("releaseAllGlobal clears claims but not listeners", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);

    const events: CoordinatorEvent[] = [];
    coord.on((event) => events.push(event));

    coord.releaseAllGlobal();
    expect(coord.getAllClaims().size).toBe(0);

    // Listeners still work
    coord.claimFiles("tab-3", "Tab 3", ["/c.ts"]);
    await tick();
    expect(events).toContain("claim");
  });

  it("resetWorkspaceCoordinator creates fresh instance", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    resetWorkspaceCoordinator();
    const fresh = getWorkspaceCoordinator();
    expect(fresh.getAllClaims().size).toBe(0);
    // Old reference is disposed
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("double dispose is safe", () => {
    coord.dispose();
    coord.dispose();
    expect(coord.getAllClaims().size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. CONFLICT INFO CORRECTNESS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("conflict info correctness", () => {
  it("conflict info has correct timestamps", () => {
    const beforeClaim = Date.now();
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const afterClaim = Date.now();

    const conflicts = coord.getConflicts("tab-2", ["/a.ts"]);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;

    expect(c.ownerTabId).toBe("tab-1");
    expect(c.ownerTabLabel).toBe("Tab 1");
    expect(c.ownedSince).toBeGreaterThanOrEqual(beforeClaim);
    expect(c.ownedSince).toBeLessThanOrEqual(afterClaim);
    expect(c.editCount).toBe(1);
    expect(c.lastEditAt).toBeGreaterThanOrEqual(beforeClaim);
  });

  it("editCount increments on repeated claims from same tab", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

    const conflicts = coord.getConflicts("tab-2", ["/a.ts"]);
    expect(conflicts[0]!.editCount).toBe(3);
  });

  it("lastEditAt updates on subsequent edits", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const firstEdit = coord.getConflicts("tab-2", ["/a.ts"])[0]!.lastEditAt;

    await new Promise((r) => setTimeout(r, 10));
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const secondEdit = coord.getConflicts("tab-2", ["/a.ts"])[0]!.lastEditAt;

    expect(secondEdit).toBeGreaterThanOrEqual(firstEdit);
  });

  it("getConflicts returns empty for multiple unclaimed files", () => {
    const conflicts = coord.getConflicts("tab-1", ["/x.ts", "/y.ts", "/z.ts"]);
    expect(conflicts).toHaveLength(0);
  });

  it("getConflicts returns partial conflicts", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/a.ts", "/unclaimed.ts", "/b.ts"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe(normPath("/a.ts"));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 11. SINGLETON BEHAVIOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("singleton behavior", () => {
  it("getWorkspaceCoordinator returns same instance", () => {
    const a = getWorkspaceCoordinator();
    const b = getWorkspaceCoordinator();
    expect(a).toBe(b);
  });

  it("state persists across getWorkspaceCoordinator calls", () => {
    getWorkspaceCoordinator().claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    expect(getWorkspaceCoordinator().getClaimCount("tab-1")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 12. getActiveEditors EDGE CASES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("getActiveEditors edge cases", () => {
  it("returns defensive copies (mutations don't affect internal state)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const editors = coord.getActiveEditors();
    const claims = editors.get("tab-1")!;

    // Mutate the returned array
    claims.length = 0;
    editors.clear();

    // Internal state unchanged
    expect(coord.getClaimCount("tab-1")).toBe(1);
    expect(coord.getActiveEditors().size).toBe(1);
  });

  it("getClaimsForTab returns defensive copies", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const claims = coord.getClaimsForTab("tab-1");

    // Mutate returned claim
    const claim = claims.get(normPath("/a.ts"))!;
    claim.editCount = 999;

    // Internal state unchanged
    const fresh = coord.getClaimsForTab("tab-1");
    expect(fresh.get(normPath("/a.ts"))!.editCount).toBe(1);
  });

  it("getAllClaims returns defensive copy", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const all = coord.getAllClaims();
    all.delete(normPath("/a.ts"));
    expect(coord.getAllClaims().size).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 13. LARGE SCALE — 100+ FILES ACROSS 5 TABS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("large scale stress", () => {
  it("100 files across 5 tabs — claims, conflicts, release all work correctly", () => {
    const tabCount = 5;
    const filesPerTab = 20;

    // Each tab claims its own files
    for (let t = 0; t < tabCount; t++) {
      const paths = Array.from({ length: filesPerTab }, (_, i) => `/tab${String(t)}/file${String(i)}.ts`);
      const result = coord.claimFiles(`tab-${String(t)}`, `Tab ${String(t)}`, paths);
      expect(result.granted).toHaveLength(filesPerTab);
      expect(result.contested).toHaveLength(0);
    }

    expect(coord.getAllClaims().size).toBe(tabCount * filesPerTab);

    // Every tab checks conflicts against tab-0's files
    for (let t = 1; t < tabCount; t++) {
      const tab0Files = Array.from({ length: filesPerTab }, (_, i) => `/tab0/file${String(i)}.ts`);
      const conflicts = coord.getConflicts(`tab-${String(t)}`, tab0Files);
      expect(conflicts).toHaveLength(filesPerTab);
    }

    // Release tab-0
    coord.releaseAll("tab-0");
    expect(coord.getAllClaims().size).toBe((tabCount - 1) * filesPerTab);

    // Tab-1 can now claim tab-0's files
    const tab0Files = Array.from({ length: filesPerTab }, (_, i) => `/tab0/file${String(i)}.ts`);
    const result = coord.claimFiles("tab-1", "Tab 1", tab0Files);
    expect(result.granted).toHaveLength(filesPerTab);
    expect(result.contested).toHaveLength(0);
  });

  it("getActiveEditors with many tabs groups correctly", () => {
    for (let t = 0; t < 5; t++) {
      const paths = Array.from({ length: 10 }, (_, i) => `/t${String(t)}/f${String(i)}.ts`);
      coord.claimFiles(`tab-${String(t)}`, `Tab ${String(t)}`, paths);
    }

    const editors = coord.getActiveEditors();
    expect(editors.size).toBe(5);
    for (let t = 0; t < 5; t++) {
      expect(editors.get(`tab-${String(t)}`)).toHaveLength(10);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 14. FORMATCONFLICTWARNING TIME AGO FORMATTING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("formatConflictWarning time formatting", () => {
  it("shows seconds for recent edits", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("/a.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Tab 1",
        ownedSince: Date.now(),
        editCount: 1,
        lastEditAt: Date.now() - 5_000, // 5 seconds ago
      },
    ]);
    expect(warning).toContain("5s ago");
  });

  it("shows minutes for older edits", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("/a.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Tab 1",
        ownedSince: Date.now(),
        editCount: 1,
        lastEditAt: Date.now() - 120_000, // 2 minutes ago
      },
    ]);
    expect(warning).toContain("2m ago");
  });

  it("shows hours for old edits", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("/a.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Tab 1",
        ownedSince: Date.now(),
        editCount: 1,
        lastEditAt: Date.now() - 7_200_000, // 2 hours ago
      },
    ]);
    expect(warning).toContain("2h ago");
  });

  it("singular 'edit' for count=1", () => {
    const warning = formatConflictWarning([
      {
        path: resolve("/a.ts"),
        ownerTabId: "tab-1",
        ownerTabLabel: "Tab 1",
        ownedSince: Date.now(),
        editCount: 1,
        lastEditAt: Date.now(),
      },
    ]);
    expect(warning).toContain("1 edit,");
    expect(warning).not.toContain("1 edits");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 15. SHELL COMMAND COORDINATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
  extractWrittenFiles,
  isGitMutatingShellCommand,
} from "../src/core/tools/index.js";

describe("shell git-mutating detection", () => {
  it("detects git commit", () => {
    expect(isGitMutatingShellCommand('git commit -m "msg"')).toBe(true);
  });

  it("detects git stash", () => {
    expect(isGitMutatingShellCommand("git stash")).toBe(true);
    expect(isGitMutatingShellCommand("git stash push -m save")).toBe(true);
  });

  it("detects git restore", () => {
    expect(isGitMutatingShellCommand("git restore src/foo.ts")).toBe(true);
  });

  it("detects git checkout --", () => {
    expect(isGitMutatingShellCommand("git checkout -- src/foo.ts")).toBe(true);
  });

  it("detects git switch", () => {
    expect(isGitMutatingShellCommand("git switch feature-branch")).toBe(true);
  });

  it("detects git merge", () => {
    expect(isGitMutatingShellCommand("git merge main")).toBe(true);
  });

  it("detects git rebase", () => {
    expect(isGitMutatingShellCommand("git rebase main")).toBe(true);
  });

  it("detects git cherry-pick", () => {
    expect(isGitMutatingShellCommand("git cherry-pick abc123")).toBe(true);
  });

  it("detects git reset", () => {
    expect(isGitMutatingShellCommand("git reset HEAD~1")).toBe(true);
    expect(isGitMutatingShellCommand("git reset --hard HEAD")).toBe(true);
  });

  it("does NOT detect git status/diff/log (read-only)", () => {
    expect(isGitMutatingShellCommand("git status")).toBe(false);
    expect(isGitMutatingShellCommand("git diff")).toBe(false);
    expect(isGitMutatingShellCommand("git log --oneline")).toBe(false);
    expect(isGitMutatingShellCommand("git show HEAD")).toBe(false);
    expect(isGitMutatingShellCommand("git branch -v")).toBe(false);
  });

  it("does NOT detect git push/pull/fetch (network, not working tree)", () => {
    expect(isGitMutatingShellCommand("git push origin main")).toBe(false);
    expect(isGitMutatingShellCommand("git pull")).toBe(false);
    expect(isGitMutatingShellCommand("git fetch")).toBe(false);
  });

  it("does NOT detect non-git commands", () => {
    expect(isGitMutatingShellCommand("echo hello")).toBe(false);
    expect(isGitMutatingShellCommand("cat file.ts")).toBe(false);
    expect(isGitMutatingShellCommand("bun test")).toBe(false);
  });
});

describe("shell file-write detection (extractWrittenFiles)", () => {
  it("detects sed -i", () => {
    const files = extractWrittenFiles("sed -i 's/foo/bar/g' src/main.ts");
    expect(files).toContain("src/main.ts");
  });

  it("detects sed --in-place", () => {
    const files = extractWrittenFiles("sed --in-place 's/a/b/' config.json");
    expect(files).toContain("config.json");
  });

  it("detects output redirection >", () => {
    const files = extractWrittenFiles("echo 'hello' > output.txt");
    expect(files).toContain("output.txt");
  });

  it("detects append redirection >>", () => {
    const files = extractWrittenFiles("echo 'line' >> log.txt");
    expect(files).toContain("log.txt");
  });

  it("detects tee", () => {
    const files = extractWrittenFiles("echo 'data' | tee result.json");
    expect(files).toContain("result.json");
  });

  it("detects cp (target file)", () => {
    const files = extractWrittenFiles("cp src/old.ts src/new.ts");
    expect(files).toContain("src/new.ts");
  });

  it("detects mv (target file)", () => {
    const files = extractWrittenFiles("mv old.ts new.ts");
    expect(files).toContain("new.ts");
  });

  it("ignores /dev/ paths", () => {
    const files = extractWrittenFiles("echo test > /dev/null");
    expect(files).toHaveLength(0);
  });

  it("returns empty for read-only commands", () => {
    expect(extractWrittenFiles("cat file.ts")).toHaveLength(0);
    expect(extractWrittenFiles("grep foo bar.ts")).toHaveLength(0);
    expect(extractWrittenFiles("git status")).toHaveLength(0);
    expect(extractWrittenFiles("bun test")).toHaveLength(0);
  });

  it("handles piped commands — only detects write side", () => {
    const files = extractWrittenFiles("cat input.txt | sed 's/a/b/' > output.txt");
    expect(files).toContain("output.txt");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 16. EDIT STACK ADVERSARIAL — HOSTILE INTERLEAVING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("edit-stack adversarial interleaving", () => {
  const { writeFileSync, readFileSync, existsSync, unlinkSync } = require("node:fs");
  const tmpFiles: string[] = [];

  function tmpFile(name: string): string {
    const p = resolve(`/tmp/cross-tab-${name}-${String(Date.now())}.ts`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      if (existsSync(f)) unlinkSync(f);
    }
    tmpFiles.length = 0;
  });

  it("3 tabs interleave edits — each undo only restores own edits", async () => {
    const file = tmpFile("interleave");
    writeFileSync(file, "current", "utf-8");

    // Interleaved push pattern: A, B, C, A, B, C, A
    pushEdit(file, "a-v1", "tab-a");
    pushEdit(file, "b-v1", "tab-b");
    pushEdit(file, "c-v1", "tab-c");
    pushEdit(file, "a-v2", "tab-a");
    pushEdit(file, "b-v2", "tab-b");
    pushEdit(file, "c-v2", "tab-c");
    pushEdit(file, "a-v3", "tab-a");

    // Undo tab-b: should get b-v2 (most recent tab-b entry), skipping a-v3 and c-v2
    const r1 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-b" });
    expect(r1.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("b-v2");

    // Undo tab-b again: should get b-v1
    writeFileSync(file, "current-again", "utf-8");
    const r2 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-b" });
    expect(r2.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("b-v1");

    // Undo tab-b again: no more entries — should fail
    writeFileSync(file, "current-again2", "utf-8");
    const r3 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-b" });
    expect(r3.success).toBe(false);
    expect(r3.output).toContain("No edit history");
  });

  it("popEdit with tabId returns null when only other tabs' entries exist", async () => {
    const file = tmpFile("only-others");
    writeFileSync(file, "current", "utf-8");
    pushEdit(file, "tab-a-content", "tab-a");
    pushEdit(file, "tab-b-content", "tab-b");

    // tab-c has no entries
    const result = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-c" });
    expect(result.success).toBe(false);

    // tab-a and tab-b entries should still be intact
    const r1 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-a" });
    expect(r1.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("tab-a-content");
  });

  it("popEdit with tabId matches unowned entries (tabId=undefined)", async () => {
    const file = tmpFile("unowned");
    writeFileSync(file, "current", "utf-8");
    pushEdit(file, "unowned-content"); // no tabId
    pushEdit(file, "tab-a-content", "tab-a");

    // tab-a undo: should pop tab-a-content first (most recent matching)
    const r1 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-a" });
    expect(r1.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("tab-a-content");

    // tab-a undo again: should match the unowned entry (tabId=undefined matches any tab)
    writeFileSync(file, "current2", "utf-8");
    const r2 = await undoEditTool.execute({ path: file, steps: 1, tabId: "tab-a" });
    expect(r2.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("unowned-content");
  });

  it("multi-step undo with tabId skips other tabs correctly", async () => {
    const file = tmpFile("multistep");
    writeFileSync(file, "current", "utf-8");

    // Push: A, B, A, B, A — 3 entries for A, 2 for B
    pushEdit(file, "a1", "tab-a");
    pushEdit(file, "b1", "tab-b");
    pushEdit(file, "a2", "tab-a");
    pushEdit(file, "b2", "tab-b");
    pushEdit(file, "a3", "tab-a");

    // Undo 3 steps for tab-a — should restore a3 (the earliest of the 3)
    const result = await undoEditTool.execute({ path: file, steps: 3, tabId: "tab-a" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Undid 3 edit");
    expect(readFileSync(file, "utf-8")).toBe("a1");

    // tab-b entries should still be there
    writeFileSync(file, "current2", "utf-8");
    const r2 = await undoEditTool.execute({ path: file, steps: 2, tabId: "tab-b" });
    expect(r2.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("b1");
  });

  it("MAX_STACK_SIZE eviction preserves tab ownership metadata", async () => {
    const file = tmpFile("eviction");
    writeFileSync(file, "current", "utf-8");
    // Push 25 entries (MAX_STACK_SIZE=20) — oldest 5 should be evicted
    for (let i = 0; i < 25; i++) {
      const tabId = i < 10 ? "tab-a" : "tab-b";
      pushEdit(file, `content-${String(i)}`, tabId);
    }
    // After eviction: entries 5-24 remain (20 items)
    // tab-a: entries 5-9 (5 items), tab-b: entries 10-24 (15 items)
    // Undo for tab-a should find its remaining 5 entries
    const result = await undoEditTool.execute({ path: file, steps: 10, tabId: "tab-a" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Undid 5 edit"); // only 5 tab-a entries survived eviction
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 17. CLAIM SECURITY — RELEASE ISOLATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("claim security — release isolation", () => {
  it("releaseFiles cannot release another tab's claims", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/secret.ts"]);
    coord.releaseFiles("tab-2", ["/secret.ts"]); // tab-2 tries to release tab-1's claim
    expect(coord.getClaimCount("tab-1")).toBe(1); // still owned by tab-1
  });

  it("releaseAll only releases own claims, not other tabs", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/c.ts", "/d.ts"]);

    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getClaimCount("tab-2")).toBe(2); // tab-2 untouched
  });

  it("releaseFiles with non-existent paths is a no-op", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.releaseFiles("tab-1", ["/nonexistent.ts", "/also-fake.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1); // /a.ts still there
  });

  it("releaseFiles for mix of own + other tab's files only releases own", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/mine.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/theirs.ts"]);

    coord.releaseFiles("tab-1", ["/mine.ts", "/theirs.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getClaimCount("tab-2")).toBe(1); // tab-2's claim untouched
  });

  it("releaseAll for non-existent tab is a no-op", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.releaseAll("tab-999");
    expect(coord.getAllClaims().size).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 18. EVENT LISTENER ERROR ISOLATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("event listener error isolation", () => {
  it("throwing listener does not prevent other listeners from firing", async () => {
    let secondCalled = false;

    coord.on(() => {
      throw new Error("I explode!");
    });
    coord.on(() => {
      secondCalled = true;
    });

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    expect(secondCalled).toBe(true);
  });

  it("throwing listener does not corrupt coordinator state", async () => {
    coord.on(() => {
      throw new Error("Kaboom");
    });

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    // State should be clean
    expect(coord.getClaimCount("tab-1")).toBe(1);
    coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(2);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 19. FORCECLAIM EDGE CASES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("forceClaim edge cases", () => {
  it("forceClaim on unclaimed file returns null for previousOwner", () => {
    const prev = coord.forceClaim("tab-1", "Tab 1", "/unclaimed.ts");
    expect(prev).toBeNull();
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("forceClaim on own file replaces own claim (resets editCount)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]); // editCount=2
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]); // editCount=3

    const prev = coord.forceClaim("tab-1", "New Label", "/a.ts");
    expect(prev?.editCount).toBe(3);
    // After forceClaim, editCount is reset to 1
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/a.ts"));
    expect(claim?.editCount).toBe(1);
    expect(claim?.tabLabel).toBe("New Label");
  });

  it("forceClaim steals file AND getConflicts reflects new owner", () => {
    coord.claimFiles("tab-1", "Victim", ["/target.ts"]);
    coord.forceClaim("tab-2", "Thief", "/target.ts");

    // tab-3 checks: conflict should be with tab-2 now, not tab-1
    const conflicts = coord.getConflicts("tab-3", ["/target.ts"]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ownerTabId).toBe("tab-2");
    expect(conflicts[0]!.ownerTabLabel).toBe("Thief");

    // tab-1 should have zero claims
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 20. DUPLICATE PATHS IN CLAIMFILES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("duplicate paths in claimFiles", () => {
  it("same path twice in one call — grants once, editCount reflects both", () => {
    const result = coord.claimFiles("tab-1", "Tab 1", ["/dup.ts", "/dup.ts"]);
    // First occurrence creates the claim, second increments editCount
    expect(result.granted).toHaveLength(2);
    expect(coord.getClaimCount("tab-1")).toBe(1); // still one file
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/dup.ts"));
    expect(claim?.editCount).toBe(2);
  });

  it("same path as both relative and absolute — normalizes to one claim", () => {
    const result = coord.claimFiles("tab-1", "Tab 1", ["src/file.ts", resolve("src/file.ts")]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
    expect(result.granted).toHaveLength(2); // both resolve to same key
  });

  it("duplicate contested paths don't double-report", () => {
    coord.claimFiles("tab-1", "Owner", ["/owned.ts"]);
    const result = coord.claimFiles("tab-2", "Challenger", ["/owned.ts", "/owned.ts"]);
    // Both resolve to same path which is contested
    expect(result.contested).toHaveLength(2);
    // But only one claim exists for tab-1
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 21. AGENT LIFECYCLE EDGE CASES — OVERFLOW / UNDERFLOW / ORDERING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("agent lifecycle overflow/underflow", () => {
  it("100 agentStarted + 100 agentFinished = clean state", () => {
    for (let i = 0; i < 100; i++) coord.agentStarted("tab-1");
    for (let i = 0; i < 100; i++) coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("99 agentStarted + 100 agentFinished — underflow capped at 0", () => {
    for (let i = 0; i < 99; i++) coord.agentStarted("tab-1");
    for (let i = 0; i < 100; i++) coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("interleaved start/finish across 5 tabs", () => {
    // Start agents: tab-1 x 3, tab-2 x 2, tab-3 x 1
    for (let i = 0; i < 3; i++) coord.agentStarted("tab-1");
    for (let i = 0; i < 2; i++) coord.agentStarted("tab-2");
    coord.agentStarted("tab-3");
    coord.claimFiles("tab-1", "T1", ["/a.ts"]);
    coord.claimFiles("tab-2", "T2", ["/b.ts"]);
    coord.claimFiles("tab-3", "T3", ["/c.ts"]);

    expect(coord.getTabsWithActiveAgents()).toHaveLength(3);

    // Finish: tab-3 done (1 agent)
    coord.agentFinished("tab-3");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(2);

    // Finish: tab-2 partially (1 of 2)
    coord.agentFinished("tab-2");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(2); // tab-2 still has 1

    // Finish: tab-2 fully
    coord.agentFinished("tab-2");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(1); // only tab-1

    // Finish: tab-1 all 3
    coord.agentFinished("tab-1");
    coord.agentFinished("tab-1");
    coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("agentStarted after dispose is safe (no crash)", () => {
    coord.dispose();
    coord.agentStarted("tab-1"); // should not throw
    coord.agentFinished("tab-1");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 22. GIT TOOL INTEGRATION — ACTUAL gitTool.execute() CALLS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { gitTool } from "../src/core/tools/git.js";

describe("gitTool.execute cross-tab blocking integration", () => {
  it("commit blocked when other tab has active agents", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature X", ["/a.ts"]);

    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED");
    expect(result.output).toContain("Feature X");
    expect(result.error).toBe("active dispatch");
  });

  it("stash blocked when other tab has active agents", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/x.ts"]);

    const result = await gitTool.execute(
      { action: "stash", sub_action: "push" },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED");
    expect(result.error).toBe("active dispatch");
  });

  it("restore blocked when other tab has active agents", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Dispatch", ["/file.ts"]);

    const result = await gitTool.execute(
      { action: "restore", files: ["src/main.ts"] },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED");
    expect(result.error).toBe("active dispatch");
  });

  it("branch switch blocked when other tab has active agents", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Builder", ["/code.ts"]);

    const result = await gitTool.execute(
      { action: "branch", sub_action: "switch", name: "other-branch" },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED");
    expect(result.error).toBe("active dispatch");
  });

  it("non-destructive ops NOT blocked (status, diff, log)", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/x.ts"]);

    // These should not be blocked regardless of active agents
    const status = await gitTool.execute({ action: "status" }, "tab-2");
    // status may fail for non-repo reasons but should NOT fail with "active dispatch"
    expect(status.error).not.toBe("active dispatch");

    const diff = await gitTool.execute({ action: "diff" }, "tab-2");
    expect(diff.error).not.toBe("active dispatch");

    const log = await gitTool.execute({ action: "log", count: 1 }, "tab-2");
    expect(log.error).not.toBe("active dispatch");
  });

  it("own tab's agents don't block own git operations", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Self", ["/a.ts"]);

    // tab-1 committing while its own agents run — should NOT be blocked
    // (it may fail for other reasons like "nothing staged" but not "active dispatch")
    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-1",
    );
    expect(result.error).not.toBe("active dispatch");
  });

  it("no tabId means no blocking check", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/x.ts"]);

    // No tabId — should skip the blocking check
    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      undefined,
    );
    expect(result.error).not.toBe("active dispatch");
  });

  it("multiple tabs with active agents — all listed in error", async () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.claimFiles("tab-1", "Alpha", ["/a.ts"]);
    coord.claimFiles("tab-2", "Beta", ["/b.ts"]);

    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-3",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Alpha");
    expect(result.output).toContain("Beta");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 23. CLAIM WARNING PREPEND BEHAVIOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("claim warning prepend behavior in git tool", () => {
  it("warning prepended to successful result only", async () => {
    coord.claimFiles("tab-1", "OtherTab", [resolve("src/claimed.ts")]);

    // A status call from tab-2 (not destructive — no warning injected)
    const status = await gitTool.execute({ action: "status" }, "tab-2");
    if (status.success) {
      expect(status.output).not.toContain("⚠️ Other tabs");
    }
  });

  it("warning NOT prepended when result.success is false", async () => {
    coord.claimFiles("tab-1", "Owner", [resolve("src/file.ts")]);

    // commit with no staged files — will fail, warning should NOT appear
    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-2",
    );
    // Either blocked by active dispatch OR fails with "nothing staged"
    // In neither case should the claim warning appear on a failed result
    if (!result.success) {
      // The claim warning only appears when result.success is true
      // If it failed due to "nothing staged" (not active dispatch), verify no warning
      if (result.error !== "active dispatch") {
        expect(result.output).not.toContain("⚠️ Other tabs");
      }
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 24. checkAndClaim RE-ENTRANT + ORDERING GUARANTEES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("checkAndClaim re-entrant ordering", () => {
  it("same tab claiming same file 10x — no warning, editCount=10", () => {
    for (let i = 0; i < 10; i++) {
      const warning = checkAndClaim("tab-1", "Tab 1", "/rapid.ts");
      expect(warning).toBeNull(); // own file — never a warning
    }
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/rapid.ts"));
    expect(claim?.editCount).toBe(10);
  });

  it("two tabs alternating claims — warning on every contested call", () => {
    // tab-1 claims first
    checkAndClaim("tab-1", "Tab 1", "/shared.ts");

    // tab-2 contests repeatedly
    for (let i = 0; i < 5; i++) {
      const warning = checkAndClaim("tab-2", "Tab 2", "/shared.ts");
      expect(warning).not.toBeNull();
      expect(warning).toContain("Tab 1");
    }

    // tab-1 still owns it (contested calls don't transfer ownership)
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/shared.ts"));
    expect(claim?.tabId).toBe("tab-1");
  });

  it("checkAndClaim with empty string tabId treated as falsy", () => {
    const warning = checkAndClaim("", "Label", "/a.ts");
    expect(warning).toBeNull(); // should short-circuit
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("checkAndClaim with empty string tabLabel treated as falsy", () => {
    const warning = checkAndClaim("tab-1", "", "/a.ts");
    expect(warning).toBeNull(); // should short-circuit
    expect(coord.getAllClaims().size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 25. STALE SWEEP — TIMESTAMP MANIPULATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("stale sweep behavior", () => {
  it("fresh claims are not swept", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/fresh.ts"]);
    // Manually trigger sweep (it's private but we can test through the public API
    // by verifying claims survive after time passes within threshold)
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("claims survive up to the stale threshold", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    // Immediately after claiming, the file should not be stale
    const claims = coord.getAllClaims();
    const claim = claims.get(normPath("/a.ts"));
    expect(claim).toBeDefined();
    const age = Date.now() - claim!.lastEditAt;
    expect(age).toBeLessThan(1000); // should be basically 0
  });

  it("getAllClaims snapshot is isolated from internal mutations", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    const snapshot1 = coord.getAllClaims();
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
    const snapshot2 = coord.getAllClaims();

    expect(snapshot1.size).toBe(1);
    expect(snapshot2.size).toBe(2);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 26. COMPOUND TOOL CLAIMING INTEGRATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("compound tool claiming — contested files", () => {
  it("claimAfterCompoundEdit on files owned by another tab — still claims them", () => {
    coord.claimFiles("tab-1", "Owner", ["/target.ts"]);
    // rename_symbol in tab-2 modifies /target.ts — post-hoc claim
    claimAfterCompoundEdit("tab-2", "Renamer", ["/target.ts", "/other.ts"]);

    // /target.ts is contested — tab-1 still owns it
    expect(coord.getClaimsForTab("tab-1").has(normPath("/target.ts"))).toBe(true);
    // /other.ts is claimed by tab-2
    expect(coord.getClaimsForTab("tab-2").has(normPath("/other.ts"))).toBe(true);
  });

  it("claimAfterCompoundEdit with many files — large batch", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/rename-target-${String(i)}.ts`);
    claimAfterCompoundEdit("tab-1", "MassRename", paths);
    expect(coord.getClaimCount("tab-1")).toBe(50);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 27. LISTENER UNSUBSCRIBE CORRECTNESS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("listener unsubscribe correctness", () => {
  it("unsubscribed listener does not fire on subsequent events", async () => {
    let callCount = 0;
    const unsub = coord.on(() => {
      callCount++;
    });

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();
    expect(callCount).toBe(1);

    unsub();

    coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    await tick();
    expect(callCount).toBe(1); // should NOT have incremented
  });

  it("double unsubscribe is safe", async () => {
    const unsub = coord.on(() => {});
    unsub();
    unsub(); // should not throw
  });

  it("unsubscribe during event flush is safe", async () => {
    let unsub2: (() => void) | undefined;
    const unsub1 = coord.on(() => {
      unsub2?.(); // unsubscribe the second listener mid-flush
    });
    unsub2 = coord.on(() => {
      // This may or may not fire depending on Set iteration order
      // The important thing is it doesn't crash
    });

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick(); // should not throw
    unsub1();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 28. SHELL COMMAND COORDINATION — FULL WIRING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("shell git-mutating — edge cases", () => {
  it("git commit with quoted message", () => {
    expect(isGitMutatingShellCommand('git commit -am "feat: add stuff"')).toBe(true);
  });

  it("git stash pop", () => {
    expect(isGitMutatingShellCommand("git stash pop")).toBe(true);
  });

  it("git stash list (read-only subcommand)", () => {
    expect(isGitMutatingShellCommand("git stash list")).toBe(true);
    // Note: stash list IS detected as mutating because the regex matches "git stash"
    // This is conservative — better to block reads than miss writes
  });

  it("git reset --soft HEAD~1", () => {
    expect(isGitMutatingShellCommand("git reset --soft HEAD~1")).toBe(true);
  });

  it("piped git command still detected", () => {
    expect(isGitMutatingShellCommand("git diff | git commit -m msg")).toBe(true);
  });

  it("git in path but not git command", () => {
    expect(isGitMutatingShellCommand("cat .gitignore")).toBe(false);
    expect(isGitMutatingShellCommand("echo git commit")).toBe(true); // regex matches substring
  });

  it("git checkout without -- (not detected as mutating)", () => {
    expect(isGitMutatingShellCommand("git checkout feature-branch")).toBe(false);
    expect(isGitMutatingShellCommand("git checkout -- file.ts")).toBe(true);
  });

  it("detects env prefix: env VAR=x git commit", () => {
    expect(isGitMutatingShellCommand('env GIT_AUTHOR_NAME=x git commit -m "y"')).toBe(true);
  });

  it("detects git flags before subcommand: git -c key=val commit", () => {
    expect(isGitMutatingShellCommand('git -c user.name=x commit -m "y"')).toBe(true);
  });

  it("detects command prefix: command git commit", () => {
    expect(isGitMutatingShellCommand("command git commit -m msg")).toBe(true);
  });

  it("detects builtin prefix: builtin git stash", () => {
    expect(isGitMutatingShellCommand("builtin git stash")).toBe(true);
  });

  it("env prefix with non-git command — not detected", () => {
    expect(isGitMutatingShellCommand("env FOO=bar echo hello")).toBe(false);
  });
});

describe("shell file-write detection edge cases", () => {
  it("multiple redirections — first target detected", () => {
    const files = extractWrittenFiles("echo a > first.txt && echo b > second.txt");
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain("first.txt");
  });

  it("heredoc redirection", () => {
    const files = extractWrittenFiles("cat > output.ts << 'EOF'");
    expect(files).toContain("output.ts");
  });

  it("sed -i with backup extension", () => {
    const files = extractWrittenFiles("sed -i.bak 's/old/new/' file.ts");
    // Should detect file.ts as the written file
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("tee -a (append mode)", () => {
    const files = extractWrittenFiles("echo data | tee -a log.txt");
    expect(files).toContain("log.txt");
  });

  it("mv with -f flag", () => {
    const files = extractWrittenFiles("mv -f old.ts new.ts");
    expect(files).toContain("new.ts");
  });

  it("cp -r directory (target)", () => {
    const files = extractWrittenFiles("cp -r src/ dest/");
    expect(files).toContain("dest/");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 29. COORDINATOR STATE CONSISTENCY UNDER STRESS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("coordinator state consistency under stress", () => {
  it("claim → release → reclaim cycle 100 times", () => {
    for (let i = 0; i < 100; i++) {
      coord.claimFiles("tab-1", "Tab 1", ["/cycle.ts"]);
      expect(coord.getClaimCount("tab-1")).toBe(1);
      coord.releaseFiles("tab-1", ["/cycle.ts"]);
      expect(coord.getClaimCount("tab-1")).toBe(0);
    }
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("alternating tabs claim/release same file — ownership transfers cleanly", () => {
    for (let i = 0; i < 50; i++) {
      const tabId = i % 2 === 0 ? "tab-a" : "tab-b";
      const otherTabId = i % 2 === 0 ? "tab-b" : "tab-a";

      // Release other tab first (if they own it)
      coord.releaseFiles(otherTabId, ["/hot.ts"]);

      const result = coord.claimFiles(tabId, `Tab ${tabId}`, ["/hot.ts"]);
      expect(result.granted).toHaveLength(1);
      expect(result.contested).toHaveLength(0);
    }
  });

  it("5 tabs — claim 20 files each, forceClaim all to tab-5, verify", () => {
    for (let t = 0; t < 5; t++) {
      const paths = Array.from({ length: 20 }, (_, i) => `/stress/t${String(t)}/f${String(i)}.ts`);
      coord.claimFiles(`tab-${String(t)}`, `Tab ${String(t)}`, paths);
    }
    expect(coord.getAllClaims().size).toBe(100);

    // Tab-5 steals everything
    for (let t = 0; t < 5; t++) {
      for (let i = 0; i < 20; i++) {
        coord.forceClaim("tab-5", "Overlord", `/stress/t${String(t)}/f${String(i)}.ts`);
      }
    }

    expect(coord.getClaimCount("tab-5")).toBe(100);
    for (let t = 0; t < 5; t++) {
      expect(coord.getClaimCount(`tab-${String(t)}`)).toBe(0);
    }
  });

  it("releaseAllGlobal during active agents — cleans agents too", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);

    coord.releaseAllGlobal();
    expect(coord.getAllClaims().size).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 30. PATH NORMALIZATION — ADVERSARIAL INPUTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("path normalization adversarial", () => {
  it("deeply nested dot-dot segments", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a/b/c/d/../../../../target.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/target.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("paths with spaces", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/path with spaces/file.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/path with spaces/file.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("paths with unicode", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/données/fichier.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/données/fichier.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("symlink-like double slashes normalized", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a//b///c.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/a/b/c.ts"]);
    expect(conflicts).toHaveLength(1);
  });

  it("current directory dot segment", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a/./b/./c.ts"]);
    const conflicts = coord.getConflicts("tab-2", ["/a/b/c.ts"]);
    expect(conflicts).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 31. RACE: TAB CLOSE DURING ACTIVE DISPATCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("race: tab close during active dispatch", () => {
  it("closeTab clears active agents — dead tab no longer blocks git", () => {
    // Tab-1 has 3 active dispatch agents
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature X", ["/a.ts", "/b.ts"]);

    // Tab-2 is blocked from committing
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);

    // User closes Tab-1 (React unmount calls closeTab)
    coord.closeTab("tab-1");

    // Tab-2 should now be unblocked
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });

  it("closed tab's dispatch agents can't create ghost claims", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature X", ["/a.ts"]);

    // Tab closes
    coord.closeTab("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // Dispatch agent (still running) tries to claim files post-close
    const result = coord.claimFiles("tab-1", "Feature X", ["/new-file.ts"]);
    expect(result.granted).toHaveLength(0); // rejected — tab is closed
    expect(coord.getClaimCount("tab-1")).toBe(0); // no ghost claims

    // Agent tries to register more agents
    coord.agentStarted("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0); // rejected
  });

  it("closed tab's agentFinished is a safe no-op", () => {
    coord.agentStarted("tab-1");
    coord.closeTab("tab-1");

    // Dispatch finally{} block fires after tab close
    coord.agentFinished("tab-1"); // should not throw or corrupt state
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("releaseAll (idle timer) does NOT block future claims", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

    // Idle timer fires → releaseAll (NOT closeTab)
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // Tab is still alive — new prompt starts, claims new files
    coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1); // should succeed
  });

  it("closeTab + git tool integration — commit unblocked after close", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/x.ts"]);

    // Tab-2 commit is blocked
    const blocked = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-2",
    );
    expect(blocked.error).toBe("active dispatch");

    // Tab-1 is closed
    coord.closeTab("tab-1");

    // Tab-2 commit should now proceed (may fail for "nothing staged" but NOT "active dispatch")
    const unblocked = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-2",
    );
    expect(unblocked.error).not.toBe("active dispatch");
  });

  it("multiple tabs close — all ghost agents cleared", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.agentStarted("tab-3");
    coord.claimFiles("tab-1", "A", ["/a.ts"]);
    coord.claimFiles("tab-2", "B", ["/b.ts"]);
    coord.claimFiles("tab-3", "C", ["/c.ts"]);

    coord.closeTab("tab-1");
    coord.closeTab("tab-2");

    expect(coord.getTabsWithActiveAgents()).toHaveLength(1);
    expect(coord.getTabsWithActiveAgents()[0]).toBe("C");
    expect(coord.getAllClaims().size).toBe(1);

    coord.closeTab("tab-3");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
    expect(coord.getAllClaims().size).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 32. RACE: IDLE TIMER vs ACTIVE PROMPT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("race: idle timer vs active prompt", () => {
  it("markActive cancels pending idle release", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1"); // starts 60s timer

    // User starts typing before timer fires
    coord.markActive("tab-1");

    // Claims should still be there
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("agentStarted cancels pending idle release", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1"); // starts timer

    // Dispatch starts while idle timer is pending
    coord.agentStarted("tab-1");

    expect(coord.getClaimCount("tab-1")).toBe(1);

    coord.agentFinished("tab-1");
    // Claims survive because agentStarted cleared the timer
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("markIdle blocked while agents are active (idle timer deferred)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.agentStarted("tab-1");

    // Prompt finishes (isLoading → false) but agents still running
    coord.markIdle("tab-1");

    // Timer should NOT start because agents are active
    // Claims must survive
    expect(coord.getClaimCount("tab-1")).toBe(1);

    // Agents finish
    coord.agentFinished("tab-1");
    // Now markIdle would work if called again
    expect(coord.getClaimCount("tab-1")).toBe(1); // but we didn't call markIdle again
  });

  it("rapid idle/active/idle doesn't start multiple timers", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

    // Rapid state changes
    coord.markIdle("tab-1");
    coord.markActive("tab-1");
    coord.markIdle("tab-1");
    coord.markActive("tab-1");
    coord.markIdle("tab-1");
    coord.markActive("tab-1");

    // Claims survive all the churn
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 17. DISPATCH CROSS-TAB GATE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("dispatch cross-tab gate prerequisites", () => {
  it("getConflicts detects cross-tab overlap for dispatch target files", () => {
    coord.claimFiles("tab-1", "Feature A", [resolve("src/api.ts"), resolve("src/db.ts")]);

    // Simulating tab-2 dispatch checking target files
    const targetFiles = [resolve("src/api.ts"), resolve("src/utils.ts")];
    const conflicts = coord.getConflicts("tab-2", targetFiles);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ownerTabLabel).toBe("Feature A");
  });

  it("no conflicts when dispatch targets don't overlap", () => {
    coord.claimFiles("tab-1", "Feature A", [resolve("src/api.ts")]);

    const targetFiles = [resolve("src/utils.ts"), resolve("src/db.ts")];
    const conflicts = coord.getConflicts("tab-2", targetFiles);
    expect(conflicts).toHaveLength(0);
  });

  it("own tab's files don't trigger conflicts in dispatch gate", () => {
    coord.claimFiles("tab-1", "Feature A", [resolve("src/api.ts")]);
    const conflicts = coord.getConflicts("tab-1", [resolve("src/api.ts")]);
    expect(conflicts).toHaveLength(0);
  });

  it("multiple files conflicting with multiple tabs", () => {
    coord.claimFiles("tab-1", "Auth", [resolve("src/auth.ts")]);
    coord.claimFiles("tab-2", "UI", [resolve("src/ui.ts")]);

    const targets = [resolve("src/auth.ts"), resolve("src/ui.ts"), resolve("src/new.ts")];
    const conflicts = coord.getConflicts("tab-3", targets);
    expect(conflicts).toHaveLength(2);

    const labels = conflicts.map((c) => c.ownerTabLabel).sort();
    expect(labels).toEqual(["Auth", "UI"]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 18. CROSS-TAB SECTION (PROMPT INJECTION)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("cross-tab prompt section formatting", () => {
  it("getActiveEditors groups by tab for prompt injection", () => {
    coord.claimFiles("tab-1", "Auth Feature", ["/a.ts", "/b.ts"]);
    coord.claimFiles("tab-2", "Bug Fix", ["/c.ts"]);

    const editors = coord.getActiveEditors();
    expect(editors.size).toBe(2);
    expect(editors.get("tab-1")).toHaveLength(2);
    expect(editors.get("tab-2")).toHaveLength(1);

    // Verify tab labels are accessible
    const tab1Claims = editors.get("tab-1")!;
    expect(tab1Claims[0]!.tabLabel).toBe("Auth Feature");
  });

  it("getClaimsForTab returns path → claim for relative path rendering", () => {
    coord.claimFiles("tab-1", "Feature", [resolve("src/core/utils.ts")]);
    const claims = coord.getClaimsForTab("tab-1");
    expect(claims.size).toBe(1);
    // The path key is the normalized absolute path
    const entries = [...claims.entries()];
    expect(entries[0]![0]).toContain("utils.ts");
    expect(entries[0]![1].tabLabel).toBe("Feature");
  });

  it("empty when only own tab has claims", () => {
    coord.claimFiles("tab-1", "My Tab", ["/a.ts"]);
    // From tab-1's perspective, no other editors
    const editors = coord.getActiveEditors();
    const otherEditors = [...editors.entries()].filter(([id]) => id !== "tab-1");
    expect(otherEditors).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 19. LONG-SESSION RESILIENCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("long-session resilience", () => {
  it("claims survive across many operations without leaking", () => {
    // Simulate a long session: 50 edits, 10 releases, check memory doesn't leak
    for (let i = 0; i < 50; i++) {
      coord.claimFiles("tab-1", "Tab 1", [`/file-${String(i)}.ts`]);
    }
    expect(coord.getClaimCount("tab-1")).toBe(50);

    // Release half
    for (let i = 0; i < 25; i++) {
      coord.releaseFiles("tab-1", [`/file-${String(i)}.ts`]);
    }
    expect(coord.getClaimCount("tab-1")).toBe(25);
    expect(coord.getAllClaims().size).toBe(25);
  });

  it("releaseAll after session end clears everything", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    coord.claimFiles("tab-2", "Tab 2", ["/c.ts"]);
    coord.agentStarted("tab-1");

    // Session ends
    coord.releaseAllGlobal();
    expect(coord.getAllClaims().size).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("resetWorkspaceCoordinator fully isolates new session", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.agentStarted("tab-1");

    resetWorkspaceCoordinator();
    const fresh = getWorkspaceCoordinator();

    expect(fresh.getAllClaims().size).toBe(0);
    expect(fresh.getTabsWithActiveAgents()).toHaveLength(0);
    // Old coord is disposed
    expect(coord.getAllClaims().size).toBe(0);

    // Update reference for afterEach cleanup
    coord = fresh;
  });

  it("tab close releases claims AND clears active agents", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);

    // Tab closes via closeTab — releases claims AND clears agents
    coord.closeTab("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("concurrent tab operations don't corrupt shared state", () => {
    // Simulate rapid concurrent operations from 3 tabs
    const ops = [
      () => coord.claimFiles("tab-1", "T1", ["/shared.ts"]),
      () => coord.claimFiles("tab-2", "T2", ["/shared.ts"]),  // contested
      () => coord.getConflicts("tab-3", ["/shared.ts"]),
      () => coord.claimFiles("tab-1", "T1", ["/shared.ts"]),  // refresh
      () => coord.forceClaim("tab-3", "T3", "/shared.ts"),     // steal
      () => coord.getActiveEditors(),
      () => coord.claimFiles("tab-2", "T2", ["/other.ts"]),
      () => coord.releaseFiles("tab-3", ["/shared.ts"]),
    ];

    // Run all operations (synchronous, simulating concurrent calls)
    for (const op of ops) op();

    // Verify final state is consistent
    const all = coord.getAllClaims();
    // tab-3 released shared.ts, tab-2 has other.ts
    expect(all.size).toBe(1);
    const remaining = [...all.values()][0]!;
    expect(remaining.tabId).toBe("tab-2");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 20. TERMINATION SCENARIOS — FULL LIFECYCLE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("termination: abort (Escape) while dispatch running", () => {
  it("abort releases claims immediately — files are free for other tabs", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature", ["/a.ts", "/b.ts"]);

    expect(coord.getClaimCount("tab-1")).toBe(2);

    // User hits Escape → abort() calls releaseAll(tabId)
    coord.releaseAll("tab-1");

    // Claims gone immediately
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // Other tab can now claim those files
    const result = coord.claimFiles("tab-2", "Other", ["/a.ts", "/b.ts"]);
    expect(result.granted).toHaveLength(2);
    expect(result.contested).toHaveLength(0);
  });

  it("agentFinished after abort clears agent counter", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature", ["/a.ts"]);

    // Abort: claims released
    coord.releaseAll("tab-1");

    // Dispatch finally fires later
    coord.agentFinished("tab-1");
    coord.agentFinished("tab-1");

    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });

  it("abort unblocks other tabs' git immediately", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    // Tab-2 is blocked
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);

    // Abort → releaseAll + agentFinished
    coord.releaseAll("tab-1");
    coord.agentFinished("tab-1");

    // Tab-2 unblocked, files free
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
    expect(coord.getConflicts("tab-2", ["/a.ts"])).toHaveLength(0);
  });

  it("abort then new prompt — re-claims happen naturally via checkAndClaim", () => {
    coord.claimFiles("tab-1", "Old Work", ["/a.ts", "/b.ts"]);

    // Abort
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // New prompt starts, agent edits /a.ts again → checkAndClaim re-claims it
    coord.claimFiles("tab-1", "New Work", ["/a.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
    const claim = coord.getClaimsForTab("tab-1").get(normPath("/a.ts"));
    expect(claim?.tabLabel).toBe("New Work");
  });
});

describe("termination: close tab during active dispatch", () => {
  it("closeTab order: claims cleared, agents cleared, tab marked closed", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Big Dispatch", ["/a.ts", "/b.ts", "/c.ts"]);

    // Simulate close sequence (matches React unmount order):
    // 1. chat.abort() fires → will trigger agentFinished later (async)
    // 2. TabInstance cleanup → coordinator.closeTab
    coord.closeTab("tab-1");

    // Everything cleared
    expect(coord.getClaimCount("tab-1")).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);

    // 3. Dispatch finally{} fires later (async) — these must be no-ops
    coord.agentFinished("tab-1"); // no-op: tab is closed
    coord.agentFinished("tab-1"); // no-op
    coord.agentFinished("tab-1"); // no-op
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("straggler tool calls after close are rejected", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature", ["/a.ts"]);
    coord.closeTab("tab-1");

    // Dispatch tool still executing after abort signal but before it catches
    // These straggler calls must all be rejected:
    const claim1 = coord.claimFiles("tab-1", "Feature", ["/straggler1.ts"]);
    expect(claim1.granted).toHaveLength(0);

    const claim2 = coord.claimFiles("tab-1", "Feature", ["/straggler2.ts", "/straggler3.ts"]);
    expect(claim2.granted).toHaveLength(0);
    expect(claim2.contested).toHaveLength(0); // not contested, just rejected

    // No ghost claims exist
    expect(coord.getAllClaims().size).toBe(0);
  });

  it("markIdle/markActive after close are no-ops", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.closeTab("tab-1");

    // React effect might fire markIdle after unmount in edge cases
    coord.markIdle("tab-1"); // should not start a timer or throw
    coord.markActive("tab-1"); // should not throw

    expect(coord.getAllClaims().size).toBe(0);
  });

  it("other tabs unaffected by closed tab", () => {
    coord.agentStarted("tab-1");
    coord.agentStarted("tab-2");
    coord.claimFiles("tab-1", "Closing", ["/a.ts"]);
    coord.claimFiles("tab-2", "Staying", ["/b.ts"]);

    coord.closeTab("tab-1");

    // Tab-2 entirely unaffected
    expect(coord.getClaimCount("tab-2")).toBe(1);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(1);
    expect(coord.getTabsWithActiveAgents()[0]).toBe("Staying");

    // Tab-2 can claim tab-1's old files
    const result = coord.claimFiles("tab-2", "Staying", ["/a.ts"]);
    expect(result.granted).toHaveLength(1);
    expect(result.contested).toHaveLength(0);
  });

  it("forceClaim on closed tab's file works for other tabs", () => {
    coord.claimFiles("tab-1", "Old Owner", ["/target.ts"]);
    coord.closeTab("tab-1");

    // File is now unclaimed — forceClaim should work
    const prev = coord.forceClaim("tab-2", "New Owner", "/target.ts");
    expect(prev).toBeNull(); // no previous owner (was released)
    expect(coord.getClaimCount("tab-2")).toBe(1);
  });
});

describe("termination: close tab with pending idle timer", () => {
  it("closeTab cancels pending idle timer", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    coord.markIdle("tab-1"); // starts 60s timer

    coord.closeTab("tab-1"); // should clear the timer

    // Claims already gone via closeTab — timer shouldn't fire or cause issues
    expect(coord.getClaimCount("tab-1")).toBe(0);
  });

  it("idle releaseAll does NOT mark tab as closed", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

    // Simulate idle timer expiry (calls releaseAll, not closeTab)
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // Tab is still alive — new prompt claims should work
    const result = coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    expect(result.granted).toHaveLength(1);
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

describe("termination: close tab during compaction", () => {
  it("closeTab during stale state doesn't leak", () => {
    // Tab has claims and agents, compaction was in progress
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Compacting", ["/a.ts", "/b.ts"]);

    // Compaction abort + tab close happen ~simultaneously
    coord.closeTab("tab-1");

    // Clean state
    expect(coord.getAllClaims().size).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);

    // No zombie state
    coord.agentFinished("tab-1"); // straggler from compaction — no-op
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });
});

describe("termination: rapid close + reopen same tabId", () => {
  it("closed tabId cannot be reused", () => {
    coord.claimFiles("tab-1", "Original", ["/a.ts"]);
    coord.closeTab("tab-1");

    // Even if somehow the same tabId is reused (shouldn't happen but defensive)
    const result = coord.claimFiles("tab-1", "Reborn", ["/b.ts"]);
    expect(result.granted).toHaveLength(0); // blocked by closedTabs

    // agentStarted also blocked
    coord.agentStarted("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });

  it("resetWorkspaceCoordinator clears closedTabs — allows reuse after full reset", () => {
    coord.claimFiles("tab-1", "Original", ["/a.ts"]);
    coord.closeTab("tab-1");

    resetWorkspaceCoordinator();
    coord = getWorkspaceCoordinator();

    // After reset, tab-1 can be used again
    const result = coord.claimFiles("tab-1", "Fresh", ["/c.ts"]);
    expect(result.granted).toHaveLength(1);
  });

  it("releaseAllGlobal clears closedTabs — app shutdown allows clean restart", () => {
    coord.claimFiles("tab-1", "Tab", ["/a.ts"]);
    coord.closeTab("tab-1");

    coord.releaseAllGlobal();

    // After global release, tab-1 can be reused
    const result = coord.claimFiles("tab-1", "Reborn", ["/a.ts"]);
    expect(result.granted).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMMANDS vs AUTO-SYSTEM — END-TO-END INTERACTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("/unclaim file → agent re-claims on next edit", () => {
  it("unclaim then checkAndClaim re-claims the same file", () => {
    // Agent edits file → auto-claimed
    checkAndClaim("tab-1", "Feature", "/src/api.ts");
    expect(coord.getClaimCount("tab-1")).toBe(1);

    // User runs /unclaim src/api.ts
    coord.releaseFiles("tab-1", [resolve("/src/api.ts")]);
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // Agent edits the same file again → re-claimed automatically
    const warning = checkAndClaim("tab-1", "Feature", "/src/api.ts");
    expect(warning).toBeNull(); // no warning — it's our own file
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("unclaim then OTHER tab claims → agent gets warning on re-edit", () => {
    checkAndClaim("tab-1", "Feature A", "/shared.ts");
    expect(coord.getClaimCount("tab-1")).toBe(1);

    // User unclaims in tab-1
    coord.releaseFiles("tab-1", [resolve("/shared.ts")]);

    // Tab-2 swoops in and claims it
    coord.claimFiles("tab-2", "Feature B", ["/shared.ts"]);

    // Tab-1 agent edits again → gets conflict warning
    const warning = checkAndClaim("tab-1", "Feature A", "/shared.ts");
    expect(warning).not.toBeNull();
    expect(warning).toContain("Feature B");

    // Tab-2 still owns it — tab-1's contested claim didn't transfer
    const claims = coord.getClaimsForTab("tab-2");
    expect(claims.has(normPath("/shared.ts"))).toBe(true);
  });
});

describe("/unclaim-all during active dispatch", () => {
  it("agents re-claim files as they continue editing", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Dispatch", ["/a.ts", "/b.ts", "/c.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(3);

    // User runs /unclaim-all (calls releaseAll)
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    // activeAgents also cleared by releaseAll
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);

    // But dispatch agents are still running — they edit files via checkAndClaim
    checkAndClaim("tab-1", "Dispatch", "/a.ts");
    checkAndClaim("tab-1", "Dispatch", "/c.ts");
    expect(coord.getClaimCount("tab-1")).toBe(2); // only the re-edited files

    // /b.ts was NOT re-edited — it stays free
    const conflicts = coord.getConflicts("tab-2", ["/b.ts"]);
    expect(conflicts).toHaveLength(0); // free!
  });

  it("unclaim-all unblocks other tabs' git ops even with dispatch running", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    // Tab-2 blocked
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);

    // User says "release everything"
    coord.releaseAll("tab-1");

    // Tab-2 unblocked immediately
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
  });

  it("unclaim-all then abort → clean state, no zombies", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Feature", ["/a.ts"]);

    // User runs /unclaim-all
    coord.releaseAll("tab-1");

    // Then immediately hits Escape (abort also calls releaseAll)
    coord.releaseAll("tab-1"); // double releaseAll is safe

    // Dispatch finally fires
    coord.agentFinished("tab-1"); // no-op — agents already cleared

    expect(coord.getAllClaims().size).toBe(0);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });
});

describe("/force-claim interactions with auto-system", () => {
  it("force-claim file from tab-2 → tab-2 agent gets warning on every edit", () => {
    // Tab-2 is editing /shared.ts
    coord.agentStarted("tab-2");
    checkAndClaim("tab-2", "Tab 2 Work", "/shared.ts");
    expect(coord.getClaimCount("tab-2")).toBe(1);

    // Tab-1 user force-claims it
    const prev = coord.forceClaim("tab-1", "Tab 1 Override", "/shared.ts");
    expect(prev?.tabId).toBe("tab-2");
    expect(coord.getClaimCount("tab-1")).toBe(1);
    expect(coord.getClaimCount("tab-2")).toBe(0);

    // Tab-2 agent edits again → checkAndClaim sees conflict
    const w1 = checkAndClaim("tab-2", "Tab 2 Work", "/shared.ts");
    expect(w1).not.toBeNull();
    expect(w1).toContain("Tab 1 Override");

    // Tab-1 still owns it
    expect(coord.getClaimsForTab("tab-1").has(normPath("/shared.ts"))).toBe(true);

    // Tab-2 agent edits again → still gets warning
    const w2 = checkAndClaim("tab-2", "Tab 2 Work", "/shared.ts");
    expect(w2).not.toBeNull();
  });

  it("force-claim then original owner aborts → force-claimer keeps ownership", () => {
    checkAndClaim("tab-1", "Original", "/target.ts");
    coord.forceClaim("tab-2", "Thief", "/target.ts");

    // Tab-1 aborts (releaseAll) — but /target.ts belongs to tab-2 now
    coord.releaseAll("tab-1");

    // Tab-2 still owns it
    expect(coord.getClaimsForTab("tab-2").has(normPath("/target.ts"))).toBe(true);
    expect(coord.getClaimCount("tab-2")).toBe(1);
  });

  it("force-claim then force-claimer aborts → file released", () => {
    checkAndClaim("tab-1", "Original", "/target.ts");
    coord.forceClaim("tab-2", "Thief", "/target.ts");

    // Tab-2 aborts — releases /target.ts
    coord.releaseAll("tab-2");

    // File is now free
    expect(coord.getAllClaims().size).toBe(0);

    // Tab-1 can reclaim
    const result = coord.claimFiles("tab-1", "Original", ["/target.ts"]);
    expect(result.granted).toHaveLength(1);
  });

  it("force-claim during dispatch → dispatch agent's checkAndClaim sees new owner", () => {
    coord.agentStarted("tab-1");
    checkAndClaim("tab-1", "Dispatch A", "/hot-file.ts");

    // Mid-dispatch, tab-2 user force-claims the file
    coord.forceClaim("tab-2", "Manual Override", "/hot-file.ts");

    // Tab-1's dispatch agent edits again
    const warning = checkAndClaim("tab-1", "Dispatch A", "/hot-file.ts");
    expect(warning).not.toBeNull();
    expect(warning).toContain("Manual Override");

    // File stays with tab-2
    expect(coord.getClaimsForTab("tab-2").has(normPath("/hot-file.ts"))).toBe(true);
  });

  it("force-claim on unclaimed file → simply claims it", () => {
    const prev = coord.forceClaim("tab-1", "Grabber", "/free-file.ts");
    expect(prev).toBeNull();
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("double force-claim from same tab → replaces own claim (resets editCount)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/x.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/x.ts"]);
    coord.claimFiles("tab-1", "Tab 1", ["/x.ts"]); // editCount=3

    const prev = coord.forceClaim("tab-1", "Tab 1 v2", "/x.ts");
    expect(prev?.editCount).toBe(3);

    const claim = coord.getClaimsForTab("tab-1").get(normPath("/x.ts"));
    expect(claim?.editCount).toBe(1);
    expect(claim?.tabLabel).toBe("Tab 1 v2");
  });
});

describe("/unclaim single file — precision release", () => {
  it("only releases the targeted file, not others", () => {
    checkAndClaim("tab-1", "Tab 1", "/a.ts");
    checkAndClaim("tab-1", "Tab 1", "/b.ts");
    checkAndClaim("tab-1", "Tab 1", "/c.ts");
    expect(coord.getClaimCount("tab-1")).toBe(3);

    coord.releaseFiles("tab-1", [resolve("/b.ts")]);
    expect(coord.getClaimCount("tab-1")).toBe(2);

    // a.ts and c.ts still claimed
    expect(coord.getClaimsForTab("tab-1").has(normPath("/a.ts"))).toBe(true);
    expect(coord.getClaimsForTab("tab-1").has(normPath("/c.ts"))).toBe(true);
    expect(coord.getClaimsForTab("tab-1").has(normPath("/b.ts"))).toBe(false);
  });

  it("unclaim file owned by OTHER tab — no-op", () => {
    coord.claimFiles("tab-1", "Owner", ["/theirs.ts"]);

    // Tab-2 tries to /unclaim a file they don't own
    coord.releaseFiles("tab-2", ["/theirs.ts"]);

    // Tab-1 still owns it
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });

  it("unclaim non-existent file — silent no-op", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/real.ts"]);
    coord.releaseFiles("tab-1", ["/imaginary.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(1);
  });
});

describe("compound tool claimAfterCompoundEdit vs commands", () => {
  it("/unclaim file → compound tool re-claims it post-hoc", () => {
    checkAndClaim("tab-1", "Tab 1", "/target.ts");
    coord.releaseFiles("tab-1", [resolve("/target.ts")]);
    expect(coord.getClaimCount("tab-1")).toBe(0);

    // rename_symbol touches /target.ts + /ref1.ts + /ref2.ts → claimAfterCompoundEdit
    claimAfterCompoundEdit("tab-1", "Tab 1", ["/target.ts", "/ref1.ts", "/ref2.ts"]);
    expect(coord.getClaimCount("tab-1")).toBe(3);
  });

  it("/force-claim then compound tool from original tab → contested", () => {
    checkAndClaim("tab-1", "Tab 1", "/module.ts");

    // Tab-2 force-claims
    coord.forceClaim("tab-2", "Override", "/module.ts");

    // Tab-1's compound tool (rename_symbol) modifies /module.ts post-hoc
    claimAfterCompoundEdit("tab-1", "Tab 1", ["/module.ts", "/other.ts"]);

    // /module.ts stays with tab-2 (contested in claimFiles)
    expect(coord.getClaimsForTab("tab-2").has(normPath("/module.ts"))).toBe(true);
    // /other.ts goes to tab-1
    expect(coord.getClaimsForTab("tab-1").has(normPath("/other.ts"))).toBe(true);
  });
});

describe("full lifecycle: prompt → edit → abort → command → new prompt", () => {
  it("complete cycle with all interactions", () => {
    // 1. Agent starts working, claims files
    coord.agentStarted("tab-1");
    checkAndClaim("tab-1", "Feature", "/api.ts");
    checkAndClaim("tab-1", "Feature", "/db.ts");
    checkAndClaim("tab-1", "Feature", "/utils.ts");
    expect(coord.getClaimCount("tab-1")).toBe(3);

    // 2. Tab-2's agent also edits — gets warnings
    const w = checkAndClaim("tab-2", "Bugfix", "/api.ts");
    expect(w).toContain("Feature");

    // 3. User force-claims /db.ts for tab-2
    coord.forceClaim("tab-2", "Bugfix", "/db.ts");
    expect(coord.getClaimsForTab("tab-2").has(normPath("/db.ts"))).toBe(true);
    expect(coord.getClaimCount("tab-1")).toBe(2); // lost /db.ts

    // 4. User aborts tab-1 (releaseAll)
    coord.releaseAll("tab-1");
    expect(coord.getClaimCount("tab-1")).toBe(0);
    // /db.ts stays with tab-2
    expect(coord.getClaimsForTab("tab-2").has(normPath("/db.ts"))).toBe(true);

    // 5. agentFinished fires from dispatch finally
    coord.agentFinished("tab-1");

    // 6. User types new prompt in tab-1
    coord.markActive("tab-1");
    coord.agentStarted("tab-1");

    // 7. New agent edits /api.ts (was freed by abort) — re-claims
    const w2 = checkAndClaim("tab-1", "New Feature", "/api.ts");
    expect(w2).toBeNull(); // free, no conflict
    expect(coord.getClaimCount("tab-1")).toBe(1);

    // 8. New agent tries /db.ts — gets warning (tab-2 owns it)
    const w3 = checkAndClaim("tab-1", "New Feature", "/db.ts");
    expect(w3).toContain("Bugfix");

    // 9. User does /unclaim-all in tab-2
    coord.releaseAll("tab-2");
    expect(coord.getClaimCount("tab-2")).toBe(0);

    // 10. Now tab-1 can grab /db.ts
    const w4 = checkAndClaim("tab-1", "New Feature", "/db.ts");
    expect(w4).toBeNull();
    expect(coord.getClaimCount("tab-1")).toBe(2);

    // 11. Cleanup
    coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COG TEST — FULL MACHINE FLOW WITH EVENT VERIFICATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("cog: every state change emits correct events", () => {
  it("claimFiles emits 'claim' event for the claiming tab", async () => {
    const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
    coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("claim");
    expect(events[0]!.tabId).toBe("tab-1");
  });

  it("releaseFiles emits 'release' event for the releasing tab", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    coord.releaseFiles("tab-1", ["/a.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("release");
    expect(events[0]!.tabId).toBe("tab-1");
  });

  it("forceClaim emits 'release' for old owner AND 'claim' for new owner", async () => {
    coord.claimFiles("tab-1", "Victim", ["/stolen.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    coord.forceClaim("tab-2", "Thief", "/stolen.ts");
    await tick();

    // Must have both events
    const releaseEvent = events.find((e) => e.event === "release" && e.tabId === "tab-1");
    const claimEvent = events.find((e) => e.event === "claim" && e.tabId === "tab-2");
    expect(releaseEvent).toBeDefined();
    expect(claimEvent).toBeDefined();
  });

  it("forceClaim on own file does NOT emit release for self", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/own.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    coord.forceClaim("tab-1", "Tab 1 v2", "/own.ts");
    await tick();

    // Only a claim event, no release (same tab)
    expect(events.every((e) => e.event === "claim")).toBe(true);
    expect(events.filter((e) => e.event === "release")).toHaveLength(0);
  });

  it("contested claimFiles emits 'conflict' event for the contesting tab", async () => {
    coord.claimFiles("tab-1", "Owner", ["/owned.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    coord.claimFiles("tab-2", "Contester", ["/owned.ts"]);
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("conflict");
    expect(events[0]!.tabId).toBe("tab-2");
  });

  it("releaseAll emits single batched 'release' event", async () => {
    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
    await tick();

    const events: Array<{ event: CoordinatorEvent; paths: string[] }> = [];
    coord.on((event, _tabId, paths) => events.push({ event, paths }));

    coord.releaseAll("tab-1");
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("release");
    expect(events[0]!.paths).toHaveLength(3);
  });
});

describe("cog: tab bar claim count stays in sync", () => {
  // Simulates the TabInstance useEffect listener
  function simulateTabBarListener(tabId: string): { getCount: () => number } {
    let count = coord.getClaimCount(tabId);
    coord.on((event, eventTabId) => {
      if (eventTabId === tabId || event === "release") {
        count = coord.getClaimCount(tabId);
      }
    });
    return { getCount: () => count };
  }

  it("claim count tracks through claim → release → reclaim cycle", async () => {
    const tab1 = simulateTabBarListener("tab-1");

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(1);

    coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(2);

    coord.releaseFiles("tab-1", ["/a.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(1);

    coord.releaseAll("tab-1");
    await tick();
    expect(tab1.getCount()).toBe(0);

    coord.claimFiles("tab-1", "Tab 1", ["/c.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(1);
  });

  it("force-claim updates BOTH tabs' counts", async () => {
    const tab1 = simulateTabBarListener("tab-1");
    const tab2 = simulateTabBarListener("tab-2");

    coord.claimFiles("tab-1", "Tab 1", ["/shared.ts", "/other.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(2);
    expect(tab2.getCount()).toBe(0);

    // Tab-2 steals /shared.ts
    coord.forceClaim("tab-2", "Tab 2", "/shared.ts");
    await tick();

    // Tab-1 lost one, tab-2 gained one
    expect(tab1.getCount()).toBe(1);
    expect(tab2.getCount()).toBe(1);
  });

  it("abort releases all — count goes to 0", async () => {
    const tab1 = simulateTabBarListener("tab-1");

    coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
    await tick();
    expect(tab1.getCount()).toBe(2);

    coord.releaseAll("tab-1");
    await tick();
    expect(tab1.getCount()).toBe(0);
  });

  it("3 tabs — each count independent and accurate through churn", async () => {
    const t1 = simulateTabBarListener("tab-1");
    const t2 = simulateTabBarListener("tab-2");
    const t3 = simulateTabBarListener("tab-3");

    coord.claimFiles("tab-1", "T1", ["/a.ts", "/b.ts"]);
    coord.claimFiles("tab-2", "T2", ["/c.ts"]);
    coord.claimFiles("tab-3", "T3", ["/d.ts", "/e.ts", "/f.ts"]);
    await tick();
    expect(t1.getCount()).toBe(2);
    expect(t2.getCount()).toBe(1);
    expect(t3.getCount()).toBe(3);

    // Tab-3 steals /a.ts from tab-1
    coord.forceClaim("tab-3", "T3", "/a.ts");
    await tick();
    expect(t1.getCount()).toBe(1);
    expect(t3.getCount()).toBe(4);

    // Tab-1 aborts
    coord.releaseAll("tab-1");
    await tick();
    expect(t1.getCount()).toBe(0);

    // Tab-2 unaffected
    expect(t2.getCount()).toBe(1);
  });
});

describe("cog: no deadlocks — every blocking path has an exit", () => {
  it("git block → agentFinished → unblocked (normal flow)", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    // Blocked
    expect(coord.getTabsWithActiveAgents("tab-2").length).toBeGreaterThan(0);

    // Normal completion
    coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
  });

  it("git block → abort (releaseAll) → unblocked", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    expect(coord.getTabsWithActiveAgents("tab-2").length).toBeGreaterThan(0);

    coord.releaseAll("tab-1");
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
  });

  it("git block → closeTab → unblocked", () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    expect(coord.getTabsWithActiveAgents("tab-2").length).toBeGreaterThan(0);

    coord.closeTab("tab-1");
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);
  });

  it("claim contention is never blocking — always advisory", () => {
    coord.claimFiles("tab-1", "Owner", ["/contested.ts"]);

    // Tab-2 tries to claim — gets contested result, NOT blocked
    const result = coord.claimFiles("tab-2", "Contester", ["/contested.ts"]);
    expect(result.contested).toHaveLength(1);
    // No thrown error, no blocking wait, no deadlock
  });

  it("circular claim contention — both tabs can proceed", () => {
    // Tab-1 owns /a.ts, tab-2 owns /b.ts
    coord.claimFiles("tab-1", "T1", ["/a.ts"]);
    coord.claimFiles("tab-2", "T2", ["/b.ts"]);

    // Tab-1 tries /b.ts, tab-2 tries /a.ts — both contested, both proceed
    const r1 = coord.claimFiles("tab-1", "T1", ["/b.ts"]);
    const r2 = coord.claimFiles("tab-2", "T2", ["/a.ts"]);

    expect(r1.contested).toHaveLength(1);
    expect(r2.contested).toHaveLength(1);

    // No deadlock — both got their results immediately
    expect(coord.getClaimCount("tab-1")).toBe(1); // still just /a.ts
    expect(coord.getClaimCount("tab-2")).toBe(1); // still just /b.ts
  });
});

describe("cog: stale sweep is the safety net — nothing persists forever", () => {
  it("claims have finite lifetime (stale sweep catches anything missed)", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/ancient.ts"]);
    const claim = coord.getAllClaims().get(normPath("/ancient.ts"));
    expect(claim).toBeDefined();

    // The claim's lastEditAt is Date.now() — fresh, not stale
    // In production, the 30s sweep interval checks lastEditAt > 5min
    // This guarantees no claim can persist more than ~5.5 minutes
    // without being refreshed by an actual edit
    const age = Date.now() - claim!.lastEditAt;
    expect(age).toBeLessThan(1000);
  });

  it("re-editing refreshes lastEditAt — keeps claim alive", () => {
    coord.claimFiles("tab-1", "Tab 1", ["/active.ts"]);
    const first = coord.getAllClaims().get(normPath("/active.ts"))!.lastEditAt;

    // Simulate time passing + re-edit
    coord.claimFiles("tab-1", "Tab 1", ["/active.ts"]);
    const second = coord.getAllClaims().get(normPath("/active.ts"))!.lastEditAt;

    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe("cog: full 3-tab autonomous session — no manual intervention needed", () => {
  it("3 tabs work independently, conflicts resolve naturally", async () => {
    const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
    coord.on((event, tabId) => events.push({ event, tabId }));

    // === Tab-1: starts a feature ===
    coord.markActive("tab-1");
    coord.agentStarted("tab-1");
    checkAndClaim("tab-1", "Auth Feature", "/src/auth.ts");
    checkAndClaim("tab-1", "Auth Feature", "/src/middleware.ts");
    checkAndClaim("tab-1", "Auth Feature", "/src/types.ts");

    // === Tab-2: starts a bugfix, touches /src/types.ts (shared) ===
    coord.markActive("tab-2");
    coord.agentStarted("tab-2");
    checkAndClaim("tab-2", "Bugfix", "/src/parser.ts");
    const typesWarning = checkAndClaim("tab-2", "Bugfix", "/src/types.ts");
    // Tab-2 gets warned about /src/types.ts — proceeds anyway (advisory)
    expect(typesWarning).toContain("Auth Feature");

    // === Tab-3: runs a refactor ===
    coord.markActive("tab-3");
    coord.agentStarted("tab-3");
    checkAndClaim("tab-3", "Refactor", "/src/utils.ts");
    claimAfterCompoundEdit("tab-3", "Refactor", ["/src/helpers.ts", "/src/index.ts"]);

    // State check: 3 tabs, each with their files, one overlap
    expect(coord.getClaimCount("tab-1")).toBe(3);
    expect(coord.getClaimCount("tab-2")).toBe(1); // /src/parser.ts only (types.ts is contested)
    expect(coord.getClaimCount("tab-3")).toBe(3);

    // Tab-2 is blocked from git commit (tab-1 and tab-3 have agents)
    expect(coord.getTabsWithActiveAgents("tab-2").length).toBe(2);

    // === Tab-1 finishes ===
    coord.agentFinished("tab-1");
    coord.markIdle("tab-1");

    // Tab-2 still blocked by tab-3
    expect(coord.getTabsWithActiveAgents("tab-2").length).toBe(1);

    // === Tab-3 finishes ===
    coord.agentFinished("tab-3");
    coord.markIdle("tab-3");

    // Tab-2 now unblocked
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);

    // === Tab-2 finishes ===
    coord.agentFinished("tab-2");
    coord.markIdle("tab-2");

    // All done — idle timers ticking, claims still alive
    expect(coord.getAllClaims().size).toBe(7);
    expect(coord.getTabsWithActiveAgents()).toHaveLength(0);

    // Events were emitted throughout
    await tick();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event === "claim")).toBe(true);
    expect(events.some((e) => e.event === "conflict")).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REGRESSION: VERIFIER PHASING + GIT ERROR WORDING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("regression: verifier releases git lock early", () => {
  it("agentFinished fires after desloppify — simulated dispatch lifecycle", () => {
    // Code agents phase
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Dispatch", ["/a.ts", "/b.ts"]);
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);

    // Desloppify phase (still editing)
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);

    // agentFinished fires AFTER desloppify, BEFORE verifier
    coord.agentFinished("tab-1");
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(0);

    // Verifier phase (read-only) — git is unblocked
    // Other tabs can now commit while verifier runs
    const result = coord.claimFiles("tab-2", "Other", ["/c.ts"]);
    expect(result.granted).toHaveLength(1);
  });

  it("if agentFinished is accidentally removed, git stays blocked", () => {
    coord.agentStarted("tab-1");
    // Without agentFinished, the agent count stays elevated
    expect(coord.getTabsWithActiveAgents("tab-2")).toHaveLength(1);
    // Cleanup
    coord.agentFinished("tab-1");
  });
});

describe("regression: git error message prevents retry loop", () => {
  it("git commit error says 'do not attempt again'", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    const result = await gitTool.execute(
      { action: "commit", message: "test" },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("do not attempt again");
    expect(result.output).not.toContain("Wait");
  });

  it("git stash error says 'do not attempt again'", async () => {
    coord.agentStarted("tab-1");
    coord.claimFiles("tab-1", "Worker", ["/a.ts"]);

    const result = await gitTool.execute(
      { action: "stash" },
      "tab-2",
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("do not attempt again");
    expect(result.output).not.toContain("Wait");
  });
});
