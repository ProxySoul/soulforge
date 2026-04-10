import { describe, expect, test } from "bun:test";
import {
  applyModelReasoningOverride,
  resolveProviderReasoningTarget,
} from "../src/core/llm/providers/reasoning-overrides.js";
import type { CustomProviderConfig } from "../src/core/llm/providers/types.js";

describe("reasoning overrides helpers", () => {
  test("prefers project provider target over global", () => {
    const globalProviders: CustomProviderConfig[] = [
      { id: "ollama-cloud", baseURL: "https://ollama.com/v1" },
    ];
    const projectProviders: CustomProviderConfig[] = [
      { id: "ollama-cloud", baseURL: "https://ollama.com/v1" },
    ];

    const target = resolveProviderReasoningTarget(
      "ollama-cloud",
      globalProviders,
      projectProviders,
    );

    expect(target).toEqual({ scope: "project", providers: projectProviders });
  });

  test("falls back to global provider target when project has none", () => {
    const globalProviders: CustomProviderConfig[] = [
      { id: "qwen-local", baseURL: "http://localhost:8080/v1" },
    ];

    const target = resolveProviderReasoningTarget("qwen-local", globalProviders, []);

    expect(target).toEqual({ scope: "global", providers: globalProviders });
  });

  test("updates existing model override in provider models array", () => {
    const providers: CustomProviderConfig[] = [
      {
        id: "ollama-cloud",
        baseURL: "https://ollama.com/v1",
        models: [{ id: "glm-5.1", name: "GLM-5.1" }],
      },
    ];

    const updated = applyModelReasoningOverride(providers, "ollama-cloud", "glm-5.1", {
      effort: "high",
    });

    const model = updated[0]?.models?.[0];
    expect(typeof model).toBe("object");
    expect(model).toMatchObject({
      id: "glm-5.1",
      name: "GLM-5.1",
      reasoning: { effort: "high" },
    });
  });

  test("adds model object when provider exists but model entry is missing", () => {
    const providers: CustomProviderConfig[] = [
      {
        id: "qwen-local",
        baseURL: "http://localhost:8080/v1",
        models: [],
      },
    ];

    const updated = applyModelReasoningOverride(
      providers,
      "qwen-local",
      "qwen3.6-plus",
      { enabled: true, budget: 4096 },
      { name: "Qwen 3.6 Plus", contextWindow: 256000 },
    );

    expect(updated[0]?.models).toEqual([
      {
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        contextWindow: 256000,
        reasoning: { enabled: true, budget: 4096 },
      },
    ]);
  });

  test("removes model reasoning override while preserving string entries", () => {
    const providers: CustomProviderConfig[] = [
      {
        id: "ollama-cloud",
        baseURL: "https://ollama.com/v1",
        models: [
          "qwen3-next:80b",
          { id: "glm-5.1", name: "GLM-5.1", reasoning: { effort: "medium" } },
        ],
      },
    ];

    const updated = applyModelReasoningOverride(providers, "ollama-cloud", "glm-5.1", null);

    expect(updated[0]?.models).toEqual([
      "qwen3-next:80b",
      { id: "glm-5.1", name: "GLM-5.1" },
    ]);
  });
});
