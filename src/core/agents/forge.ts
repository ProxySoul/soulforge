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
  SCHEMAS,
} from "../tools/index.js";
import { readFileTool } from "../tools/read-file.js";
import { renderTaskList } from "../tools/task-list.js";
import { normalizePath } from "./agent-bus.js";
import { isApiExportEnabled } from "./step-utils.js";
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

const READ_TOOL_NAMES = new Set(["read_file"]);

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
  contextManager?: {
    buildCrossTabSection(): string | null;
    buildSoulMapDiff(): string | null;
    commitSoulMapDiff(): void;
    buildSkillsBlock(): string | null;
  },
) {
  // biome-ignore lint/suspicious/noExplicitAny: PrepareStepFunction generic is invariant
  return ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }): any => {
    const sanitized = sanitizeMessages(messages);

    const result: {
      messages?: ModelMessage[];
    } = {};

    // Soul Map snapshot + skills are in the system prompt (instructions).
    // prepareStep only handles diffs (file changes since last step) and hints.
    const hints: string[] = [];
    let soulMapDiff: string | null = null;

    if (contextManager) {
      soulMapDiff = contextManager.buildSoulMapDiff();
    }

    // [6] Plan mode nudges — hint only, no activeTools forcing
    if (isPlanMode && stepNumber >= PLAN_NUDGE_STEP && !hasPlanToolCall(messages)) {
      if (stepNumber >= PLAN_FORCE_STEP) {
        hints.push(
          "You have done enough research. Call plan NOW with everything you have. Do not read more files.",
        );
      } else {
        hints.push(
          "You have gathered substantial context. Start assembling the plan — call plan when ready.",
        );
      }
    }

    // [4] Read nudges + [5] Loop detection
    if (!isPlanMode && stepNumber >= 3) {
      const hasDispatch = hasToolCall(messages, "dispatch");
      const readsAfterDispatch = countReadsAfterLastDispatch(messages);
      if (hasDispatch && readsAfterDispatch >= 2) {
        hints.push(
          "You have dispatch results. Proceed to implementation or respond — additional reads are likely redundant.",
        );
      }

      const READ_TOOLS = new Set([
        "read_file",
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

      if (!hasDispatch && readsSinceAction >= 8) {
        hints.push(
          `${String(readsSinceAction)} consecutive reads without an action (edit/dispatch). Act on what you have — edit files directly or use dispatch for parallel work.`,
        );
      }

      // [5] Loop detection — hint only, no activeTools blocking
      const LOOP_THRESHOLD = 3;
      const LOOP_WINDOW = 16;
      const callCounts = new Map<string, { toolName: string; count: number }>();
      const startIdx = Math.max(0, messages.length - LOOP_WINDOW);
      for (let i = startIdx; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (typeof part !== "object" || part === null || !("type" in part)) continue;
          const p = part as { type: string; toolName?: string; input?: unknown };
          if (p.type !== "tool-call" || !p.toolName) continue;
          let argStr: string;
          try {
            argStr = JSON.stringify(p.input ?? {});
          } catch {
            argStr = "{}";
          }
          const sig = `${p.toolName}::${argStr}`;
          const entry = callCounts.get(sig);
          if (entry) entry.count++;
          else callCounts.set(sig, { toolName: p.toolName, count: 1 });
        }
      }
      for (const [, entry] of callCounts) {
        if (entry.count >= LOOP_THRESHOLD) {
          hints.push(
            `🔁 LOOP DETECTED: ${entry.toolName} called ${String(entry.count)} times with identical arguments. Results have not changed. Do NOT call it again. Act on the results you already have or try a different approach.`,
          );
          break;
        }
      }
    }

    // [8] Task list injection
    const taskBlock = renderTaskList();
    if (taskBlock) hints.push(taskBlock);

    // [7] Cross-tab claims
    if (contextManager) {
      const crossTab = contextManager.buildCrossTabSection();
      if (crossTab) hints.push(crossTab);
    }

    // Assemble tail content: diffs + hints + steering.
    // System prompt has the snapshot; prepareStep only adds ephemeral updates.
    const tailParts: string[] = [];

    if (soulMapDiff) tailParts.push(soulMapDiff);

    if (hints.length > 0) {
      tailParts.push(...hints.map((h) => `<system-reminder>\n${h}\n</system-reminder>`));
    }
    if (stepNumber > 0 && drainSteering) {
      const combined = drainSteering();
      if (combined) {
        tailParts.push(
          `IMPORTANT — the user just sent this while you were working. Prioritize this:\n\n${combined}`,
        );
      }
    }

    if (tailParts.length > 0) {
      const msgs = result.messages ?? [...sanitized];
      msgs.push({
        role: "user" as const,
        content: [{ type: "text" as const, text: tailParts.join("\n\n") }],
      });
      result.messages = msgs;
    }

    // [9] Debug API logging
    if (process.env.SOULFORGE_DEBUG_API) {
      const msgs = result.messages ?? sanitized;
      const dump = msgs
        .map((m, i) => {
          const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          const preview = raw.slice(0, 300);
          return `[${String(i)}] ${m.role} (${String(raw.length)} chars): ${preview}${raw.length > 300 ? "..." : ""}`;
        })
        .join("\n---\n");
      import("../tools/tee.js").then(({ saveTee }) => {
        saveTee(
          `forge-step-${String(stepNumber)}`,
          `Forge Step ${String(stepNumber)} — ${String(msgs.length)} messages\n\n=== MESSAGES ===\n${dump}`,
        );
      });
    }

    // [10] API export logging
    if (isApiExportEnabled()) {
      const msgs = result.messages ?? sanitized;
      const serializeContent = (content: unknown): unknown => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return String(content);
        return (content as Record<string, unknown>[]).map((p) => {
          if (p.type === "tool-call") {
            return {
              type: "tool-call",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              input: typeof p.input === "string" ? p.input : JSON.stringify(p.input),
            };
          }
          if (p.type === "tool-result") {
            const out = p.output as Record<string, unknown> | undefined;
            const text =
              out?.type === "text"
                ? String(out.value ?? "")
                : out?.type === "json"
                  ? JSON.stringify(out.value)
                  : JSON.stringify(out);
            return {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              contentLength: text.length,
              content: text,
            };
          }
          if (p.type === "text") return { type: "text", text: String(p.text ?? "") };
          return p;
        });
      };
      const exportData = {
        agent: "forge",
        step: stepNumber,
        timestamp: new Date().toISOString(),
        messageCount: msgs.length,
        messages: msgs.map((m, i) => {
          const content = serializeContent(m.content);
          const charCount =
            typeof content === "string"
              ? content.length
              : Array.isArray(content)
                ? (content as Record<string, unknown>[]).reduce(
                    (s: number, p) =>
                      s +
                      (typeof p.content === "string" ? p.content.length : 0) +
                      (typeof p.text === "string" ? p.text.length : 0) +
                      (typeof p.input === "string" ? p.input.length : 0),
                    0,
                  )
                : 0;
          return {
            index: i,
            role: m.role,
            charCount,
            estimatedTokens: Math.ceil(charCount / 4),
            content,
          };
        }),
      };
      import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        const dir = `${process.cwd()}/.soulforge/api-export`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          `${dir}/forge-step-${String(stepNumber).padStart(2, "0")}.json`,
          JSON.stringify(exportData, null, 2),
          "utf-8",
        );
      });
    }

    if (sanitized !== messages && !result.messages) {
      result.messages = sanitized;
    }

    // Commit diff after building result — if API call fails and retries,
    // buildSoulMapDiff returns the same pending diff instead of losing it
    if (soulMapDiff && contextManager) contextManager.commitSoulMapDiff();

    return Object.keys(result).length > 0 ? result : undefined;
  };
}

