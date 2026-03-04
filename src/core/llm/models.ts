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
export type GatewaySubProvider = SubProvider;

export interface GroupedModelsResult {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  error?: string;
}

// Backward-compat alias
export type GatewayModelsResult = GroupedModelsResult;

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

/**
 * Get the context window size (in tokens) for a model ID.
 * Checks cached API data first, then falls back to provider-defined patterns.
 * Accepts full "provider/model" format or just the model part.
 * Pattern order matters — specific patterns must come before general ones.
 */
export function getModelContextWindow(modelId: string): number {
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx >= 0 ? modelId.slice(0, slashIdx) : "";
  const model = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Check cached API data (most accurate — comes from the provider)
  if (providerId && !getProvider(providerId)?.grouped) {
    const cached = modelCache.get(providerId);
    if (cached) {
      const match = cached.find((m) => m.id === model);
      if (match?.contextWindow) return match.contextWindow;
    }
  }
  // Check grouped provider caches (gateway, proxy, etc.)
  if (providerId) {
    const grouped = groupedCache.get(providerId);
    if (grouped) {
      for (const models of Object.values(grouped.modelsByProvider)) {
        const match = models.find((m) => m.id === model || modelId.endsWith(m.id));
        if (match?.contextWindow) return match.contextWindow;
      }
    }
  }

  // 2. Fallback to provider-defined context window patterns
  for (const provider of getAllProviders()) {
    for (const [pattern, tokens] of provider.contextWindows) {
      if (model.includes(pattern)) return tokens;
    }
  }
  return DEFAULT_CONTEXT_TOKENS;
}

// ─── Cache ───

const modelCache = new Map<string, ProviderModelInfo[]>();

export function getCachedModels(providerId: string): ProviderModelInfo[] | null {
  return modelCache.get(providerId) ?? null;
}

// ─── Public API ───

export async function fetchProviderModels(providerId: string): Promise<FetchModelsResult> {
  // Check cache first
  const cached = modelCache.get(providerId);
  if (cached) return { models: cached };

  const provider = getProvider(providerId);
  if (!provider) return { models: [] };

  try {
    const models = await provider.fetchModels();
    if (models) {
      modelCache.set(providerId, models);
      return { models };
    }
    return { models: provider.fallbackModels };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { models: provider.fallbackModels, error: `API error: ${msg}` };
  }
}

// ─── Grouped Models (Gateway, Proxy, etc.) ───

interface OpenAIModelEntry {
  id: string;
  owned_by?: string;
  name?: string;
  type?: string;
}

const groupedCache = new Map<string, GroupedModelsResult>();

export function getCachedGroupedModels(providerId: string): GroupedModelsResult | null {
  return groupedCache.get(providerId) ?? null;
}

// Backward-compat wrapper
export function getCachedGatewayModels(): GroupedModelsResult | null {
  return groupedCache.get("gateway") ?? null;
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
  const cached = groupedCache.get(providerId);
  if (cached) return cached;

  if (providerId === "gateway") return fetchGatewayGrouped();
  if (providerId === "proxy") return fetchProxyGrouped();

  return {
    subProviders: [],
    modelsByProvider: {},
    error: `Unknown grouped provider: ${providerId}`,
  };
}

// Backward-compat wrapper
export async function fetchGatewayModels(): Promise<GroupedModelsResult> {
  return fetchGroupedModels("gateway");
}

async function fetchGatewayGrouped(): Promise<GroupedModelsResult> {
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
    groupedCache.set("gateway", result);
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
    groupedCache.set("proxy", result);
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
