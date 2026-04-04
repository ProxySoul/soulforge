import { describe, expect, test } from "bun:test";
import { CLAUDE_PROMPT } from "../src/core/prompts/families/claude";
import { DEFAULT_PROMPT } from "../src/core/prompts/families/default";
import { GOOGLE_PROMPT } from "../src/core/prompts/families/google";
import { OPENAI_PROMPT } from "../src/core/prompts/families/openai";
import { SHARED_RULES } from "../src/core/prompts/families/shared-rules";
import { TOOL_GUIDANCE_WITH_MAP } from "../src/core/prompts/shared/tool-guidance";

describe("shared-rules content", () => {
  test("contains verification and reporting section", () => {
    expect(SHARED_RULES).toContain("# Verification and reporting");
    expect(SHARED_RULES).toContain("Report outcomes faithfully");
    expect(SHARED_RULES).toContain("run project");
  });

  test("contains output discipline with numeric anchors", () => {
    expect(SHARED_RULES).toContain("# Output discipline");
    expect(SHARED_RULES).toContain("0 words between tool calls");
    expect(SHARED_RULES).toContain("≤50 words");
    expect(SHARED_RULES).toContain("≤120 words");
  });

  test("contains commit-to-decisions guidance", () => {
    expect(SHARED_RULES).toContain("Choose an approach and commit");
    expect(SHARED_RULES).toContain("not out of uncertainty");
  });

  test("does not contain pruning awareness (dropped)", () => {
    expect(SHARED_RULES).not.toContain("summarized automatically");
    expect(SHARED_RULES).not.toContain("survive summarization");
  });
});

describe("claude prompt content", () => {
  test("has positive execution-style section (not forbidden-patterns)", () => {
    expect(CLAUDE_PROMPT).toContain("<execution-style>");
    expect(CLAUDE_PROMPT).not.toContain("<forbidden-patterns>");
    expect(CLAUDE_PROMPT).not.toContain("forbidden");
  });

  test("has workflow section (not separate working-on-a-task + code-execution)", () => {
    expect(CLAUDE_PROMPT).toContain("<workflow>");
    expect(CLAUDE_PROMPT).not.toContain("<working-on-a-task>");
    expect(CLAUDE_PROMPT).not.toContain("<code-execution>");
  });

  test("does not contain user-preferences section (merged into workflow)", () => {
    expect(CLAUDE_PROMPT).not.toContain("<user-preferences>");
  });

  test("uses positive framing (not negative)", () => {
    expect(CLAUDE_PROMPT).not.toContain("Split reads across");
    expect(CLAUDE_PROMPT).not.toContain("Extra soul_greps");
    expect(CLAUDE_PROMPT).not.toContain("Using Grep, sed");
  });

  test("references soul tools and soul map", () => {
    expect(CLAUDE_PROMPT).toContain("Soul Map");
    expect(CLAUDE_PROMPT).toContain("soul_find");
    expect(CLAUDE_PROMPT).toContain("soul_grep");
  });
});

describe("tool guidance content", () => {
  test("mentions navigate for types/props without reading node_modules", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("type info, props, and inherited members");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("without reading node_modules directly");
  });

  test("mentions dep param for dependency search", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("dep param");
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("any language/package manager");
  });

  test("does not duplicate navigate action list (removed)", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(definition, symbol=");
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("navigate(references, symbol=");
  });

  test("does not have dedicated tools section (removed — tool descriptions handle it)", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).not.toContain("## Use dedicated tools, not shell");
  });

  test("keeps shell guidance", () => {
    expect(TOOL_GUIDANCE_WITH_MAP).toContain("Shell is for installs and system commands only");
  });
});

describe("all family prompts reference soul tools", () => {
  test("openai references soul tools", () => {
    expect(OPENAI_PROMPT).toContain("soul tools");
    expect(OPENAI_PROMPT).toContain("soul_find");
    expect(OPENAI_PROMPT).not.toContain("Task tool");
  });

  test("google references soul tools", () => {
    expect(GOOGLE_PROMPT).toContain("soul tools");
    expect(GOOGLE_PROMPT).toContain("soul_find");
    expect(GOOGLE_PROMPT).not.toContain("Task tool");
  });

  test("default references soul tools", () => {
    expect(DEFAULT_PROMPT).toContain("soul tools");
    expect(DEFAULT_PROMPT).toContain("soul_find");
    expect(DEFAULT_PROMPT).not.toContain("Task tool");
  });

  test("all families include verification language", () => {
    expect(OPENAI_PROMPT).toContain("report the actual result");
    expect(GOOGLE_PROMPT).toContain("report the actual result");
    expect(DEFAULT_PROMPT).toContain("report the actual result");
  });

  test("no family has duplicate silent-tool-use section (moved to shared-rules)", () => {
    expect(OPENAI_PROMPT).not.toContain("# Silent tool use");
    expect(GOOGLE_PROMPT).not.toContain("# Silent tool use");
    expect(DEFAULT_PROMPT).not.toContain("# Silent tool use");
  });
});
