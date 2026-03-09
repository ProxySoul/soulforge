import { ensureProxy } from "../proxy/lifecycle.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import type { ProviderModelInfo } from "./providers/types.js";

// Re-export for backward compatibility
export type { ProviderModelInfo } from "./providers/types.js";

// ─── Types ───

export interface FetchModelsResult {
  models: ProviderModelInfo[];
  error?: string;
}

export interface SubProvider {
  id: string;
  name: string;
}

// Backward-compat alias
export type VercelGatewaySubProvider = SubProvider;

export interface GroupedModelsResult {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  error?: string;
}

// Backward-compat alias
export type VercelGatewayModelsResult = GroupedModelsResult;

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
  grouped?: boolean;
}

// ─── Provider Configs (derived from registry) ───

export const PROVIDER_CONFIGS: ProviderConfig[] = getAllProviders().map((p) => ({
  id: p.id,
  name: p.name,
  envVar: p.envVar,
  grouped: p.grouped,
}));

// ─── Context Windows ───

const DEFAULT_CONTEXT_TOKENS = 128_000;

export type ContextWindowSource = "api" | "openrouter" | "fallback";

interface ContextWindowResult {
  tokens: number;
  source: ContextWindowSource;
}

/**
 * Get the context window size (in tokens) for a model ID.
 * Priority: provider API cache → OpenRouter cache → hardcoded patterns → default.
 */
export function getModelContextWindow(modelId: string): number {
  return getModelContextInfo(modelId).tokens;
}

export function getModelContextInfo(modelId: string): ContextWindowResult {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const model = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Provider's own API data (most accurate)
  if (providerId && !getProvider(providerId)?.grouped) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === model);
      if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
    }
  }
  if (providerId) {
    const grouped = getCachedGroupedModels(providerId);
    if (grouped) {
      for (const models of Object.values(grouped.modelsByProvider)) {
        const match = models.find((m) => m.id === model || modelId.endsWith(m.id));
        if (match?.contextWindow) return { tokens: match.contextWindow, source: "api" };
      }
    }
  }

  // 2. OpenRouter metadata (accurate, covers all providers)
  const orMatch = findOpenRouterModel(model);
  if (orMatch?.context_length) return { tokens: orMatch.context_length, source: "openrouter" };

  // 3. Hardcoded fallback patterns
  for (const provider of getAllProviders()) {
    for (const [pattern, tokens] of provider.contextWindows) {
      if (model.includes(pattern)) return { tokens, source: "fallback" };
    }
  }
  return { tokens: DEFAULT_CONTEXT_TOKENS, source: "fallback" };
}

// ─── OpenRouter Metadata ───

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
}

let openRouterCache: OpenRouterModel[] | null = null;
let openRouterPromise: Promise<void> | null = null;

export async function fetchOpenRouterMetadata(): Promise<void> {
  if (openRouterCache) return;
  if (openRouterPromise) return openRouterPromise;
  openRouterPromise = (async () => {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) return;
      const data = (await res.json()) as { data: OpenRouterModel[] };
      openRouterCache = data.data;
    } catch {
      // silently fail — fallback patterns still work
    } finally {
      openRouterPromise = null;
    }
  })();
  return openRouterPromise;
}

function findOpenRouterModel(model: string): OpenRouterModel | undefined {
  if (!openRouterCache) return undefined;
  const lower = model.toLowerCase();
  return (
    openRouterCache.find((m) => m.id.endsWith(`/${lower}`)) ??
    openRouterCache.find((m) => m.id.endsWith(`/${model}`)) ??
    openRouterCache.find((m) => {
      const orModel = m.id.split("/").pop() ?? "";
      return lower.startsWith(orModel.toLowerCase()) || orModel.toLowerCase().startsWith(lower);
    })
  );
}

export function getOpenRouterModelName(model: string): string | undefined {
  const match = findOpenRouterModel(model);
  if (!match) return undefined;
  return match.name.replace(/^[^:]+:\s*/, "");
}

/**
 * Get a short display label for a model ID (e.g. "Claude Sonnet 4", "GPT-4o Mini").
 * Resolution: provider API cache → grouped cache → OpenRouter cache → smart fallback.
 * No hardcoded model names — all labels come from API data or clean truncation.
 */
