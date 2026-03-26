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

export interface ProviderModelsState {
  items: ProviderModelInfo[];
  loading: boolean;
}

export interface UseAllProviderModelsReturn {
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
  const [providerData, setProviderData] = useState<Record<string, ProviderModelsState>>({});
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

    const init: Record<string, ProviderModelsState> = {};
    for (const c of PROVIDER_CONFIGS) init[c.id] = { items: [], loading: true };
    setProviderData(init);

    checkProviders()
      .then((statuses) => {
        if (dead) return;
        const map = new Map<string, boolean>();
        for (const s of statuses) map.set(s.id, s.available);
        setAvailability(map);
      })
      .catch(() => {});

    let dead = false;

    for (const cfg of PROVIDER_CONFIGS) {
      const set = (items: ProviderModelInfo[]) => {
        if (!dead) setProviderData((p) => ({ ...p, [cfg.id]: { items, loading: false } }));
      };
      const fail = () => set([]);

      if (cfg.grouped) {
        const cached = getCachedGroupedModels(cfg.id);
        if (cached) {
          set(flattenGrouped(cached));
          continue;
        }
        fetchGroupedModels(cfg.id)
          .then((r) => set(flattenGrouped(r)))
          .catch(fail);
      } else {
        const cached = getCachedModels(cfg.id);
        if (cached) {
          set(cached);
          continue;
        }
        fetchProviderModels(cfg.id)
          .then((r) => set(r.models))
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
