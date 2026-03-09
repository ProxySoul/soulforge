import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
	buildPrepareStep,
	buildSymbolLookup,
	KEEP_RECENT_MESSAGES,
} from "../src/core/agents/step-utils.js";

const LONG_CONTENT = Array.from(
	{ length: 100 },
	(_, i) => `     ${String(i + 1)}\tconst x${String(i)} = ${String(i)};`,
).join("\n");

function assistantToolCall(
	calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ModelMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({
			type: "tool-call" as const,
			toolCallId: c.id,
			toolName: c.name,
			input: c.input,
		})),
	};
}

function toolResult(
	results: Array<{ id: string; name: string; output: unknown }>,
): ModelMessage {
	return {
		role: "tool",
		content: results.map((r) => ({
			type: "tool-result" as const,
			toolCallId: r.id,
			toolName: r.name,
			output: { type: "text" as const, value: r.output } as never,
		})),
	};
}

function buildPaddedConversation(
	first: {
		id: string;
		name: string;
		input: Record<string, unknown>;
		output: unknown;
	},
	paddingCount?: number,
): ModelMessage[] {
	const needed = paddingCount ?? Math.ceil(KEEP_RECENT_MESSAGES / 2) + 1;
	const msgs: ModelMessage[] = [
		assistantToolCall([
			{ id: first.id, name: first.name, input: first.input },
		]),
		toolResult([
			{ id: first.id, name: first.name, output: first.output },
		]),
	];
	for (let i = 1; i < needed; i++) {
		const id = `pad-${String(i)}`;
		msgs.push(
			assistantToolCall([
				{ id, name: "read_file", input: { path: `/pad${String(i)}.ts` } },
			]),
		);
		msgs.push(
			toolResult([{ id, name: "read_file", output: LONG_CONTENT }]),
		);
	}
	return msgs;
}

function resultText(
	msgs: ModelMessage[],
	msgIdx: number,
	partIdx = 0,
): string {
	const msg = msgs[msgIdx];
	if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) {
		throw new Error(
			`Message at index ${String(msgIdx)} is not a tool-result message`,
		);
	}
	const part = msg.content[partIdx] as { output: unknown };
	if (typeof part.output === "string") return part.output;
	if (part.output && typeof part.output === "object") {
		const obj = part.output as Record<string, unknown>;
		if (typeof obj.value === "string") return obj.value;
	}
	return JSON.stringify(part.output);
}

function makeSteps(totalTokens: number) {
	return [{ usage: { inputTokens: totalTokens, outputTokens: 0 } }];
}

const TOOLS = {
	read_file: {},
	read_code: {},
	grep: {},
	glob: {},
	edit_file: {},
	done: {},
};

function callPrepareStep(
	opts: Parameters<typeof buildPrepareStep>[0],
	stepArgs: {
		stepNumber: number;
		messages: ModelMessage[];
		steps?: Array<{ usage: { inputTokens: number; outputTokens: number } }>;
	},
) {
	const fn = buildPrepareStep(opts);
	return fn({
		stepNumber: stepArgs.stepNumber,
		messages: stepArgs.messages,
		steps: (stepArgs.steps ?? []) as never,
		model: {} as never,
		experimental_context: undefined,
	});
}

// ---------------------------------------------------------------------------
// pruning rules
// ---------------------------------------------------------------------------

describe("pruning rules", () => {
	it("does not compact when message count <= KEEP_RECENT_MESSAGES", () => {
		const msgs: ModelMessage[] = [
			assistantToolCall([
				{ id: "1", name: "read_file", input: { path: "/a.ts" } },
			]),
			toolResult([{ id: "1", name: "read_file", output: LONG_CONTENT }]),
		];
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(LONG_CONTENT);
	});

	it("does not compact at step 2 even with enough messages", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 2, messages: msgs },
		);
		expect(result?.messages).toBeUndefined();
	});

	it("compacts at step 3 when messages exceed threshold", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(result?.messages).toBeDefined();
		expect(resultText(result!.messages!, 1)).toContain("[pruned]");
	});

	it("preserves recent messages within KEEP_RECENT_MESSAGES window", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		const lastToolIdx = result!.messages!.length - 1;
		expect(resultText(result!.messages!, lastToolIdx)).toBe(LONG_CONTENT);
	});

	it("preserves short results (<= 200 chars)", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: "short",
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("short");
	});
});

