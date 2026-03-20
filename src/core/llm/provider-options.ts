import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AppConfig, ContextManagementConfig } from "../../types/index.js";
import { getModelContextWindow } from "./models.js";
import type { TaskType } from "./task-router.js";

interface ModelCapabilities {
  provider: "anthropic" | "openai" | "google" | "other";
  thinking: boolean;
  adaptiveThinking: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  interleavedThinking: boolean;
  openaiReasoning: boolean;
  openaiServiceTier: boolean;
}

interface ProviderConstraints {
  anthropicOptions: boolean;
  openaiOptions: boolean;
  effort: boolean;
  speed: boolean;
  contextManagement: boolean;
  adaptiveThinking: boolean;
  interleavedThinking: boolean;
}

const ANTHROPIC_FULL: ProviderConstraints = {
  anthropicOptions: true,
  openaiOptions: false,
  effort: true,
  speed: true,
  contextManagement: true,
  adaptiveThinking: true,
  interleavedThinking: true,
};

const OPENAI_FULL: ProviderConstraints = {
  anthropicOptions: false,
  openaiOptions: true,
  effort: false,
  speed: false,
  contextManagement: false,
  adaptiveThinking: false,
  interleavedThinking: false,
};

const GATEWAY_FULL: ProviderConstraints = {
  anthropicOptions: true,
  openaiOptions: true,
  effort: true,
  speed: true,
  contextManagement: true,
  adaptiveThinking: true,
  interleavedThinking: true,
};

const PROVIDER_CONSTRAINTS: Record<string, ProviderConstraints> = {
  anthropic: ANTHROPIC_FULL,
  proxy: ANTHROPIC_FULL,
  openai: OPENAI_FULL,
  xai: OPENAI_FULL,
  vercel_gateway: GATEWAY_FULL,
  llmgateway: GATEWAY_FULL,
  openrouter: GATEWAY_FULL,
};

const NO_SUPPORT: ProviderConstraints = {
  anthropicOptions: false,
  openaiOptions: false,
  effort: false,
  speed: false,
  contextManagement: false,
  adaptiveThinking: false,
  interleavedThinking: false,
};

function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "", model: modelId };
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

function extractBaseModel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

type ClaudeGen = "legacy" | "3.5" | "4+" | "non-claude";

const LEGACY_PREFIXES = [
  "claude-3-haiku",
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3.0",
  "claude-2",
  "claude-instant",
];

function getClaudeGen(model: string): ClaudeGen {
  if (!model.startsWith("claude")) return "non-claude";
  for (const p of LEGACY_PREFIXES) {
    if (model.startsWith(p)) return "legacy";
  }
  if (model.startsWith("claude-3.5") || model.startsWith("claude-3-5")) return "3.5";
  return "4+";
}

//
// For direct providers (anthropic/, openai/), the provider prefix tells us everything.
// For gateways (llmgateway/, openrouter/, vercel_gateway/), we inspect the model name
// to determine the underlying provider family.

type ModelFamily = "claude" | "openai" | "google" | "other";

function detectModelFamily(modelId: string): ModelFamily {
  const { provider } = parseModelId(modelId);

  // Direct providers — no guessing needed
  if (provider === "anthropic" || provider === "proxy") return "claude";
  if (provider === "openai" || provider === "xai") return "openai";
  if (provider === "google") return "google";

  // Gateways — inspect model name for the underlying provider
  const base = extractBaseModel(modelId);
  if (base.startsWith("claude")) return "claude";
  if (
    base.startsWith("gpt-") ||
    base.startsWith("o1") ||
    base.startsWith("o3") ||
    base.startsWith("o4")
  )
    return "openai";
  if (base.startsWith("gemini")) return "google";

  // OpenRouter nested paths like "anthropic/claude-*" or "openai/gpt-*"
  const model = parseModelId(modelId).model;
  if (model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("openai/")) return "openai";
  if (model.startsWith("google/")) return "google";

  return "other";
}

