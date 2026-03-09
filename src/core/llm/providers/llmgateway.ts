import { createLLMGateway } from "@llmgateway/ai-sdk-provider";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const llmgateway: ProviderDefinition = {
  id: "llmgateway",
  name: "LLM Gateway",
  envVar: "LLM_GATEWAY_API_KEY",
  icon: "󰒍", // nf-md-cloud_sync U+F048D
  grouped: true,

  createModel(modelId: LLMGatewayModelId): ReturnType<typeof createLLMGateway> {
    if (!process.env.LLM_GATEWAY_API_KEY) {
      throw new Error("LLM_GATEWAY_API_KEY is not set");
    }
    const provider = createLLMGateway({
      apiKey: process.env.LLM_GATEWAY_API_KEY,
    });
    return provider(modelId); // Temporary workaround for type mismatch
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null; // grouped provider — uses fetchGroupedModels instead
  },

  fallbackModels: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],

  contextWindows: [
    ["gpt-4o-mini", 128_000],
    ["gpt-4o", 128_000],
    ["claude-sonnet-4", 200_000],
    ["claude-3-5-haiku", 200_000],
    ["claude-3-5-sonnet", 200_000],
    ["gemini-2.0-flash", 1_048_576],
    ["gemini-2.5-pro", 1_048_576],
    ["deepseek-chat", 64_000],
    ["o3-mini", 200_000],
    ["o3", 200_000],
    ["grok", 131_072],
  ],
};
