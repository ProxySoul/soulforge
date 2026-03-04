import { useEffect, useState } from "react";
import {
  fetchGroupedModels,
  getCachedGroupedModels,
  type ProviderModelInfo,
  type SubProvider,
} from "../core/llm/models.js";

interface UseGroupedModelsReturn {
  subProviders: SubProvider[];
  modelsByProvider: Record<string, ProviderModelInfo[]>;
  loading: boolean;
  error?: string;
}

export function useGroupedModels(providerId: string | null): UseGroupedModelsReturn {
  const [subProviders, setSubProviders] = useState<SubProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ProviderModelInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!providerId) {
      setSubProviders([]);
      setModelsByProvider({});
      setLoading(false);
      setError(undefined);
      return;
    }

    const cached = getCachedGroupedModels(providerId);
    if (cached) {
      setSubProviders(cached.subProviders);
      setModelsByProvider(cached.modelsByProvider);
      setLoading(false);
      setError(cached.error);
      return;
    }

    setLoading(true);
    setError(undefined);
    let cancelled = false;

    fetchGroupedModels(providerId).then((result) => {
      if (!cancelled) {
        setSubProviders(result.subProviders);
        setModelsByProvider(result.modelsByProvider);
        setError(result.error);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [providerId]);

  return { subProviders, modelsByProvider, loading, error };
}
