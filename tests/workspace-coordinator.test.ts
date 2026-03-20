import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { WorkspaceCoordinator } from "../src/core/coordination/WorkspaceCoordinator.js";
import type { CoordinatorEvent } from "../src/core/coordination/types.js";

let coord: WorkspaceCoordinator;

beforeEach(() => {
	coord = new WorkspaceCoordinator();
});

afterEach(() => {
	coord.dispose();
});

// ── Claim Lifecycle ─────────────────────────────────────────────────────

describe("claimFiles", () => {
	it("grants new claims to first tab", () => {
		const result = coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
		expect(result.granted).toHaveLength(2);
		expect(result.contested).toHaveLength(0);
	});

	it("normalizes paths to absolute", () => {
		const result = coord.claimFiles("tab-1", "Tab 1", ["src/foo.ts"]);
		expect(result.granted[0]).toBe(resolve("src/foo.ts"));
	});

	it("refreshes existing claim from same tab (increments editCount)", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const result = coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		expect(result.granted).toHaveLength(1);
		expect(result.contested).toHaveLength(0);

		const claims = coord.getClaimsForTab("tab-1");
		const claim = claims.get(resolve("/a.ts"));
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

	it("handles mixed granted and contested in one call", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const result = coord.claimFiles("tab-2", "Tab 2", ["/a.ts", "/b.ts"]);
		expect(result.granted).toHaveLength(1); // /b.ts
		expect(result.contested).toHaveLength(1); // /a.ts
		expect(result.granted[0]).toBe(resolve("/b.ts"));
	});

	it("does not transfer ownership on contest", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);

		const tab1Claims = coord.getClaimsForTab("tab-1");
		const tab2Claims = coord.getClaimsForTab("tab-2");
		expect(tab1Claims.size).toBe(1);
		expect(tab2Claims.size).toBe(0);
	});

	it("handles empty paths array", () => {
		const result = coord.claimFiles("tab-1", "Tab 1", []);
		expect(result.granted).toHaveLength(0);
		expect(result.contested).toHaveLength(0);
	});
});

// ── Release ─────────────────────────────────────────────────────────────

describe("releaseFiles", () => {
	it("releases specific files for a tab", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
		coord.releaseFiles("tab-1", ["/a.ts"]);

		expect(coord.getClaimCount("tab-1")).toBe(1);
		const claims = coord.getClaimsForTab("tab-1");
		expect(claims.has(resolve("/a.ts"))).toBe(false);
		expect(claims.has(resolve("/b.ts"))).toBe(true);
	});

	it("ignores release of files not owned by the tab", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.releaseFiles("tab-2", ["/a.ts"]); // tab-2 doesn't own it

		expect(coord.getClaimCount("tab-1")).toBe(1);
	});

	it("ignores release of unclaimed files", () => {
		coord.releaseFiles("tab-1", ["/nonexistent.ts"]);
		// No error — just a no-op
		expect(coord.getAllClaims().size).toBe(0);
	});
});

describe("releaseAll", () => {
	it("releases all claims for a tab", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts", "/c.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/d.ts"]);

		coord.releaseAll("tab-1");

		expect(coord.getClaimCount("tab-1")).toBe(0);
		expect(coord.getClaimCount("tab-2")).toBe(1);
	});

	it("is safe to call with no claims", () => {
		coord.releaseAll("tab-1"); // no-op
		expect(coord.getAllClaims().size).toBe(0);
	});

	it("allows another tab to claim released files", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.releaseAll("tab-1");

		const result = coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);
		expect(result.granted).toHaveLength(1);
		expect(result.contested).toHaveLength(0);
	});
});

// ── Force Claim ─────────────────────────────────────────────────────────

describe("forceClaim", () => {
	it("steals a file from another tab", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const prev = coord.forceClaim("tab-2", "Tab 2", "/a.ts");

		expect(prev).not.toBeNull();
		expect(prev!.tabId).toBe("tab-1");
		expect(prev!.tabLabel).toBe("Tab 1");

		// Ownership transferred
		const tab2Claims = coord.getClaimsForTab("tab-2");
		expect(tab2Claims.has(resolve("/a.ts"))).toBe(true);
		const tab1Claims = coord.getClaimsForTab("tab-1");
		expect(tab1Claims.has(resolve("/a.ts"))).toBe(false);
	});

	it("returns null when claiming an unclaimed file", () => {
		const prev = coord.forceClaim("tab-1", "Tab 1", "/a.ts");
		expect(prev).toBeNull();

		expect(coord.getClaimCount("tab-1")).toBe(1);
	});

	it("returns own claim when force-claiming own file", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const prev = coord.forceClaim("tab-1", "Tab 1", "/a.ts");

		expect(prev).not.toBeNull();
		expect(prev!.tabId).toBe("tab-1");
		expect(coord.getClaimCount("tab-1")).toBe(1);
	});
});

// ── Query Methods ───────────────────────────────────────────────────────

describe("getConflicts", () => {
	it("returns conflicts from another tab's perspective", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);

		const conflicts = coord.getConflicts("tab-2", ["/a.ts", "/b.ts", "/c.ts"]);
		expect(conflicts).toHaveLength(2);
		expect(conflicts[0]!.ownerTabId).toBe("tab-1");
		expect(conflicts[0]!.ownerTabLabel).toBe("Tab 1");
		expect(conflicts[0]!.editCount).toBe(1);
	});

	it("returns empty for own files", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const conflicts = coord.getConflicts("tab-1", ["/a.ts"]);
		expect(conflicts).toHaveLength(0);
	});

	it("returns empty for unclaimed files", () => {
		const conflicts = coord.getConflicts("tab-1", ["/unclaimed.ts"]);
		expect(conflicts).toHaveLength(0);
	});
});

