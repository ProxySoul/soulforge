import { forwardAnthropicContainerIdFromLastStep } from "@ai-sdk/anthropic";
import type { ModelMessage, ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type {
  AgentFeatures,
  EditorIntegration,
  ForgeMode,
  ImageAttachment,
  InteractiveCallbacks,
} from "../../types/index.js";
import { compressImageForApi } from "../../utils/image-compress.js";
import type { ContextManager } from "../context/manager.js";
import {
  detectModelFamily,
  EPHEMERAL_CACHE,
  getAnthropicToolVersions,
  isAnthropicNative,
} from "../llm/provider-options.js";
import { getMCPManager } from "../mcp/index.js";
import {
  buildInteractiveTools,
  buildTools,
  CORE_TOOL_NAMES,
  PLAN_EXECUTION_TOOL_NAMES,
  PROGRAMMATIC_PROVIDER_OPTS,
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

/** Check if the most recent assistant message (last step) included a `plan` tool call. */
function lastStepHadPlanCall(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) return false;
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.toolName === "plan") return true;
    }
    return false; // checked the last assistant message — stop
  }
  return false;
}

function buildForgePrepareStep(
  isPlanMode: boolean,
  drainSteering?: () => { text: string; images?: ImageAttachment[] } | null,
  contextManager?: {
    buildCrossTabSection(): string | null;
    buildSoulMapDiff(): string | null;
    commitSoulMapDiff(): void;
    buildSkillsBlock(): string | null;
  },
  tabId?: string,
  codeExecution?: boolean,
  parentMessagesRef?: { current: ModelMessage[] | null },
) {
  // Cache-stable inject tracking: the ToolLoopAgent discards prepareStep message
  // modifications after each step (it rebuilds from initialMessages + responseMessages).
  // To maintain prefix stability for Anthropic prompt caching, we re-insert previous
  // injects at their original positions so the API always sees an append-only history.
  const previousInjects: Array<{ cleanInsertAt: number; message: ModelMessage }> = [];

  type StepEntry = { providerMetadata?: Record<string, unknown> };
  return async ({
    stepNumber,
    messages,
    steps,
  }: {
    stepNumber: number;
    messages: ModelMessage[];
    steps: StepEntry[];
    // biome-ignore lint/suspicious/noExplicitAny: PrepareStepFunction generic is invariant
  }): Promise<any> => {
    let steeringImages: ImageAttachment[] | undefined;
    // Doppelganger: snapshot the current conversation for spark mirror mode.
    // Sparks receive this prefix so the API sees an identical cache-hit prefix.
    if (parentMessagesRef) {
      parentMessagesRef.current = messages;
    }

    const sanitized = sanitizeMessages(messages);

    const result: {
      messages?: ModelMessage[];
      model?: LanguageModel;
      providerOptions?: ProviderOptions;
      toolChoice?: "required" | "auto" | "none";
    } = {};

    // Forward code execution container ID between steps so the sandbox persists.
    // This reuses the same container (filesystem, installed packages) across steps.
    if (codeExecution && steps.length > 0) {
      // biome-ignore lint/suspicious/noExplicitAny: step metadata types vary by provider
      const forwarded = forwardAnthropicContainerIdFromLastStep({ steps: steps as any });
      if (forwarded?.providerOptions) {
        result.providerOptions = forwarded.providerOptions as ProviderOptions;
      }
    }

    // Plan gate: after a `plan` call, stop the tool loop (text-only).
    // Plans always require user approval — the agent must not auto-execute.
    if (stepNumber > 0 && lastStepHadPlanCall(messages)) {
      result.toolChoice = "none";
    }

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
        hints.push("Call plan NOW with everything you have. You have enough context.");
      } else {
        hints.push(
          "You have gathered substantial context. Start assembling the plan — call plan when ready.",
        );
      }
    }

    // [4] Read nudges disabled — conversational hints cause "You're right" responses.
    // Read steering handled by system prompt ("max 3 exploration rounds").
    // [5] Loop detection only
    if (!isPlanMode && stepNumber >= 3) {
      // [5] Loop detection — hint only, no activeTools blocking
      const LOOP_THRESHOLD = 3;
      const LOOP_WINDOW = 16;
      // Count tool calls in the raw messages (before inject re-insertion)
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
            `🔁 ${entry.toolName} called ${String(entry.count)}× with identical arguments — same result each time. Use the result you already have, or try a different tool/approach.`,
          );
          break;
        }
      }
    }

    // [8] Task list injection
    const taskBlock = renderTaskList(tabId);
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
      const steering = drainSteering();
      if (steering) {
        tailParts.push(
          `<steering>\nThe user just sent a new message while you were working:\n\n${steering.text}\n\nFinish any in-progress tool call, then switch entirely to this message in your next response.\n</steering>`,
        );
        // Thread steering images into the inject message
        if (steering.images && steering.images.length > 0) {
          steeringImages = steering.images;
        }
      }
    }

    // Re-insert previous injects + append new one for cache-stable prefix.
    // The ToolLoopAgent rebuilds messages fresh each step (initialMessages + responseMessages),
    // discarding our injected user messages. We re-insert them at their original positions
    // so Anthropic sees a byte-identical, append-only prefix → auto-cache hits.
    //
    // Position tracking uses cleanInsertAt — the index in the CLEAN message array
    // (before any re-insertions). This ensures correct placement across steps:
    //   Step N:   [...clean_17, INJECT_9]
    //   Step N+1: [...clean_17, INJECT_9, asst, tool, INJECT_10]
    //   Step N+2: [...clean_17, INJECT_9, asst, tool, INJECT_10, asst, tool, INJECT_11]
    if (tailParts.length > 0 || previousInjects.length > 0) {
      const msgs = result.messages ?? [...sanitized];
      const cleanMsgCount = msgs.length;

      // Re-insert all previous injects at their original positions.
      // cleanInsertAt is relative to the clean array; offset accounts for prior splices.
      let offset = 0;
      for (const prev of previousInjects) {
        const insertAt = prev.cleanInsertAt + offset;
        if (insertAt <= msgs.length) {
          msgs.splice(insertAt, 0, prev.message);
          offset++;
        }
      }

      // Append the new inject (if any content this step)
      if (tailParts.length > 0) {
        const contentParts: Array<
          { type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }
        > = [{ type: "text" as const, text: tailParts.join("\n\n") }];
        if (steeringImages) {
          for (const img of steeringImages) {
            const raw = Buffer.from(img.base64, "base64");
            const { data, mediaType } = await compressImageForApi(raw, img.mediaType);
            contentParts.push({
              type: "image" as const,
              image: data,
              mediaType,
            });
          }
        }
        const injectMessage: ModelMessage = {
          role: "user" as const,
          content: contentParts,
        };
        previousInjects.push({ cleanInsertAt: cleanMsgCount, message: injectMessage });
        msgs.push(injectMessage);
      }

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
    /** Model for ⚡ spark agents — explore/investigate. */
    spark?: LanguageModel;
    /** Model for 🔥 ember agents — code edits. */
    ember?: LanguageModel;
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
  computerUse?: boolean;
  anthropicTextEditor?: boolean;
  cwd?: string;
  sessionId?: string;
  sharedCacheRef?: SharedCacheRef;
  agentFeatures?: AgentFeatures;
  planExecution?: boolean;
  drainSteering?: () => { text: string; images?: ImageAttachment[] } | null;
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
  computerUse,
  anthropicTextEditor,
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

  // Auto mode: bypass all permission prompts — fully autonomous execution.
  const autoApprove = () => Promise.resolve(true);
  const effectiveApproveWebSearch = forgeMode === "auto" ? autoApprove : onApproveWebSearch;
  const effectiveApproveFetchPage = forgeMode === "auto" ? autoApprove : onApproveFetchPage;
  const effectiveApproveOutsideCwd =
    forgeMode === "auto" ? (autoApprove as typeof onApproveOutsideCwd) : onApproveOutsideCwd;
  const effectiveApproveDestructive = forgeMode === "auto" ? autoApprove : onApproveDestructive;

  const modelId =
    typeof model === "object" && model !== null && "modelId" in model
      ? String((model as { modelId: string }).modelId)
      : "";
  // Ensure ContextManager knows the model before building the system prompt
  // (family-specific prompt selection depends on this)
  if (modelId) contextManager.setActiveModel(modelId);
  const isAnthropic = isAnthropicNative(modelId);
  const toolVersions = getAnthropicToolVersions(modelId);
  // Code execution (20260120) requires programmatic tool calling — skip entirely for models
  // that don't support it (e.g. Haiku). Basic code execution (20250825) isn't useful here
  // since SoulForge's value comes from programmatic tool batching, and mixing tool versions
  // causes auto-injection conflicts with the API.
  const canUseCodeExecution = codeExecution && isAnthropic && toolVersions.programmaticToolCalling;

  const onDemandEnabled = !disabledTools?.has("request_tools") && !isRestricted && !planExecution;
  const activeDeferredTools = onDemandEnabled ? new Set<string>() : undefined;

  const directTools = buildTools(undefined, editorIntegration, effectiveApproveWebSearch, {
    codeExecution: canUseCodeExecution,
    computerUse: computerUse && isAnthropic && toolVersions.computerUse != null,
    anthropicTextEditor: anthropicTextEditor && isAnthropic && toolVersions.textEditor != null,
    toolVersions: {
      computerUse: toolVersions.computerUse ?? undefined,
      textEditor: toolVersions.textEditor ?? undefined,
      programmaticToolCalling: toolVersions.programmaticToolCalling,
    },
    contextManager,
    agentSkills: !disabledTools?.has("skills"),
    webSearchModel,
    repoMap,
    onApproveFetchPage: effectiveApproveFetchPage,
    onApproveOutsideCwd: effectiveApproveOutsideCwd,
    onApproveDestructive: effectiveApproveDestructive,
    tabId: tabId ?? contextManager.getTabId() ?? undefined,
    tabLabel: tabLabel ?? contextManager.getTabLabel() ?? undefined,
    activeDeferredTools,
  });

  // Reorder tools: soul tools → LSP → core. Models prefer tools earlier in the list,
  // and soul tools are TIER-1 (cheapest, most informative). This ordering reinforces
  // the decision flow in the system prompt without adding tokens.
  const STABLE_ORDER = [
    // TIER-1: Soul tools (cheapest, graph-backed)
    "soul_grep",
    "soul_find",
    "soul_analyze",
    "soul_impact",
    // TIER-1: LSP tools
    "navigate",
    "analyze",
    // TIER-1: Core read/edit
    "read",
    "edit_file",
    "multi_edit",
    "project",
    // TIER-2: Search fallbacks
    "grep",
    "glob",
    "list_dir",
    // TIER-2: Shell & git
    "shell",
    "git",
    // TIER-3: Compound operations
    "refactor",
    "rename_symbol",
    "move_symbol",
    "rename_file",
    // Scaffolding & discovery
    "test_scaffold",
    "discover_pattern",
    // Web
    "web_search",
    "fetch_page",
    // Agent & interactive
    "dispatch",
    "plan",
    "update_plan_step",
    "ask_user",
    // Editor & session
    "editor",
    "task_list",
    "undo_edit",
    // Memory & skills
    "memory",
    "skills",
    // Tool management
    "request_tools",
    "release_tools",
    // Anthropic optional
    "code_execution",
    "web_fetch",
    "computer",
    "str_replace_based_edit_tool",
  ];
  const orderedTools: Record<string, unknown> = {};
  for (const name of STABLE_ORDER) {
    if (name in directTools) orderedTools[name] = (directTools as Record<string, unknown>)[name];
  }
  for (const [name, def] of Object.entries(directTools)) {
    if (!(name in orderedTools)) orderedTools[name] = def;
  }

  {
    const mcpTools = getMCPManager().getTools();
    for (const [name, def] of Object.entries(mcpTools)) {
      orderedTools[name] = def;
    }
  }

  // Spark mode: share the forge system prompt + tool definitions with subagents for prefix cache hits.
  // The Anthropic cache prefix is tools → system → messages. Sharing both tools AND instructions
  // means the entire [tools + system] prefix is a cache HIT on every spark's first step.
  // buildInstructions is WeakMap-cached, so this call is effectively free.
  const forgeInstructions = buildInstructions(contextManager, modelId);
  const forgeTools = orderedTools;

  // Doppelganger ref: mutable container updated by prepareStep on every forge step.
  // Spark mirror agents clone from this snapshot — they inherit the full conversation prefix
  // so the API sees an identical cache-hit prefix (tools + system + messages).
  const parentMessagesRef: { current: ModelMessage[] | null } = { current: null };

  // OpenAI prompt cache routing: session-level key co-locates requests sharing
  // the same prefix on the same backend, improving hit rates (~60% → ~87%).
  const subagentHeaders =
    detectModelFamily(modelId) === "openai" && sessionId
      ? { ...headers, "x-prompt-cache-key": sessionId }
      : headers;

  const subagentTools = isRestricted
    ? {
        dispatch: buildSubagentTools({
          defaultModel: model,
          sparkModel: subagentModels?.spark,
          webSearchModel,
          providerOptions,
          headers: subagentHeaders,
          onApproveWebSearch: effectiveApproveWebSearch,
          onApproveFetchPage: effectiveApproveFetchPage,
          readOnly: true,
          repoMap,
          sharedCacheRef,
          agentFeatures,
          skills,
          disablePruning,
          tabId: tabId ?? contextManager.getTabId() ?? undefined,
          forgeInstructions,
          forgeTools,
          parentMessagesRef,
        }).dispatch,
      }
    : buildSubagentTools({
        defaultModel: model,
        sparkModel: subagentModels?.spark,
        emberModel: subagentModels?.ember,
        desloppifyModel: subagentModels?.desloppify,
        verifyModel: subagentModels?.verify,
        webSearchModel,
        providerOptions,
        headers: subagentHeaders,
        onApproveWebSearch: effectiveApproveWebSearch,
        onApproveFetchPage: effectiveApproveFetchPage,
        repoMap,
        sharedCacheRef,
        agentFeatures,
        skills,
        disablePruning,
        tabId: tabId ?? contextManager.getTabId() ?? undefined,
        forgeInstructions,
        forgeTools,
        parentMessagesRef,
      });

  const canUseProgrammatic = canUseCodeExecution && toolVersions.programmaticToolCalling;
  const cachedReadFile =
    sharedCacheRef && agentFeatures?.dispatchCache !== false
      ? wrapReadFileWithDispatchCache(directTools.read, sharedCacheRef, cwd, canUseProgrammatic)
      : directTools.read;

  const allTools = {
    ...orderedTools,
    read: cachedReadFile,
    ...subagentTools,
    ...(interactive ? buildInteractiveTools(interactive, { cwd, sessionId, forgeMode }) : {}),
  };

  // Cache breakpoints: system prompt (via instructions) + first 2 messages.
  // Total: 3 breakpoints. The system+tools prefix is the biggest stable cache.

  const allToolNames = Object.keys(allTools) as (keyof typeof allTools)[];
  const restrictedSet = new Set(RESTRICTED_TOOL_NAMES);
  const planExecSet = new Set(PLAN_EXECUTION_TOOL_NAMES);

  const coreSet = activeDeferredTools ? new Set(CORE_TOOL_NAMES) : undefined;

  const computeActiveTools = (): (keyof typeof allTools)[] | undefined => {
    if (isRestricted) return allToolNames.filter((name) => restrictedSet.has(name));
    if (planExecution) return allToolNames.filter((name) => planExecSet.has(name));

    let names = allToolNames;

    // Agent-managed mode: only expose core tools + explicitly requested deferred tools
    if (activeDeferredTools && coreSet) {
      names = names.filter((name) => coreSet.has(name) || activeDeferredTools.has(name));
    }

    // User-disabled tools via /tools popup
    if (disabledTools && disabledTools.size > 0) {
      names = names.filter((name) => !disabledTools.has(name));
    }

    return names.length < allToolNames.length ? names : undefined;
  };

  const wrappedProviderOptions = {
    ...providerOptions,
    anthropic: {
      ...(((providerOptions as Record<string, unknown>)?.anthropic as Record<string, unknown>) ??
        {}),
      cacheControl: { type: "ephemeral" },
    },
  } as ProviderOptions;

  return new ToolLoopAgent({
    id: "forge",
    model,
    temperature: 0,
    // maxOutputTokens: 16384,
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
    prepareStep: buildForgePrepareStep(
      forgeMode === "plan",
      drainSteering,
      contextManager,
      tabId,
      canUseCodeExecution,
      parentMessagesRef,
    ),
    experimental_repairToolCall: repairToolCall,
    providerOptions: wrappedProviderOptions,
    ...(subagentHeaders ? { headers: subagentHeaders } : {}),
  });
}

