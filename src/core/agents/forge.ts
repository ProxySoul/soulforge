import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type {
  AgentFeatures,
  EditorIntegration,
  ForgeMode,
  InteractiveCallbacks,
} from "../../types/index.js";
import type { ContextManager } from "../context/manager.js";
import { EPHEMERAL_CACHE, isAnthropicNative } from "../llm/provider-options.js";
import {
  buildInteractiveTools,
  buildTools,
  PLAN_EXECUTION_TOOL_NAMES,
  RESTRICTED_TOOL_NAMES,
} from "../tools/index.js";
import { readFileTool } from "../tools/read-file.js";
import { renderTaskList } from "../tools/task-list.js";
import { normalizePath } from "./agent-bus.js";
import { repairToolCall, sanitizeMessages } from "./stream-options.js";
import { buildSubagentTools, type SharedCacheRef } from "./subagent-tools.js";

const RESTRICTED_MODES = new Set<ForgeMode>(["architect", "socratic", "challenge", "plan"]);

const PLAN_NUDGE_STEP = 10;
const PLAN_FORCE_STEP = 20;

function hasPlanToolCall(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.toolName === "plan") return true;
    }
  }
  return false;
}

function hasToolCall(messages: ModelMessage[], toolName: string): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolName" in part &&
        (part as { toolName: string }).toolName === toolName
      ) {
        return true;
      }
    }
  }
  return false;
}

const READ_TOOL_NAMES = new Set(["read_file", "read_code"]);

function countReadsAfterLastDispatch(messages: ModelMessage[]): number {
  let lastDispatchIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolName" in part &&
        (part as { toolName: string }).toolName === "dispatch"
      ) {
        lastDispatchIdx = i;
        break;
      }
    }
    if (lastDispatchIdx >= 0) break;
  }
  if (lastDispatchIdx < 0) return 0;

  let count = 0;
  for (let i = lastDispatchIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { type: string }).type === "tool-call" &&
        "toolName" in part &&
        READ_TOOL_NAMES.has((part as { toolName: string }).toolName)
      ) {
        count++;
      }
    }
  }
  return count;
}

function buildForgePrepareStep(
  isPlanMode: boolean,
  drainSteering?: () => string | null,
  _repoMap?: import("../intelligence/repo-map.js").RepoMap,
) {
  // biome-ignore lint/suspicious/noExplicitAny: PrepareStepFunction generic is invariant
  return ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }): any => {
    const sanitized = sanitizeMessages(messages);
    const result: {
      messages?: ModelMessage[];
      activeTools?: string[];
      toolChoice?: "required" | "auto";
      system?: string;
    } = {};

    if (sanitized !== messages) {
      result.messages = sanitized;
    }

    // Cache breakpoint: mark the second-to-last message with cache_control.
    // This tells the API "everything up to this point is a prefix — cache it."
    // Same technique as Claude Code: append-only messages + breakpoint on penultimate.
    if (stepNumber > 0) {
      const msgs = result.messages ?? messages;
      if (msgs.length >= 2) {
        // Strip cache_control from all messages first (only one breakpoint allowed)
        for (const msg of msgs) {
          if (msg.providerOptions?.anthropic) {
            const { anthropic: _, ...rest } = msg.providerOptions;
            msg.providerOptions = Object.keys(rest).length > 0 ? rest : undefined;
          }
        }
        // Place breakpoint on second-to-last message
        const target = msgs[msgs.length - 2];
        if (target) {
          target.providerOptions = { ...target.providerOptions, ...EPHEMERAL_CACHE };
        }
      }
    }

    if (isPlanMode && stepNumber >= PLAN_NUDGE_STEP && !hasPlanToolCall(messages)) {
      if (stepNumber >= PLAN_FORCE_STEP) {
        result.activeTools = ["plan", "ask_user"];
        result.toolChoice = "required";
        result.system =
          "You have done enough research. Call plan NOW with everything you have. Do not read more files.";
      } else {
        result.system =
          "You have gathered substantial context. Start assembling the plan — call plan when ready.";
      }
    }

    if (!isPlanMode && stepNumber >= 3) {
      const hasDispatch = hasToolCall(messages, "dispatch");
      const readsAfterDispatch = countReadsAfterLastDispatch(messages);
      if (hasDispatch && readsAfterDispatch >= 2) {
        const hint =
          readsAfterDispatch >= 4
            ? "You are re-reading files the dispatch already returned. Stop reading — synthesize what you have and act: edit code, propose a plan, or respond to the user."
            : "You have dispatch results. Proceed to implementation or respond — additional reads are likely redundant.";
        result.system = result.system ? `${result.system}\n\n${hint}` : hint;
      }

      // Detect excessive reads without action — language-agnostic
      const READ_TOOLS = new Set([
        "read_file",
        "read_code",
        "grep",
        "soul_grep",
        "soul_find",
        "navigate",
        "analyze",
      ]);
      const ACTION_TOOLS = new Set([
        "edit_file",
        "write_file",
        "create_file",
        "plan",
        "dispatch",
        "shell",
      ]);
      let totalReads = 0;
      let lastActionStep = -1;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (typeof part !== "object" || part === null || !("type" in part)) continue;
          if ((part as { type: string }).type !== "tool-call" || !("toolName" in part)) continue;
          const tn = (part as { toolName: string }).toolName;
          if (READ_TOOLS.has(tn)) totalReads++;
          if (ACTION_TOOLS.has(tn)) lastActionStep = i;
        }
      }
      const readsSinceAction =
        lastActionStep === -1
          ? totalReads
          : (() => {
              let count = 0;
              for (let i = lastActionStep + 1; i < messages.length; i++) {
                const m = messages[i];
                if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
                for (const part of m.content) {
                  if (typeof part !== "object" || part === null || !("type" in part)) continue;
                  if ((part as { type: string }).type !== "tool-call" || !("toolName" in part))
                    continue;
                  if (READ_TOOLS.has((part as { toolName: string }).toolName)) count++;
                }
              }
              return count;
            })();

      // Only nudge when no dispatch was used (dispatches handle their own read patterns)
      // and the agent isn't in plan mode (audits/plans legitimately need many reads)
      if (!hasDispatch) {
        if (readsSinceAction >= 8) {
          const nudge = `${String(readsSinceAction)} consecutive reads without an action (plan/edit/dispatch). If you're gathering for a plan, call plan now. If this is an audit, use dispatch for parallel scanning.`;
          result.system = result.system ? `${result.system}\n\n${nudge}` : nudge;
        }
      }
    }

    // Inject task list so it survives compaction and is always visible
    const taskBlock = renderTaskList();
    if (taskBlock) {
      result.system = `${result.system ?? ""}\n\n${taskBlock}`.trim();
    }

    // Inject steering messages from queue (user typed while agent was running)
    if (stepNumber > 0 && drainSteering) {
      const allSteering: string[] = [];
      let next = drainSteering();
      while (next) {
        allSteering.push(next);
        next = drainSteering();
      }
      if (allSteering.length > 0) {
        const msgs = result.messages ?? [...messages];
        const combined = allSteering.join("\n\n");
        msgs.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `IMPORTANT — the user just sent this while you were working. Prioritize this:\n\n${combined}`,
            },
          ],
        });
        result.messages = msgs;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };
}

