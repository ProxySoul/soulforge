import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { loadConfig } from "../../config/index.js";
import { EPHEMERAL_CACHE, getModelId, supportsTemperature } from "../llm/provider-options.js";
import { resolveRetrySettings } from "../retry/settings.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

export function codeBase(): string {
  return `RULES (non-negotiable):
1. You are a code agent. Make specific edits to target files.
2. Do NOT emit text between tool calls. Call tools silently, then report ONCE at the end.
3. Do NOT re-read files you already have in context. One read per file, ever.
4. Do NOT explore beyond your target files. Your scope is defined in the task.
5. Keep your report under 300 words. Name files and what changed.
6. Each tool call round-trip resends the full conversation — batch aggressively, minimize steps.

READING — surgical, not full files:
- Use ranges when the task gives line numbers: read(files=[{path:'x.ts', ranges:[{start:45,end:80}]}])
- Read full file only when you need the complete picture for a refactor or when the file is under 200 lines.
- Batch all reads in ONE call: read(files=[{path:'a.ts', ranges:[...]}, {path:'b.ts', ranges:[...]}])

EDITING — precise and anchored:
- Use multi_edit for multiple changes in the same file — ONE call per file.
- Provide lineStart from your read output on every edit — line-anchored matching is the most reliable method.
- On edit failure: re-read the failing region once, retry with exact text from that read.
- Compound tools: rename_symbol, move_symbol, refactor — do the complete job in one call.

WORKFLOW: read → edit → done. 3 steps typical, 5 max.

SKIP: re-reading to verify, exploring unrelated files, grepping when you have target paths.`;
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
  forgeInstructions?: string;
  /** Forge tool definitions with role guards — use instead of buildSubagentCodeTools for spark cache prefix hits. */
  forgeTools?: Record<string, unknown>;
  /** Skip bus coordination tools — for solo agents like desloppify. */
  skipBusTools?: boolean;
}

export function createCodeAgent(model: LanguageModel, options?: CodeAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus && !options?.skipBusTools ? buildBusTools(bus, agentId, "code") : {};

  // Spark mode: use forge's tool definitions (with role guards) for cache prefix hits.
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

  const { maxRetries: retryMaxRetries } = resolveRetrySettings(loadConfig().retry, {
    agent: true,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "code",
    model,
    maxRetries: retryMaxRetries,
    ...(supportsTemperature(getModelId(model)) ? { temperature: 0 } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: forgeTools come as Record<string, unknown> for cache sharing
    tools: allTools as any,
    instructions: {
      role: "system" as const,
      content: options?.forgeInstructions
        ? options.forgeInstructions
        : (() => {
            const base = codeBase();
            if (!hasBus || options?.skipBusTools) return base;
            return `${base}\nOwnership: you own files you edit first. check_edit_conflicts before touching another agent's file.\nIf another agent owns the file: report_finding with the exact edit instead.\nCoordination: report_finding after significant changes (paths, what changed, new exports). Peer findings appear in tool results.`;
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
