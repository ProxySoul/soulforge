import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, getFamilyPrompt, getPromptForModel } from "../src/core/prompts/builder";
import { CLAUDE_PROMPT } from "../src/core/prompts/families/claude";
import { DEFAULT_PROMPT } from "../src/core/prompts/families/default";
import { GOOGLE_PROMPT } from "../src/core/prompts/families/google";
import { OPENAI_PROMPT } from "../src/core/prompts/families/openai";
import { getModeInstructions } from "../src/core/prompts/modes";
import { buildDirectoryTree, buildSoulMapAck, buildSoulMapUserMessage } from "../src/core/prompts/shared";
import type { PromptBuilderOptions } from "../src/core/prompts/builder";

// ── Family Selection ──

describe("family prompt selection", () => {
  test("getFamilyPrompt returns correct prompt per family", () => {
    expect(getFamilyPrompt("claude")).toBe(CLAUDE_PROMPT);
    expect(getFamilyPrompt("openai")).toBe(OPENAI_PROMPT);
    expect(getFamilyPrompt("google")).toBe(GOOGLE_PROMPT);
    expect(getFamilyPrompt("other")).toBe(DEFAULT_PROMPT);
  });

  test("getFamilyPrompt returns default for unknown family", () => {
    expect(getFamilyPrompt("deepseek")).toBe(DEFAULT_PROMPT);
    expect(getFamilyPrompt("llama")).toBe(DEFAULT_PROMPT);
  });

  test("getPromptForModel routes by model ID", () => {
    expect(getPromptForModel("anthropic/claude-sonnet-4-6")).toBe(CLAUDE_PROMPT);
    expect(getPromptForModel("openai/gpt-4o")).toBe(OPENAI_PROMPT);
    expect(getPromptForModel("google/gemini-2.5-pro")).toBe(GOOGLE_PROMPT);
    expect(getPromptForModel("ollama/llama3")).toBe(DEFAULT_PROMPT);
  });

  test("getPromptForModel handles gateway providers", () => {
    expect(getPromptForModel("openrouter/anthropic/claude-sonnet-4")).toBe(CLAUDE_PROMPT);
    expect(getPromptForModel("llmgateway/claude-sonnet-4-20250514")).toBe(CLAUDE_PROMPT);
    expect(getPromptForModel("llmgateway/gpt-4o")).toBe(OPENAI_PROMPT);
    expect(getPromptForModel("proxy/claude-opus-4")).toBe(CLAUDE_PROMPT);
    expect(getPromptForModel("proxy/gpt-4o")).toBe(OPENAI_PROMPT);
    expect(getPromptForModel("proxy/gemini-2.5-pro")).toBe(GOOGLE_PROMPT);
  });

  test("xai routes to openai family", () => {
    expect(getPromptForModel("xai/grok-3")).toBe(OPENAI_PROMPT);
  });
});

// ── Family Prompt Content ──

describe("family prompt content", () => {
  test("all family prompts contain Forge identity", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).toContain("Forge");
    }
  });

  test("all family prompts reference soul tools", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).toContain("soul_find");
    }
  });

  test("all family prompts include answer-voice compression rules", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).toContain("<answer_voice>");
    }
  });

  test("all family prompts prohibit unsolicited commits", () => {
    for (const prompt of [CLAUDE_PROMPT, OPENAI_PROMPT, GOOGLE_PROMPT, DEFAULT_PROMPT]) {
      expect(prompt).toContain("Only commit changes when the user explicitly asks you to");
    }
  });

  test("claude prompt has workflow section", () => {
    expect(CLAUDE_PROMPT).toContain("<workflow>");
  });

  test("openai prompt has agent framing", () => {
    expect(OPENAI_PROMPT).toContain("keep going until");
  });

  test("google prompt has structured mandates", () => {
    expect(GOOGLE_PROMPT).toContain("Core Mandates");
  });
});

// ── Builder Assembly ──

function baseOpts(overrides?: Partial<PromptBuilderOptions>): PromptBuilderOptions {
  return {
    modelId: "anthropic/claude-sonnet-4-6",
    hasRepoMap: false,
    hasSymbols: false,
    forgeMode: "default",
    contextPercent: 50,
    projectInstructions: null,
    ...overrides,
  };
}