// ---------------------------------------------------------------------------
// summary formats
// ---------------------------------------------------------------------------

describe("summary formats", () => {
	it("read_file: exact format with line count", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("[pruned] 100 lines");
	});

	it("read_file with symbols: exact format", () => {
		const symbolLookup = (p: string) =>
			p === "/a.ts"
				? [
						{ name: "Foo", kind: "class", isExported: true },
						{ name: "bar", kind: "function", isExported: true },
					]
				: [];
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			"[pruned] 100 lines — exports: Foo, bar",
		);
	});

	it("read_code uses same format as read_file", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_code",
			input: { file: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("[pruned] 100 lines");
	});

	it("grep: exact match count", () => {
		const grepOutput = "a:1:x\n".repeat(42);
		const msgs = buildPaddedConversation({
			id: "1",
			name: "grep",
			input: { pattern: "x" },
			output: grepOutput,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("[pruned] 42 matches");
	});

	it("glob: exact file count", () => {
		const globOutput = Array.from(
			{ length: 25 },
			(_, i) => `src/f${String(i)}.ts`,
		).join("\n");
		const msgs = buildPaddedConversation({
			id: "1",
			name: "glob",
			input: { pattern: "**/*.ts" },
			output: globOutput,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("[pruned] 25 files");
	});

	it("shell: exact lines of output format", () => {
		const output = "some output line with enough content\n".repeat(30);
		const lineCount = output.split("\n").length;
		const msgs = buildPaddedConversation({
			id: "1",
			name: "shell",
			input: { command: "ls" },
			output,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: { ...TOOLS, shell: {} } },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			`[pruned] ${String(lineCount)} lines of output`,
		);
	});

	it("dispatch with ### Files Edited", () => {
		const output =
			"### Summary\n" +
			"Details about what was done. ".repeat(10) +
			"\n### Files Edited\nsrc/a.ts, src/b.ts\n### Done";
		const msgs = buildPaddedConversation({
			id: "1",
			name: "dispatch",
			input: {},
			output,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: { ...TOOLS, dispatch: {} } },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			"[pruned] dispatch completed — src/a.ts, src/b.ts",
		);
	});

	it("dispatch without ### Files Edited falls back to char count", () => {
		const output = `Agent completed. ${"x".repeat(300)}`;
		const msgs = buildPaddedConversation({
			id: "1",
			name: "dispatch",
			input: {},
			output,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: { ...TOOLS, dispatch: {} } },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			`[pruned] dispatch completed — ${String(output.length)} chars of output`,
		);
	});

	it("generic fallback for navigate/analyze/web_search/fetch_page", () => {
		for (const toolName of [
			"navigate",
			"analyze",
			"web_search",
			"fetch_page",
		]) {
			const output = "some result line with enough content\n".repeat(30);
			const msgs = buildPaddedConversation({
				id: "1",
				name: toolName,
				input: {},
				output,
			});
			const result = callPrepareStep(
				{ role: "explore", allTools: { ...TOOLS, [toolName]: {} } },
				{ stepNumber: 3, messages: msgs },
			);
			const text = resultText(result!.messages!, 1);
			expect(text).toMatch(/^\[pruned\] \d+ lines, \d+ chars$/);
		}
	});

	it("handles raw string output from extractText", () => {
		const msgs: ModelMessage[] = [
			assistantToolCall([
				{ id: "1", name: "shell", input: { command: "ls" } },
			]),
			{
				role: "tool",
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "1",
						toolName: "shell",
						output: LONG_CONTENT as never,
					},
				],
			},
		];
		for (let i = 0; i < Math.ceil(KEEP_RECENT_MESSAGES / 2) + 1; i++) {
			const id = `pad-${String(i)}`;
			msgs.push(
				assistantToolCall([
					{
						id,
						name: "read_file",
						input: { path: `/p${String(i)}.ts` },
					},
				]),
			);
			msgs.push(
				toolResult([{ id, name: "read_file", output: LONG_CONTENT }]),
			);
		}
		const result = callPrepareStep(
			{ role: "explore", allTools: { ...TOOLS, shell: {} } },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toContain("[pruned]");
	});

	it("handles {output: string} format from extractText", () => {
		const msgs: ModelMessage[] = [
			assistantToolCall([
				{ id: "1", name: "shell", input: { command: "ls" } },
			]),
			{
				role: "tool",
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "1",
						toolName: "shell",
						output: { output: LONG_CONTENT } as never,
					},
				],
			},
		];
		for (let i = 0; i < Math.ceil(KEEP_RECENT_MESSAGES / 2) + 1; i++) {
			const id = `pad-${String(i)}`;
			msgs.push(
				assistantToolCall([
					{
						id,
						name: "read_file",
						input: { path: `/p${String(i)}.ts` },
					},
				]),
			);
			msgs.push(
				toolResult([{ id, name: "read_file", output: LONG_CONTENT }]),
			);
		}
		const result = callPrepareStep(
			{ role: "explore", allTools: { ...TOOLS, shell: {} } },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toContain("[pruned]");
	});
});