function wrapReadFileWithDispatchCache(
  _original: ReturnType<typeof buildTools>["read"],
  cacheRef: SharedCacheRef,
  projectCwd?: string,
  codeExecution?: boolean,
) {
  const cwdPrefix = projectCwd ? (projectCwd.endsWith("/") ? projectCwd : `${projectCwd}/`) : null;

  // The main read tool in index.ts handles batch mode (files array, ranges, etc.).
  // This wrapper ONLY intercepts single-file full reads for dispatch cache hits.
  // Everything else passes through to the real tool.
  return tool({
    description: readFileTool.description,
    inputSchema: SCHEMAS.readFile,
    providerOptions: codeExecution ? PROGRAMMATIC_PROVIDER_OPTS : undefined,
    execute: async (args) => {
      const specs = Array.isArray(args.files) ? args.files : args.files ? [args.files] : [];

      // Only intercept single-file full reads (no ranges, no target, no multi-file)
      if (specs.length === 1 && !specs[0]?.ranges?.length && !specs[0]?.target) {
        const filePath = specs[0]?.path ?? "";
        const cache = cacheRef.current;
        if (cache && filePath) {
          let normalized = normalizePath(filePath);
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

      // Pass through: execute each file spec against the raw readFileTool
      const outputs: string[] = [];
      const multiFile = specs.length > 1;
      for (const spec of specs) {
        if (multiFile) outputs.push(`── ${spec.path} ──`);
        if (spec.ranges && spec.ranges.length > 0) {
          for (const r of spec.ranges) {
            const result = await readFileTool.execute({
              path: spec.path,
              startLine: r.start,
              endLine: r.end,
            });
            outputs.push(result.output);
          }
        } else {
          const result = await readFileTool.execute({
            path: spec.path,
            ...(spec.target ? { target: spec.target, name: spec.name } : {}),
          });
          outputs.push(result.output);
        }
      }
      return { success: true, output: outputs.join("\n\n") };
    },
  });
}
