import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

export function codeBase(hasPreloadedFiles: boolean): string {
  if (hasPreloadedFiles) {
    return `Code agent. Make specific edits. Target files and changes are in the task.

Target file contents are preloaded below and up-to-date. Proceed directly with multi_edit — one call per file.
- Use the preloaded line numbers for lineStart in your edits
- Use read_file only for files not listed in the preloaded section
- On edit failure: re-read once, retry with exact text from that read
- Compound tools: rename_symbol, move_symbol, refactor — do the complete job

OUTPUT: Concise summary of what changed. Name files and modifications.`;
  }
  return `Code agent. Make specific edits. Target files and changes are in the task.

Workflow: read_file → multi_edit → done. 3 steps typical, 5 max.
- Read each target file ONCE in full, plan all changes, apply with multi_edit in ONE call per file
- On edit failure: re-read once, retry with exact text from that read
- Compound tools: rename_symbol, move_symbol, refactor — do the complete job

Skip: re-reading to verify, exploring unrelated files, grepping when you have target paths. Use multi_edit for same-file changes.

OUTPUT: Concise summary of what changed. Name files and modifications.`;
}

// No structured output schema — agents return plain text summaries.
// The system tracks edits via bus and extracts tool results deterministically.

interface CodeAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  parentToolCallId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: import("../workers/intelligence-client.js").IntelligenceClient;
  contextWindow?: number;
  disablePruning?: boolean;
  tabId?: string;
  hasPreloadedFiles?: boolean;
  forgeInstructions?: string;
  /** Forge tool definitions with role guards — use instead of buildSubagentCodeTools for cache prefix hits. */
  forgeTools?: Record<string, unknown>;
}

export function createCodeAgent(model: LanguageModel, options?: CodeAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus ? buildBusTools(bus, agentId, "code") : {};

  // miniForge mode: use forge's tool definitions (with role guards) for cache prefix hits.
  // Regular mode: build code-specific tools.
  let allTools: Record<string, unknown>;
  if (options?.forgeTools) {
    allTools = { ...options.forgeTools, ...busTools };
  } else {
    let tools = buildSubagentCodeTools({
      webSearchModel: options?.webSearchModel,
      onApproveWebSearch: options?.onApproveWebSearch,
      onApproveFetchPage: options?.onApproveFetchPage,
      repoMap: options?.repoMap,
    });
    if (hasBus) {
      tools = wrapWithBusCache(tools, bus, agentId, options?.repoMap) as typeof tools;
    }
    allTools = { ...tools, ...busTools };
  }

  const { prepareStep, stopConditions } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "code",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
    disablePruning: options?.disablePruning,
    tabId: options?.tabId,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "code",
    model,
    temperature: 0,
    // biome-ignore lint/suspicious/noExplicitAny: forgeTools come as Record<string, unknown> for cache sharing
    tools: allTools as any,
    instructions: {
      role: "system" as const,
      content: options?.forgeInstructions
        ? options.forgeInstructions
        : (() => {
            const base = codeBase(options?.hasPreloadedFiles ?? false);
            return hasBus
              ? `${base}\nOwnership: you own files you edit first. check_edit_conflicts before touching another agent's file.\nIf another agent owns the file: report_finding with the exact edit instead.\nCoordination: report_finding after significant changes (paths, what changed, new exports). Peer findings appear in tool results.`
              : base;
          })(),
      providerOptions: EPHEMERAL_CACHE,
    },
    stopWhen: stopConditions,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    providerOptions: {
      ...options?.providerOptions,
      anthropic: {
        ...(((options?.providerOptions as Record<string, unknown>)?.anthropic as Record<
          string,
          unknown
        >) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    } as ProviderOptions,
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