// ---------------------------------------------------------------------------
// preservation rules
// ---------------------------------------------------------------------------

describe("preservation rules", () => {
	it("preserves edit_file/write_file/create_file results", () => {
		for (const toolName of ["edit_file", "write_file", "create_file"]) {
			const msgs = buildPaddedConversation({
				id: "1",
				name: toolName,
				input: { path: "/a.ts" },
				output: LONG_CONTENT,
			});
			const result = callPrepareStep(
				{ role: "code", allTools: { ...TOOLS, [toolName]: {} } },
				{ stepNumber: 3, messages: msgs },
			);
			expect(resultText(result!.messages!, 1)).toBe(LONG_CONTENT);
		}
	});

	it("preserves non-summarizable tools (e.g. done)", () => {
		const msgs = buildPaddedConversation({
			id: "1",
			name: "done",
			input: {},
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(LONG_CONTENT);
	});

	it("multi-part tool result: prunes read_file, keeps edit_file in same message", () => {
		const msgs: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "r",
						toolName: "read_file",
						input: { path: "/a.ts" },
					},
					{
						type: "tool-call" as const,
						toolCallId: "e",
						toolName: "edit_file",
						input: { path: "/b.ts" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "r",
						toolName: "read_file",
						output: {
							type: "text" as const,
							value: LONG_CONTENT,
						} as never,
					},
					{
						type: "tool-result" as const,
						toolCallId: "e",
						toolName: "edit_file",
						output: {
							type: "text" as const,
							value: LONG_CONTENT,
						} as never,
					},
				],
			},
		];
		for (let i = 0; i < Math.ceil(KEEP_RECENT_MESSAGES / 2) + 1; i++) {
			const id = `pad-${String(i)}`;
			msgs.push(
				assistantToolCall([
					{
						id,
						name: "read_file",
						input: { path: `/pad${String(i)}.ts` },
					},
				]),
			);
			msgs.push(
				toolResult([{ id, name: "read_file", output: LONG_CONTENT }]),
			);
		}

		const result = callPrepareStep(
			{ role: "code", allTools: TOOLS },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1, 0)).toBe("[pruned] 100 lines");
		expect(resultText(result!.messages!, 1, 1)).toBe(LONG_CONTENT);
	});
});

// ---------------------------------------------------------------------------
// symbol enrichment
// ---------------------------------------------------------------------------

