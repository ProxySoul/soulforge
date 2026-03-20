import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	getWorkspaceCoordinator,
	resetWorkspaceCoordinator,
	WorkspaceCoordinator,
} from "../src/core/coordination/WorkspaceCoordinator.js";
import {
	checkAndClaim,
	formatConflictWarning,
	prependWarning,
} from "../src/core/coordination/tool-wrapper.js";
import type { ConflictInfo } from "../src/core/coordination/types.js";

// ── formatConflictWarning ───────────────────────────────────────────────

describe("formatConflictWarning", () => {
	it("returns null for empty conflicts", () => {
		expect(formatConflictWarning([])).toBeNull();
	});

	it("formats a single conflict", () => {
		const conflicts: ConflictInfo[] = [
			{
				path: resolve("src/foo.ts"),
				ownerTabId: "tab-1",
				ownerTabLabel: "Tab 1",
				ownedSince: Date.now() - 30_000,
				editCount: 3,
				lastEditAt: Date.now() - 10_000,
			},
		];

		const result = formatConflictWarning(conflicts)!;
		expect(result).toContain("⚠️");
		expect(result).toContain('Tab "Tab 1"');
		expect(result).toContain("3 edits");
		expect(result).toContain("10s ago");
	});

	it("formats singular edit count", () => {
		const conflicts: ConflictInfo[] = [
			{
				path: "/absolute/path.ts",
				ownerTabId: "tab-1",
				ownerTabLabel: "Tab 1",
				ownedSince: Date.now(),
				editCount: 1,
				lastEditAt: Date.now(),
			},
		];

		const result = formatConflictWarning(conflicts)!;
		expect(result).toContain("1 edit,");
		expect(result).not.toContain("1 edits");
	});

	it("formats multiple conflicts as multi-line", () => {
		const conflicts: ConflictInfo[] = [
			{
				path: "/a.ts",
				ownerTabId: "tab-1",
				ownerTabLabel: "Tab 1",
				ownedSince: Date.now(),
				editCount: 1,
				lastEditAt: Date.now(),
			},
			{
				path: "/b.ts",
				ownerTabId: "tab-2",
				ownerTabLabel: "Tab 2",
				ownedSince: Date.now(),
				editCount: 5,
				lastEditAt: Date.now() - 120_000,
			},
		];

		const result = formatConflictWarning(conflicts)!;
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('Tab "Tab 1"');
		expect(lines[1]).toContain('Tab "Tab 2"');
		expect(lines[1]).toContain("2m ago");
	});

	it("formats hours correctly", () => {
		const conflicts: ConflictInfo[] = [
			{
				path: "/a.ts",
				ownerTabId: "tab-1",
				ownerTabLabel: "Tab 1",
				ownedSince: Date.now(),
				editCount: 1,
				lastEditAt: Date.now() - 7200_000,
			},
		];

		const result = formatConflictWarning(conflicts)!;
		expect(result).toContain("2h ago");
	});
});

// ── prependWarning ──────────────────────────────────────────────────────

describe("prependWarning", () => {
	it("returns original result when warning is null", () => {
		expect(prependWarning("Edited file.ts", null)).toBe("Edited file.ts");
	});

	it("prepends warning with separator", () => {
		const result = prependWarning("Edited file.ts", "⚠️ Conflict!");
		expect(result).toContain("⚠️ Conflict!");
		expect(result).toContain("Proceeding anyway");
		expect(result).toContain("Edited file.ts");
		// Warning comes first
		expect(result.indexOf("⚠️")).toBeLessThan(result.indexOf("Edited file.ts"));
	});
});

// ── checkAndClaim ───────────────────────────────────────────────────────

describe("checkAndClaim", () => {
	beforeEach(() => {
		resetWorkspaceCoordinator();
	});

	afterEach(() => {
		resetWorkspaceCoordinator();
	});

	it("returns null when tabId is undefined", () => {
		expect(checkAndClaim(undefined, "Tab 1", "/a.ts")).toBeNull();
	});

	it("returns null when tabLabel is undefined", () => {
		expect(checkAndClaim("tab-1", undefined, "/a.ts")).toBeNull();
	});

	it("returns null and claims file on first edit (no conflict)", () => {
		const warning = checkAndClaim("tab-1", "Tab 1", "/a.ts");
		expect(warning).toBeNull();

		// File should now be claimed
		const coord = getWorkspaceCoordinator();
		expect(coord.getClaimCount("tab-1")).toBe(1);
	});

	it("returns warning when another tab owns the file", () => {
		const coord = getWorkspaceCoordinator();
		coord.claimFiles("tab-1", "Tab 1", [resolve("/a.ts")]);

		const warning = checkAndClaim("tab-2", "Tab 2", "/a.ts");
		expect(warning).not.toBeNull();
		expect(warning).toContain("⚠️");
		expect(warning).toContain('Tab "Tab 1"');
	});

	it("claims the file even when contested", () => {
		const coord = getWorkspaceCoordinator();
		coord.claimFiles("tab-1", "Tab 1", [resolve("/a.ts")]);

		checkAndClaim("tab-2", "Tab 2", "/a.ts");

		// Tab 1 still owns it (not transferred)
		expect(coord.getClaimsForTab("tab-1").size).toBe(1);
		// Tab 2 does NOT own it (contested, not granted)
		expect(coord.getClaimsForTab("tab-2").size).toBe(0);
	});

	it("returns null when re-editing own file", () => {
		checkAndClaim("tab-1", "Tab 1", "/a.ts");
		const warning = checkAndClaim("tab-1", "Tab 1", "/a.ts");
		expect(warning).toBeNull();
	});
});

// ── Singleton ───────────────────────────────────────────────────────────

describe("singleton", () => {
	afterEach(() => {
		resetWorkspaceCoordinator();
	});

	it("getWorkspaceCoordinator returns same instance", () => {
		const a = getWorkspaceCoordinator();
		const b = getWorkspaceCoordinator();
		expect(a).toBe(b);
	});

	it("resetWorkspaceCoordinator creates new instance", () => {
		const a = getWorkspaceCoordinator();
		a.claimFiles("tab-1", "Tab 1", ["/a.ts"]);

		resetWorkspaceCoordinator();

		const b = getWorkspaceCoordinator();
		expect(b).not.toBe(a);
		expect(b.getAllClaims().size).toBe(0);
	});
});
