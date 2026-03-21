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
    "Code agent. You are dispatched to make specific edits. Your target files and what to change are in the task.",
    "WORKFLOW: read_file → multi_edit → done. That's it. 3 steps typical, 5 max for complex edits.",
    "Read each target file ONCE (full file), plan all edits, apply with multi_edit in ONE call per file.",
    "On edit failure: re-read the file once, retry with exact text from that read.",
    "Multiple edits to one file = multi_edit (one call, all changes).",
    "Rename = rename_symbol. FORBIDDEN: re-reading to verify, re-reading after edits, exploring unrelated files, grep/search when you already have target paths, sequential edit_file calls to the same file.",
    'OUTPUT: When done editing, respond with a JSON object: {"summary":"...","filesEdited":[{"file":"...","changes":"..."}],"filesExamined":[...],"verified":true}.',
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
    stopWhen: stopConditions,
    prepareStep,
    experimental_repairToolCall: repairToolCall,
    ...(options?.providerOptions && Object.keys(options.providerOptions).length > 0
      ? { providerOptions: options.providerOptions }
      : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
  });
}
