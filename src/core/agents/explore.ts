import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { buildToolGuidance } from "../context/manager.js";
import { buildSubagentExploreTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup, tokenBudget } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function exploreBase(hasRepoMap: boolean): string {
  return [
    "Explore agent. Read-only codebase research.",
    "",
    ...buildToolGuidance(hasRepoMap),
    "",
    "WORKFLOW: Your task includes specific file paths and symbols. Go directly to those targets — read_code for the named symbols, read_file only if the task specifies config files. Paths in the task are already resolved — use them directly. If the repo map is appended below, use it to navigate related code without extra discovery steps.",
    "DISCOVERY: If your task names symbols or keywords but NOT file paths, run one navigate workspace_symbols call with the keyword, then read_code on the result. If workspace_symbols returns nothing, fall back to grep for the symbol name across the codebase. One search, one read — never chain multiple discovery tools for the same target. If the task is web research, go straight to web_search.",
    "",
    'OUTPUT CONTRACT: The parent agent is BLIND to your tool results — it only sees your done call. Paste full function bodies, complete type definitions, and entire relevant code blocks into keyFindings[].detail. If the parent has to call read_file after you, your done call failed. Rule: if you read it and it matters, paste it. Descriptions like "it uses a map to track X" are worthless — paste the actual map code.',
  ].join("\n");
}

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

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
            .describe(
              "PASTE the actual code: full function bodies, complete type definitions, entire relevant blocks. The parent makes decisions from this text alone — descriptions like 'it uses a map' are useless, paste the code.",
            ),
          lineNumbers: z.string().optional(),
        }),
      )
      .describe("Each finding must contain pasteable code, not prose descriptions"),
  }),
});

interface ExploreAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  repoMapContext?: string;
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
    repoMap: options?.repoMap,
  });
  if (hasBus) {
    tools = wrapWithBusCache(tools, bus, agentId) as typeof tools;
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
        const hasMap = !!options?.repoMapContext;
        const base = exploreBase(hasMap);
        const withBus = hasBus
          ? `${base}\nCoordination: report_finding to share discoveries. Peer findings appear in tool results — check_findings for detail.`
          : base;
        return hasMap
          ? `${withBus}\n\nRepo map (ranked by importance, + = exported):\n${options.repoMapContext}`
          : withBus;
      })(),
      providerOptions: ANTHROPIC_CACHE,
    },
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
