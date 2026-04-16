import type { ConfigScope } from "../../../components/layout/shared.js";
import type { CustomProviderConfig, CustomReasoningConfig, ProviderModelInfo } from "./types.js";

export interface ResolvedReasoningTarget {
  scope: ConfigScope;
  providers: CustomProviderConfig[];
}

export function resolveProviderReasoningTarget(
  providerId: string,
  globalProviders: CustomProviderConfig[],
  projectProviders: CustomProviderConfig[],
): ResolvedReasoningTarget | null {
  if (projectProviders.some((p) => p.id === providerId)) {
    return { scope: "project", providers: projectProviders };
  }
  if (globalProviders.some((p) => p.id === providerId)) {
    return { scope: "global", providers: globalProviders };
  }
  return null;
}

export function applyModelReasoningOverride(
  providers: CustomProviderConfig[],
  providerId: string,
  modelId: string,
  reasoning: CustomReasoningConfig | null,
  fallbackModel?: Pick<ProviderModelInfo, "name" | "contextWindow">,
): CustomProviderConfig[] {
  return providers.map((p) => {
    if (p.id !== providerId) return p;

    let found = false;
    const models: (string | ProviderModelInfo)[] = (p.models ?? []).map((m) => {
      const info: ProviderModelInfo = typeof m === "string" ? { id: m, name: m } : { ...m };
      if (info.id !== modelId) return m;

      found = true;
      if (reasoning) {
        return { ...info, reasoning };
      }

      if (typeof m === "string") return m;
      const { reasoning: _drop, ...rest } = info;
      return rest;
    });

    if (!found && reasoning) {
      const addedModel: ProviderModelInfo = {
        id: modelId,
        name: fallbackModel?.name ?? modelId,
        ...(fallbackModel?.contextWindow ? { contextWindow: fallbackModel.contextWindow } : {}),
        reasoning,
      };
      models.push(addedModel);
    }

    return { ...p, models };
  });
}
