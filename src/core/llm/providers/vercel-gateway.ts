import { gateway as aiGateway } from "ai";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const vercelGatewayProvider: ProviderDefinition = {
  id: "vercel_gateway",
  name: "Vercel AI Gateway",
  envVar: "AI_GATEWAY_API_KEY",
  icon: "󰒍", // nf-md-cloud_sync U+F048D
  secretKey: "vercel-gateway-api-key",
  keyUrl: "vercel.com/ai-gateway",
  asciiIcon: "☁",
  grouped: true,

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("AI_GATEWAY_API_KEY");
    if (!apiKey) {
      throw new Error("AI_GATEWAY_API_KEY is not set");
    }
    return aiGateway(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    return null;
  },

  fallbackModels: [],
  contextWindows: [],
};
