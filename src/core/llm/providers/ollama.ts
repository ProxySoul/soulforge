import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface OllamaModel {
  name: string;
}

// Ollama uses OpenAI's SDK with a local base URL because Ollama exposes
// an OpenAI-compatible API at localhost:11434/v1.
export const ollama: ProviderDefinition = {
  id: "ollama",
  name: "Ollama",
  envVar: "",
  icon: "🦙",
  asciiIcon: "🦙",

  createModel(modelId: string) {
    const client = createOpenAI({
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
    return client.chat(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) throw new Error(`Ollama API ${String(res.status)}`);
    const data = (await res.json()) as { models: OllamaModel[] };
    return data.models.map((m) => {
      const name = m.name.replace(/:latest$/, "");
      return { id: name, name };
    });
  },

  fallbackModels: [
    { id: "llama3.3", name: "Llama 3.3" },
    { id: "qwen3", name: "Qwen 3" },
    { id: "deepseek-coder-v2", name: "DeepSeek Coder v2" },
    { id: "mistral", name: "Mistral" },
  ],

  async checkAvailability() {
    try {
      const res = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  contextWindows: [
    ["llama3.3", 131_072],
    ["llama3.1:70b", 128_000],
    ["llama3.1", 128_000],
    ["codellama", 16_000],
    ["deepseek-coder", 128_000],
    ["deepseek", 128_000],
    ["mistral", 128_000],
    ["qwen3", 131_072],
    ["qwen2.5", 128_000],
    ["qwen", 128_000],
  ],
};
