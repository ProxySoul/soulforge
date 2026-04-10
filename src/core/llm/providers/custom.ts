import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getProviderApiKey } from "../../secrets.js";
import type { CustomProviderConfig, ProviderDefinition, ProviderModelInfo } from "./types.js";

interface OpenAIModelListResponse {
  data: { id: string; owned_by?: string }[];
}

function normalizeModels(models?: (string | ProviderModelInfo)[]): ProviderModelInfo[] {
  if (!models || models.length === 0) return [];
  return models.map((m) => (typeof m === "string" ? { id: m, name: m } : m));
}

export function buildCustomProvider(config: CustomProviderConfig): ProviderDefinition {
  const envVar = config.envVar ?? "";

  return {
    id: config.id,
    name: config.name ?? config.id,
    envVar,
    icon: "\uF29F", // nf-fa-diamond U+F29F
    asciiIcon: "◇",
    custom: true,

    createModel(modelId: string) {
      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "custom";
      const client = createOpenAICompatible({
        name: config.id,
        baseURL: config.baseURL,
        apiKey,
      });
      return client.chatModel(modelId);
    },

    async fetchModels(): Promise<ProviderModelInfo[] | null> {
      if (!config.modelsAPI) return null;
      const apiKey = envVar ? (getProviderApiKey(envVar) ?? "") : "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const res = await fetch(config.modelsAPI, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as OpenAIModelListResponse;
      if (!Array.isArray(data.data)) return null;

      return data.data.map((m) => ({ id: m.id, name: m.id }));
    },

    fallbackModels: normalizeModels(config.models),
    contextWindows: [],

    async checkAvailability() {
      if (envVar) return Boolean(getProviderApiKey(envVar));
      try {
        const res = await fetch(config.baseURL, { signal: AbortSignal.timeout(2000) });
        return res.ok || res.status === 401 || res.status === 403;
      } catch {
        return false;
      }
    },
  };
}