describe("symbol enrichment", () => {
	it("truncates symbol list beyond 8 entries", () => {
		const symbolLookup = (p: string) =>
			p === "/big.ts"
				? Array.from({ length: 12 }, (_, i) => ({
						name: `Sym${String(i)}`,
						kind: "function",
						isExported: true,
					}))
				: [];

		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/big.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		const text = resultText(result!.messages!, 1);
		expect(text).toContain("Sym0");
		expect(text).toContain("Sym7");
		expect(text).toContain("+4");
		expect(text).not.toContain("Sym8");
	});

	it("handles throwing symbolLookup gracefully", () => {
		const symbolLookup = () => {
			throw new Error("DB not ready");
		};
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/a.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe("[pruned] 100 lines");
	});

	it("resolves read_code 'file' input key", () => {
		const symbolLookup = (p: string) =>
			p === "/models.ts"
				? [{ name: "User", kind: "interface", isExported: true }]
				: [];
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_code",
			input: { file: "/models.ts", target: "interface" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			"[pruned] 100 lines — exports: User",
		);
	});

	it("resolves 'filePath' input key variant", () => {
		const symbolLookup = (p: string) =>
			p === "/utils.ts"
				? [{ name: "helper", kind: "function", isExported: true }]
				: [];
		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { filePath: "/utils.ts" },
			output: LONG_CONTENT,
		});
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toBe(
			"[pruned] 100 lines — exports: helper",
		);
	});

	it("sanitization before compaction does not break symbol lookup", () => {
		const symbolLookup = (absPath: string) =>
			absPath === "/project/src/a.ts"
				? [{ name: "Foo", kind: "class", isExported: true }]
				: [];

		const msgs = buildPaddedConversation({
			id: "1",
			name: "read_file",
			input: { path: "/project/src/a.ts" },
			output: LONG_CONTENT,
		});

		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		expect(resultText(result!.messages!, 1)).toContain("exports: Foo");
	});

	it("symbol lookup with malformed input falls back to no symbols", () => {
		const symbolLookup = (absPath: string) =>
			absPath === "/a.ts"
				? [{ name: "Bar", kind: "function", isExported: true }]
				: [];

		const msgs: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "bad",
						toolName: "read_file",
						input: "/a.ts" as never,
					},
				],
			},
			toolResult([
				{ id: "bad", name: "read_file", output: LONG_CONTENT },
			]),
		];
		for (
			let i = 1;
			i <= Math.ceil(KEEP_RECENT_MESSAGES / 2) + 1;
			i++
		) {
			const id = `pad-${String(i)}`;
			msgs.push(
				assistantToolCall([
					{
						id,
						name: "read_file",
						input: { path: `/pad${String(i)}.ts` },
					},
				]),
			);
			msgs.push(
				toolResult([{ id, name: "read_file", output: LONG_CONTENT }]),
			);
		}

		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS, symbolLookup },
			{ stepNumber: 3, messages: msgs },
		);
		const summary = resultText(result!.messages!, 1);
		expect(summary).toBe("[pruned] 100 lines");
		const part = (msgs[0]!.content as Array<{ input: unknown }>)[0];
		expect(part?.input).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// buildPrepareStep — step gating & cache control
// ---------------------------------------------------------------------------

describe("buildPrepareStep — step gating", () => {
	it("forces toolChoice: required on step 0", () => {
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 0, messages: [] },
		);
		expect(result?.toolChoice).toBe("required");
	});

	it("returns undefined (no overrides) on step 1 with empty messages", () => {
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: [] },
		);
		expect(result).toBeUndefined();
	});
});

describe("buildPrepareStep — cache control", () => {
	it("sets ephemeral cache on penultimate message at step > 0", () => {
		const msgs: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			assistantToolCall([
				{ id: "1", name: "read_file", input: { path: "/a.ts" } },
			]),
			toolResult([{ id: "1", name: "read_file", output: "short" }]),
		];
		callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: msgs },
		);
		const penultimate = msgs[msgs.length - 2];
		expect(penultimate?.providerOptions?.anthropic).toEqual({
			cacheControl: { type: "ephemeral" },
		});
	});

	it("does not set cache on step 0", () => {
		const msgs: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		];
		callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 0, messages: msgs },
		);
		expect(msgs[0]?.providerOptions).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildPrepareStep — token budgets
