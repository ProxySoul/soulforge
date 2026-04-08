import { createOpenAI } from "@ai-sdk/openai";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const zai: ProviderDefinition = {
  id: "zai",
  name: "Z.AI (GLM)",
  envVar: "ZAI_API_KEY",
  icon: "\uF09CA", // nf-md-brain U+F09CA
  secretKey: "zai-api-key",
  keyUrl: "z.ai/model-api",
  asciiIcon: "Z",
  description: "GLM models via Z.AI coding plan",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("ZAI_API_KEY");
    if (!apiKey) {
      throw new Error("ZAI_API_KEY is not set");
    }
    const client = createOpenAI({
      baseURL: "https://api.z.ai/api/paas/v4",
      apiKey,
    });
    return client.chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("ZAI_API_KEY");
    if (!apiKey) return null;
    try {
      const res = await fetch("https://api.z.ai/api/paas/v4/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data: { id: string }[];
      };
      if (!Array.isArray(data.data)) return null;
      return data.data.map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return null;
    }
  },

  fallbackModels: [
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-4.5-air", name: "GLM-4.5 Air" },
    { id: "glm-4.5", name: "GLM-4.5" },
  ],

  contextWindows: [
    ["glm-5.1", 204_800],
    ["glm-4.5", 128_000],
    ["glm-4.5-air", 128_000],
  ],
};