function getModelCapabilities(modelId: string): ModelCapabilities {
  const base = extractBaseModel(modelId);
  const family = detectModelFamily(modelId);

  if (family === "openai") {
    // Reasoning models: o1, o3, o4, gpt-5+
    const isReasoning =
      base.startsWith("o1") ||
      base.startsWith("o3") ||
      base.startsWith("o4") ||
      base.startsWith("gpt-5");
    return {
      provider: "openai",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: isReasoning,
      openaiServiceTier: true,
    };
  }

  if (family === "google") {
    return {
      provider: "google",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  if (family !== "claude") {
    return {
      provider: "other",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  // Claude models — generation-based capabilities
  const gen = getClaudeGen(base);

  if (gen === "legacy") {
    return {
      provider: "anthropic",
      thinking: false,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  if (gen === "3.5") {
    return {
      provider: "anthropic",
      thinking: true,
      adaptiveThinking: false,
      effort: false,
      speed: false,
      contextManagement: false,
      interleavedThinking: false,
      openaiReasoning: false,
      openaiServiceTier: false,
    };
  }

  return {
    provider: "anthropic",
    thinking: true,
    adaptiveThinking: true,
    effort: true,
    speed: base.includes("opus"),
    contextManagement: true,
    interleavedThinking: true,
    openaiReasoning: false,
    openaiServiceTier: false,
  };
}

function getProviderConstraints(providerId: string): ProviderConstraints {
  if (!providerId) return NO_SUPPORT;

  const exact = PROVIDER_CONSTRAINTS[providerId];
  if (exact) return exact;

  // Vercel Gateway with Claude models gets Anthropic-level support
  if (providerId === "vercel_gateway") return PROVIDER_CONSTRAINTS.anthropic as ProviderConstraints;

  return NO_SUPPORT;
}

interface EffectiveCaps extends ModelCapabilities {
  anthropicOptions: boolean;
  openaiOptions: boolean;
}

function getEffectiveCaps(modelId: string): EffectiveCaps {
  const model = getModelCapabilities(modelId);
  const { provider } = parseModelId(modelId);
  const pc = getProviderConstraints(provider);
  const family = detectModelFamily(modelId);

  return {
    ...model,
    anthropicOptions: pc.anthropicOptions && family === "claude",
    openaiOptions: pc.openaiOptions && family === "openai",
    adaptiveThinking: model.adaptiveThinking && pc.adaptiveThinking,
    effort: model.effort && pc.effort,
    speed: model.speed && pc.speed,
    contextManagement: model.contextManagement && pc.contextManagement,
    interleavedThinking: model.interleavedThinking && pc.interleavedThinking,
  };
}

export function isAnthropicNative(modelId: string): boolean {
  const { provider } = parseModelId(modelId);
  return provider === "anthropic" || provider === "proxy";
}

function supportsAnthropicOptions(modelId: string): boolean {
  return getEffectiveCaps(modelId).anthropicOptions;
}

const TASK_EFFORT: Record<TaskType, string> = {
  planning: "max",
  coding: "high",
  exploration: "medium",
  webSearch: "medium",
  compact: "medium",
  default: "high",
};

function resolveEffort(taskType: TaskType, configured?: string): string {
  return configured ?? TASK_EFFORT[taskType];
}

function buildContextEdits(
  config: ContextManagementConfig,
  contextWindow: number,
  thinkingEnabled: boolean,
): unknown[] | null {
  const edits: unknown[] = [];

  if (config.clearThinking && thinkingEnabled) {
    edits.push({
      type: "clear_thinking_20251015",
      keep: { type: "thinking_turns", value: 5 },
    });
  }

  if (config.clearToolUses) {
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 100_000 },
      keep: { type: "tool_uses", value: 10 },
      clearToolInputs: true,
    });
  }

  if (config.compact && contextWindow >= 200_000) {
    edits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: Math.floor(contextWindow * 0.75) },
    });
  }

  return edits.length > 0 ? edits : null;
}

//
// Ephemeral cache breakpoints for prompt caching. Set on all provider keys
// so caching works regardless of which provider routes to Anthropic/Claude.
// The Vercel AI SDK silently ignores keys that don't match the active provider.

const CACHE_EPHEMERAL = { cacheControl: { type: "ephemeral" } } as const;

export const EPHEMERAL_CACHE: ProviderOptions = {
  anthropic: CACHE_EPHEMERAL,
  google: CACHE_EPHEMERAL,
  proxy: CACHE_EPHEMERAL,
  llmgateway: CACHE_EPHEMERAL,
  openrouter: CACHE_EPHEMERAL,
  vercel_gateway: CACHE_EPHEMERAL,
} as ProviderOptions;

