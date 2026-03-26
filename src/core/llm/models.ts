import { toErrorMessage } from "../../utils/errors.js";
import { ensureProxy } from "../proxy/lifecycle.js";
import { getProviderApiKey } from "../secrets.js";
import { getAllProviders, getProvider } from "./providers/index.js";
import type { ProviderModelInfo } from "./providers/types.js";

// Re-export for backward compatibility
export type { ProviderModelInfo } from "./providers/types.js";

export interface FetchModelsResult {
  models: ProviderModelInfo[];
  error?: string;
}

export interface SubProvider {
  id: string;
  name: string;
}

export interface GroupedModelsResult {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  error?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  envVar: string;
  grouped?: boolean;
}

export const PROVIDER_CONFIGS: ProviderConfig[] = getAllProviders().map((p) => ({
  id: p.id,
  name: p.name,
  envVar: p.envVar,
  grouped: p.grouped,
}));

const DEFAULT_CONTEXT_TOKENS = 128_000;

type ContextWindowSource = "api" | "openrouter" | "fallback";

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

function getOpenRouterModelName(model: string): string | undefined {
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

const MODEL_CACHE_TTL = 30 * 60_000;
const modelCache = new Map<string, { models: ProviderModelInfo[]; ts: number }>();

function getCached<T>(cache: Map<string, { result: T; ts: number }>, key: string): T | null;
function getCached<T>(cache: Map<string, { models: T; ts: number }>, key: string): T | null;
function getCached(
  cache: Map<string, { result?: unknown; models?: unknown; ts: number }>,
  key: string,
): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > MODEL_CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.result ?? entry.models ?? null;
}

export function getCachedModels(providerId: string): ProviderModelInfo[] | null {
  return getCached(modelCache, providerId);
}

export function invalidateModelCache(providerId?: string): void {
  if (providerId) {
    modelCache.delete(providerId);
    groupedCache.delete(providerId);
  } else {
    modelCache.clear();
    groupedCache.clear();
  }
}

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
    const msg = toErrorMessage(err);
    return { models: provider.fallbackModels, error: `API error: ${msg}` };
  }
}

interface OpenAIModelEntry {
  id: string;
  owned_by?: string;
  name?: string;
  type?: string;
}

interface AnthropicModelEntry {
  id: string;
  type: string;
  display_name?: string;
  context_window?: number;
}

/**
 * Fetch context window sizes from Anthropic's /v1/models API.
 * Returns a map of modelId → context_window tokens.
 * Falls back gracefully if ANTHROPIC_API_KEY is unavailable or the call fails.
 */
async function fetchAnthropicContextWindows(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const apiKey = getProviderApiKey("ANTHROPIC_API_KEY");
  if (!apiKey) return map;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) return map;
    const data = (await res.json()) as { data: AnthropicModelEntry[] };
    for (const m of data.data) {
      if (m.context_window) map.set(m.id, m.context_window);
    }
  } catch {}
  return map;
}

const groupedCache = new Map<string, { result: GroupedModelsResult; ts: number }>();

export function getCachedGroupedModels(providerId: string): GroupedModelsResult | null {
  return getCached(groupedCache, providerId);
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

function groupFallbackModels(providerId: string): GroupedModelsResult {
  const provider = getProvider(providerId);
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
  return { subProviders, modelsByProvider: grouped };
}

export async function fetchGroupedModels(providerId: string): Promise<GroupedModelsResult> {
  const entry = groupedCache.get(providerId);
  if (entry && Date.now() - entry.ts <= MODEL_CACHE_TTL) return entry.result;

  if (providerId === "vercel_gateway") return fetchVercelGatewayGrouped();
  if (providerId === "llmgateway") return fetchLLMGatewayGrouped();
  if (providerId === "proxy") return fetchProxyGrouped();
  if (providerId === "openrouter") return fetchOpenRouterGrouped();

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
  if (!getProviderApiKey("AI_GATEWAY_API_KEY")) {
    return {
      subProviders: [],
      modelsByProvider: {},
      error: "AI_GATEWAY_API_KEY not set",
    };
  }

  try {
    const apiKey = getProviderApiKey("AI_GATEWAY_API_KEY");
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
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
    const msg = toErrorMessage(err);
    return {
      subProviders: [],
      modelsByProvider: {},
      error: `Gateway error: ${msg}`,
    };
  }
}

async function fetchLLMGatewayGrouped(): Promise<GroupedModelsResult> {
  const apiKey = getProviderApiKey("LLM_GATEWAY_API_KEY");
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
    const msg = toErrorMessage(err);
    return { ...groupFallbackModels("llmgateway"), error: `LLM Gateway: ${msg}` };
  }
}

async function fetchOpenRouterGrouped(): Promise<GroupedModelsResult> {
  const apiKey = getProviderApiKey("OPENROUTER_API_KEY");
  if (!apiKey) {
    return groupFallbackModels("openrouter");
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return {
        ...groupFallbackModels("openrouter"),
        error: `OpenRouter error: ${String(res.status)}`,
      };
    }

    const data = (await res.json()) as { data: OpenRouterModel[] };
    // Cache for context-window lookups
    openRouterCache = data.data;

    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      // model IDs are "provider/model-name"
      const slashIdx = m.id.indexOf("/");
      const group = slashIdx >= 0 ? m.id.slice(0, slashIdx).toLowerCase() : "other";
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push({
        id: m.id,
        name: m.name.replace(/^[^:]+:\s*/, ""),
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
    groupedCache.set("openrouter", { result, ts: Date.now() });
    return result;
  } catch (err) {
    const msg = toErrorMessage(err);
    return { ...groupFallbackModels("openrouter"), error: `OpenRouter: ${msg}` };
  }
}

async function fetchProxyGrouped(): Promise<GroupedModelsResult> {
  const baseURL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
  const apiKey = process.env.PROXY_API_KEY || "soulforge";

  const proxyStatus = await ensureProxy();
  if (!proxyStatus.ok) {
    return { ...groupFallbackModels("proxy"), error: proxyStatus.error };
  }

  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Proxy API ${String(res.status)}`);

    const data = (await res.json()) as {
      data: (OpenAIModelEntry & { context_length?: number })[];
    };

    // Tier 1: context windows from proxy /models response
    // Tier 2: Anthropic API + OpenRouter catalog (parallel fetch)
    const [anthropicCtx] = await Promise.all([
      fetchAnthropicContextWindows(),
      fetchOpenRouterMetadata(),
    ]);

    const grouped: Record<string, ProviderModelInfo[]> = {};

    for (const m of data.data) {
      const group = inferModelGroup(m.id);
      if (!grouped[group]) grouped[group] = [];

      // Tier 1: proxy response, Tier 2: Anthropic API / OpenRouter, Tier 3: hardcoded (via caller)
      const ctxWindow =
        m.context_length ?? anthropicCtx.get(m.id) ?? findOpenRouterModel(m.id)?.context_length;

      grouped[group].push({
        id: m.id,
        name: m.id,
        contextWindow: ctxWindow,
      });
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
    return { ...groupFallbackModels("proxy"), error: "Proxy not running — showing defaults" };
  }
}
