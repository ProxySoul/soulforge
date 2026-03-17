import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { Output, ToolLoopAgent } from "ai";
import { z } from "zod";
import { EPHEMERAL_CACHE } from "../llm/provider-options.js";
import { buildSubagentCodeTools, wrapWithBusCache } from "../tools/index.js";
import type { AgentBus } from "./agent-bus.js";
import { buildBusTools } from "./bus-tools.js";
import { buildPrepareStep, buildSymbolLookup } from "./step-utils.js";
import { repairToolCall } from "./stream-options.js";

function codeBase(): string {
  return [
    "Code agent. Surgical edits, zero waste. Only call tools when necessary.",
    "Tool results are authoritative. FORBIDDEN: re-reading to verify, re-reading to confirm changes, chunking files, commentary between tool calls.",
    "Task paths are pre-resolved — read target, edit it, move on. On edit failure: re-read with read_file, retry with exact text.",
    "Pick the RIGHT tool: read one symbol = read_code. Find where something is defined = navigate definition. Check for errors after edit = analyze diagnostics (not project typecheck). Rename = rename_symbol (not grep + edit_file). FORBIDDEN: using grep when navigate or read_code answers it.",
    "Entity oversight: every tool call is monitored. Re-reads, waste, and sloppy behavior earn warnings. 3 warnings = termination and replacement.",
    "Stay in scope — out-of-scope issues get one sentence, no fix. No commentary between tool calls.",
  ].join("\n");
}

const codeOutputSchema = z.object({
  summary: z.string().describe("What was accomplished and any decisions made"),
  filesEdited: z
    .array(z.object({ file: z.string(), changes: z.string() }))
    .optional()
    .describe("Files modified with change descriptions"),
  filesExamined: z.array(z.string()).optional().describe("Files read during task"),
  keyFindings: z
    .array(z.object({ file: z.string(), detail: z.string() }))
    .optional()
    .describe("Key findings with code"),
  verified: z.boolean().optional().describe("Whether changes were verified"),
});

const codeOutput = Output.object({
  name: "code_result",
  description:
    "Structured result of code edits. Include file paths, changes, and verification status.",
  schema: codeOutputSchema,
});

interface CodeAgentOptions {
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

  const { prepareStep, tokenStop } = buildPrepareStep({
    bus,
    agentId,
    parentToolCallId: options?.parentToolCallId,
    role: "code",
    allTools,
    symbolLookup: buildSymbolLookup(options?.repoMap),
    contextWindow: options?.contextWindow,
  });

  return new ToolLoopAgent({
    id: options?.agentId ?? "code",
    model,
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
    output: codeOutput,
    stopWhen: tokenStop,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    ...(options?.providerOptions && Object.keys(options.providerOptions).length > 0
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