const instructionsCache = new WeakMap<ContextManager, { text: string; key: string }>();

function buildInstructions(cm: ContextManager, modelId: string): string {
  const key = cm.getInstructionsCacheKey(modelId);
  const cached = instructionsCache.get(cm);
  if (cached && cached.key === key) return cached.text;
  const parts = [cm.buildSystemPrompt(modelId)];
  const snapshot = cm.buildSoulMapSnapshot(false);
  if (snapshot) parts.push(snapshot);
  const skills = cm.buildSkillsBlock();
  if (skills) parts.push(skills);
  const text = parts.join("\n\n");
  if (snapshot) instructionsCache.set(cm, { text, key });
  return text;
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
    editing?: LanguageModel;
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
  disablePruning?: boolean;
  disabledTools?: Set<string>;
  tabId?: string;
  tabLabel?: string;
}

/** Creates the main Forge ToolLoopAgent — model can change between turns (Ctrl+L). */
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
  disablePruning,
  disabledTools,
  tabId,
  tabLabel,
}: ForgeAgentOptions) {
  const isRestricted = RESTRICTED_MODES.has(forgeMode);
  const repoMap = contextManager.isRepoMapReady() ? contextManager.getRepoMap() : undefined;
  const skills = contextManager.getActiveSkillEntries();

  const modelId =
    typeof model === "object" && model !== null && "modelId" in model
      ? String((model as { modelId: string }).modelId)
      : "";
  // Ensure ContextManager knows the model before building the system prompt
  // (family-specific prompt selection depends on this)
  if (modelId) contextManager.setActiveModel(modelId);
  const canUseCodeExecution = codeExecution && isAnthropicNative(modelId);

  const onDemandEnabled = agentFeatures?.onDemandTools !== false && !isRestricted && !planExecution;
  const activeDeferredTools = onDemandEnabled ? new Set<string>() : undefined;

  const directTools = buildTools(undefined, editorIntegration, onApproveWebSearch, {
    codeExecution: canUseCodeExecution,
    contextManager,
    agentSkills: agentFeatures?.agentSkills,
    webSearchModel,
    repoMap,
    onApproveFetchPage,
    onApproveOutsideCwd,
    onApproveDestructive,
    tabId: tabId ?? contextManager.getTabId() ?? undefined,
    tabLabel: tabLabel ?? contextManager.getTabLabel() ?? undefined,
    activeDeferredTools,
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
          skills,
          disablePruning,
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
        skills,
        disablePruning,
      });

  const cachedReadFile =
    sharedCacheRef && agentFeatures?.dispatchCache !== false
      ? wrapReadFileWithDispatchCache(directTools.read_file, sharedCacheRef, cwd)
      : directTools.read_file;

  const allTools = {
    ...directTools,
    read_file: cachedReadFile,
    ...subagentTools,
    ...(interactive ? buildInteractiveTools(interactive, { cwd, sessionId, forgeMode }) : {}),
  };

  // Cache breakpoints: system prompt (via instructions) + first 2 messages.
  // Total: 3 breakpoints. The system+tools prefix is the biggest stable cache.

  const allToolNames = Object.keys(allTools) as (keyof typeof allTools)[];
  const restrictedSet = new Set(RESTRICTED_TOOL_NAMES);
  const planExecSet = new Set(PLAN_EXECUTION_TOOL_NAMES);

  const computeActiveTools = (): (keyof typeof allTools)[] | undefined => {
    if (isRestricted) return allToolNames.filter((name) => restrictedSet.has(name));
    if (planExecution) return allToolNames.filter((name) => planExecSet.has(name));
    if (disabledTools && disabledTools.size > 0) {
      return allToolNames.filter((name) => !disabledTools.has(name));
    }
    return undefined;
  };

  return new ToolLoopAgent({
    id: "forge",
    model,
    temperature: 0,
    maxOutputTokens: 4096,
    tools: allTools,
    stopWhen: () => false,
    instructions: {
      role: "system" as const,
      content: buildInstructions(contextManager, modelId),
      providerOptions: EPHEMERAL_CACHE,
    },
    callOptionsSchema: z.object({
      userMessage: z.string().nullable(),
    }),
    prepareCall: ({ options: _options, ...settings }) => {
      const activeTools = computeActiveTools();
      return {
        ...settings,
        ...(activeTools ? { activeTools } : {}),
      };
    },
    prepareStep: buildForgePrepareStep(forgeMode === "plan", drainSteering, contextManager),
    experimental_repairToolCall: repairToolCall,
    providerOptions: {
      ...providerOptions,
      anthropic: {
        ...(((providerOptions as Record<string, unknown>)?.anthropic as Record<string, unknown>) ??
          {}),
        cacheControl: { type: "ephemeral" },
      },
    } as ProviderOptions,
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
    inputSchema: SCHEMAS.readFile.pick({ path: true, startLine: true, endLine: true }),
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

          const isFullRead = args.startLine == null && args.endLine == null;
          if (isFullRead) {
            const lines = cached.split("\n");
            const numbered = lines
              .map((line: string, i: number) => `${String(i + 1).padStart(4)}  ${line}`)
              .join("\n");
            return {
              success: true,
              output: `[from dispatch cache — ${String(lines.length)} lines]\n${numbered}`,
            };
          }
        }
      }
      return readFileTool.execute(args);
    },
  });
}