export function getShortModelLabel(modelId: string): string {
  if (modelId === "none") return "No model";
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const bareModel = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Provider API cache (direct providers)
  if (providerId) {
    const entry = modelCache.get(providerId);
    if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) {
      const match = entry.models.find((m) => m.id === bareModel);
      if (match) return match.name;
    }
  }

  // 2. Grouped provider cache (vercel_gateway, proxy)
  for (const entry of groupedCache.values()) {
    if (Date.now() - entry.ts > MODEL_CACHE_TTL) continue;
    for (const models of Object.values(entry.result.modelsByProvider)) {
      const match = models.find((m) => m.id === bareModel || m.id === modelId);
      if (match && match.name !== match.id) return match.name;
    }
  }

  // 3. Fallback models from provider definitions
  const stripped = bareModel.replace(/-\d{8}$/, "");
  let bestFallback: { name: string; specificity: number } | null = null;
  for (const provider of getAllProviders()) {
    for (const m of provider.fallbackModels) {
      if (m.id === bareModel || m.id === stripped) return m.name;
      if (stripped.startsWith(m.id) || m.id.startsWith(stripped)) {
        const specificity = m.id.length;
        if (!bestFallback || specificity > bestFallback.specificity) {
          bestFallback = { name: m.name, specificity };
        }
      }
    }
  }
  if (bestFallback) return bestFallback.name;

  // 4. OpenRouter metadata
  const orName = getOpenRouterModelName(bareModel);
  if (orName) return orName;

  // 5. Smart fallback — strip date suffix, clean up
  const clean = bareModel.replace(/-\d{8}$/, "");
  return clean.length > 24 ? `${clean.slice(0, 21)}...` : clean;
}

// ─── Cache ───

const MODEL_CACHE_TTL = 30 * 60_000;
const modelCache = new Map<string, { models: ProviderModelInfo[]; ts: number }>();

export function getCachedModels(providerId: string): ProviderModelInfo[] | null {
  const entry = modelCache.get(providerId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL) {
    modelCache.delete(providerId);
    return null;
  }
  return entry.models;
}

// ─── Public API ───

export async function fetchProviderModels(providerId: string): Promise<FetchModelsResult> {
  // Check cache first
  const entry = modelCache.get(providerId);
  if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) return { models: entry.models };

  const provider = getProvider(providerId);
  if (!provider) return { models: [] };

  try {
    const models = await provider.fetchModels();
    if (models) {
      modelCache.set(providerId, { models, ts: Date.now() });
      return { models };
    }
    return { models: provider.fallbackModels };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { models: provider.fallbackModels, error: `API error: ${msg}` };
  }
}

// ─── Grouped Models (Vercel Gateway, Proxy, etc.) ───

interface OpenAIModelEntry {
  id: string;
  owned_by?: string;
  name?: string;
  type?: string;
}

const groupedCache = new Map<string, { result: GroupedModelsResult; ts: number }>();

export function getCachedGroupedModels(providerId: string): GroupedModelsResult | null {
  const entry = groupedCache.get(providerId);
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL) {
    groupedCache.delete(providerId);
    return null;
  }
  return entry.result;
}

// Backward-compat wrapper
export function getCachedVercelGatewayModels(): GroupedModelsResult | null {
  return getCachedGroupedModels("vercel_gateway");
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Infer a provider group from a model ID prefix. */
function inferModelGroup(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1-") ||
    id.startsWith("o3-") ||
    id.startsWith("o4-") ||
    id.startsWith("chatgpt")
  )
    return "openai";
  if (id.startsWith("gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.startsWith("llama") || id.startsWith("meta-")) return "meta";
  if (id.startsWith("mistral") || id.startsWith("codestral") || id.startsWith("pixtral"))
    return "mistral";
  if (id.startsWith("deepseek")) return "deepseek";
  return "other";
}

const GROUP_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  other: "Other",
};

export async function fetchGroupedModels(providerId: string): Promise<GroupedModelsResult> {
  const entry = groupedCache.get(providerId);
  if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) return entry.result;

  if (providerId === "vercel_gateway") return fetchVercelGatewayGrouped();
  if (providerId === "llmgateway") return fetchLLMGatewayGrouped();
  if (providerId === "proxy") return fetchProxyGrouped();

  return {
    subProviders: [],
    modelsByProvider: {},
    error: `Unknown grouped provider: ${providerId}`,
  };
}