// ---------------------------------------------------------------------------

describe("buildPrepareStep — token budgets", () => {
	it("explore: warns at 60k tokens", () => {
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: [], steps: makeSteps(61_000) },
		);
		expect(result?.system).toContain("running low on token budget");
		expect(result?.system).toContain("Wrap up");
		expect(result?.activeTools).toBeDefined();
		expect(result?.activeTools).not.toContain("edit_file");
	});

	it("explore: forces done at 70k tokens", () => {
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: [], steps: makeSteps(71_000) },
		);
		expect(result?.activeTools).toEqual(["done"]);
		expect(result?.toolChoice).toBe("required");
		expect(result?.system).toContain("Token budget exhausted");
	});

	it("code: warns at 120k tokens", () => {
		const result = callPrepareStep(
			{ role: "code", allTools: TOOLS },
			{ stepNumber: 1, messages: [], steps: makeSteps(121_000) },
		);
		expect(result?.system).toContain("running low on token budget");
		expect(result?.system).toContain("Finish your current edit");
	});

	it("code: forces done at 135k tokens", () => {
		const result = callPrepareStep(
			{ role: "code", allTools: TOOLS },
			{ stepNumber: 1, messages: [], steps: makeSteps(136_000) },
		);
		expect(result?.activeTools).toEqual(["done"]);
		expect(result?.toolChoice).toBe("required");
	});

	it("no warning below threshold", () => {
		const result = callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: [], steps: makeSteps(10_000) },
		);
		expect(result?.system).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildPrepareStep — input sanitization
// ---------------------------------------------------------------------------

describe("buildPrepareStep — input sanitization", () => {
	it("replaces non-dict tool-call inputs with {}", () => {
		const msgs: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call" as const,
						toolCallId: "bad",
						toolName: "read_file",
						input: "not-a-dict" as never,
					},
				],
			},
			toolResult([{ id: "bad", name: "read_file", output: "result" }]),
		];
		callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: msgs },
		);
		const part = (msgs[0]!.content as Array<{ input: unknown }>)[0];
		expect(part?.input).toEqual({});
	});

	it("preserves valid dict inputs", () => {
		const input = { path: "/a.ts" };
		const msgs: ModelMessage[] = [
			assistantToolCall([{ id: "ok", name: "read_file", input }]),
			toolResult([{ id: "ok", name: "read_file", output: "result" }]),
		];
		callPrepareStep(
			{ role: "explore", allTools: TOOLS },
			{ stepNumber: 1, messages: msgs },
		);
		const part = (msgs[0]!.content as Array<{ input: unknown }>)[0];
		expect(part?.input).toEqual(input);
	});
});

// ---------------------------------------------------------------------------
// buildSymbolLookup
// ---------------------------------------------------------------------------

describe("buildSymbolLookup", () => {
	it("returns undefined when no repoMap", () => {
		expect(buildSymbolLookup(undefined)).toBeUndefined();
	});

	it("returns empty array when not ready", () => {
		const lookup = buildSymbolLookup({
			isReady: false,
			getCwd: () => "/project",
			getFileSymbols: () => [
				{ name: "X", kind: "class", isExported: true },
			],
		});
		expect(lookup!("/project/src/a.ts")).toEqual([]);
	});

	it("strips cwd prefix for relative path lookup", () => {
		let calledWith = "";
		const lookup = buildSymbolLookup({
			isReady: true,
			getCwd: () => "/project",
			getFileSymbols: (rel: string) => {
				calledWith = rel;
				return [];
			},
		});
		lookup!("/project/src/models.ts");
		expect(calledWith).toBe("src/models.ts");
	});

	it("passes through non-cwd paths unchanged", () => {
		let calledWith = "";
		const lookup = buildSymbolLookup({
			isReady: true,
			getCwd: () => "/project",
			getFileSymbols: (rel: string) => {
				calledWith = rel;
				return [];
			},
		});
		lookup!("/other/src/a.ts");
		expect(calledWith).toBe("/other/src/a.ts");
	});
});