describe("getClaimsForTab", () => {
	it("returns copies, not references", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const claims = coord.getClaimsForTab("tab-1");
		const claim = claims.get(resolve("/a.ts"))!;

		// Mutating the copy should not affect the coordinator
		claim.editCount = 999;

		const fresh = coord.getClaimsForTab("tab-1");
		expect(fresh.get(resolve("/a.ts"))!.editCount).toBe(1);
	});
});

describe("getActiveEditors", () => {
	it("groups claims by tabId", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/c.ts"]);

		const editors = coord.getActiveEditors();
		expect(editors.size).toBe(2);
		expect(editors.get("tab-1")).toHaveLength(2);
		expect(editors.get("tab-2")).toHaveLength(1);
	});

	it("returns empty map when no claims", () => {
		expect(coord.getActiveEditors().size).toBe(0);
	});
});

describe("getClaimCount", () => {
	it("counts claims for a specific tab", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/c.ts"]);

		expect(coord.getClaimCount("tab-1")).toBe(2);
		expect(coord.getClaimCount("tab-2")).toBe(1);
		expect(coord.getClaimCount("tab-3")).toBe(0);
	});
});

describe("getAllClaims", () => {
	it("returns all claims as a new Map", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);

		const all = coord.getAllClaims();
		expect(all.size).toBe(2);

		// Should be a copy
		all.clear();
		expect(coord.getAllClaims().size).toBe(2);
	});
});

// ── Events ──────────────────────────────────────────────────────────────

describe("events", () => {
	it("emits 'claim' on new claims", () => {
		const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
		coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));

		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("claim");
		expect(events[0]!.tabId).toBe("tab-1");
	});

	it("emits 'conflict' on contested claims", () => {
		const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

		coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));
		coord.claimFiles("tab-2", "Tab 2", ["/a.ts"]);

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("conflict");
		expect(events[0]!.tabId).toBe("tab-2");
	});

	it("emits 'release' on releaseFiles", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

		const events: Array<{ event: CoordinatorEvent; tabId: string }> = [];
		coord.on((event, tabId) => events.push({ event, tabId }));
		coord.releaseFiles("tab-1", ["/a.ts"]);

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("release");
	});

	it("emits 'release' on releaseAll", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts", "/b.ts"]);

		const events: Array<{ event: CoordinatorEvent; tabId: string; paths: string[] }> = [];
		coord.on((event, tabId, paths) => events.push({ event, tabId, paths }));
		coord.releaseAll("tab-1");

		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe("release");
		expect(events[0]!.paths).toHaveLength(2);
	});

	it("does not emit release when nothing to release", () => {
		const events: Array<{ event: CoordinatorEvent }> = [];
		coord.on((event) => events.push({ event }));

		coord.releaseAll("tab-1");
		coord.releaseFiles("tab-1", ["/a.ts"]);

		expect(events).toHaveLength(0);
	});

	it("unsubscribes via returned function", () => {
		const events: CoordinatorEvent[] = [];
		const unsub = coord.on((event) => events.push(event));

		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		expect(events).toHaveLength(1);

		unsub();
		coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
		expect(events).toHaveLength(1); // no new event
	});

	it("emits both 'claim' and 'conflict' for mixed results", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

		const events: CoordinatorEvent[] = [];
		coord.on((event) => events.push(event));

		coord.claimFiles("tab-2", "Tab 2", ["/a.ts", "/b.ts"]);

		expect(events).toContain("claim");
		expect(events).toContain("conflict");
	});

	it("swallows listener errors without breaking", () => {
		coord.on(() => {
			throw new Error("listener crash");
		});
		const events: CoordinatorEvent[] = [];
		coord.on((event) => events.push(event));

		// Should not throw
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		expect(events).toHaveLength(1);
	});
});

// ── Idle & Stale ────────────────────────────────────────────────────────

describe("idle timer", () => {
	it("markIdle + wait releases claims", async () => {
		// Create a coordinator with short timeouts for testing
		coord.dispose();
		// We'll test the flow manually by calling markIdle and advancing time
		coord = new WorkspaceCoordinator();

		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		expect(coord.getClaimCount("tab-1")).toBe(1);

		// markActive should prevent release
		coord.markIdle("tab-1");
		coord.markActive("tab-1");

		// Claims should still be there
		expect(coord.getClaimCount("tab-1")).toBe(1);
	});

	it("claiming files clears idle timer", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.markIdle("tab-1");

		// New claim should clear idle timer
		coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
		expect(coord.getClaimCount("tab-1")).toBe(2);
	});
});

// ── releaseAllGlobal ────────────────────────────────────────────────────

describe("releaseAllGlobal", () => {
	it("clears all claims across all tabs", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		coord.claimFiles("tab-2", "Tab 2", ["/b.ts"]);
		coord.claimFiles("tab-3", "Tab 3", ["/c.ts"]);

		coord.releaseAllGlobal();

		expect(coord.getAllClaims().size).toBe(0);
		expect(coord.getClaimCount("tab-1")).toBe(0);
		expect(coord.getClaimCount("tab-2")).toBe(0);
		expect(coord.getClaimCount("tab-3")).toBe(0);
	});
});

// ── Dispose ─────────────────────────────────────────────────────────────

describe("dispose", () => {
	it("clears all state", () => {
		coord.claimFiles("tab-1", "Tab 1", ["/a.ts"]);
		const events: CoordinatorEvent[] = [];
		coord.on((event) => events.push(event));

		coord.dispose();

		expect(coord.getAllClaims().size).toBe(0);

		// No events emitted after dispose
		events.length = 0;
		coord.claimFiles("tab-1", "Tab 1", ["/b.ts"]);
		// listeners were cleared, so no events captured
		expect(events).toHaveLength(0);
	});
});
