import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { buildToolGuidance } from "../context/manager.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup, tokenBudget } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function codeBase(hasRepoMap: boolean): string {
  return [
    "Code agent. Surgical reads, targeted edits, zero waste.",
    "",
    ...buildToolGuidance(hasRepoMap),
    "",
    "On edit failure ('old_string not found'): re-read file with read_file, retry with exact text. Never retry the same edit blindly.",
    "",
    "WORKFLOW: Your task includes specific file paths and symbols to edit. Go directly to those targets — read_code to understand the current code, then edit_file to make changes. Paths in the task are already resolved — use them directly. If the repo map is appended below, use it to find related code (callers, importers) without extra discovery steps.",
    "DISCOVERY: If your task names symbols or keywords but NOT file paths, run one navigate workspace_symbols call with the keyword, then read_code on the result. If workspace_symbols returns nothing, fall back to grep for the symbol name across the codebase. One search, one read — never chain multiple discovery tools for the same target.",
    "",
    "OUTPUT CONTRACT: The parent agent is BLIND to your tool results — it only sees your done call. For edits: exact file paths, what changed, and the final signatures/types of key additions. For research: paste actual code, not descriptions. If the parent has to re-read your files, your done call failed.",
  ].join("\n");
}

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

const codeDoneTool = tool({
  description:
    "Call when your coding task is complete. The parent agent ONLY sees what you put here — include enough detail that it can proceed without re-reading your files.",
  inputSchema: z.object({
    summary: z.string().describe("What was accomplished and any decisions made"),
    filesEdited: z
      .array(
        z.object({
          file: z.string(),
          changes: z
            .string()
            .describe(
              "Specific changes: new function signatures, modified types, added exports. Include the final code of key additions.",
            ),
        }),
      )
      .describe("Files modified with concrete change descriptions"),
    verified: z.boolean().describe("Whether changes were verified (lint/typecheck/test)"),
    verificationOutput: z.string().optional().describe("Output from verification commands"),
  }),
});

interface CodeAgentOptions {
  bus?: AgentBus;
  agentId?: string;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  repoMapContext?: string;
  repoMap?: import("../intelligence/repo-map.js").RepoMap;
}

export function createCodeAgent(model: LanguageModel, options?: CodeAgentOptions) {
  const bus = options?.bus;
  const agentId = options?.agentId;
  const hasBus = !!(bus && agentId);
  const busTools = hasBus ? buildBusTools(bus, agentId, "code") : {};

  let tools = buildSubagentCodeTools({
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
    done: codeDoneTool,
  };

  return new ToolLoopAgent({
    id: options?.agentId ?? "code",
    model,
    tools: allTools,
    instructions: {
      role: "system" as const,
      content: (() => {
        const hasMap = !!options?.repoMapContext;
        const base = codeBase(hasMap);
        const withBus = hasBus
          ? `${base}\nOwnership: you own files you edit first. check_edit_conflicts before touching another agent's file.\nIf another agent owns the file: report_finding with the exact edit instead.\nCoordination: report_finding after significant changes (paths, what changed, new exports). Peer findings appear in tool results.`
          : base;
        return hasMap
          ? `${withBus}\n\nRepo map (ranked by importance, + = exported):\n${options.repoMapContext}`
          : withBus;
      })(),
      providerOptions: ANTHROPIC_CACHE,
    },
    stopWhen: [stepCountIs(25), tokenBudget(150_000), hasToolCall("done")],
    prepareStep: buildPrepareStep({
      bus,
      agentId,
      role: "code",
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
