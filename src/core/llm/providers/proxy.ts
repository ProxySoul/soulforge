import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";

export const proxy: ProviderDefinition = {
  id: "proxy",
  name: "Proxy",
  envVar: "",
  icon: "󰌆", // nf-md-shield_key U+F0306
  grouped: true,

  createModel(modelId: string) {
    const client = createAnthropic({
      baseURL,
      apiKey: process.env.PROXY_API_KEY || "soulforge",
    });
    return client(modelId);
  },

  // Models are fetched via grouped flow in models.ts
  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null;
  },

  fallbackModels: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5" },
  ],

  contextWindows: [
    ["claude-opus", 200_000],
    ["claude-sonnet", 200_000],
    ["claude-haiku", 200_000],
    ["claude-3", 200_000],
  ],
};
