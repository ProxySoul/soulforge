import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { hasToolCall, Output, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentExploreTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup, tokenBudget } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function exploreBase(): string {
  return [
    "Explore agent. Read-only research. Only call tools when necessary.",
    "Tool results are authoritative. FORBIDDEN: re-reading to verify, re-grepping what you already found, chunking files into sequential reads.",
    "Task paths are pre-resolved from Repo Map — go directly to them. Two examples confirming a pattern = confirmed.",
    "Ask what question you need answered, then pick the RIGHT tool: Where is X defined? = navigate definition. Who calls X? = navigate references. Read one symbol = read_code. What's in this file? = read_file (once). How widespread? = soul_grep count. What breaks if I change X? = soul_impact. FORBIDDEN: using grep when navigate answers it, reading full files when read_code gives the symbol.",
    "EXTRACTION (paths given): read_code for symbols, read_file for config. DISCOVERY (keywords only): one navigate workspace_symbols then read_code. If nothing, one grep. INVESTIGATION (patterns): soul_grep count then soul_analyze then read hits only.",
    "STEP BUDGET: ~15 tool calls max. Reserve last for done. Past 10 reads = call done NOW with what you have.",
    'OUTPUT CONTRACT: Parent sees ONLY your done call. Paste full code in keyFindings. "it uses a map" = useless — paste actual code. Parent re-reading your files = your done call failed.',
  ].join("\n");
}

const exploreDoneTool = tool({
  description:
    "Call when research is complete. The parent agent ONLY sees what you put here — your tool results are invisible to it. Paste full function bodies, type definitions, and implementations. A summary without code forces the parent to re-read everything.",
  inputSchema: z.object({
    summary: z.string().describe("Direct answer to the task question with key conclusions"),
    filesExamined: z.array(z.string()).describe("File paths you examined"),
    keyFindings: z
      .array(
        z.object({
          file: z.string(),
          detail: z
            .string()
            .min(10)
            .describe(
              "PASTE the actual code: full function bodies, complete type definitions, entire relevant blocks. The parent makes decisions from this text alone.",
            ),
          lineNumbers: z.string().optional(),
        }),
      )
      .min(1, "At least one key finding with actual code is required")
      .describe("Each finding with pasteable code"),
  }),
});

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
});

const exploreOutput = Output.object({
  name: "research_result",
  description:
    "Structured research result. Paste full code in keyFindings — the parent is BLIND to your tool results.",
  schema: exploreOutputSchema,
});

export type ExploreOutput = z.infer<typeof exploreOutputSchema>;

interface ExploreAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: import("../intelligence/repo-map.js").RepoMap;
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
    done: exploreDoneTool,
  };

  return new ToolLoopAgent({
    id: options?.agentId ?? "explore",
    model,
    tools: allTools,
    instructions: {
      role: "system" as const,
      content: (() => {
        const base = exploreBase();
        return hasBus
          ? `${base}\nCoordination: report_finding to share discoveries. Peer findings appear in tool results — check_findings for detail.`
          : base;
      })(),
      providerOptions: EPHEMERAL_CACHE,
    },
    output: exploreOutput,
    stopWhen: [stepCountIs(15), tokenBudget(80_000), hasToolCall("done")],
    prepareStep: buildPrepareStep({
      bus,
      agentId,
      role: "explore",
      allTools,
      symbolLookup: buildSymbolLookup(options?.repoMap),
    }),
    experimental_repairToolCall: repairToolCall,
    ...(options?.providerOptions && Object.keys(options.providerOptions).length > 0
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
