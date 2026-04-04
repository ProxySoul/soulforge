import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ensureProxy, stopProxy } from "../../proxy/lifecycle.js";
import { SHARED_CONTEXT_WINDOWS } from "./context-windows.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
const apiKey = process.env.PROXY_API_KEY || "soulforge";

function isAnthropicModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("claude");
}

export const proxy: ProviderDefinition = {
  id: "proxy",
  name: "Proxy",
  envVar: "",
  icon: "󰌆", // nf-md-shield_key U+F0306
  asciiIcon: "⛨",
  grouped: true,

  createModel(modelId: string) {
    // Claude → Anthropic SDK (proxy serves /v1/messages)
    // Everything else → OpenAI SDK chat completions (proxy serves /v1/chat/completions)
    // Must use .chat() — default uses Responses API (/v1/responses) which proxy can't translate for all providers
    if (isAnthropicModel(modelId)) {
      return createAnthropic({ baseURL, apiKey })(modelId);
    }
    return createOpenAI({ baseURL, apiKey }).chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null;
  },

  async onActivate() {
    await ensureProxy();
  },

  onDeactivate() {
    stopProxy();
  },

  fallbackModels: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5" },
  ],

  // Specific overrides first → shared patterns → generic catch-alls last.
  contextWindows: [
    // Claude (both dot/hyphen styles)
    ["claude-opus-4-6", 1_000_000],
    ["claude-opus-4.6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-sonnet-4.6", 1_000_000],
    ["claude-sonnet-4-5", 200_000],
    ["claude-sonnet-4.5", 200_000],
    ["claude-opus-4-5", 200_000],
    ["claude-opus-4.5", 200_000],
    ["claude-sonnet-4", 200_000],
    ["claude-opus-4", 200_000],
    ["claude-haiku-4", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3-7-sonnet", 200_000],
    ["claude-3.5-sonnet", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["claude-3.5-haiku", 200_000],
    ["claude-3-5-haiku", 200_000],
    // GPT
    ["gpt-5-chat", 128_000],
    ["gpt-4.1", 1_048_576],
    // Grok
    ["grok-4.1", 2_000_000],
    ["grok-4-1", 2_000_000],
    ["grok-4.20", 2_000_000],
    ["grok-4-20", 2_000_000],
    // Llama
    ["llama-4-scout", 327_680],
    ["llama-3.2", 131_072],
    ["llama-3.1", 131_072],
    // Shared patterns
    ...SHARED_CONTEXT_WINDOWS,
    // Generic catch-alls AFTER shared
    ["gpt-5.4", 1_050_000],
    ["gpt-5", 400_000],
    ["gpt-4", 128_000],
    ["qwen3.5", 262_144],
    ["qwen3", 131_072],
    ["qwen2.5", 32_768],
    ["qwen", 32_768],
    ["mistral-large", 128_000],
    ["mistral-medium", 131_072],
    ["mistral-small", 32_768],
    ["mistral", 128_000],
    ["gemma-3", 131_072],
    ["gemma", 128_000],
    ["grok", 131_072],
    ["llama", 131_072],
  ],
};