interface ForgeAgentOptions {
  model: LanguageModel;
  contextManager: ContextManager;
  forgeMode?: ForgeMode;
  interactive?: InteractiveCallbacks;
  editorIntegration?: EditorIntegration;
  subagentModels?: {
    exploration?: LanguageModel;
    coding?: LanguageModel;
    trivial?: LanguageModel;
    desloppify?: LanguageModel;
    verify?: LanguageModel;
  };
  webSearchModel?: LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
  onApproveDestructive?: (description: string) => Promise<boolean>;
  providerOptions?: ProviderOptions;
  headers?: Record<string, string>;
  codeExecution?: boolean;
  cwd?: string;
  sessionId?: string;
  sharedCacheRef?: SharedCacheRef;
  agentFeatures?: AgentFeatures;
  planExecution?: boolean;
  drainSteering?: () => string | null;
}

/**
 * Creates the main Forge ToolLoopAgent.
 * Factory function (not singleton) — model can change between turns (Ctrl+L).
 * Combines direct tools + subagent tools + optional interactive tools.
 *
 * For restricted modes (architect, socratic, challenge), activeTools limits
 * to read-only tools — the LLM physically cannot call edit/shell/git.
 *
 * Uses prepareCall for auto-recall: user message passed via callOptionsSchema
 * at .stream() time, memory search injected into instructions dynamically.
 */