export interface ProviderOptionsResult {
  providerOptions: ProviderOptions;
  headers: Record<string, string> | undefined;
}

function buildAnthropicOptions(
  modelId: string,
  caps: EffectiveCaps,
  config: AppConfig,
  taskType?: TaskType,
): { opts: Record<string, unknown>; headers: Record<string, string>; thinkingEnabled: boolean } {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};
  const headers: Record<string, string> = {};
  let thinkingEnabled = false;

  if (caps.thinking) {
    const mode = config.thinking?.mode ?? "off";
    if (mode === "auto" || mode === "adaptive") {
      if (caps.adaptiveThinking) {
        opts.thinking = { type: "adaptive" };
        thinkingEnabled = true;
      }
    } else if (mode === "enabled") {
      opts.thinking = {
        type: "enabled",
        ...(config.thinking?.budgetTokens ? { budgetTokens: config.thinking.budgetTokens } : {}),
      };
      thinkingEnabled = true;
    }
  }

  if (caps.effort && config.performance?.effort && config.performance.effort !== "off") {
    opts.effort = resolveEffort(taskType ?? "default", config.performance.effort);
  }

  // `speed` requires @ai-sdk/anthropic >= 4.x (current 3.x rejects it as unknown field)
  // if (caps.speed && config.performance?.speed && config.performance.speed !== "off") {
  //   opts.speed = config.performance.speed;
  // }

  if (config.performance?.disableParallelToolUse) {
    opts.disableParallelToolUse = true;
  }

  if (config.performance?.sendReasoning === false) {
    opts.sendReasoning = false;
  }

  if (caps.contextManagement && config.contextManagement) {
    const contextWindow = getModelContextWindow(modelId);
    const edits = buildContextEdits(config.contextManagement, contextWindow, thinkingEnabled);
    if (edits) {
      opts.contextManagement = { edits };
    }
  }

  if (thinkingEnabled && caps.interleavedThinking) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  return { opts, headers, thinkingEnabled };
}

function buildOpenAIOptions(
  caps: EffectiveCaps,
  config: AppConfig,
): { opts: Record<string, unknown> } {
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};

  if (caps.openaiReasoning) {
    const effort = config.performance?.openaiReasoningEffort;
    if (effort && effort !== "off") {
      opts.reasoningEffort = effort;
    }
  }

  if (caps.openaiServiceTier) {
    const tier = config.performance?.serviceTier;
    if (tier && tier !== "off") {
      opts.serviceTier = tier;
    }
  }

  if (config.performance?.disableParallelToolUse) {
    opts.parallelToolCalls = false;
  }

  return { opts };
}

export function buildProviderOptions(
  modelId: string,
  config: AppConfig,
  taskType?: TaskType,
): ProviderOptionsResult {
  const caps = getEffectiveCaps(modelId);
  const providerOptions: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  if (caps.anthropicOptions) {
    const result = buildAnthropicOptions(modelId, caps, config, taskType);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.anthropic = result.opts;
    }
    headers = result.headers;
  }

  if (caps.openaiOptions) {
    const result = buildOpenAIOptions(caps, config);
    if (Object.keys(result.opts).length > 0) {
      providerOptions.openai = result.opts;
    }
  }

  return {
    providerOptions: providerOptions as ProviderOptions,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

export function degradeProviderOptions(modelId: string, level: number): ProviderOptionsResult {
  if (level >= 2 || !supportsAnthropicOptions(modelId)) {
    return { providerOptions: {}, headers: undefined };
  }

  const caps = getModelCapabilities(modelId);
  // biome-ignore lint/suspicious/noExplicitAny: ProviderOptions inner shape is parsed by Zod at runtime
  const opts: Record<string, any> = {};

  if (caps.thinking) {
    opts.thinking = { type: "enabled", budgetTokens: 5_000 };
  }

  return {
    providerOptions: { anthropic: opts } as ProviderOptions,
    headers: undefined,
  };
}

export function isProviderOptionsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("not supported") ||
    lower.includes("not available") ||
    lower.includes("does not support") ||
    lower.includes("invalid parameter") ||
    lower.includes("inputschema") ||
    lower.includes("thinking is not supported") ||
    lower.includes("adaptive thinking") ||
    lower.includes("clear_thinking") ||
    lower.includes("context management") ||
    lower.includes("unknown parameter")
  );
}
