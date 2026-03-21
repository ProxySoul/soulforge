import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { SessionMeta, TabMeta } from "../src/core/sessions/types.js";
import type { ChatMessage } from "../src/types/index.js";

const TEST_DIR = join(import.meta.dir, ".tmp-session-test");

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
		cwd: TEST_DIR,
		forgeMode: "default",
		tabs: tabs.map((t) => makeTab(t.id)),
	};
}

function makeMessage(role: "user" | "assistant", content: string): ChatMessage {
	return { role, content } as ChatMessage;
}

describe("SessionManager", () => {
	let manager: SessionManager;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		manager = new SessionManager(TEST_DIR);
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it("saves and loads a session round-trip", async () => {
		const meta = makeMeta("sess-1");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];
		const tabMessages = new Map([["tab-1", msgs]]);

		await manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("sess-1");

		expect(loaded).not.toBeNull();
		expect(loaded!.meta.id).toBe("sess-1");
		const loadedMsgs = loaded!.tabMessages.get("tab-1");
		expect(loadedMsgs).toHaveLength(2);
		expect(loadedMsgs![0]!.content).toBe("hello");
		expect(loadedMsgs![1]!.content).toBe("hi");
	});

	it("atomic writes — no .tmp files left after save", async () => {
		const meta = makeMeta("sess-2");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);

		await manager.saveSession(meta, tabMessages);

		const sessionDir = join(TEST_DIR, ".soulforge", "sessions", "sess-2");
		expect(existsSync(join(sessionDir, "meta.json"))).toBe(true);
		expect(existsSync(join(sessionDir, "messages.jsonl"))).toBe(true);
		expect(existsSync(join(sessionDir, "meta.json.tmp"))).toBe(false);
		expect(existsSync(join(sessionDir, "messages.jsonl.tmp"))).toBe(false);
	});

	it("handles corrupted meta.json gracefully", async () => {
		const meta = makeMeta("sess-corrupt");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);
		await manager.saveSession(meta, tabMessages);

		const metaPath = join(TEST_DIR, ".soulforge", "sessions", "sess-corrupt", "meta.json");
		writeFileSync(metaPath, "{ broken json ---");

		const loaded = manager.loadSession("sess-corrupt");
		expect(loaded).toBeNull();
	});

	it("recovers valid lines before corruption in messages.jsonl", async () => {
		const meta = makeMeta("sess-jsonl-corrupt");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];
		const tabMessages = new Map([["tab-1", msgs]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".soulforge",
			"sessions",
			"sess-jsonl-corrupt",
			"messages.jsonl",
		);
		writeFileSync(jsonlPath, '{"role":"user","content":"ok"}\n{broken\n');

		const loaded = manager.loadSession("sess-jsonl-corrupt");
		expect(loaded).not.toBeNull();
		const tabMsgs = loaded!.tabMessages.get("tab-1") ?? [];
		expect(tabMsgs.length).toBeGreaterThanOrEqual(1);
		expect((tabMsgs[0] as { role: string }).role).toBe("user");
	});

	it("handles missing messages.jsonl (meta exists, data missing)", async () => {
		const meta = makeMeta("sess-no-jsonl");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".soulforge",
			"sessions",
			"sess-no-jsonl",
			"messages.jsonl",
		);
		rmSync(jsonlPath);

		const loaded = manager.loadSession("sess-no-jsonl");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(0);
	});

	it("handles empty messages.jsonl", async () => {
		const meta = makeMeta("sess-empty");
		const tabMessages = new Map([["tab-1", []]]);
		await manager.saveSession(meta, tabMessages);

		const loaded = manager.loadSession("sess-empty");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(0);
	});

	it("handles truncated messages.jsonl (partial last line)", async () => {
		const meta = makeMeta("sess-trunc");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "world")];
		const tabMessages = new Map([["tab-1", msgs]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".soulforge",
			"sessions",
			"sess-trunc",
			"messages.jsonl",
		);
		const content = readFileSync(jsonlPath, "utf-8");
		writeFileSync(jsonlPath, content.slice(0, content.length - 10));

		const loaded = manager.loadSession("sess-trunc");
		expect(loaded).not.toBeNull();
		const tabMsgs = loaded!.tabMessages.get("tab-1") ?? [];
		expect(tabMsgs.length).toBeGreaterThanOrEqual(1);
	});

	it("returns null for non-existent session", () => {
		expect(manager.loadSession("does-not-exist")).toBeNull();
	});

	it("deletes a session", async () => {
		const meta = makeMeta("sess-del");
		await manager.saveSession(meta, new Map([["tab-1", []]]));
		expect(manager.deleteSession("sess-del")).toBe(true);
		expect(manager.loadSession("sess-del")).toBeNull();
	});

	it("lists sessions sorted by updatedAt descending", async () => {
		const m1 = makeMeta("sess-old");
		m1.updatedAt = 1000;
		const m2 = makeMeta("sess-new");
		m2.updatedAt = 2000;
		await manager.saveSession(m1, new Map([["tab-1", []]]));
		await manager.saveSession(m2, new Map([["tab-1", []]]));

		const list = manager.listSessions();
		expect(list).toHaveLength(2);
		expect(list[0]!.id).toBe("sess-new");
		expect(list[1]!.id).toBe("sess-old");
	});

	it("sessionCount returns correct count", async () => {
		await manager.saveSession(makeMeta("s1"), new Map([["tab-1", []]]));
		await manager.saveSession(makeMeta("s2"), new Map([["tab-1", []]]));
		expect(manager.sessionCount()).toBe(2);
	});

	it("clearAllSessions removes everything", async () => {
		await manager.saveSession(makeMeta("s1"), new Map([["tab-1", []]]));
		await manager.saveSession(makeMeta("s2"), new Map([["tab-1", []]]));
		const cleared = manager.clearAllSessions();
		expect(cleared).toBe(2);
		expect(manager.sessionCount()).toBe(0);
	});

	it("deriveTitle truncates long messages", () => {
		const long = "a".repeat(100);
		const title = SessionManager.deriveTitle([makeMessage("user", long)]);
		expect(title.length).toBeLessThanOrEqual(60);
		expect(title.endsWith("...")).toBe(true);
	});

	it("multi-tab session preserves per-tab messages", async () => {
		const meta = makeMeta("sess-multi", [{ id: "tab-a" }, { id: "tab-b" }]);
		const tabMessages = new Map([
			["tab-a", [makeMessage("user", "tab a msg")]],
			["tab-b", [makeMessage("user", "tab b msg1"), makeMessage("assistant", "tab b msg2")]],
		]);

		await manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("sess-multi");

		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-a")).toHaveLength(1);
		expect(loaded!.tabMessages.get("tab-b")).toHaveLength(2);
		expect(loaded!.tabMessages.get("tab-a")![0]!.content).toBe("tab a msg");
		expect(loaded!.tabMessages.get("tab-b")![1]!.content).toBe("tab b msg2");
	});
});