export function createForgeAgent({
  model,
  contextManager,
  forgeMode = "default",
  interactive,
  editorIntegration,
  subagentModels,
  webSearchModel,
  onApproveWebSearch,
  onApproveFetchPage,
  onApproveOutsideCwd,
  onApproveDestructive,
  providerOptions,
  headers,
  codeExecution,
  cwd,
  sessionId,
  sharedCacheRef,
  agentFeatures,
  planExecution,
  drainSteering,
}: ForgeAgentOptions) {
  const isRestricted = RESTRICTED_MODES.has(forgeMode);
  const repoMap = contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;

  const modelId =
    typeof model === "object" && model !== null && "modelId" in model
      ? String((model as { modelId: string }).modelId)
      : "";
  const canUseCodeExecution = codeExecution && isAnthropicNative(modelId);

  const directTools = buildTools(undefined, editorIntegration, onApproveWebSearch, {
    codeExecution: canUseCodeExecution,
    webSearchModel,
    repoMap,
    onApproveFetchPage,
    onApproveOutsideCwd,
    onApproveDestructive,
  });

  const subagentTools = isRestricted
    ? {
        dispatch: buildSubagentTools({
          defaultModel: model,
          explorationModel: subagentModels?.exploration,
          webSearchModel,
          providerOptions,
          headers,
          onApproveWebSearch,
          onApproveFetchPage,
          readOnly: true,
          repoMap,
          sharedCacheRef,
          agentFeatures,
        }).dispatch,
      }
    : buildSubagentTools({
        defaultModel: model,
        explorationModel: subagentModels?.exploration,
        codingModel: subagentModels?.coding,
        trivialModel: subagentModels?.trivial,
        desloppifyModel: subagentModels?.desloppify,
        verifyModel: subagentModels?.verify,
        webSearchModel,
        providerOptions,
        headers,
        onApproveWebSearch,
        onApproveFetchPage,
        repoMap,
        sharedCacheRef,
        agentFeatures,
      });

  const cachedReadFile =
    sharedCacheRef && agentFeatures?.dispatchCache !== false
      ? wrapReadFileWithDispatchCache(directTools.read_file, sharedCacheRef, cwd)
      : directTools.read_file;

  const allTools = {
    ...directTools,
    read_file: cachedReadFile,
    ...subagentTools,
    ...(interactive ? buildInteractiveTools(interactive, { cwd, sessionId }) : {}),
  };

  const allToolNames = Object.keys(allTools) as (keyof typeof allTools)[];
  const restrictedSet = new Set(RESTRICTED_TOOL_NAMES);
  const planExecSet = new Set(PLAN_EXECUTION_TOOL_NAMES);
  const activeToolOverride = isRestricted
    ? allToolNames.filter((name) => restrictedSet.has(name))
    : planExecution
      ? allToolNames.filter((name) => planExecSet.has(name))
      : undefined;

  return new ToolLoopAgent({
    id: "forge",
    model,
    tools: allTools,
    callOptionsSchema: z.object({
      userMessage: z.string().optional(),
    }),
    instructions: {
      role: "system" as const,
      content: contextManager.buildSystemPrompt(),
      providerOptions: EPHEMERAL_CACHE,
    },
    prepareCall: ({ options: _options, ...settings }) => {
      return {
        ...settings,
        ...(activeToolOverride ? { activeTools: activeToolOverride } : {}),
      };
    },
    prepareStep: buildForgePrepareStep(forgeMode === "plan", drainSteering, repoMap),
    experimental_repairToolCall: repairToolCall,
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(headers ? { headers } : {}),
  });
}

function wrapReadFileWithDispatchCache(
  _original: ReturnType<typeof buildTools>["read_file"],
  cacheRef: SharedCacheRef,
  projectCwd?: string,
) {
  const cwdPrefix = projectCwd ? (projectCwd.endsWith("/") ? projectCwd : `${projectCwd}/`) : null;

  return tool({
    description: readFileTool.description,
    inputSchema: z.object({
      path: z.string().describe("File path to read"),
      startLine: z.number().optional().describe("Start line (1-indexed)"),
      endLine: z.number().optional().describe("End line (1-indexed)"),
    }),
    execute: async (args) => {
      const cache = cacheRef.current;
      if (cache) {
        let normalized = normalizePath(args.path);
        if (cwdPrefix && normalized.startsWith(cwdPrefix)) {
          normalized = normalized.slice(cwdPrefix.length);
        }
        let cached = cache.files.get(normalized);
        if (cached != null) {
          for (let depth = 0; depth < 5 && cached.startsWith('{"success":'); depth++) {
            try {
              const parsed = JSON.parse(cached) as { success?: boolean; output?: string };
              if (typeof parsed.success === "boolean" && typeof parsed.output === "string") {
                cached = parsed.output;
              } else break;
            } catch {
              break;
            }
          }

          const lines = cached.split("\n");
          const lineCount = lines.length;
          const rangeCoversFile =
            args.startLine != null &&
            args.startLine <= 1 &&
            (args.endLine == null || args.endLine >= lineCount * 0.8);
          const isFullRead = args.startLine == null && args.endLine == null;

          if ((isFullRead || rangeCoversFile) && lineCount > 80) {
            const ent = cacheRef.entity;
            ent.warnings = Math.min(ent.warnings + 1, 3);
            ent.cleanSteps = 0;
            const fileName = normalized.split("/").pop() ?? normalized;
            return {
              success: true,
              output:
                `⚠ ENTITY → WARNING ${String(ent.warnings)}/3: Re-read of ${fileName} (${String(lineCount)} lines) — already in your context from dispatch. ` +
                (ent.warnings >= 3
                  ? "WARNING LIMIT REACHED — you will be replaced by a cheaper model and your work discarded. "
                  : "") +
                `Use read_code for specific symbols, or act on dispatch findings above.`,
            };
          }

          if (isFullRead) {
            const numbered = lines
              .map((line: string, i: number) => `${String(i + 1).padStart(4)}  ${line}`)
              .join("\n");
            return {
              success: true,
              output: `[from dispatch cache — ${String(lineCount)} lines]\n${numbered}`,
            };
          }
        }
      }
      return readFileTool.execute(args);
    },
  });
}
