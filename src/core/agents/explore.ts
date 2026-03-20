import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { Output, ToolLoopAgent } from "ai";
import { z } from "zod";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentExploreTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { ReadTracker } from "./read-tracker.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";
import { wrapToolsWithReadTracker } from "./tracker-wrap.js";

function exploreBase(): string {
  return [
    "Explore agent. Read-only research. Only call tools when necessary.",
    "Tool results are authoritative. FORBIDDEN: re-reading to verify, re-grepping what you already found, chunking files into sequential reads.",
    "Task paths are pre-resolved from Soul Map — go directly to them. Two examples confirming a pattern = confirmed.",
    "Ask what question you need answered, then pick the RIGHT tool: Where is X defined? = navigate definition. Who calls X? = navigate references. Read one symbol = read_file(target, name). What's in this file? = read_file (once). How widespread? = soul_grep count. What breaks if I change X? = soul_impact. FORBIDDEN: using grep when navigate answers it, reading full files when read_file(target) gives the symbol.",
    "EXTRACTION (paths given): read_file(target, name) for symbols, read_file for config. DISCOVERY (keywords only): one navigate workspace_symbols then read_file(target, name). If nothing, one grep. INVESTIGATION (patterns): soul_grep count then soul_analyze then read hits only.",
    "DEPTH: After reading targets, trace one level of callers (navigate references). Flag disconnects: stated vs actual behavior, missing enforcement, edge cases.",
    "Re-reads are blocked — if you already read a file or symbol, the result is in your context. Use read_file with target + name for specific symbols instead of re-reading full files.",
    "STEP BUDGET: ~15 tool calls. Past 10 reads = you likely have enough.",
  ].join("\n");
}

const exploreOutputSchema = z.object({
  summary: z.string().describe("Direct answer to the task question with key conclusions"),
  filesExamined: z.array(z.string()).describe("File paths you examined"),
  keyFindings: z
    .array(
      z.object({
        file: z.string(),
        detail: z
          .string()
          .describe("PASTE actual code: full function bodies, type definitions, relevant blocks"),
        lineNumbers: z.string().optional(),
      }),
    )
    .describe("Each finding with pasteable code"),
  gaps: z
    .array(z.string())
    .optional()
    .describe(
      "Disconnects: missing enforcement, stated vs actual behavior, unhandled edge cases, dead code paths",
    ),
  connections: z
    .array(z.string())
    .optional()
    .describe(
      "Cross-cutting: symbols, configs, or APIs in your files that also appear in peer agents' targets",
    ),
});

const exploreOutput = Output.object({
  name: "research_result",
  description:
    "Structured research result. Paste full code in keyFindings — the parent is BLIND to your tool results.",
  schema: exploreOutputSchema,
});


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

  const tracker = new ReadTracker("subagent");
  wrapToolsWithReadTracker(allTools, tracker);

  const { prepareStep, tokenStop } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "explore",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "explore",
    model,
    tools: allTools,
    instructions: {
      role: "system" as const,
      content: (() => {
        const base = exploreBase();
        return hasBus
          ? `${base}\nCoordination: report_finding after discoveries — especially shared symbols/configs with peer targets. check_findings for peer detail.`
          : base;
      })(),
      providerOptions: EPHEMERAL_CACHE,
    },
    output: exploreOutput,
    stopWhen: tokenStop,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    ...(options?.providerOptions && Object.keys(options.providerOptions).length > 0
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
