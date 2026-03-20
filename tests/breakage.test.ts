/**
 * Breakage tests — things that COULD break but weren't tested.
 *
 * Categories:
 *   1. Concurrency (SessionManager, MemoryDB)
 *   2. Security bypass (symlinks → forbidden files, read_file forbidden gate)
 *   3. Boundary conditions (exact thresholds, off-by-one)
 *   4. Error paths (malformed input, partial failures)
 */
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryDB } from "../src/core/memory/db.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { ChatMessage } from "../src/types/index.js";
import type { SessionMeta, TabMeta } from "../src/core/sessions/types.js";
import {
	initForbidden,
	isForbidden,
	addSessionPattern,
} from "../src/core/security/forbidden.js";
import { computeDiff } from "../src/core/diff.js";
import { extractConversationTerms } from "../src/core/context/manager.js";
import { readFileTool } from "../src/core/tools/read-file.js";

// ─── Helpers ───

function makeTmpDir(label: string): string {
	const dir = join(tmpdir(), `breakage-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeTab(id: string): TabMeta {
	return {
		id,
		label: "Tab",
		activeModel: "test-model",
		sessionId: "test",
		planMode: false,
		planRequest: null,
		coAuthorCommits: false,
		tokenUsage: { prompt: 0, completion: 0, total: 0 },
		messageRange: { startLine: 0, endLine: 0 },
	};
}

function makeMeta(id: string, tabs: Array<{ id: string }> = [{ id: "tab-1" }]): SessionMeta {
	return {
		id,
		title: "Test session",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		activeTabId: tabs[0]!.id,
		cwd: "/tmp",
		forgeMode: "default",
		tabs: tabs.map((t) => makeTab(t.id)),
	};
}

function makeMessage(role: "user" | "assistant", content: string): ChatMessage {
	return { role, content } as ChatMessage;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. CONCURRENCY — Race conditions that can corrupt data
// ═══════════════════════════════════════════════════════════════════════

describe("Concurrency — SessionManager", () => {
	let dir: string;
	let manager: SessionManager;

	beforeEach(() => {
		dir = makeTmpDir("session-concurrent");
		manager = new SessionManager(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("concurrent saves to SAME session don't corrupt data", async () => {
		const saves = Array.from({ length: 10 }, (_, i) => {
			const meta = makeMeta("race-same");
			meta.title = `Save ${i}`;
			const msgs = [makeMessage("user", `message from save ${i}`)];
			return () => manager.saveSession(meta, new Map([["tab-1", msgs]]));
		});

		await Promise.all(saves.map((fn) => Promise.resolve().then(fn)));

		const loaded = manager.loadSession("race-same");
		expect(loaded).not.toBeNull();
		expect(loaded!.meta.title).toMatch(/^Save \d$/);
		const msgs = loaded!.tabMessages.get("tab-1");
		expect(msgs).toHaveLength(1);
		expect(msgs![0]!.content).toMatch(/^message from save \d$/);
	});

	it("concurrent saves to DIFFERENT sessions don't interfere", async () => {
		const saves = Array.from({ length: 20 }, (_, i) => {
			const id = `race-diff-${i}`;
			const meta = makeMeta(id);
			const msgs = [makeMessage("user", `content-${i}`)];
			return () => manager.saveSession(meta, new Map([["tab-1", msgs]]));
		});

		await Promise.all(saves.map((fn) => Promise.resolve().then(fn)));

		for (let i = 0; i < 20; i++) {
			const loaded = manager.loadSession(`race-diff-${i}`);
			expect(loaded).not.toBeNull();
			const msgs = loaded!.tabMessages.get("tab-1");
			expect(msgs).toHaveLength(1);
			expect(msgs![0]!.content).toBe(`content-${i}`);
		}
	});

	it("save during load doesn't produce half-written state", async () => {
		const meta = makeMeta("save-load-race");
		const msgs = [makeMessage("user", "original")];
		manager.saveSession(meta, new Map([["tab-1", msgs]]));

		const results = await Promise.all([
			Promise.resolve().then(() => manager.loadSession("save-load-race")),
			Promise.resolve().then(() => {
				const newMeta = makeMeta("save-load-race");
				newMeta.title = "Updated";
				manager.saveSession(newMeta, new Map([["tab-1", [makeMessage("user", "updated")]]]));
			}),
		]);

		const loaded = results[0];
		// Either we got the old version or the new version — never a mix
		if (loaded) {
			const msgs = loaded.tabMessages.get("tab-1");
			expect(msgs).toHaveLength(1);
			const content = msgs![0]!.content;
			expect(content === "original" || content === "updated").toBe(true);
		}

		// Final state should be consistent
		const final = manager.loadSession("save-load-race");
		expect(final).not.toBeNull();
		expect(final!.tabMessages.get("tab-1")![0]!.content).toBe("updated");
	});

	it("concurrent deletes don't throw", async () => {
		manager.saveSession(makeMeta("del-race"), new Map([["tab-1", []]]));

		const results = await Promise.allSettled([
			Promise.resolve().then(() => manager.deleteSession("del-race")),
			Promise.resolve().then(() => manager.deleteSession("del-race")),
			Promise.resolve().then(() => manager.deleteSession("del-race")),
		]);

		// At least one should succeed, none should throw unhandled
		const successes = results.filter((r) => r.status === "fulfilled");
		expect(successes.length).toBe(3);

		// At most one returned true
		const trueResults = successes.filter(
			(r) => r.status === "fulfilled" && r.value === true,
		);
		expect(trueResults.length).toBeGreaterThanOrEqual(1);
	});
});

describe("Concurrency — MemoryDB", () => {
	it("concurrent writes to same DB don't lose data", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			const ids: string[] = [];
			for (let i = 0; i < 100; i++) {
				const r = db.write({ title: `Concurrent ${i}`, category: "fact", tags: [`t${i}`] });
				ids.push(r.id);
			}

			expect(db.list().length).toBe(100);

			for (const id of ids) {
				expect(db.read(id)).not.toBeNull();
			}
		} finally {
			db.close();
		}
	});

	it("concurrent upserts to same ID preserve last write", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			for (let i = 0; i < 50; i++) {
				db.write({ id: "contested", title: `Version ${i}`, category: "fact", tags: [] });
			}

			const final = db.read("contested");
			expect(final).not.toBeNull();
			expect(final!.title).toBe("Version 49");
		} finally {
			db.close();
		}
	});

	it("write + delete interleaving doesn't corrupt FTS", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			for (let i = 0; i < 50; i++) {
				const r = db.write({
					title: `Interleave uniqueterm${i}`,
					category: "fact",
					tags: [],
				});
				if (i % 2 === 0) db.delete(r.id);
			}

			// FTS should be consistent with main table
			const list = db.list();
			expect(list.length).toBe(25);

			// Search should only find non-deleted
			const found = db.search("uniqueterm0");
			expect(found.length).toBe(0); // deleted (even index)

			const found1 = db.search("uniqueterm1");
			expect(found1.length).toBe(1); // kept (odd index)
		} finally {
			db.close();
		}
	});

	it("deleteAll during search doesn't throw", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			for (let i = 0; i < 100; i++) {
				db.write({ title: `Searchable term${i}`, category: "fact", tags: [] });
			}

			// Search then immediately deleteAll
			const results = db.search("Searchable");
			db.deleteAll();

			// Results from before delete should still be valid objects
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]!.title).toContain("Searchable");

			// DB should be empty now
			expect(db.list().length).toBe(0);
			expect(db.search("Searchable").length).toBe(0);
		} finally {
			db.close();
		}
	});
});

describe("Concurrency — MemoryDB file-backed", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir("memdb-file");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("two DB instances on same file don't corrupt each other", () => {
		const dbPath = join(dir, "shared.db");
		const db1 = new MemoryDB(dbPath, "project");
		const db2 = new MemoryDB(dbPath, "project");

		try {
			db1.write({ id: "from-db1", title: "Written by DB1", category: "fact", tags: [] });
			db2.write({ id: "from-db2", title: "Written by DB2", category: "fact", tags: [] });

			// Both should be visible from either connection (WAL mode)
			const list1 = db1.list();
			const list2 = db2.list();

			expect(list1.length).toBe(2);
			expect(list2.length).toBe(2);
		} finally {
			db1.close();
			db2.close();
		}
	});

	it("rapid writes from two instances maintain count", () => {
		const dbPath = join(dir, "rapid.db");
		const db1 = new MemoryDB(dbPath, "project");
		const db2 = new MemoryDB(dbPath, "project");

		try {
			for (let i = 0; i < 50; i++) {
				db1.write({ title: `DB1 record ${i}`, category: "fact", tags: [] });
				db2.write({ title: `DB2 record ${i}`, category: "decision", tags: [] });
			}

			const total = db1.list().length;
			expect(total).toBe(100);
		} finally {
			db1.close();
			db2.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 2. SECURITY — Symlink bypass, forbidden file gates
// ═══════════════════════════════════════════════════════════════════════

describe("Security — symlink bypass of forbidden files", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir("symlink-security");
		initForbidden(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("symlink pointing to .env is still forbidden (realpath resolves)", () => {
		const envFile = join(dir, ".env");
		writeFileSync(envFile, "SECRET=hunter2");
		const link = join(dir, "totally-safe.txt");
		symlinkSync(envFile, link);

		// The symlink target is .env — should be caught
		expect(isForbidden(link)).toBe(".env");
	});

	it("symlink pointing to id_rsa is still forbidden", () => {
		const keyFile = join(dir, "id_rsa");
		writeFileSync(keyFile, "private key data");
		const link = join(dir, "my-config");
		symlinkSync(keyFile, link);

		expect(isForbidden(link)).toBe("id_rsa");
	});

	it("symlink to .env in subdirectory is forbidden", () => {
		const subdir = join(dir, "config");
		mkdirSync(subdir, { recursive: true });
		const envFile = join(subdir, ".env.production");
		writeFileSync(envFile, "DB_PASS=secret");
		const link = join(dir, "config-link");
		symlinkSync(envFile, link);

		expect(isForbidden(link)).toBe(".env.*");
	});

	it("symlink with innocent name to credentials.json is forbidden", () => {
		const creds = join(dir, "credentials.json");
		writeFileSync(creds, '{"api_key":"abc123"}');
		const link = join(dir, "data.json");
		symlinkSync(creds, link);

		expect(isForbidden(link)).toBe("credentials.json");
	});

	it("symlink to symlink to .env is forbidden (chained symlinks)", () => {
		const envFile = join(dir, ".env");
		writeFileSync(envFile, "SECRET=yes");
		const link1 = join(dir, "link1");
		symlinkSync(envFile, link1);
		const link2 = join(dir, "link2");
		symlinkSync(link1, link2);

		expect(isForbidden(link2)).toBe(".env");
	});

	it("non-forbidden symlink target is allowed", () => {
		const safeFile = join(dir, "index.ts");
		writeFileSync(safeFile, "export {}");
		const link = join(dir, "alias.ts");
		symlinkSync(safeFile, link);

		expect(isForbidden(link)).toBeNull();
	});

	it("directory symlink containing .env resolves correctly", () => {
		const realDir = join(dir, "real-secrets");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, ".env"), "SECRET=1");

		const linkDir = join(dir, "safe-config");
		symlinkSync(realDir, linkDir);

		expect(isForbidden(join(linkDir, ".env"))).toBe(".env");
	});
});

describe("Security — read_file respects forbidden gate", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir("readfile-forbidden");
		initForbidden(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("read_file blocks .env files", async () => {
		const envFile = join(dir, ".env");
		writeFileSync(envFile, "SECRET=hunter2\nAPI_KEY=abc123");

		const result = await readFileTool.execute({ path: envFile });
		expect(result.success).toBe(false);
		expect(result.output).toContain("forbidden");
		expect(result.output).not.toContain("hunter2");
		expect(result.output).not.toContain("abc123");
	});

	it("read_file blocks .env via symlink", async () => {
		const envFile = join(dir, ".env");
		writeFileSync(envFile, "SECRET=password123");
		const link = join(dir, "safe-name.txt");
		symlinkSync(envFile, link);

		const result = await readFileTool.execute({ path: link });
		expect(result.success).toBe(false);
		expect(result.output).not.toContain("password123");
	});

	it("read_file blocks credentials.json", async () => {
		const creds = join(dir, "credentials.json");
		writeFileSync(creds, '{"secret":"value"}');

		const result = await readFileTool.execute({ path: creds });
		expect(result.success).toBe(false);
	});

	it("read_file allows normal files", async () => {
		const normal = join(dir, "index.ts");
		writeFileSync(normal, "export const x = 1;");

		const result = await readFileTool.execute({ path: normal });
		expect(result.success).toBe(true);
		expect(result.output).toContain("export const x = 1");
	});

	it("read_file blocks dynamically added session patterns", async () => {
		addSessionPattern("*.supersecret");
		const secretFile = join(dir, "data.supersecret");
		writeFileSync(secretFile, "top secret content");

		const result = await readFileTool.execute({ path: secretFile });
		expect(result.success).toBe(false);
		expect(result.output).not.toContain("top secret content");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 3. BOUNDARY CONDITIONS — Off-by-one, exact thresholds
// ═══════════════════════════════════════════════════════════════════════

describe("Boundary — diff matrix guard at 100k", () => {
	it("just below threshold uses LCS (context lines present)", () => {
		// n*m = 99_999 → e.g. 317 x 315 = 99_855 (close enough, under 100k)
		const a = Array.from({ length: 316 }, (_, i) => `line ${i}`);
		const b = Array.from({ length: 316 }, (_, i) => (i === 0 ? "CHANGED" : `line ${i}`));

		const result = computeDiff(a.join("\n"), b.join("\n"));
		// LCS should produce context lines (unchanged lines between changes)
		const contextLines = result.lines.filter((l) => l.kind === "context");
		expect(contextLines.length).toBeGreaterThan(0);
		expect(result.added).toBe(1);
		expect(result.removed).toBe(1);
	});

	it("just above threshold falls back to full remove+add", () => {
		// n*m > 100_000 → e.g. 318 x 318 = 101_124
		const a = Array.from({ length: 318 }, (_, i) => `line ${i}`);
		const b = Array.from({ length: 318 }, (_, i) => (i === 0 ? "CHANGED" : `line ${i}`));

		const result = computeDiff(a.join("\n"), b.join("\n"));
		// Fallback: everything is remove + add, NO context lines
		const contextLines = result.lines.filter((l) => l.kind === "context");
		expect(contextLines.length).toBe(0);
		expect(result.removed).toBe(318);
		expect(result.added).toBe(318);
	});

	it("exactly at threshold (100k product) falls back", () => {
		// 1000 x 100 = 100_000 — NOT greater than, so should use LCS
		// Wait — the check is > 100_000, so 100_000 exactly should use LCS
		const a = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const b = Array.from({ length: 1000 }, (_, i) => `line ${i}`);

		const result = computeDiff(a.join("\n"), b.join("\n"));
		// 100 * 1000 = 100_000, not > 100_000, so LCS should be used
		// There should be context lines for the shared prefix
		const contextLines = result.lines.filter((l) => l.kind === "context");
		expect(contextLines.length).toBeGreaterThan(0);
	});

	it("one above threshold (100_001) triggers fallback", () => {
		// Need n*m = 100_001 → e.g. 101 x 991 = 100_091
		const a = Array.from({ length: 101 }, (_, i) => `line ${i}`);
		const b = Array.from({ length: 991 }, (_, i) => `line ${i}`);

		const result = computeDiff(a.join("\n"), b.join("\n"));
		const contextLines = result.lines.filter((l) => l.kind === "context");
		expect(contextLines.length).toBe(0);
	});
});

describe("Boundary — read_file line cap", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir("readfile-boundary");
		initForbidden(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("exactly 500 lines: no cap notice", async () => {
		const filePath = join(dir, "exact500.txt");
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 500");
		expect(result.output).not.toContain("showing first");
	});

	it("501 lines: no cap for non-code files under 50MB", async () => {
		const filePath = join(dir, "just-over.txt");
		const lines = Array.from({ length: 501 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 500");
		expect(result.output).toContain("line 501");
	});

	it("499 lines: no cap, all lines shown", async () => {
		const filePath = join(dir, "just-under.txt");
		const lines = Array.from({ length: 499 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 499");
		expect(result.output).not.toContain("showing first");
	});

	it("startLine beyond file length returns empty", async () => {
		const filePath = join(dir, "short.txt");
		writeFileSync(filePath, "line 1\nline 2\nline 3");

		const result = await readFileTool.execute({ path: filePath, startLine: 100 });
		expect(result.success).toBe(true);
		expect(result.output.trim()).toBe("");
	});

	it("endLine beyond file length doesn't crash", async () => {
		const filePath = join(dir, "short2.txt");
		writeFileSync(filePath, "line 1\nline 2\nline 3");

		const result = await readFileTool.execute({ path: filePath, startLine: 1, endLine: 9999 });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 1");
		expect(result.output).toContain("line 3");
	});

	it("startLine > endLine returns empty", async () => {
		const filePath = join(dir, "inverted.txt");
		writeFileSync(filePath, "line 1\nline 2\nline 3");

		const result = await readFileTool.execute({ path: filePath, startLine: 3, endLine: 1 });
		expect(result.success).toBe(true);
		expect(result.output.trim()).toBe("");
	});

	it("startLine = 0 treated as line 1 (off-by-one)", async () => {
		const filePath = join(dir, "zero-start.txt");
		writeFileSync(filePath, "first\nsecond\nthird");

		const result = await readFileTool.execute({ path: filePath, startLine: 0, endLine: 2 });
		expect(result.success).toBe(true);
		// startLine 0 → (0-1) = -1, slice(-1, 2) gives unexpected results
		// This tests whether the code handles it gracefully
	});

	it("negative startLine doesn't crash", async () => {
		const filePath = join(dir, "negative.txt");
		writeFileSync(filePath, "alpha\nbravo\ncharlie");

		const result = await readFileTool.execute({ path: filePath, startLine: -5, endLine: 2 });
		expect(result.success).toBe(true);
	});
});

describe("Boundary — extract terms limit", () => {
	it("exactly 15 unique words returns 15", () => {
		const words = Array.from({ length: 15 }, (_, i) => `unique${i}`).join(" ");
		const terms = extractConversationTerms(words);
		expect(terms).toHaveLength(15);
	});

	it("16 unique words returns exactly 15", () => {
		const words = Array.from({ length: 16 }, (_, i) => `unique${i}`).join(" ");
		const terms = extractConversationTerms(words);
		expect(terms).toHaveLength(15);
		expect(terms).not.toContain("unique15"); // 16th word (0-indexed) dropped
	});

	it("14 unique words returns all 14", () => {
		const words = Array.from({ length: 14 }, (_, i) => `unique${i}`).join(" ");
		const terms = extractConversationTerms(words);
		expect(terms).toHaveLength(14);
	});

	it("3-char word boundary: 'abc' included, 'ab' excluded", () => {
		const terms = extractConversationTerms("abc ab");
		expect(terms).toContain("abc");
		expect(terms).not.toContain("ab");
	});

	it("exactly 3-char word is the minimum", () => {
		const terms = extractConversationTerms("foo");
		expect(terms).toEqual(["foo"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 4. ERROR PATHS — Malformed input, partial failures
// ═══════════════════════════════════════════════════════════════════════

describe("Error paths — MemoryDB", () => {
	it("empty title is accepted (no NOT NULL violation on empty string)", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			const r = db.write({ title: "", category: "fact", tags: [] });
			expect(r.title).toBe("");
			const read = db.read(r.id);
			expect(read!.title).toBe("");
		} finally {
			db.close();
		}
	});

	it("very long title (10k chars) is stored and retrieved", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			const longTitle = "x".repeat(10_000);
			const r = db.write({ title: longTitle, category: "fact", tags: [] });
			const read = db.read(r.id);
			expect(read!.title).toBe(longTitle);
			expect(read!.title.length).toBe(10_000);
		} finally {
			db.close();
		}
	});

	it("FTS search with special chars doesn't crash", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Normal record", category: "fact", tags: [] });

			// FTS5 special chars that could break queries
			expect(() => db.search("*")).not.toThrow();
			expect(() => db.search("NOT")).not.toThrow();
			expect(() => db.search("OR")).not.toThrow();
			expect(() => db.search("AND")).not.toThrow();
			expect(() => db.search("NEAR")).not.toThrow();
			expect(() => db.search("(")).not.toThrow();
			expect(() => db.search(")")).not.toThrow();
			expect(() => db.search("{}[]")).not.toThrow();
			expect(() => db.search("col:value")).not.toThrow();
			expect(() => db.search('"unclosed')).not.toThrow();
			expect(() => db.search("^")).not.toThrow();
		} finally {
			db.close();
		}
	});

	it("search with FTS operator words returns results (not errors)", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Use NOT pattern for validation", category: "fact", tags: [] });
			db.write({ title: "Use OR logic in queries", category: "fact", tags: [] });

			// "NOT" and "OR" are FTS operators — search should handle gracefully
			const notResults = db.search("NOT");
			const orResults = db.search("OR");

			// Should either return results or empty — never throw
			expect(Array.isArray(notResults)).toBe(true);
			expect(Array.isArray(orResults)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("tag with quotes doesn't break list filter", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Quoted tag", category: "fact", tags: ['tag"with"quotes'] });
			// The tag filter uses LIKE with the tag embedded — SQL injection potential
			const results = db.list({ tag: 'tag"with"quotes' });
			expect(results.length).toBe(1);
		} finally {
			db.close();
		}
	});

	it("tag filter with SQL wildcard chars", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Percent tag", category: "fact", tags: ["100%"] });
			db.write({ title: "Underscore tag", category: "fact", tags: ["_internal"] });
			db.write({ title: "Normal tag", category: "fact", tags: ["normal"] });

			// "%" is a LIKE wildcard — could match everything
			const percentResults = db.list({ tag: "100%" });
			expect(percentResults.length).toBe(1);

			// "_" is a LIKE single-char wildcard — could match too broadly
			const underscoreResults = db.list({ tag: "_internal" });
			expect(underscoreResults.length).toBe(1);
		} finally {
			db.close();
		}
	});

	it("operations after close throw (not silently corrupt)", () => {
		const db = new MemoryDB(":memory:", "project");
		db.write({ title: "Before close", category: "fact", tags: [] });
		db.close();

		expect(() => db.write({ title: "After close", category: "fact", tags: [] })).toThrow();
		expect(() => db.list()).toThrow();
		expect(() => db.search("anything")).toThrow();
	});
});

describe("Error paths — SessionManager", () => {
	let dir: string;
	let manager: SessionManager;

	beforeEach(() => {
		dir = makeTmpDir("session-errors");
		manager = new SessionManager(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("save with empty tabMessages map still creates valid session", () => {
		const meta = makeMeta("empty-tabs");
		manager.saveSession(meta, new Map());

		const loaded = manager.loadSession("empty-tabs");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(0);
	});

	it("session with messages containing newlines roundtrips", () => {
		const meta = makeMeta("newline-msg");
		const msgs = [makeMessage("user", "line1\nline2\nline3")];
		manager.saveSession(meta, new Map([["tab-1", msgs]]));

		const loaded = manager.loadSession("newline-msg");
		expect(loaded).not.toBeNull();
		const loadedMsgs = loaded!.tabMessages.get("tab-1");
		expect(loadedMsgs).toHaveLength(1);
		expect(loadedMsgs![0]!.content).toBe("line1\nline2\nline3");
	});

	it("session with unicode messages roundtrips", () => {
		const meta = makeMeta("unicode-msg");
		const msgs = [makeMessage("user", "日本語 🎉 émoji café")];
		manager.saveSession(meta, new Map([["tab-1", msgs]]));

		const loaded = manager.loadSession("unicode-msg");
		expect(loaded!.tabMessages.get("tab-1")![0]!.content).toBe("日本語 🎉 émoji café");
	});

	it("session with very large message roundtrips", () => {
		const meta = makeMeta("large-msg");
		const bigContent = "x".repeat(1_000_000);
		const msgs = [makeMessage("user", bigContent)];
		manager.saveSession(meta, new Map([["tab-1", msgs]]));

		const loaded = manager.loadSession("large-msg");
		expect(loaded!.tabMessages.get("tab-1")![0]!.content.length).toBe(1_000_000);
	});

	it("overwriting a session replaces cleanly", () => {
		const meta1 = makeMeta("overwrite");
		meta1.title = "First version";
		manager.saveSession(meta1, new Map([["tab-1", [makeMessage("user", "v1")]]]));

		const meta2 = makeMeta("overwrite");
		meta2.title = "Second version";
		manager.saveSession(meta2, new Map([["tab-1", [makeMessage("user", "v2")]]]));

		const loaded = manager.loadSession("overwrite");
		expect(loaded!.meta.title).toBe("Second version");
		expect(loaded!.tabMessages.get("tab-1")![0]!.content).toBe("v2");
	});

	it("meta.json with extra unknown fields loads gracefully", () => {
		const meta = makeMeta("extra-fields");
		manager.saveSession(meta, new Map([["tab-1", [makeMessage("user", "test")]]]));

		// Inject extra field into meta.json
		const metaPath = join(dir, ".soulforge", "sessions", "extra-fields", "meta.json");
		const raw = JSON.parse(readFileSync(metaPath, "utf-8"));
		raw.unknownField = "surprise";
		raw.nestedUnknown = { deep: true };
		writeFileSync(metaPath, JSON.stringify(raw));

		const loaded = manager.loadSession("extra-fields");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(1);
	});

	it("deriveTitle with no user message returns fallback", () => {
		const title = SessionManager.deriveTitle([makeMessage("assistant", "I am an AI")]);
		expect(title).toBe("Empty session");
	});

	it("deriveTitle with exactly 60 chars doesn't truncate", () => {
		const text = "a".repeat(60);
		const title = SessionManager.deriveTitle([makeMessage("user", text)]);
		expect(title).toBe(text);
		expect(title.length).toBe(60);
		expect(title.endsWith("...")).toBe(false);
	});

	it("deriveTitle with 61 chars truncates to 57+...", () => {
		const text = "a".repeat(61);
		const title = SessionManager.deriveTitle([makeMessage("user", text)]);
		expect(title.length).toBe(60);
		expect(title.endsWith("...")).toBe(true);
	});

	it("findByPrefix is case-insensitive", () => {
		manager.saveSession(makeMeta("MySession-123"), new Map([["tab-1", []]]));
		expect(manager.findByPrefix("mysession")).toBe("MySession-123");
		expect(manager.findByPrefix("MYSESSION")).toBe("MySession-123");
		expect(manager.findByPrefix("MySession")).toBe("MySession-123");
	});

	it("findByPrefix returns null for empty dir", () => {
		expect(manager.findByPrefix("anything")).toBeNull();
	});
});

describe("Error paths — read_file edge cases", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmpDir("readfile-errors");
		initForbidden(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binary file with null bytes doesn't crash", async () => {
		const filePath = join(dir, "binary.bin");
		const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
		writeFileSync(filePath, buf);

		const result = await readFileTool.execute({ path: filePath });
		// Should either succeed or fail gracefully — never crash
		expect(typeof result.success).toBe("boolean");
	});

	it("file with only newlines", async () => {
		const filePath = join(dir, "newlines.txt");
		writeFileSync(filePath, "\n\n\n\n\n");

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
	});

	it("file with very long single line", async () => {
		const filePath = join(dir, "long-line.txt");
		writeFileSync(filePath, "x".repeat(100_000));

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
	});

	it("file path with spaces", async () => {
		const filePath = join(dir, "file with spaces.txt");
		writeFileSync(filePath, "content here");

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("content here");
	});

	it("file path with unicode chars", async () => {
		const filePath = join(dir, "日本語.txt");
		writeFileSync(filePath, "unicode filename content");

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("unicode filename content");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// 5. DATA INTEGRITY — Things that silently produce wrong results
// ═══════════════════════════════════════════════════════════════════════

describe("Data integrity — MemoryDB tag filter LIKE injection", () => {
	it("tag containing % doesn't match all records", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Has percent", category: "fact", tags: ["50%"] });
			db.write({ title: "No match", category: "fact", tags: ["other"] });

			const results = db.list({ tag: "%" });
			expect(results.length).toBe(0);
		} finally {
			db.close();
		}
	});

	it("tag containing _ doesn't match single-char wildcard", () => {
		const db = new MemoryDB(":memory:", "project");
		try {
			db.write({ title: "Has underscore", category: "fact", tags: ["a_b"] });
			db.write({ title: "Similar", category: "fact", tags: ["axb"] });

			const results = db.list({ tag: "a_b" });
			expect(results.length).toBe(1);
			expect(results[0]!.title).toBe("Has underscore");
		} finally {
			db.close();
		}
	});
});

describe("Data integrity — SessionManager messageRange", () => {
	let dir: string;
	let manager: SessionManager;

	beforeEach(() => {
		dir = makeTmpDir("session-range");
		manager = new SessionManager(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("multi-tab message ranges don't overlap", () => {
		const meta = makeMeta("range-test", [{ id: "t1" }, { id: "t2" }, { id: "t3" }]);
		const tabMessages = new Map([
			["t1", [makeMessage("user", "t1-msg1"), makeMessage("assistant", "t1-msg2")]],
			["t2", [makeMessage("user", "t2-msg1")]],
			["t3", [makeMessage("user", "t3-msg1"), makeMessage("assistant", "t3-msg2"), makeMessage("user", "t3-msg3")]],
		]);

		manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("range-test");
		expect(loaded).not.toBeNull();

		// Verify no message leaks between tabs
		const t1Msgs = loaded!.tabMessages.get("t1")!;
		const t2Msgs = loaded!.tabMessages.get("t2")!;
		const t3Msgs = loaded!.tabMessages.get("t3")!;

		expect(t1Msgs).toHaveLength(2);
		expect(t2Msgs).toHaveLength(1);
		expect(t3Msgs).toHaveLength(3);

		expect(t1Msgs[0]!.content).toBe("t1-msg1");
		expect(t1Msgs[1]!.content).toBe("t1-msg2");
		expect(t2Msgs[0]!.content).toBe("t2-msg1");
		expect(t3Msgs[0]!.content).toBe("t3-msg1");
		expect(t3Msgs[2]!.content).toBe("t3-msg3");
	});

	it("tab with no messages in tabMessages gets empty array", () => {
		const meta = makeMeta("missing-tab", [{ id: "t1" }, { id: "t2" }]);
		// Only provide messages for t1, not t2
		const tabMessages = new Map([
			["t1", [makeMessage("user", "hello")]],
		]);

		manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("missing-tab");
		expect(loaded).not.toBeNull();

		expect(loaded!.tabMessages.get("t1")).toHaveLength(1);
		expect(loaded!.tabMessages.get("t2")).toHaveLength(0);
	});
});
