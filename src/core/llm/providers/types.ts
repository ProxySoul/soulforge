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
  /** Kebab-case key for the secrets store (e.g. "anthropic-api-key"). Derived from envVar if omitted. */
  secretKey?: string;
  /** URL where users can create/manage their API key (shown in /keys UI). */
  keyUrl?: string;
  /** ASCII fallback icon for terminals without nerd fonts. */
  asciiIcon?: string;
  /** Short description for wizard/UI (e.g. "Claude models"). */
  description?: string;
  /** Inline badge for provider selectors (e.g. "unofficial", "non-streaming"). */
  badge?: string;
  /** Custom label shown when the provider is unavailable and needs auth. */
  noAuthLabel?: string;
  /** Custom label shown when model loading fails after the provider is available. */
  authErrorLabel?: string;
  createModel(modelId: string): LanguageModel;
  fetchModels(): Promise<ProviderModelInfo[] | null>;
  fallbackModels: ProviderModelInfo[];
  contextWindows: [pattern: string, tokens: number][];
  grouped?: boolean;
  custom?: boolean;
  checkAvailability?(): Promise<boolean>;
  onRequestAuth?(): Promise<void>;
  onActivate?(): Promise<void>;
  onDeactivate?(): void;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseURL: string;
  envVar?: string;
  models?: (string | ProviderModelInfo)[];
  modelsAPI?: string;
}
