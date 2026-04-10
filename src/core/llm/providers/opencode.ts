import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderApiKey } from "../../secrets.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const ZEN_BASE = "https://opencode.ai/zen/v1";

function getApiKey(): string {
  const key = getProviderApiKey("OPENCODE_API_KEY");
  if (!key) throw new Error("OPENCODE_API_KEY is not set");
  return key;
}

function isClaudeModel(id: string): boolean {
  return id.startsWith("claude-");
}

function isOpenAIModel(id: string): boolean {
  return (
    id.startsWith("gpt-") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt")
  );
}

function isGeminiModel(id: string): boolean {
  return id.startsWith("gemini-");
}

export const opencode: ProviderDefinition = {
  id: "opencode",
  name: "OpenCode Zen",
  envVar: "OPENCODE_API_KEY",
  icon: "\uF0AC", // nf-fa-globe U+F0AC
  secretKey: "opencode-api-key",
  keyUrl: "opencode.ai/auth",
  asciiIcon: "⊙",
  description: "Curated multi-provider gateway",
  grouped: true,

  createModel(modelId: string) {
    const apiKey = getApiKey();

    if (isClaudeModel(modelId)) {
      return createAnthropic({ baseURL: ZEN_BASE, apiKey })(modelId);
    }

    if (isOpenAIModel(modelId)) {
      return createOpenAI({ baseURL: ZEN_BASE, apiKey })(modelId);
    }

    if (isGeminiModel(modelId)) {
      return createGoogleGenerativeAI({
        baseURL: ZEN_BASE,
        // Pass as apiKey so the SDK doesn't throw; Zen accepts x-goog-api-key.
        // Also set Authorization header for gateway compatibility.
        apiKey,
        headers: { Authorization: `Bearer ${apiKey}` },
      })(modelId);
    }

    // Kimi, GLM, MiniMax, Qwen, Nemotron, Big Pickle, etc.
    return createOpenAICompatible({
      name: "opencode",
      baseURL: `${ZEN_BASE}/chat/completions`,
      apiKey,
    }).chatModel(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null; // grouped provider — uses fetchGroupedModels instead
  },

  fallbackModels: [
    // Claude
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-3-5-haiku", name: "Claude Haiku 3.5" },
    // GPT
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-pro", name: "GPT 5.4 Pro" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT 5.4 Nano" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.2-codex", name: "GPT 5.2 Codex" },
    { id: "gpt-5.1", name: "GPT 5.1" },
    { id: "gpt-5.1-codex", name: "GPT 5.1 Codex" },
    { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini" },
    { id: "gpt-5", name: "GPT 5" },
    { id: "gpt-5-codex", name: "GPT 5 Codex" },
    { id: "gpt-5-nano", name: "GPT 5 Nano" },
    // Gemini
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    // Open models
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.5-free", name: "MiniMax M2.5 Free" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "big-pickle", name: "Big Pickle" },
    { id: "qwen3.6-plus-free", name: "Qwen3.6 Plus Free" },
    { id: "nemotron-3-super-free", name: "Nemotron 3 Super Free" },
  ],

  contextWindows: [
    // Claude
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4-1", 200_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-3-5-haiku", 200_000],
    // GPT
    ["gpt-5.4-pro", 1_050_000],
    ["gpt-5.4-mini", 400_000],
    ["gpt-5.4-nano", 400_000],
    ["gpt-5.4", 1_050_000],
    ["gpt-5.3-codex", 400_000],
    ["gpt-5.3-codex-spark", 400_000],
    ["gpt-5.2-codex", 262_144],
    ["gpt-5.2", 262_144],
    ["gpt-5.1-codex-max", 400_000],
    ["gpt-5.1-codex-mini", 400_000],
    ["gpt-5.1-codex", 400_000],
    ["gpt-5.1", 400_000],
    ["gpt-5-codex", 400_000],
    ["gpt-5-nano", 400_000],
    ["gpt-5", 400_000],
    // Gemini
    ["gemini-3.1-pro", 1_048_576],
    ["gemini-3-flash", 1_048_576],
    // Open models
    ["kimi-k2.5", 262_144],
    ["glm-5.1", 204_800],
    ["glm-5", 204_800],
    ["minimax-m2.5", 196_608],
    ["minimax-m2.5-free", 196_608],
    ["qwen3.6-plus-free", 1_000_000],
    ["nemotron-3-super-free", 262_144],
    ["big-pickle", 200_000],
    // Shared patterns
    ...SHARED_CONTEXT_WINDOWS,
  ],
};
