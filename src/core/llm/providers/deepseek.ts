import { createDeepSeek } from "@ai-sdk/deepseek";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

export const deepseek: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek",
  envVar: "DEEPSEEK_API_KEY",
  icon: "󰧑", // nf-md-head_snowflake U+F09D1
  secretKey: "deepseek-api-key",
  keyUrl: "platform.deepseek.com",
  asciiIcon: "D",
  description: "DeepSeek models",

  createModel(modelId: string) {
    const apiKey = getProviderApiKey("DEEPSEEK_API_KEY");
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not set");
    }
    return createDeepSeek({ apiKey })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = getProviderApiKey("DEEPSEEK_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`DeepSeek API ${String(res.status)}`);
    const data = (await res.json()) as {
      data: { id: string; owned_by?: string }[];
    };
    return data.data.map((m) => ({ id: m.id, name: m.id }));
  },

  fallbackModels: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
  ],

  contextWindows: [
    ["deepseek-chat", 131_072],
    ["deepseek-reasoner", 131_072],
    ["deepseek-v3", 131_072],
    ["deepseek-r1", 131_072],
    ["deepseek-coder", 128_000],
  ],
};
