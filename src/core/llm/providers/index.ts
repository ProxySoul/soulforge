export { anthropic } from "./anthropic.js";
export { gatewayProvider } from "./gateway.js";
export { google } from "./google.js";
export { ollama } from "./ollama.js";
export { openai } from "./openai.js";
export { proxy } from "./proxy.js";
export type { ProviderDefinition, ProviderModelInfo } from "./types.js";
export { xai } from "./xai.js";

import { anthropic } from "./anthropic.js";
import { gatewayProvider } from "./gateway.js";
import { google } from "./google.js";
import { ollama } from "./ollama.js";
import { openai } from "./openai.js";
import { proxy } from "./proxy.js";
import type { ProviderDefinition } from "./types.js";
import { xai } from "./xai.js";

const ALL_PROVIDERS: ProviderDefinition[] = [
  gatewayProvider,
  anthropic,
  openai,
  xai,
  google,
  ollama,
  proxy,
];

const providerMap = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): ProviderDefinition | undefined {
  return providerMap.get(id);
}

export function getAllProviders(): ProviderDefinition[] {
  return ALL_PROVIDERS;
}
