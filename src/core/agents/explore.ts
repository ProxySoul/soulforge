import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent } from "ai";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentExploreTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function exploreBase(): string {
  return `Explore agent. Read-only research. Tool results are authoritative.

Use the cheapest tool first:
1. soul_find, soul_grep(count), soul_impact, navigate, analyze — free, instant
2. read_file(target, name) — extract one symbol, not the whole file
3. read_file full, grep — only when 1-2 didn't answer

Workflow:
- Paths given → read_file(target, name) for each
- Keywords only → soul_find or navigate(definition), then read hits
- Data flow → soul_impact + navigate(references)
After reading targets, trace callers via navigate(references). Flag disconnects.

OUTPUT: Concise text summary with file names, line numbers, exact values. Your text is the only thing the parent sees.`;
}

function investigateBase(): string {
  return `Investigation agent. Broad cross-cutting analysis.

Quantify before reading: soul_grep(count), soul_analyze, soul_impact first.
Only read files that indexed tools pointed you to.

Use soul_grep for pattern matching, soul_analyze for structural queries (unused exports, frequency, profiles), soul_impact for dependencies, navigate for tracing usage.

OUTPUT: Concise text summary with counts, file lists, exact values. Your text is the only thing the parent sees.`;
}

// No structured output schema — agents return plain text summaries.
// The system extracts tool results deterministically and writes context files to disk.

interface ExploreAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  parentToolCallId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: import("../intelligence/repo-map.js").RepoMap;
  contextWindow?: number;
  disablePruning?: boolean;
  role?: "explore" | "investigate";
}

export function createExploreAgent(model: LanguageModel, options?: ExploreAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus ? buildBusTools(bus, agentId, "explore") : {};

  let tools = buildSubagentExploreTools({
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
    role: "explore",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
    disablePruning: options?.disablePruning,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "explore",
    model,
    tools: allTools,
    instructions: {
      role: "system" as const,
      content: (() => {
        const isInvestigate = options?.role === "investigate";
        const base = isInvestigate ? investigateBase() : exploreBase();
        return hasBus
          ? `${base}\nCoordination: report_finding after discoveries — especially shared symbols/configs with peer targets. check_findings for peer detail.`
          : base;
      })(),
      providerOptions: EPHEMERAL_CACHE,
    },
    stopWhen: stopConditions,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    ...(options?.providerOptions && Object.keys(options.providerOptions).length > 0
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
