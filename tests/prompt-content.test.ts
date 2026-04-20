import { describe, expect, test } from "bun:test";
import { CLAUDE_PROMPT } from "../src/core/prompts/families/claude";
import { DEFAULT_PROMPT } from "../src/core/prompts/families/default";
import { GOOGLE_PROMPT } from "../src/core/prompts/families/google";
import { OPENAI_PROMPT } from "../src/core/prompts/families/openai";
import { CORE_RULES, SHARED_IDENTITY, SHARED_RULES } from "../src/core/prompts/families/shared-rules";
import { TOOL_GUIDANCE_WITH_MAP } from "../src/core/prompts/shared/tool-guidance";

describe("shared-rules content", () => {
  test("contains tool usage and verification guidance", () => {
    expect(SHARED_RULES).toContain("# Tool usage");
    expect(SHARED_RULES).toContain("project");
  });

  test("contains commit-to-decisions guidance", () => {
    expect(SHARED_RULES).toContain("Commit to an approach");
  });

  test("does not contain pruning awareness (dropped)", () => {
    expect(SHARED_RULES).not.toContain("summarized automatically");
    expect(SHARED_RULES).not.toContain("survive summarization");
  });
});

describe("shared-identity content", () => {
  test("enforces silent tool loop in the identity block", () => {
    expect(SHARED_IDENTITY).toContain("<silent_tool_loop>");
    expect(SHARED_IDENTITY).toContain("<forbidden_between_tool_calls>");
    expect(SHARED_IDENTITY).toContain("Between tool calls: silence");
  });

  test("exposes CORE_RULES single-source micro-prompt", () => {
    expect(CORE_RULES).toContain("Silent tool loop");
    expect(CORE_RULES).toContain("Speak only at the end");
  });
});

describe("claude prompt content", () => {
  test("has positive execution-style section (not forbidden-patterns)", () => {
    expect(CLAUDE_PROMPT).toContain("<execution-style>");
    expect(CLAUDE_PROMPT).not.toContain("<forbidden-patterns>");
  });

  test("has workflow section (not separate working-on-a-task + code-execution)", () => {
    expect(CLAUDE_PROMPT).toContain("<workflow>");
    expect(CLAUDE_PROMPT).not.toContain("<working-on-a-task>");
    expect(CLAUDE_PROMPT).not.toContain("<code-execution>");
  });

  test("does not contain user-preferences section (merged into workflow)", () => {
    expect(CLAUDE_PROMPT).not.toContain("<user-preferences>");
  });

  test("references soul tools and soul map", () => {
    expect(CLAUDE_PROMPT).toContain("Soul Map");
    expect(CLAUDE_PROMPT).toContain("soul_find");
    expect(CLAUDE_PROMPT).toContain("soul_grep");
  });
});

describe("tool guidance content", () => {
  test("mentions navigate reaching into dependency stubs for type info", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("type info");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("node_modules");
  });

  test("mentions dep param for dependency search", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("dep");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("package manager");
  });

  test("does not duplicate navigate action list (removed)", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(definition, symbol=");
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(references, symbol=");
  });

  test("keeps shell and git guidance", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("shell");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("git");
  });
});

describe("all family prompts", () => {
  test("openai references soul tools", () => {
    expect(OPENAI_PROMPT).toContain("soul_find");
    expect(OPENAI_PROMPT).not.toContain("Task tool");
  });

  test("google references soul tools", () => {
    expect(GOOGLE_PROMPT).toContain("soul_find");
    expect(GOOGLE_PROMPT).not.toContain("Task tool");
  });

  test("default references soul tools", () => {
    expect(DEFAULT_PROMPT).toContain("soul_find");
    expect(DEFAULT_PROMPT).not.toContain("Task tool");
  });

  test("all families include verification step", () => {
    expect(OPENAI_PROMPT).toContain("typecheck/lint/test");
    expect(GOOGLE_PROMPT).toContain("typecheck/lint/test");
    expect(DEFAULT_PROMPT).toContain("typecheck/lint/test");
  });

  test("no family has duplicate silent-tool-use section (moved to shared-rules)", () => {
    expect(OPENAI_PROMPT).not.toContain("# Silent tool use");
    expect(GOOGLE_PROMPT).not.toContain("# Silent tool use");
    expect(DEFAULT_PROMPT).not.toContain("# Silent tool use");
  });
});
