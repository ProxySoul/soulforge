import type { LanguageModel } from "ai";

export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  envVar: string;
  icon: string;
  createModel(modelId: string): LanguageModel;
  fetchModels(): Promise<ProviderModelInfo[] | null>;
  fallbackModels: ProviderModelInfo[];
  contextWindows: [pattern: string, tokens: number][];
  grouped?: boolean;
}
