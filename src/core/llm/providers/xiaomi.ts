import { createOpenAI } from "@ai-sdk/openai";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const xiaomi: ProviderDefinition = {
  id: "xiaomi",
  name: "Xiaomi (MiMo)",
  envVar: "XIAOMI_API_KEY",
  icon: "", // nf-md-brain U+F09CA
  secretKey: "xiaomi-api-key",
  keyUrl: "platform.xiaomimimo.com",
  asciiIcon: "X",
  description: "MiMo models via Xiaomi token plan",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("XIAOMI_API_KEY");
    if (!apiKey) {
      throw new Error("XIAOMI_API_KEY is not set");
    }
    const client = createOpenAI({
      baseURL: "https://token-plan-sgp.xiaomimimo.com/v1",
      apiKey,
    });
    return client.chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("XIAOMI_API_KEY");
    if (!apiKey) return null;
    try {
      const res = await fetch("https://token-plan-sgp.xiaomimimo.com/v1/models", {
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
    { id: "mimo-v2-pro", name: "MiMo V2 Pro" },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { id: "mimo-v2-lite", name: "MiMo V2 Lite" },
  ],

  contextWindows: [
    ["mimo-v2-pro", 128_000],
    ["mimo-v2-omni", 128_000],
    ["mimo-v2-lite", 64_000],
  ],
};