// Backward-compat wrapper
export async function fetchVercelGatewayModels(): Promise<GroupedModelsResult> {
  return fetchGroupedModels("vercel_gateway");
}

async function fetchVercelGatewayGrouped(): Promise<GroupedModelsResult> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return {
      subProviders: [],
      modelsByProvider: {},
      error: "AI_GATEWAY_API_KEY not set",
    };
  }

  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models");
    if (!res.ok) {
      return {
        subProviders: [],
        modelsByProvider: {},
        error: `Gateway error: ${String(res.status)}`,
      };
    }

    const data = (await res.json()) as { data: OpenAIModelEntry[] };
    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      if (m.type !== "language") continue;
      const owner = m.owned_by ?? "other";
      if (!grouped[owner]) grouped[owner] = [];
      grouped[owner].push({ id: m.id, name: m.name ?? m.id });
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: titleCase(id) }));

    const result: GroupedModelsResult = {
      subProviders,
      modelsByProvider: grouped,
    };
    groupedCache.set("vercel_gateway", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      subProviders: [],
      modelsByProvider: {},
      error: `Gateway error: ${msg}`,
    };
  }
}

async function fetchLLMGatewayGrouped(): Promise<GroupedModelsResult> {
  const apiKey = process.env.LLM_GATEWAY_API_KEY;
  if (!apiKey) {
    return {
      subProviders: [],
      modelsByProvider: {},
      error: "LLM_GATEWAY_API_KEY not set",
    };
  }

  try {
    const res = await fetch("https://api.llmgateway.io/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return {
        subProviders: [],
        modelsByProvider: {},
        error: `LLM Gateway error: ${String(res.status)}`,
      };
    }

    const data = (await res.json()) as {
      data: {
        id: string;
        name: string;
        family?: string;
        context_length?: number;
      }[];
    };
    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      const group = m.family?.toLowerCase() || inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_length,
      });
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    const result: GroupedModelsResult = {
      subProviders,
      modelsByProvider: grouped,
    };
    groupedCache.set("llmgateway", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // Fall back to grouped fallback models
    const provider = getProvider("llmgateway");
    if (!provider) return { subProviders: [], modelsByProvider: {}, error: `LLM Gateway: ${msg}` };

    const fallbackGrouped: Record<string, ProviderModelInfo[]> = {};
    for (const m of provider.fallbackModels) {
      const group = inferModelGroup(m.id);
      if (!fallbackGrouped[group]) fallbackGrouped[group] = [];
      fallbackGrouped[group].push(m);
    }

    const subProviders: SubProvider[] = Object.keys(fallbackGrouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    return {
      subProviders,
      modelsByProvider: fallbackGrouped,
      error: `LLM Gateway: ${msg}`,
    };
  }
}

async function fetchProxyGrouped(): Promise<GroupedModelsResult> {
  const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
  const apiKey = process.env.PROXY_API_KEY || "soulforge";

  // Auto-install and spawn proxy if needed
  const proxyStatus = await ensureProxy();
  if (!proxyStatus.ok) {
    // Return fallback models with error
    const provider = getProvider("proxy");
    if (!provider) return { subProviders: [], modelsByProvider: {}, error: proxyStatus.error };

    const grouped: Record<string, ProviderModelInfo[]> = {};
    for (const m of provider.fallbackModels) {
      const group = inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(m);
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    return { subProviders, modelsByProvider: grouped, error: proxyStatus.error };
  }

  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Proxy API ${String(res.status)}`);

    const data = (await res.json()) as { data: OpenAIModelEntry[] };
    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      const group = inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push({ id: m.id, name: m.id });
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    const result: GroupedModelsResult = {
      subProviders,
      modelsByProvider: grouped,
    };
    groupedCache.set("proxy", { result, ts: Date.now() });
    return result;
  } catch {
    // Proxy not running — group fallback models by prefix
    const provider = getProvider("proxy");
    if (!provider) return { subProviders: [], modelsByProvider: {} };

    const grouped: Record<string, ProviderModelInfo[]> = {};
    for (const m of provider.fallbackModels) {
      const group = inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(m);
    }

    const subProviders: SubProvider[] = Object.keys(grouped)
      .sort()
      .map((id) => ({ id, name: GROUP_DISPLAY_NAMES[id] ?? titleCase(id) }));

    return {
      subProviders,
      modelsByProvider: grouped,
      error: "Proxy not running — showing defaults",
    };
  }
}
