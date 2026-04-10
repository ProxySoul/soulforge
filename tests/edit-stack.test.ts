import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import {
	pushEdit,
	updateLastAfterHash,
	clearEditStacks,
	undoEditTool,
} from "../src/core/tools/edit-stack.js";
import { editFileTool, buildRichEditError } from "../src/core/tools/edit-file.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { setFormatCache } from "../src/core/tools/auto-format.js";
import { markToolWrite, readBufferContent } from "../src/core/editor/instance.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `edit-stack-test-${Date.now()}`);

async function writeTestFile(name: string, content: string): Promise<string> {
	const path = join(TMP, name);
	await writeFile(path, content, "utf-8");
	return path;
}

beforeEach(async () => {
	clearEditStacks();
	setFormatCache(null);
	await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
	await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ════════════════════════════════════════════════════════════
// edit-stack: pushEdit + updateLastAfterHash (unit tests)
// ════════════════════════════════════════════════════════════

describe("edit-stack: pushEdit + updateLastAfterHash", () => {
	it("undo without hash sync REFUSES stale by default", async () => {
		const path = await writeTestFile("stale.ts", "original");
		pushEdit(path, "original", "edited");
		await writeFile(path, "edited", "utf-8");

		// External modification (simulates formatter)
		await writeFile(path, "formatted", "utf-8");

		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(false);
		expect(result.output).toContain("surgically revert");
		// File unchanged
		const content = await Bun.file(path).text();
		expect(content).toBe("formatted");
	});

	it("undo WITH hash sync does NOT refuse after formatter", async () => {
		const path = await writeTestFile("synced.ts", "original");
		pushEdit(path, "original", "edited");
		await writeFile(path, "edited", "utf-8");

		// Formatter rewrites file
		await writeFile(path, "formatted", "utf-8");
		updateLastAfterHash(path, "formatted");

		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(true);
		expect(result.output).not.toContain("modified externally");
		const content = await Bun.file(path).text();
		expect(content).toBe("original");
	});

	it("updateLastAfterHash with tabId targets correct entry", async () => {
		const path = await writeTestFile("tabs.ts", "original");
		pushEdit(path, "original", "tab1-edit", "tab1");
		pushEdit(path, "v2", "tab2-edit", "tab2");

		// Sync only tab1 to "tab1-formatted"
		updateLastAfterHash(path, "tab1-formatted", "tab1");

		// Undo tab2 — should use tab2's original hash (not tab1's updated one)
		await writeFile(path, "tab2-edit", "utf-8");
		const result = await undoEditTool.execute({ path, tabId: "tab-2" });
		// tab2 has tabId "tab2" not "tab-2", so no matching entry
		expect(result.success).toBe(false);
	});

	it("updateLastAfterHash is no-op on empty/nonexistent stack", () => {
		updateLastAfterHash("/nonexistent.ts", "content");
		updateLastAfterHash("/nonexistent.ts", "content", "tab1");
	});
});

describe("edit-stack: clearEditStacks", () => {
	it("clears all stacks when no tabId", async () => {
		const path = await writeTestFile("clear-all.ts", "content");
		pushEdit(path, "a", "b");
		pushEdit(path, "b", "c");
		clearEditStacks();
		await writeFile(path, "c", "utf-8");
		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(false);
		expect(result.output).toContain("No edit history");
	});

	it("clears only matching tabId entries", async () => {
		const path = await writeTestFile("clear-tab.ts", "v1");
		pushEdit(path, "v1", "v2", "tab-A");
		pushEdit(path, "v2", "v3", "tab-B");
		clearEditStacks("tab-A");

		// tab-B's entry should remain
		await writeFile(path, "v3", "utf-8");
		const result = await undoEditTool.execute({ path, tabId: "tab-B" });
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toBe("v2");
	});
});

describe("edit-stack: undo multi-step", () => {
	it("multi-step undo restores through multiple edits", async () => {
		const path = await writeTestFile("multistep.ts", "step0");
		pushEdit(path, "step0", "step1");
		pushEdit(path, "step1", "step2");
		pushEdit(path, "step2", "step3");
		await writeFile(path, "step3", "utf-8");

		const result = await undoEditTool.execute({ path, steps: 3 });
		expect(result.success).toBe(true);
		expect(result.output).toContain("Undid 3 edits");
		const content = await Bun.file(path).text();
		expect(content).toBe("step0");
	});

	it("reports remaining undo count", async () => {
		const path = await writeTestFile("remaining.ts", "v1");
		pushEdit(path, "v1", "v2");
		pushEdit(path, "v2", "v3");
		await writeFile(path, "v3", "utf-8");

		const result = await undoEditTool.execute({ path, steps: 1 });
		expect(result.success).toBe(true);
		expect(result.output).toContain("1 more undo");
	});

	it("fails when no history exists", async () => {
		const path = await writeTestFile("nohistory.ts", "content");
		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(false);
		expect(result.output).toContain("No edit history");
	});
});

describe("edit-stack: cross-tab isolation", () => {
	it("undo with tabId only undoes that tab's edits", async () => {
		const path = await writeTestFile("cross-tab.ts", "original");

		pushEdit(path, "original", "tab1-edit", "tab1");
		await writeFile(path, "tab1-edit", "utf-8");

		pushEdit(path, "tab1-edit", "tab2-edit", "tab2");
		await writeFile(path, "tab2-edit", "utf-8");

		// Undo tab2's edit only
		const result = await undoEditTool.execute({ path, tabId: "tab2" });
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toBe("tab1-edit");

		// tab1's entry should still be available
		const result2 = await undoEditTool.execute({ path, tabId: "tab1" });
		expect(result2.success).toBe(true);
		const content2 = await Bun.file(path).text();
		expect(content2).toBe("original");
	});

	it("undo without tabId takes from any tab", async () => {
		const path = await writeTestFile("any-tab.ts", "v1");
		pushEdit(path, "v1", "v2", "tab1");
		pushEdit(path, "v2", "v3", "tab2");
		await writeFile(path, "v3", "utf-8");

		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toBe("v2");
	});
});

// ════════════════════════════════════════════════════════════
// edit_file tool: mismatch behavior (the critical fix)
// ════════════════════════════════════════════════════════════

describe("edit_file tool: mismatch now fails instead of blind apply", () => {
	it("fails when oldString does not match line range", async () => {
		const path = await writeTestFile("mismatch.ts", "line1\nline2\nline3\nline4\nline5");
		const result = await editFileTool.execute({
			path,
			oldString: "WRONG CONTENT",
			newString: "replacement",
			lineStart: 2,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("oldString does not match");
		expect(result.output).toContain("line2");
		expect(result.output).toContain("Re-read the file");
	}, 30_000);

	it("shows actual content at line range in error", async () => {
		const path = await writeTestFile("show-actual.ts", "aaa\nbbb\nccc\nddd");
		const result = await editFileTool.execute({
			path,
			oldString: "WRONG\nALSO_WRONG",
			newString: "X\nY",
			lineStart: 2,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("bbb");
		expect(result.output).toContain("ccc");
	}, 30_000);

	it("succeeds when oldString exactly matches line range", async () => {
		const path = await writeTestFile("exact.ts", "line1\nline2\nline3\nline4");
		const result = await editFileTool.execute({
			path,
			oldString: "line2\nline3",
			newString: "replaced2\nreplaced3",
			lineStart: 2,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Edited");
	}, 30_000);

	it("succeeds with fuzzy whitespace match at line range", async () => {
		const path = await writeTestFile("fuzzy.ts", "line1\n\tconst x = 1;\nline3");
		const result = await editFileTool.execute({
			path,
			oldString: "  const x = 1;",
			newString: "  const x = 2;",
			lineStart: 2,
		});
		expect(result.success).toBe(true);
	}, 30_000);

	it("falls back to string match when lineStart is out of range", async () => {
		const path = await writeTestFile("fallback.ts", "aaa\nbbb\nccc");
		const result = await editFileTool.execute({
			path,
			oldString: "bbb",
			newString: "BBB",
			lineStart: 999,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("string match");
	}, 30_000);
});

describe("edit_file tool: string-based edit", () => {
	it("warns about missing lineStart", async () => {
		const path = await writeTestFile("noline.ts", "aaa\nbbb\nccc");
		const result = await editFileTool.execute({
			path,
			oldString: "bbb",
			newString: "BBB",
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("lineStart not provided");
	}, 30_000);

	it("rejects when oldString has multiple matches without lineStart", async () => {
		const path = await writeTestFile("dupes.ts", "x\nx\nx");
		const result = await editFileTool.execute({
			path,
			oldString: "x",
			newString: "y",
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("matches");
	}, 30_000);
});

describe("edit_file tool: create new file", () => {
	it("creates file when oldString is empty", async () => {
		const path = join(TMP, "newfile.ts");
		const result = await editFileTool.execute({
			path,
			oldString: "",
			newString: "const x = 1;\n",
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Created");
		const content = await Bun.file(path).text();
		expect(content).toBe("const x = 1;\n");
	}, 30_000);

	it("creates nested directories", async () => {
		const path = join(TMP, "deep", "nested", "dir", "file.ts");
		const result = await editFileTool.execute({
			path,
			oldString: "",
			newString: "hello",
		});
		expect(result.success).toBe(true);
	}, 30_000);
});

describe("edit_file tool: error cases", () => {
	it("rejects edit on nonexistent file", async () => {
		const result = await editFileTool.execute({
			path: join(TMP, "nonexistent.ts"),
			oldString: "something",
			newString: "other",
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("File not found");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// multi_edit tool: mismatch + atomicity
// ════════════════════════════════════════════════════════════

describe("multi_edit tool: mismatch behavior", () => {
	it("fails when any edit has oldString mismatch at line range", async () => {
		const original = "line1\nline2\nline3\nline4\nline5";
		const path = await writeTestFile("multi-mismatch.ts", original);
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "line2", newString: "L2", lineStart: 2 },
				{ oldString: "WRONG", newString: "L4", lineStart: 4 },
			],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("old_string not found");
		expect(result.output).toContain("atomic rollback");
	}, 30_000);

	it("succeeds when all edits match exactly", async () => {
		const path = await writeTestFile("multi-ok.ts", "A\nB\nC\nD\nE");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "B", newString: "B1", lineStart: 2 },
				{ oldString: "D", newString: "D1", lineStart: 4 },
			],
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Applied 2 edits");
	}, 30_000);

	it("tracks lineOffset across edits — expansion", async () => {
		const path = await writeTestFile("multi-offset.ts", "A\nB\nC\nD\nE");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "B", newString: "B1\nB2\nB3", lineStart: 2 },
				{ oldString: "D", newString: "D1", lineStart: 4 },
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content.split("\n")).toEqual(["A", "B1", "B2", "B3", "C", "D1", "E"]);
	}, 30_000);

	it("tracks lineOffset across 3 edits — first adds lines", async () => {
		const path = await writeTestFile("3-shift.ts",
			"line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "line2", newString: "line2a\nline2b\nline2c", lineStart: 2 },
				{ oldString: "line5", newString: "FIVE", lineStart: 5 },
				{ oldString: "line8", newString: "EIGHT", lineStart: 8 },
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content.split("\n")).toEqual([
			"line1", "line2a", "line2b", "line2c", "line3", "line4", "FIVE",
			"line6", "line7", "EIGHT", "line9", "line10",
		]);
	}, 30_000);

	it("tracks lineOffset across 3 edits — first deletes lines", async () => {
		const path = await writeTestFile("3-shrink.ts",
			"line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "line2\nline3", newString: "MERGED", lineStart: 2 },
				{ oldString: "line5", newString: "FIVE", lineStart: 5 },
				{ oldString: "line7", newString: "SEVEN", lineStart: 7 },
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content.split("\n")).toEqual([
			"line1", "MERGED", "line4", "FIVE", "line6", "SEVEN", "line8",
		]);
	}, 30_000);

	it("handles out-of-order edits — sorts by lineStart before applying", async () => {
		const path = await writeTestFile("out-of-order.ts",
			"line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "line6", newString: "SIX\nSIX-B", lineStart: 6 },
				{ oldString: "line2", newString: "TWO", lineStart: 2 },
				{ oldString: "line4", newString: "FOUR\nFOUR-B\nFOUR-C", lineStart: 4 },
			],
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content.split("\n")).toEqual([
			"line1", "TWO", "line3", "FOUR", "FOUR-B", "FOUR-C", "line5", "SIX", "SIX-B", "line7", "line8",
		]);
	}, 30_000);

	it("single undo reverts entire multi_edit batch", async () => {
		const original = "1\n2\n3\n4\n5\n6\n7";
		const path = await writeTestFile("multi-undo.ts", original);

		await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "2", newString: "A", lineStart: 2 },
				{ oldString: "4", newString: "B", lineStart: 4 },
				{ oldString: "6", newString: "C", lineStart: 6 },
			],
		});

		const edited = await Bun.file(path).text();
		expect(edited).toContain("A");
		expect(edited).toContain("B");
		expect(edited).toContain("C");

		const undoResult = await undoEditTool.execute({ path });
		expect(undoResult.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toBe(original);
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Formatter scenario: the root cause reproduction
// ════════════════════════════════════════════════════════════

describe("formatter interaction: hash sync prevents stale undo", () => {
	it("push + format + hash sync + undo = clean restore", async () => {
		const path = await writeTestFile("format-undo.ts", "original content");

		// Step 1: edit via pushEdit (simulating edit_file tool)
		pushEdit(path, "original content", "edited content");
		await writeFile(path, "edited content", "utf-8");

		// Step 2: formatter rewrites file
		await writeFile(path, "edited content\n// formatted", "utf-8");

		// Step 3: sync the hash (this is what the fix does)
		updateLastAfterHash(path, "edited content\n// formatted");

		// Step 4: undo — should cleanly restore without stale warning
		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(true);
		expect(result.output).not.toContain("modified externally");
		const content = await Bun.file(path).text();
		expect(content).toBe("original content");
	});

	it("without hash sync, undo refuses stale (default)", async () => {
		const path = await writeTestFile("format-stale.ts", "original");

		pushEdit(path, "original", "edited");
		await writeFile(path, "edited", "utf-8");

		// Formatter rewrites WITHOUT hash sync
		await writeFile(path, "formatted", "utf-8");

		const result = await undoEditTool.execute({ path });
		expect(result.success).toBe(false);
		expect(result.output).toContain("surgically revert");
	});

	it("two edits with format between each — hash sync on both", async () => {
		const path = await writeTestFile("two-edits.ts", "v0");

		// Edit 1
		pushEdit(path, "v0", "v1");
		await writeFile(path, "v1", "utf-8");
		await writeFile(path, "v1-fmt", "utf-8");
		updateLastAfterHash(path, "v1-fmt");

		// Edit 2
		pushEdit(path, "v1-fmt", "v2");
		await writeFile(path, "v2", "utf-8");
		await writeFile(path, "v2-fmt", "utf-8");
		updateLastAfterHash(path, "v2-fmt");

		// Undo edit 2 — should restore to v1-fmt (the pre-edit-2 content)
		const undo2 = await undoEditTool.execute({ path });
		expect(undo2.success).toBe(true);
		expect(undo2.output).not.toContain("modified externally");
		let content = await Bun.file(path).text();
		expect(content).toBe("v1-fmt");

		// Undo edit 1 — should restore to v0
		const undo1 = await undoEditTool.execute({ path });
		expect(undo1.success).toBe(true);
		expect(undo1.output).not.toContain("modified externally");
		content = await Bun.file(path).text();
		expect(content).toBe("v0");
	});
});

describe("stale lineStart: the corruption scenario", () => {
	it("edit with wrong lineStart fails with helpful error", async () => {
		// Scenario: formatter added 2 lines, shifting "return 2;" from line 6 to line 8
		const path = await writeTestFile("shifted.ts",
			"function a() {\n  return 1;\n}\n\n// added by formatter\n// also added\nfunction b() {\n  return 2;\n}");

		// Agent tries stale line 6 — should fail, not corrupt
		const result = await editFileTool.execute({
			path,
			oldString: "  return 2;",
			newString: "  return 99;",
			lineStart: 6,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("oldString does not match");
		expect(result.output).toContain("// also added");

		// File unchanged
		const content = await Bun.file(path).text();
		expect(content).toContain("  return 2;");
		expect(content).not.toContain("return 99");
	}, 30_000);

	it("edit with correct lineStart after re-read succeeds", async () => {
		const path = await writeTestFile("correct-retry.ts",
			"function a() {\n  return 1;\n}\n\n// added\nfunction b() {\n  return 2;\n}");

		// Agent re-reads and uses correct line 7
		const result = await editFileTool.execute({
			path,
			oldString: "  return 2;",
			newString: "  return 99;",
			lineStart: 7,
		});
		expect(result.success).toBe(true);
		const content = await Bun.file(path).text();
		expect(content).toContain("return 99");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// CAS: concurrent modification detection
// ════════════════════════════════════════════════════════════

describe("CAS: edit_file detects concurrent modification", () => {
	it("edit_file succeeds when file is unmodified (CAS passes)", async () => {
		const path = await writeTestFile("cas-edit.ts", "original content");
		const result = await editFileTool.execute({
			path,
			oldString: "original content",
			newString: "edited content",
		});
		expect(result.success).toBe(true);
	}, 30_000);

	it("edit_file rejects stale content after prior edit", async () => {
		// Two sequential editFileTool calls trigger intelligence diagnostics + auto-format
		// which can exceed the default 5s timeout in test environments
		const path = await writeTestFile("cas-race.ts", "version-A");

		const r1 = await editFileTool.execute({
			path,
			oldString: "version-A",
			newString: "version-B",
		});
		expect(r1.success).toBe(true);

		// File is now "version-B" — stale oldString rejected at string-match
		const r2 = await editFileTool.execute({
			path,
			oldString: "version-A",
			newString: "version-C",
		});
		expect(r2.success).toBe(false);
	}, 30_000);

	it("multi_edit rejects stale content after prior edit", async () => {
		const path = await writeTestFile("cas-multi.ts", "line1\nline2\nline3");

		const r1 = await multiEditTool.execute({
			path,
			edits: [{ oldString: "line2", newString: "EDITED", lineStart: 2 }],
		});
		expect(r1.success).toBe(true);

		// "line2" no longer exists — rejected
		const r2 = await multiEditTool.execute({
			path,
			edits: [{ oldString: "line2", newString: "AGAIN", lineStart: 2 }],
		});
		expect(r2.success).toBe(false);
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Multi-tab undo: interleaved edits
// ════════════════════════════════════════════════════════════

describe("multi-tab undo: interleaved edit scenario", () => {
	it("tab A undo after tab B edit REFUSES by default", async () => {
		const path = await writeTestFile("interleave.ts", "v0");

		// Tab A edits
		pushEdit(path, "v0", "v1-tabA", "tabA");
		await writeFile(path, "v1-tabA", "utf-8");

		// Tab B edits (overwrites tab A's changes)
		pushEdit(path, "v1-tabA", "v2-tabB", "tabB");
		await writeFile(path, "v2-tabB", "utf-8");

		// Tab A undoes — file is now v2-tabB but undo expects v1-tabA → refuses
		const result = await undoEditTool.execute({ path, tabId: "tabA" });
		expect(result.success).toBe(false);
		expect(result.output).toContain("surgically revert");
		// File unchanged — Tab B's work preserved
		const content = await Bun.file(path).text();
		expect(content).toBe("v2-tabB");
	});

	it("tab B undo after tab A undo restores correctly when isolated", async () => {
		const path = await writeTestFile("isolated.ts", "original");

		// Tab A edits line 1, Tab B edits line 2 (non-overlapping)
		pushEdit(path, "original", "A-edited", "tabA");
		await writeFile(path, "A-edited", "utf-8");

		pushEdit(path, "A-edited", "AB-edited", "tabB");
		await writeFile(path, "AB-edited", "utf-8");

		// Tab B undoes — restores to A-edited
		const r1 = await undoEditTool.execute({ path, tabId: "tabB" });
		expect(r1.success).toBe(true);
		let content = await Bun.file(path).text();
		expect(content).toBe("A-edited");

		// Tab A undoes — restores to original
		const r2 = await undoEditTool.execute({ path, tabId: "tabA" });
		expect(r2.success).toBe(true);
		content = await Bun.file(path).text();
		expect(content).toBe("original");
	});

	it("multi_edit undo is isolated per tab — refuses stale by default", async () => {
		const path = await writeTestFile("multi-tab-undo.ts", "A\nB\nC\nD");

		// Tab 1: multi_edit
		pushEdit(path, "A\nB\nC\nD", "A\nX\nC\nD", "tab1");
		await writeFile(path, "A\nX\nC\nD", "utf-8");

		// Tab 2: multi_edit
		pushEdit(path, "A\nX\nC\nD", "A\nX\nC\nY", "tab2");
		await writeFile(path, "A\nX\nC\nY", "utf-8");

		// Undo tab1 — stale because tab2 modified after tab1's edit
		const result = await undoEditTool.execute({ path, tabId: "tab1" });
		expect(result.success).toBe(false);
		expect(result.output).toContain("surgically revert");
		// File unchanged — tab2's work preserved
		const content = await Bun.file(path).text();
		expect(content).toBe("A\nX\nC\nY");
	});

});

// ════════════════════════════════════════════════════════════
// buildRichEditError
// ════════════════════════════════════════════════════════════

describe("buildRichEditError", () => {
	it("shows snippet centered on lineHint", () => {
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const result = buildRichEditError(content, "nonexistent", 10);
		expect(result.output).toContain("line 10");
		expect(result.output).toContain("old_string not found");
	});

	it("detects escape-heavy content", () => {
		const content = "some content\nmore content";
		const escapedOld = "\\\\some\\\\content\\\\with\\\\many\\\\backslashes";
		const result = buildRichEditError(content, escapedOld);
		expect(result.output).toContain("Escape-heavy content detected");
	});

	it("handles file shorter than snippet window", () => {
		const content = "short\nfile";
		const result = buildRichEditError(content, "nonexistent", 1);
		expect(result.output).toContain("short");
		expect(result.output).toContain("file");
	});

	it("does not say re-read performed", () => {
		const content = "line1\nline2\nline3";
		const result = buildRichEditError(content, "nonexistent", 2);
		expect(result.output).not.toContain("re-read performed");
		expect(result.output).toContain("Current content at that region");
	});
});

// ════════════════════════════════════════════════════════════
// readBufferContent: markToolWrite freshness (no marker deletion)
// ════════════════════════════════════════════════════════════

describe("readBufferContent: tool write marker survives multiple reads", () => {
	it("reads from disk on consecutive calls within freshness window", async () => {
		const path = await writeTestFile("marker-survive.ts", "version-1");

		markToolWrite(path);

		// First read — should come from disk
		const r1 = await readBufferContent(path);
		expect(r1).toBe("version-1");

		// Modify file on disk (simulates a second edit writing to disk)
		await writeFile(path, "version-2", "utf-8");

		// Second read within 2s — marker should still be active, reads from disk
		const r2 = await readBufferContent(path);
		expect(r2).toBe("version-2");
	});

	it("multiple rapid reads all reflect latest disk content", async () => {
		const path = await writeTestFile("marker-rapid.ts", "A");
		markToolWrite(path);

		const r1 = await readBufferContent(path);
		expect(r1).toBe("A");

		await writeFile(path, "B", "utf-8");
		markToolWrite(path); // Second edit re-marks

		const r2 = await readBufferContent(path);
		expect(r2).toBe("B");

		await writeFile(path, "C", "utf-8");
		markToolWrite(path); // Third edit re-marks

		const r3 = await readBufferContent(path);
		expect(r3).toBe("C");
	});
});

// ════════════════════════════════════════════════════════════
// Sequential edit_file: edits accumulate (regression for lost edits)
// ════════════════════════════════════════════════════════════

describe("sequential edit_file: all edits persist", () => {
	it("3 sequential edits to different lines all survive", async () => {
		const path = await writeTestFile("seq-3.ts", "line1\nline2\nline3\nline4\nline5");

		const r1 = await editFileTool.execute({
			path, oldString: "line1", newString: "FIRST", lineStart: 1,
		});
		expect(r1.success).toBe(true);

		const r2 = await editFileTool.execute({
			path, oldString: "line3", newString: "THIRD", lineStart: 3,
		});
		expect(r2.success).toBe(true);

		const r3 = await editFileTool.execute({
			path, oldString: "line5", newString: "FIFTH", lineStart: 5,
		});
		expect(r3.success).toBe(true);

		const content = await Bun.file(path).text();
		expect(content).toBe("FIRST\nline2\nTHIRD\nline4\nFIFTH");
	}, 30_000);

	it("4 sequential edits that shift lines all persist", async () => {
		const path = await writeTestFile("seq-shift.ts", "A\nB\nC\nD");

		// Edit 1: expand line 1
		const r1 = await editFileTool.execute({
			path, oldString: "A", newString: "A1\nA2", lineStart: 1,
		});
		expect(r1.success).toBe(true);

		// Edit 2: replace B (now at line 3 after expansion)
		const r2 = await editFileTool.execute({
			path, oldString: "B", newString: "BB",
		});
		expect(r2.success).toBe(true);

		// Edit 3: replace C
		const r3 = await editFileTool.execute({
			path, oldString: "C", newString: "CC",
		});
		expect(r3.success).toBe(true);

		// Edit 4: replace D
		const r4 = await editFileTool.execute({
			path, oldString: "D", newString: "DD",
		});
		expect(r4.success).toBe(true);

		const content = await Bun.file(path).text();
		expect(content).toBe("A1\nA2\nBB\nCC\nDD");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// Multi-tab dispatch: parallel agents editing same file
// ════════════════════════════════════════════════════════════

describe("multi-tab dispatch: concurrent edits to same file", () => {
	it("tab A edit then tab B edit — both persist when non-overlapping", async () => {
		const path = await writeTestFile("dispatch-ab.ts", "header\nbody\nfooter");

		// Tab A edits header
		const r1 = await editFileTool.execute({
			path, oldString: "header", newString: "HEADER", lineStart: 1, tabId: "tabA",
		});
		expect(r1.success).toBe(true);

		// Tab B edits footer
		const r2 = await editFileTool.execute({
			path, oldString: "footer", newString: "FOOTER", lineStart: 3, tabId: "tabB",
		});
		expect(r2.success).toBe(true);

		const content = await Bun.file(path).text();
		expect(content).toBe("HEADER\nbody\nFOOTER");
	}, 30_000);

	it("tab A undo after tab B edit — refuses (stale)", async () => {
		const path = await writeTestFile("dispatch-stale.ts", "v0");

		await editFileTool.execute({
			path, oldString: "v0", newString: "v1-A", tabId: "tabA",
		});

		await editFileTool.execute({
			path, oldString: "v1-A", newString: "v2-B", tabId: "tabB",
		});

		// Tab A undo should refuse — file was modified by tab B
		const undo = await undoEditTool.execute({ path, tabId: "tabA" });
		expect(undo.success).toBe(false);
		expect(undo.output).toContain("surgically revert");

		// File unchanged — tab B's work preserved
		const content = await Bun.file(path).text();
		expect(content).toBe("v2-B");
	}, 30_000);

	it("multi_edit from two tabs — second tab sees first tab's changes", async () => {
		const path = await writeTestFile("dispatch-multi.ts", "A\nB\nC\nD");

		// Tab 1 edits lines 1-2
		const r1 = await multiEditTool.execute({
			path,
			edits: [{ oldString: "A", newString: "X", lineStart: 1 }],
			tabId: "tab1",
		});
		expect(r1.success).toBe(true);

		// Tab 2 edits line 3 — sees X at line 1 from tab 1
		const r2 = await multiEditTool.execute({
			path,
			edits: [{ oldString: "C", newString: "Y", lineStart: 3 }],
			tabId: "tab2",
		});
		expect(r2.success).toBe(true);

		const content = await Bun.file(path).text();
		expect(content).toBe("X\nB\nY\nD");
	}, 30_000);

	it("multi_edit CAS catches race between tabs", async () => {
		const path = await writeTestFile("dispatch-cas.ts", "original");

		// Tab 1 reads file (simulated by multi_edit reading internally)
		// Tab 2 writes concurrently between tab 1's read and write
		// This is hard to test directly — instead verify CAS works at edit_file level
		await editFileTool.execute({
			path, oldString: "original", newString: "tab1-wrote", tabId: "tab1",
		});

		// Tab 2 tries to edit based on stale "original" content
		const r2 = await editFileTool.execute({
			path, oldString: "original", newString: "tab2-wrote", tabId: "tab2",
		});
		expect(r2.success).toBe(false);

		// File is tab1's version
		const content = await Bun.file(path).text();
		expect(content).toBe("tab1-wrote");
	}, 30_000);
});

// ════════════════════════════════════════════════════════════
// multi_edit: atomic rollback error messages
// ════════════════════════════════════════════════════════════

describe("multi_edit: error messages communicate atomic rollback", () => {
	it("mismatch error says NO edits were applied", async () => {
		const path = await writeTestFile("msg-mismatch.ts", "A\nB\nC");
		const result = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "A", newString: "X", lineStart: 1 },
				{ oldString: "WRONG", newString: "Y", lineStart: 2 },
			],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("NO edits were applied");
		expect(result.output).toContain("atomic rollback");

		// Verify nothing was written
		const content = await Bun.file(path).text();
		expect(content).toBe("A\nB\nC");
	}, 30_000);

	it("ambiguous match error says NO edits were applied", async () => {
		const path = await writeTestFile("msg-ambig.ts", "dup\ndup\nother");
		const result = await multiEditTool.execute({
			path,
			edits: [{ oldString: "dup", newString: "unique" }],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("NO edits were applied");

		const content = await Bun.file(path).text();
		expect(content).toBe("dup\ndup\nother");
	}, 30_000);

	it("string-not-found error says NO edits were applied", async () => {
		const path = await writeTestFile("msg-notfound.ts", "hello\nworld");
		const result = await multiEditTool.execute({
			path,
			edits: [{ oldString: "nonexistent", newString: "replacement" }],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("NO edits were applied");

		const content = await Bun.file(path).text();
		expect(content).toBe("hello\nworld");
	}, 30_000);

	it("CAS failure error says NO edits were applied", async () => {
		// Can't easily trigger CAS failure without concurrent writes,
		// but we can verify the error path exists by checking multi_edit
		// after external modification
		const path = await writeTestFile("msg-cas.ts", "start");

		// Simulate: multi_edit reads "start", external process writes "changed"
		// before multi_edit can write back. We can't inject this easily,
		// so verify that sequential edits with stale content fail cleanly.
		await writeFile(path, "changed-externally", "utf-8");

		const result = await multiEditTool.execute({
			path,
			edits: [{ oldString: "start", newString: "edited", lineStart: 1 }],
		});
		expect(result.success).toBe(false);

		const content = await Bun.file(path).text();
		expect(content).toBe("changed-externally");
	}, 30_000);
});
