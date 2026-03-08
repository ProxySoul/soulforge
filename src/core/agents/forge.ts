import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import type { EditorIntegration, ForgeMode, InteractiveCallbacks } from "../../types/index.js";
import type { ContextManager } from "../context/manager.js";
import { buildInteractiveTools, buildTools, RESTRICTED_TOOL_NAMES } from "../tools/index.js";
import { repairToolCall, sanitizeToolInputsStep, smoothStreamOptions } from "./stream-options.js";
import { buildSubagentTools, type SharedCacheRef } from "./subagent-tools.js";

const RESTRICTED_MODES = new Set<ForgeMode>(["architect", "socratic", "challenge"]);

interface ForgeAgentOptions {
  model: LanguageModel;
  contextManager: ContextManager;
  forgeMode?: ForgeMode;
  interactive?: InteractiveCallbacks;
  editorIntegration?: EditorIntegration;
  subagentModels?: { exploration?: LanguageModel; coding?: LanguageModel };
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  codeExecution?: boolean;
  cwd?: string;
  sessionId?: string;
  sharedCacheRef?: SharedCacheRef;
}

/**
 * Creates the main Forge ToolLoopAgent.
 * Factory function (not singleton) — model can change between turns (Ctrl+L).
 * Combines direct tools + subagent tools + optional interactive tools.
 *
 * For restricted modes (architect, socratic, challenge), activeTools limits
 * to read-only tools — the LLM physically cannot call edit/shell/git.
 *
 * Uses prepareCall for auto-recall: user message passed via callOptionsSchema
 * at .stream() time, memory search injected into instructions dynamically.
 */
export function createForgeAgent({
  model,
  contextManager,
  forgeMode = "default",
  interactive,
  editorIntegration,
  subagentModels,
  webSearchModel,
  onApproveWebSearch,
  providerOptions,
  headers,
  codeExecution,
  cwd,
  sessionId,
  sharedCacheRef,
}: ForgeAgentOptions) {
  const isRestricted = RESTRICTED_MODES.has(forgeMode);
  const repoMap = contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;

  const directTools = buildTools(undefined, editorIntegration, onApproveWebSearch, {
    codeExecution,
    webSearchModel,
    repoMap,
  });

  const repoMapContext = contextManager.isRepoMapReady()
    ? contextManager.renderRepoMap() || undefined
    : undefined;

  const subagentTools = isRestricted
    ? {
        dispatch: buildSubagentTools({
          defaultModel: model,
          explorationModel: subagentModels?.exploration,
          webSearchModel,
          providerOptions,
          headers,
          onApproveWebSearch,
          readOnly: true,
          repoMapContext,
          repoMap,
          sharedCacheRef,
        }).dispatch,
      }
    : buildSubagentTools({
        defaultModel: model,
        explorationModel: subagentModels?.exploration,
        codingModel: subagentModels?.coding,
        webSearchModel,
        providerOptions,
        headers,
        onApproveWebSearch,
        repoMapContext,
        repoMap,
        sharedCacheRef,
      });

  const allTools = {
    ...directTools,
    ...subagentTools,
    ...(interactive ? buildInteractiveTools(interactive, { cwd, sessionId }) : {}),
  };

  const allToolNames = Object.keys(allTools) as (keyof typeof allTools)[];
  const restrictedSet = new Set(RESTRICTED_TOOL_NAMES);
  const restrictedActiveTools = isRestricted
    ? allToolNames.filter((name) => restrictedSet.has(name))
    : undefined;

  return new ToolLoopAgent({
    id: "forge",
    model,
    ...smoothStreamOptions,
    tools: allTools,
    callOptionsSchema: z.object({
      userMessage: z.string().optional(),
    }),
    instructions: {
      role: "system" as const,
      content: contextManager.buildSystemPrompt(),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    prepareCall: ({ options, ...settings }) => {
      const recalled = options?.userMessage
        ? contextManager.getMemoryManager().autoRecall(options.userMessage)
        : null;

      return {
        ...settings,
        ...(recalled
          ? {
              instructions: `${settings.instructions}\n\n### Auto-Recalled Memories (matching this message)\n${recalled}`,
            }
          : {}),
        ...(restrictedActiveTools ? { activeTools: restrictedActiveTools } : {}),
      };
    },
    stopWhen: stepCountIs(500),
    prepareStep: sanitizeToolInputsStep,
    experimental_repairToolCall: repairToolCall,
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(headers ? { headers } : {}),
  });
}
