import { describe, expect, test } from "bun:test";
import {
	buildAssistantMessage,
	hasRenderableAssistantContent,
} from "../src/hooks/useChat-content.js";

describe("hasRenderableAssistantContent", () => {
	test("does not treat an orphan tools segment as visible assistant output", () => {
		expect(
			hasRenderableAssistantContent({
				fullText: "",
				toolCallCount: 0,
				segments: [{ type: "tools", toolCallIds: ["call-1"] }],
			}),
		).toBe(false);
	});

	test("treats plan segments as visible assistant output", () => {
		expect(
			hasRenderableAssistantContent({
				fullText: "",
				toolCallCount: 0,
				segments: [
					{
						type: "plan",
						plan: {
							title: "Set up files",
							createdAt: Date.now(),
							status: "active",
							steps: [
								{ id: "1", label: "Create config", status: "pending" },
							],
						},
					},
				],
			}),
		).toBe(true);
	});

	test("does not build a blank assistant message for orphan tool segments", () => {
		expect(
			buildAssistantMessage({
				fullText: "",
				completedCalls: [],
				segments: [{ type: "tools", toolCallIds: ["call-1"] }],
				responseStartedAt: 1_000,
				now: 2_000,
			}),
		).toBeNull();
	});

	test("builds an assistant message for visible plan output", () => {
		const message = buildAssistantMessage({
			fullText: "",
			completedCalls: [],
			segments: [
				{
					type: "plan",
					plan: {
						title: "Set up files",
						createdAt: 123,
						status: "active",
						steps: [{ id: "1", label: "Create config", status: "pending" }],
					},
				},
			],
			responseStartedAt: 1_000,
			now: 2_500,
		});

		expect(message).toMatchObject({
			role: "assistant",
			content: "",
			durationMs: 1_500,
			segments: [
				{
					type: "plan",
				},
			],
		});
	});
});