describe("buildSystemPrompt assembly", () => {
  test("includes family prompt for the model", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).toContain("Forge");
    expect(prompt).toContain("<workflow>"); // claude-specific
  });

  test("includes tool guidance when repo map is ready", () => {
    const prompt = buildSystemPrompt(baseOpts({ hasRepoMap: true }));
    expect(prompt).toContain("Soul Map");
    expect(prompt).toContain("Decision flow");
  });

  test("includes no-map guidance when repo map not ready", () => {
    const prompt = buildSystemPrompt(baseOpts({ hasRepoMap: false }));
    expect(prompt).toContain("dedicated tools over shell");
    expect(prompt).not.toContain("Decision flow");
  });

  test("does not include cwd, projectInfo, or memory", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).not.toContain("Project cwd");
    expect(prompt).not.toContain("Memory:");
  });

  test("includes mode overlay when not default", () => {
    const prompt = buildSystemPrompt(baseOpts({ forgeMode: "architect" }));
    expect(prompt).toContain("ARCHITECT MODE");
  });

  test("no mode overlay for default mode", () => {
    const prompt = buildSystemPrompt(baseOpts({ forgeMode: "default" }));
    expect(prompt).not.toContain("Mode:");
  });

  test("includes skills reference", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).toContain("Skills may be loaded");
  });

  test("warns about limited symbols", () => {
    const prompt = buildSystemPrompt(baseOpts({ hasRepoMap: true, hasSymbols: false }));
    expect(prompt).toContain("Code intelligence limited");
  });

  test("uses correct family for different models", () => {
    const claude = buildSystemPrompt(baseOpts({ modelId: "anthropic/claude-opus-4" }));
    const openai = buildSystemPrompt(baseOpts({ modelId: "openai/gpt-4o" }));
    expect(claude).toContain("<workflow>"); // claude-specific
    expect(openai).toContain("keep going until"); // openai-specific
  });
});

// ── Mode Instructions ──

describe("mode instructions", () => {
  test("default mode returns null", () => {
    expect(getModeInstructions("default")).toBeNull();
  });

  test("architect mode returns read-only instructions", () => {
    const instructions = getModeInstructions("architect");
    expect(instructions).toContain("ARCHITECT MODE");
    expect(instructions).toContain("Read-only");
  });

  test("plan mode returns full plan at high context", () => {
    const instructions = getModeInstructions("plan", { contextPercent: 80 });
    expect(instructions).toContain("full");
    expect(instructions).toContain("code_snippets");
  });

  test("plan mode returns light plan at low context", () => {
    const instructions = getModeInstructions("plan", { contextPercent: 30 });
    expect(instructions).toContain("light");
    expect(instructions).toContain("no code_snippets");
  });

  test("auto mode returns autonomous instructions", () => {
    const instructions = getModeInstructions("auto");
    expect(instructions).toContain("AUTO MODE");
    expect(instructions).toContain("Execute immediately");
  });

  test("socratic mode returns investigation instructions", () => {
    const instructions = getModeInstructions("socratic");
    expect(instructions).toContain("SOCRATIC MODE");
  });

  test("challenge mode returns adversarial instructions", () => {
    const instructions = getModeInstructions("challenge");
    expect(instructions).toContain("CHALLENGE MODE");
  });
});

// ── Soul Map Messages ──

describe("soul map messages", () => {
  test("buildSoulMapUserMessage wraps content in tags", () => {
    const msg = buildSoulMapUserMessage("file1.ts\n  +export foo", false);
    expect(msg).toContain("<soul_map>");
    expect(msg).toContain("</soul_map>");
    expect(msg).toContain("<data>");
    expect(msg).toContain("file1.ts");
    expect(msg).toContain("+export foo");
  });

  test("buildSoulMapUserMessage includes legend for non-minimal", () => {
    const msg = buildSoulMapUserMessage("data", false);
    expect(msg).toContain("+ = exported");
    expect(msg).toContain("blast radius");
  });

  test("buildSoulMapUserMessage omits legend for minimal", () => {
    const msg = buildSoulMapUserMessage("data", true);
    expect(msg).not.toContain("+ = exported");
  });

  test("buildSoulMapUserMessage includes directory tree when provided", () => {
    const tree = "├── src/\n│   ├── core/\n└── tests/";
    const msg = buildSoulMapUserMessage("data", false, tree);
    expect(msg).toContain("<directory_tree>");
    expect(msg).toContain("├── src/");
    expect(msg).toContain("</directory_tree>");
  });

  test("buildSoulMapUserMessage omits directory tree when null", () => {
    const msg = buildSoulMapUserMessage("data", false, null);
    expect(msg).not.toContain("<directory_tree>");
  });

  test("buildSoulMapAck returns acknowledgment", () => {
    const ack = buildSoulMapAck();
    expect(ack).toContain("Soul Map loaded");
  });

  test("buildSoulMapUserMessage includes description and usage", () => {
    const msg = buildSoulMapUserMessage("data", false);
    expect(msg).toContain("<description>");
    expect(msg).toContain("<how_to_use>");
    expect(msg).toContain("navigate()");
  });
});

// ── Directory Tree ──

describe("buildDirectoryTree", () => {
  test("returns null for non-existent directory", () => {
    const tree = buildDirectoryTree("/non/existent/path");
    expect(tree).toBeNull();
  });

  test("returns tree for valid directory", () => {
    const tree = buildDirectoryTree(process.cwd());
    expect(tree).not.toBeNull();
    expect(tree).toContain("docs/");
  });

  test("uses tree characters", () => {
    const tree = buildDirectoryTree(process.cwd());
    expect(tree).not.toBeNull();
    // Should contain tree connectors
    expect(tree!).toMatch(/[├└│]/);
  });
});