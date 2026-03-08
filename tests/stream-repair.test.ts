import { describe, expect, it } from "bun:test";
import {
  repairToolCall,
  sanitizeMessages,
  sanitizeToolInputsStep,
} from "../src/core/agents/stream-options.js";

function mockToolCall(input: string) {
  return {
    type: "tool-call" as const,
    toolCallId: "test-id",
    toolName: "test-tool",
    input,
  };
}

describe("repairToolCall — truncated output", () => {
  it("closes truncated object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "test.ts"') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ file: "test.ts" });
  });

  it("closes truncated nested object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": 1') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a.b).toBe(1);
  });

  it("closes truncated array in object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [1, 2, 3') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).items).toEqual([1, 2, 3]);
  });

  it("cannot recover truncation mid-string value", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "src/core/too') });
    expect(result).toBeNull();
  });

  it("cannot recover truncation mid-key", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": "test.ts", "con') });
    expect(result).toBeNull();
  });

  it("handles deeply nested truncation", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": {"c": {"d": 1') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a.b.c.d).toBe(1);
  });

  it("closes deeply nested truncation with arrays", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [{"a": [1, 2') });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.items[0].a).toEqual([1, 2]);
  });

  it("repairs input with unicode values", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"name": "café"') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).name).toBe("café");
  });

  it("repairs input with newlines", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{\n  "a": 1\n') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).a).toBe(1);
  });

  it("repairs trailing comma combined with truncation", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1, "b": [2,') });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.input);
    expect(parsed.a).toBe(1);
    expect(parsed.b).toEqual([2]);
  });
});

describe("repairToolCall — trailing commas", () => {
  it("fixes trailing comma in object", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1,}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ a: 1 });
  });

  it("fixes trailing comma in array", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"items": [1, 2,]}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).items).toEqual([1, 2]);
  });

  it("fixes multiple trailing commas", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": {"b": 1,},}') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input)).toEqual({ a: { b: 1 } });
  });
});

describe("repairToolCall — string edge cases", () => {
  it("returns null for valid JSON with escaped quotes (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"msg": "say \\"hello\\""}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with escaped backslashes (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": "C:\\\\Users\\\\"}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with brackets in strings (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"code": "if (x) { return [1]; }"}') });
    expect(result).toBeNull();
  });

  it("cannot recover truncation after escaped quote", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"msg": "hello \\"world') });
    expect(result).toBeNull();
  });

  it("handles empty string value", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"file": ""') });
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.input).file).toBe("");
  });

  it("cannot recover string ending with backslash (truncated escape)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"path": "C:\\') });
    expect(result).toBeNull();
  });
});

describe("repairToolCall — invalid / no-op input", () => {
  it("returns null for empty string", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("") });
    expect(result).toBeNull();
  });

  it("returns null for whitespace only", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("   ") });
    expect(result).toBeNull();
  });

  it("returns null for array (not object)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("[1, 2, 3]") });
    expect(result).toBeNull();
  });

  it("returns null for string primitive", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('"hello"') });
    expect(result).toBeNull();
  });

  it("returns null for completely garbled input", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall("not json at all") });
    expect(result).toBeNull();
  });

  it("returns null for already-valid JSON (no repair needed)", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('{"a": 1}') });
    expect(result).toBeNull();
  });

  it("returns null for valid JSON with leading/trailing whitespace", async () => {
    const result = await repairToolCall({ toolCall: mockToolCall('  {"a": 1}  ') });
    expect(result).toBeNull();
  });

  it("100 levels of nested brackets — doesn't hang", async () => {
    const input = "{".repeat(100) + '"a": 1';
    await expect(repairToolCall({ toolCall: mockToolCall(input) })).resolves.toBeDefined();
  });

  it("handles mismatched brackets without hanging", async () => {
    await expect(repairToolCall({ toolCall: mockToolCall('{"a": [1}') })).resolves.toBeDefined();
  });
});

describe("sanitizeMessages", () => {
  it("returns same reference when no tool calls present", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("returns same reference for empty messages array", () => {
    const messages: Parameters<typeof sanitizeMessages>[0] = [];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("leaves valid object tool call inputs unchanged", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: { a: 1 } },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).toBe(messages);
  });

  it("replaces string tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces array tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: [1, 2] as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces null tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: null as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("replaces number tool call input with {}", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: 42 as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const part = (result[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });

  it("handles mix of valid and invalid tool calls in same message", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "good", input: { file: "a.ts" } },
          { type: "tool-call" as const, toolCallId: "t2", toolName: "bad", input: "oops" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    const content = (result[0] as { content: Array<{ toolCallId: string; input: unknown }> }).content;
    expect(content[0].input).toEqual({ file: "a.ts" });
    expect(content[1].input).toEqual({});
  });

  it("non-assistant messages pass through unchanged", () => {
    const messages = [
      { role: "user" as const, content: "do something" },
      { role: "system" as const, content: "you are helpful" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeMessages(messages);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
  });
});

describe("sanitizeToolInputsStep", () => {
  it("returns undefined when messages are clean", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: { a: 1 } },
        ],
      },
    ];
    const result = sanitizeToolInputsStep({ messages });
    expect(result).toBeUndefined();
  });

  it("returns { messages } when messages need sanitization", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool-call" as const, toolCallId: "t1", toolName: "test", input: "bad" as unknown as Record<string, unknown> },
        ],
      },
    ];
    const result = sanitizeToolInputsStep({ messages });
    expect(result).toBeDefined();
    expect(result!.messages).not.toBe(messages);
    const part = (result!.messages[0] as { content: Array<{ input: unknown }> }).content[0];
    expect(part.input).toEqual({});
  });
});
