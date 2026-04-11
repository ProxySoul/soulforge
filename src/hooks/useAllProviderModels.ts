import { useEffect, useMemo, useState } from "react";
import {
  fetchGroupedModels,
  fetchProviderModels,
  getCachedGroupedModels,
  getCachedModels,
  PROVIDER_CONFIGS,
  type ProviderModelInfo,
} from "../core/llm/models.js";
import { checkProviders, getCachedProviderStatuses } from "../core/llm/provider.js";
import { hasSecret, type SecretKey } from "../core/secrets.js";

const ENV_SK: Record<string, SecretKey> = {
  ANTHROPIC_API_KEY: "anthropic-api-key",
  OPENAI_API_KEY: "openai-api-key",
  GOOGLE_GENERATIVE_AI_API_KEY: "google-api-key",
  XAI_API_KEY: "xai-api-key",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLM_GATEWAY_API_KEY: "llmgateway-api-key",
  AI_GATEWAY_API_KEY: "vercel-gateway-api-key",
};

interface ProviderModelsState {
  items: ProviderModelInfo[];
  loading: boolean;
  error?: string;
}

interface UseAllProviderModelsReturn {
  providerData: Record<string, ProviderModelsState>;
  availability: Map<string, boolean>;
  anyLoading: boolean;
}

function flattenGrouped(r: {
  subProviders: { id: string }[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
}): ProviderModelInfo[] {
  const out: ProviderModelInfo[] = [];
  for (const s of r.subProviders) for (const m of r.modelsByProvider[s.id] ?? []) out.push(m);
  return out;
}

export function useAllProviderModels(active: boolean): UseAllProviderModelsReturn {
  const [providerData, setProviderData] = useState<Record<string, ProviderModelsState>>(() => {
    // Initialize from cache immediately — prewarmAllModels() populates these at boot
    const init: Record<string, ProviderModelsState> = {};
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) {
        const cached = getCachedGroupedModels(cfg.id);
        init[cfg.id] = cached
          ? { items: flattenGrouped(cached), loading: false }
          : { items: [], loading: true };
      } else {
        const cached = getCachedModels(cfg.id);
        init[cfg.id] = cached ? { items: cached, loading: false } : { items: [], loading: true };
      }
    }
    return init;
  });
  const [availability, setAvailability] = useState<Map<string, boolean>>(() => {
    const cached = getCachedProviderStatuses();
    const map = new Map<string, boolean>();
    if (cached) {
      for (const s of cached) map.set(s.id, s.available);
    } else {
      for (const cfg of PROVIDER_CONFIGS) {
        const sk = cfg.envVar ? ENV_SK[cfg.envVar] : null;
        map.set(cfg.id, sk ? hasSecret(sk).set : true);
      }
    }
    return map;
  });

  useEffect(() => {
    if (!active) return;

    // Re-read caches — prewarmAllModels() may have populated them since initial state
    const init: Record<string, ProviderModelsState> = {};
    let anyStale = false;
    for (const cfg of PROVIDER_CONFIGS) {
      if (cfg.grouped) {
        const cached = getCachedGroupedModels(cfg.id);
        init[cfg.id] = cached
          ? { items: flattenGrouped(cached), loading: false }
          : { items: [], loading: true };
      } else {
        const cached = getCachedModels(cfg.id);
        init[cfg.id] = cached ? { items: cached, loading: false } : { items: [], loading: true };
      }
      if (init[cfg.id]?.loading) anyStale = true;
    }

    // Only trigger a re-render if the fresh cache differs from current state.
    // Checks loading/error flags (value comparison) and items (reference
    // comparison — cache returns the same array object on re-read).
    setProviderData((prev) => {
      const initKeys = Object.keys(init);
      const prevKeys = Object.keys(prev);
      if (initKeys.length !== prevKeys.length) return init;
      // Detect replaced keys: same length but different key set
      for (const k of prevKeys) {
        if (!(k in init)) return init;
      }
      for (const k of initKeys) {
        const a = prev[k];
        const b = init[k];
        if (!a || !b || a.loading !== b.loading || a.items !== b.items || a.error !== b.error) {
          return init;
        }
      }
      return prev;
    });

    // Re-sync availability from the global cache (cheap map read).
    // If checkProviders() ran elsewhere (auth flow, config reload) the
    // global cache was updated but our local state wasn't.
    const cachedStatuses = getCachedProviderStatuses();
    if (cachedStatuses) {
      const map = new Map<string, boolean>();
      for (const s of cachedStatuses) map.set(s.id, s.available);
      setAvailability(map);
    }

    let dead = false;

    // Refresh availability in the background even when cache exists.
    // This keeps local providers (e.g. Ollama/LM Studio) from staying stale.
    checkProviders()
      .then((statuses) => {
        if (dead) return;
        const map = new Map<string, boolean>();
        for (const s of statuses) map.set(s.id, s.available);
        setAvailability(map);
      })
      .catch(() => undefined);

    // If everything is cached, no need to fetch models
    if (!anyStale) {
      return () => {
        dead = true;
      };
    }

    // Only fetch providers that aren't cached yet
    for (const cfg of PROVIDER_CONFIGS) {
      if (!init[cfg.id]?.loading) continue;
      const set = (items: ProviderModelInfo[], error?: string) => {
        if (!dead) setProviderData((p) => ({ ...p, [cfg.id]: { items, loading: false, error } }));
      };
      const fail = () => set([]);

      if (cfg.grouped) {
        fetchGroupedModels(cfg.id)
          .then((r) => set(flattenGrouped(r), r.error))
          .catch(fail);
      } else {
        fetchProviderModels(cfg.id)
          .then((r) => set(r.models, r.error))
          .catch(fail);
      }
    }

    return () => {
      dead = true;
    };
  }, [active]);

  const anyLoading = useMemo(
    () => Object.values(providerData).some((p) => p.loading),
    [providerData],
  );

  return { providerData, availability, anyLoading };
}
