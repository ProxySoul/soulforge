import { gateway as aiGateway } from "ai";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

// The gateway provider aggregates sub-providers (anthropic, openai, etc.)
// through Vercel's AI Gateway. Model IDs use a triple-slash format:
// "gateway/anthropic/claude-opus-4.6" → gateway("anthropic/claude-opus-4.6")
export const gatewayProvider: ProviderDefinition = {
  id: "gateway",
  name: "Gateway (Vercel)",
  envVar: "AI_GATEWAY_API_KEY",
  icon: "󰒍", // nf-md-cloud_sync U+F048D
  grouped: true,

  createModel(modelId: string) {
    if (!process.env.AI_GATEWAY_API_KEY) {
      throw new Error("AI_GATEWAY_API_KEY is not set");
    }
    return aiGateway(modelId);
  },

  // Gateway models are fetched separately via fetchGatewayModels() in models.ts
  // because they have a different structure (grouped by sub-provider).
  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null;
  },

  fallbackModels: [],
  contextWindows: [],
};
