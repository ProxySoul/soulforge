import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface GoogleModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export const google: ProviderDefinition = {
  id: "google",
  name: "Gemini",
  envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
  icon: "󰊭", // nf-md-google U+F02AD

  createModel(modelId: string) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
    }
    return createGoogleGenerativeAI()(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) return null;
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`Google API ${String(res.status)}`);
    const data = (await res.json()) as { models: GoogleModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.models) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = m.name?.replace("models/", "") ?? "";
      if (id === "") continue;
      result.push({
        id,
        name: m.displayName ?? id,
        contextWindow: m.inputTokenLimit,
      });
    }
    return result;
  },

  fallbackModels: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],

  contextWindows: [
    ["gemini-2.5-pro", 1_000_000],
    ["gemini-2.5-flash", 1_000_000],
    ["gemini-2.0-flash", 1_000_000],
    ["gemini-1.5-pro", 2_000_000],
    ["gemini-1.5-flash", 1_000_000],
    ["gemini", 1_000_000],
  ],
};
