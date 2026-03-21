import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileTool } from "../src/core/tools/read-file.js";

const TEST_DIR = join(import.meta.dir, ".tmp-read-file-test");

describe("readFileTool", () => {
	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it("reads a simple file with line numbers", async () => {
		const filePath = join(TEST_DIR, "hello.txt");
		writeFileSync(filePath, "line one\nline two\nline three\n");

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line one");
		expect(result.output).toContain("line two");
		expect(result.output).toMatch(/^\s*1\s+line one/m);
	});

	it("respects startLine and endLine", async () => {
		const filePath = join(TEST_DIR, "range.txt");
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath, startLine: 5, endLine: 10 });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 5");
		expect(result.output).toContain("line 10");
		expect(result.output).not.toContain("line 4");
		expect(result.output).not.toContain("line 11");
	});

	it("returns full content for non-code files (no cap)", async () => {
		const filePath = join(TEST_DIR, "big.txt");
		const lines = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join("\n");
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("line 1");
		expect(result.output).toContain("line 800");
	});

	it("returns outline-only for large code files", async () => {
		const filePath = join(TEST_DIR, "big.ts");
		const fnLines = Array.from(
			{ length: 400 },
			(_, i) => `export function fn${String(i)}() { return ${String(i)}; }`,
		).join("\n");
		writeFileSync(filePath, fnLines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBe(true);
		expect(result.output).toContain("400 lines");
		expect(result.output).toContain("startLine=1 for the full file");
	}, 30_000);

	it("returns full content for large code file with startLine=1", async () => {
		const filePath = join(TEST_DIR, "big2.ts");
		const fnLines = Array.from(
			{ length: 400 },
			(_, i) => `export function fn${String(i)}() { return ${String(i)}; }`,
		).join("\n");
		writeFileSync(filePath, fnLines);

		const result = await readFileTool.execute({ path: filePath, startLine: 1 });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBeUndefined();
		expect(result.output).toContain("fn0");
		expect(result.output).toContain("fn399");
	}, 30_000);

	it("returns error for non-existent file", async () => {
		const result = await readFileTool.execute({ path: join(TEST_DIR, "nope.txt") });
		expect(result.success).toBe(false);
		expect(result.error).toContain("File not found");
	});

	it("returns error for directory", async () => {
		const result = await readFileTool.execute({ path: TEST_DIR });
		expect(result.success).toBe(false);
		expect(result.error).toContain("directory");
	});

	it("truncates files >50MB with helpful message", async () => {
		const filePath = join(TEST_DIR, "huge.txt");
		const lineContent = "x".repeat(1000);
		const lineCount = 60_000;
		const lines = Array.from({ length: lineCount }, (_, i) => `${i}: ${lineContent}`).join(
			"\n",
		);
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.output).toContain("[Truncated");
		expect(result.output).toContain("MB");
		expect(result.output).toContain("startLine/endLine");
	});

	it("allows startLine/endLine on large files (bypasses truncation)", async () => {
		const filePath = join(TEST_DIR, "huge-range.txt");
		const lineContent = "x".repeat(1000);
		const lineCount = 60_000;
		const lines = Array.from({ length: lineCount }, (_, i) => `${i}: ${lineContent}`).join(
			"\n",
		);
		writeFileSync(filePath, lines);

		const result = await readFileTool.execute({ path: filePath, startLine: 1, endLine: 10 });
		expect(result.success).toBe(true);
		expect(result.output).not.toContain("[Truncated");
		expect(result.output).toContain("0:");
	});

	it("reads empty file without error", async () => {
		const filePath = join(TEST_DIR, "empty.txt");
		writeFileSync(filePath, "");

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
	});

	it("code file at exactly 300 lines returns full content (not outline)", async () => {
		const filePath = join(TEST_DIR, "boundary.ts");
		const fnLines = Array.from(
			{ length: 300 },
			(_, i) => `export function fn${String(i)}() { return ${String(i)}; }`,
		).join("\n");
		writeFileSync(filePath, fnLines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBeUndefined();
		expect(result.output).toContain("fn0");
		expect(result.output).toContain("fn299");
	});

	it("code file at 301 lines returns outline-only", async () => {
		const filePath = join(TEST_DIR, "boundary301.ts");
		const fnLines = Array.from(
			{ length: 301 },
			(_, i) => `export function fn${String(i)}() { return ${String(i)}; }`,
		).join("\n");
		writeFileSync(filePath, fnLines);

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBe(true);
		expect(result.output).toContain("301 lines");
	}, 90_000);

	it("range read on large code file returns content (not outline)", async () => {
		const filePath = join(TEST_DIR, "range-large.ts");
		const fnLines = Array.from(
			{ length: 400 },
			(_, i) => `export function fn${String(i)}() { return ${String(i)}; }`,
		).join("\n");
		writeFileSync(filePath, fnLines);

		const result = await readFileTool.execute({ path: filePath, startLine: 50, endLine: 100 });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBeUndefined();
		expect(result.output).toContain("fn49");
		expect(result.output).toContain("fn99");
		expect(result.output).not.toContain("fn0()");
	}, 30_000);

	it("non-code file over 300 lines returns full content (no outline)", async () => {
		const filePath = join(TEST_DIR, "big-config.json");
		const obj: Record<string, number> = {};
		for (let i = 0; i < 400; i++) obj[`key${String(i)}`] = i;
		writeFileSync(filePath, JSON.stringify(obj, null, 2));

		const result = await readFileTool.execute({ path: filePath });
		expect(result.success).toBe(true);
		expect(result.outlineOnly).toBeUndefined();
		expect(result.output).toContain("key0");
		expect(result.output).toContain("key399");
	});
});
