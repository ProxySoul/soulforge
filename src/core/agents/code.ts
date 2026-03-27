import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function codeBase(): string {
  return `Code agent. Make specific edits. Target files and changes are in the task.

Workflow: read_file → multi_edit → done. 3 steps typical, 5 max.
- Read each target file ONCE in full, plan all changes, apply with multi_edit in ONE call per file
- On edit failure: re-read once, retry with exact text from that read
- Compound tools: rename_symbol, move_symbol, refactor — do the complete job

Do NOT: re-read to verify, explore unrelated files, grep when you have target paths, use sequential edit_file on the same file.

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
}

export function createCodeAgent(model: LanguageModel, options?: CodeAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus ? buildBusTools(bus, agentId, "code") : {};

  let tools = buildSubagentCodeTools({
    webSearchModel: options?.webSearchModel,
    onApproveWebSearch: options?.onApproveWebSearch,
    onApproveFetchPage: options?.onApproveFetchPage,
    repoMap: options?.repoMap,
  });
  if (hasBus) {
    tools = wrapWithBusCache(tools, bus, agentId, options?.repoMap) as typeof tools;
  }

  const allTools = {
    ...tools,
    ...busTools,
  };

  const { prepareStep, stopConditions } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "code",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
    disablePruning: options?.disablePruning,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "code",
    model,
    temperature: 0,
    tools: allTools,
    instructions: {
      role: "system" as const,
      content: (() => {
        const base = codeBase();
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
