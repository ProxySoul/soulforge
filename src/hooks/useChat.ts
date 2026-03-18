import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage, StreamTextResult, TextPart, ToolCallPart, ToolSet } from "ai";
import { generateText } from "ai";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamSegment } from "../components/StreamSegmentList.js";
import type { LiveToolCall } from "../components/ToolCallDisplay.js";
import { createForgeAgent } from "../core/agents/index.js";
import { smoothStreamOptions } from "../core/agents/stream-options.js";
import { onAgentStats, onMultiAgentEvent } from "../core/agents/subagent-events.js";
import type { SharedCacheRef } from "../core/agents/subagent-tools.js";
import {
  buildV2Summary,
  extractFromAssistantMessage,
  extractFromToolCall,
  extractFromToolResult,
  extractFromUserMessage,
  WorkingStateManager,
} from "../core/compaction/index.js";
import type { ContextManager } from "../core/context/manager.js";
import { setCoAuthorEnabled } from "../core/git/status.js";
import { getModelContextWindow, getShortModelLabel } from "../core/llm/models.js";
import { resolveModel } from "../core/llm/provider.js";
import {
  buildProviderOptions,
  degradeProviderOptions,
  isProviderOptionsError,
} from "../core/llm/provider-options.js";
import { detectTaskType, resolveTaskModel } from "../core/llm/task-router.js";
import { SessionManager } from "../core/sessions/manager.js";
import { createThinkingParser } from "../core/thinking-parser.js";
import { onFileEdited } from "../core/tools/file-events.js";
import { planFileName } from "../core/tools/index.js";
import { setShellCoAuthorEnabled } from "../core/tools/shell.js";
import { resetInProgressTasks } from "../core/tools/task-list.js";
import { logCompaction } from "../stores/compaction-logs.js";
import { logBackgroundError } from "../stores/errors.js";
import { useStatusBarStore } from "../stores/statusbar.js";
import type {
  AppConfig,
  ChatMessage,
  InteractiveCallbacks,
  MessageSegment,
  PendingPlanReview,
  PendingQuestion,
  Plan,
  PlanReviewAction,
  PlanStepStatus,
  QueuedMessage,
} from "../types/index.js";
import { buildSessionMeta } from "./useSessionBuilder.js";

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PATH_ARG_KEYS = new Set([
  "file",
  "path",
  "filePath",
  "file_path",
  "target_file",
  "source_file",
  "target",
]);

function reprimeContextFromMessages(cm: ContextManager, msgs: ModelMessage[]): void {
  try {
    for (const msg of msgs) {
      if (typeof msg.content === "string") {
        extractPathsFromText(msg.content, cm);
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (typeof part !== "object" || part === null) continue;
        const typed = part as { type?: string; text?: string; args?: Record<string, unknown> };
        if (typed.type === "tool-call" && typed.args && typeof typed.args === "object") {
          for (const [key, val] of Object.entries(typed.args)) {
            if (PATH_ARG_KEYS.has(key) && typeof val === "string" && val.length > 0) {
              cm.trackMentionedFile(val);
            }
            if (key === "files" && Array.isArray(val)) {
              for (const f of val) {
                if (typeof f === "string") cm.trackMentionedFile(f);
              }
            }
          }
        } else if ("text" in typed && typeof typed.text === "string") {
          extractPathsFromText(typed.text, cm);
        }
      }
    }
  } catch {
    // Best-effort — partial priming is better than crashing compaction/restore
  }
}

const BACKTICK_PATH_RE = /`([^`\s]+)`/g;

function extractPathsFromText(text: string, cm: ContextManager): void {
  if (text.length > 500_000) return;
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    if (match[1] && looksLikeFilePath(match[1])) {
      cm.trackMentionedFile(match[1]);
    }
  }
}

export function looksLikeFilePath(s: string): boolean {
  if (s.length < 3 || s.length > 300) return false;
  if (/[<>{}[\]|&;$!()@#=+]/.test(s)) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  if (/\s/.test(s)) return false;
  if (!s.includes("/")) return false;
  const lastDot = s.lastIndexOf(".");
  if (lastDot < 0) return false;
  const ext = s.slice(lastDot + 1);
  return ext.length > 0 && ext.length <= 10 && /^[a-zA-Z0-9]+$/.test(ext);
}

// ─── Types ───

export interface TabState {
  id: string;
  label: string;
  messages: ChatMessage[];
  coreMessages: ModelMessage[];
  activeModel: string;
  activePlan: Plan | null;
  sidebarPlan: Plan | null;
  tokenUsage: TokenUsage;
  coAuthorCommits: boolean;
  sessionId: string;
  planMode: boolean;
  planRequest: string | null;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  subagentInput: number;
  subagentOutput: number;
}

export const ZERO_USAGE: TokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
  cacheRead: 0,
  subagentInput: 0,
  subagentOutput: 0,
};

export interface WorkspaceSnapshot {
  forgeMode: import("../types/index.js").ForgeMode;
  tabStates: TabState[];
  activeTabId: string;
}

export interface UseChatOptions {
  effectiveConfig: AppConfig;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  cwd: string;
  openEditorWithFile: (file: string) => void;
  openEditor: () => void;
  onSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  initialState?: TabState;
  getWorkspaceSnapshot?: () => WorkspaceSnapshot;
  visible?: boolean;
}

export interface ChatInstance {
  // State
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  coreMessages: ModelMessage[];
  setCoreMessages: React.Dispatch<React.SetStateAction<ModelMessage[]>>;
  isLoading: boolean;
  isCompacting: boolean;
  streamSegments: StreamSegment[];
  liveToolCalls: LiveToolCall[];
  activePlan: Plan | null;
  setActivePlan: React.Dispatch<React.SetStateAction<Plan | null>>;
  sidebarPlan: Plan | null;
  setSidebarPlan: React.Dispatch<React.SetStateAction<Plan | null>>;
  pendingQuestion: PendingQuestion | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<PendingQuestion | null>>;
  messageQueue: QueuedMessage[];
  setMessageQueue: React.Dispatch<React.SetStateAction<QueuedMessage[]>>;
  activeModel: string;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  coAuthorCommits: boolean;
  setCoAuthorCommits: React.Dispatch<React.SetStateAction<boolean>>;
  tokenUsage: TokenUsage;
  setTokenUsage: React.Dispatch<React.SetStateAction<TokenUsage>>;
  contextTokens: number;
  lastStepOutput: number;
  chatChars: number;
  sessionId: string;
  planFile: string;
  planMode: boolean;
  planRequest: string | null;
  // Actions
  handleSubmit: (input: string) => Promise<void>;
  summarizeConversation: (opts?: { skipQueueDrain?: boolean }) => Promise<void>;
  abort: () => void;
  interactiveCallbacks: InteractiveCallbacks;
  // Plan mode
  setPlanMode: (on: boolean) => void;
  setPlanRequest: (req: string | null) => void;
  pendingPlanReview: PendingPlanReview | null;
  setPendingPlanReview: React.Dispatch<React.SetStateAction<PendingPlanReview | null>>;
  snapshot: (label: string) => TabState;
  contextManager: ContextManager;
}

export function useChat({
  effectiveConfig,
  contextManager,
  sessionManager,
  cwd,
  openEditorWithFile,
  openEditor,
  initialState,
  getWorkspaceSnapshot,
  visible = true,
}: UseChatOptions): ChatInstance {
  const [messages, setMessages] = useState<ChatMessage[]>(initialState?.messages ?? []);
  const [coreMessages, setCoreMessages] = useState<ModelMessage[]>(
    initialState?.coreMessages ?? [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const streamSegmentsBuffer = useRef<StreamSegment[]>([]);
  const liveToolCallsBuffer = useRef<LiveToolCall[]>([]);
  const pendingTokenUsage = useRef<TokenUsage | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const segmentsDirty = useRef(false);
  const toolCallsDirty = useRef(false);
  const lastFlushedSegments = useRef<StreamSegment[]>([]);
  const lastFlushedToolCalls = useRef<LiveToolCall[]>([]);
  const lastFlushedStreamingChars = useRef(0);
  const flushStreamState = useCallback(() => {
    startTransition(() => {
      if (segmentsDirty.current) {
        const buf = streamSegmentsBuffer.current;
        const prev = lastFlushedSegments.current;
        let changed = buf.length !== prev.length;
        const next: StreamSegment[] = new Array(buf.length);
        for (let i = 0; i < buf.length; i++) {
          const s = buf[i] as StreamSegment;
          const p = prev[i];
          if (p && s.type === p.type) {
            let same = false;
            if (s.type === "text" && p.type === "text") {
              same = s.content === p.content;
            } else if (s.type === "reasoning" && p.type === "reasoning") {
              same = s.content === p.content && s.id === p.id && s.done === p.done;
            } else if (s.type === "tools" && p.type === "tools") {
              same =
                s.callIds.length === p.callIds.length &&
                s.callIds.every((id, j) => id === p.callIds[j]);
            }
            if (same) {
              next[i] = p;
              continue;
            }
          }
          changed = true;
          next[i] = s.type === "tools" ? { ...s, callIds: [...s.callIds] } : { ...s };
        }
        if (changed) {
          lastFlushedSegments.current = next;
          setStreamSegments(next);
        }
        segmentsDirty.current = false;
      }
      if (toolCallsDirty.current) {
        const buf = liveToolCallsBuffer.current;
        const prev = lastFlushedToolCalls.current;
        let changed = buf.length !== prev.length;
        const next: LiveToolCall[] = new Array(buf.length);
        for (let i = 0; i < buf.length; i++) {
          const tc = buf[i] as LiveToolCall;
          const p = prev[i];
          if (
            p &&
            tc.id === p.id &&
            tc.toolName === p.toolName &&
            tc.state === p.state &&
            tc.args === p.args &&
            tc.result === p.result &&
            tc.error === p.error
          ) {
            next[i] = p;
            continue;
          }
          changed = true;
          next[i] = { ...tc };
        }
        if (changed) {
          lastFlushedToolCalls.current = next;
          setLiveToolCalls(next);
        }
        toolCallsDirty.current = false;
      }
      const tu = pendingTokenUsage.current;
      if (tu) {
        setTokenUsageRaw(tu);
        if (visibleRef.current) useStatusBarStore.getState().setTokenUsage(tu);
        pendingTokenUsage.current = null;
      }
      const ct = pendingContextTokens.current;
      if (ct !== null) {
        setContextTokens(ct);
        pendingContextTokens.current = null;
      }
      const so = pendingLastStepOutput.current;
      if (so !== null) {
        setLastStepOutput(so);
        pendingLastStepOutput.current = null;
      }
      const nextChars = streamingCharsRef.current + toolCharsRef.current;
      if (nextChars !== lastFlushedStreamingChars.current) {
        lastFlushedStreamingChars.current = nextChars;
        setStreamingChars(nextChars);
      }
    });
  }, []);

  const flushMicrotaskQueued = useRef(false);
  const flushMicrotaskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTime = useRef(0);
  const queueMicrotaskFlush = useCallback(() => {
    if (flushMicrotaskQueued.current) return;
    flushMicrotaskQueued.current = true;
    flushMicrotaskTimer.current = setTimeout(() => {
      flushMicrotaskQueued.current = false;
      flushMicrotaskTimer.current = null;
      lastFlushTime.current = Date.now();
      flushStreamState();
    }, 0);
  }, [flushStreamState]);

  // Clean up pending microtask flush on unmount
  useEffect(() => {
    return () => {
      if (flushMicrotaskTimer.current) {
        clearTimeout(flushMicrotaskTimer.current);
        flushMicrotaskTimer.current = null;
      }
    };
  }, []);

  // Interactive state
  const abortRef = useRef<AbortController | null>(null);
  const autoApproveWebAccessRef = useRef(false);
  const webAccessMutexRef = useRef<Promise<void>>(Promise.resolve());
  const autoApproveOutsideCwdRef = useRef(false);
  const outsideCwdMutexRef = useRef<Promise<void>>(Promise.resolve());
  const webSearchModelLabelRef = useRef<string | null>(null);
  const [activePlan, setActivePlanRaw] = useState<Plan | null>(initialState?.activePlan ?? null);
  const activePlanRef = useRef<Plan | null>(activePlan);
  const setActivePlan = useCallback<typeof setActivePlanRaw>((v) => {
    if (typeof v === "function") {
      setActivePlanRaw((prev) => {
        const next = v(prev);
        activePlanRef.current = next;
        return next;
      });
    } else {
      activePlanRef.current = v;
      setActivePlanRaw(v);
    }
  }, []);
  const [sidebarPlan, setSidebarPlan] = useState<Plan | null>(initialState?.sidebarPlan ?? null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const messageQueueRef = useRef<QueuedMessage[]>([]);
  messageQueueRef.current = messageQueue;
  const steeringAbortedRef = useRef(false);
  const abortedSegmentsSnapshot = useRef<StreamSegment[]>([]);
  const abortedToolCallsSnapshot = useRef<LiveToolCall[]>([]);

  // LLM state
  const [activeModel, setActiveModel] = useState(
    initialState?.activeModel ?? effectiveConfig.defaultModel,
  );
  const [coAuthorCommits, setCoAuthorCommits] = useState(initialState?.coAuthorCommits ?? true);

  // Sync co-author flag with git module + shell interceptor
  useEffect(() => {
    setCoAuthorEnabled(coAuthorCommits);
    setShellCoAuthorEnabled(coAuthorCommits);
  }, [coAuthorCommits]);

  // Sync context window size to contextManager + status bar store.
  // Pin per model — never downgrade if API cache expires (prevents 1M→200k drop).
  const contextManagerRef = useRef(contextManager);
  contextManagerRef.current = contextManager;
  const pinnedContextWindow = useRef(new Map<string, number>());
  useEffect(() => {
    const cached = pinnedContextWindow.current.get(activeModel);
    const fresh = getModelContextWindow(activeModel);
    const windowTokens = cached ? Math.max(cached, fresh) : fresh;
    pinnedContextWindow.current.set(activeModel, windowTokens);
    contextManagerRef.current.setContextWindow(windowTokens);
    if (visible) useStatusBarStore.getState().setContextWindow(windowTokens);
  }, [activeModel, visible]);

  const [tokenUsage, setTokenUsageRaw] = useState<TokenUsage>(
    initialState?.tokenUsage ?? { ...ZERO_USAGE },
  );
  const sessionIdRef = useRef<string>(initialState?.sessionId ?? crypto.randomUUID());
  const sharedCacheRef = useRef<SharedCacheRef>(
    (() => {
      const ref: SharedCacheRef = {
        current: undefined,
        entity: { warnings: 0, lastWarningStep: 0, cleanSteps: 0 },
        updateFile(absPath: string, content: string) {
          if (!ref.current) return;
          const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
          const rel = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
          ref.current.files.set(rel, content);
          for (const key of ref.current.toolResults.keys()) {
            if (key.includes(rel)) ref.current.toolResults.delete(key);
          }
        },
      };
      return ref;
    })(),
  );

  useEffect(() => {
    return onFileEdited((absPath, content) => sharedCacheRef.current.updateFile(absPath, content));
  }, []);

  // Streaming token estimation
  const streamingCharsRef = useRef(0);
  const toolCharsRef = useRef(0);
  const [streamingChars, setStreamingChars] = useState(0);
  const baseTokenUsageRef = useRef<TokenUsage>({ ...ZERO_USAGE });
  const tokenUsageRef = useRef(tokenUsage);
  tokenUsageRef.current = tokenUsage;

  // Latest step's tokens = actual context size + generation reported by the API
  const [contextTokens, setContextTokens] = useState(0);
  const [lastStepOutput, setLastStepOutput] = useState(0);
  const pendingContextTokens = useRef<number | null>(null);
  const pendingLastStepOutput = useRef<number | null>(null);

  const setTokenUsage: typeof setTokenUsageRaw = useCallback((action) => {
    setTokenUsageRaw((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      if (next.total === 0 || next.total < prev.total) {
        baseTokenUsageRef.current = { ...next };
        streamingCharsRef.current = 0;
        toolCharsRef.current = 0;
        if (next.total === 0) {
          setContextTokens(0);
          setStreamingChars(0);
        }
      }
      if (visibleRef.current) useStatusBarStore.getState().setTokenUsage(next);
      return next;
    });
  }, []);

  // Plan mode
  const [pendingPlanReview, setPendingPlanReview] = useState<PendingPlanReview | null>(null);
  const planPostActionRef = useRef<{
    action: "execute" | "clear_execute" | "cancel" | "revise";
    planContent: string | null;
    plan?: Plan;
    reviseFeedback?: string;
  } | null>(null);
  const planModeRef = useRef(initialState?.planMode ?? false);
  const planRequestRef = useRef<string | null>(initialState?.planRequest ?? null);
  const planExecutionRef = useRef(false);

  const coreCharsCache = useRef({ len: 0, chars: 0 });
  const coreChars = useMemo(() => {
    const cache = coreCharsCache.current;
    let sum = cache.len <= coreMessages.length ? cache.chars : 0;
    const start = cache.len <= coreMessages.length ? cache.len : 0;
    for (let i = start; i < coreMessages.length; i++) {
      const m = coreMessages[i] as ModelMessage;
      if (typeof m.content === "string") {
        sum += m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          sum +=
            typeof part === "object" && part !== null && "text" in part
              ? String((part as { text: string }).text).length
              : JSON.stringify(part).length;
        }
      }
    }
    coreCharsCache.current = { len: coreMessages.length, chars: sum };
    return sum;
  }, [coreMessages]);

  const chatChars = coreChars + streamingChars;

  useEffect(() => {
    if (visible) useStatusBarStore.getState().setContext(contextTokens, chatChars);
  }, [contextTokens, chatChars, visible]);

  const coreMessagesRef = useRef(coreMessages);
  coreMessagesRef.current = coreMessages;
  const activeModelRef = useRef(activeModel);
  activeModelRef.current = activeModel;
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);
  const compactAbortRef = useRef<AbortController | null>(null);
  const pendingCompactRef = useRef(false);
  const initialStrategy = effectiveConfig.compaction?.strategy ?? "v1";
  const workingStateRef = useRef<WorkingStateManager | null>(
    initialStrategy === "v2" ? new WorkingStateManager(effectiveConfig.compaction) : null,
  );

  // Rehydrate v2 working state from restored session messages
  const didRehydrate = useRef(false);
  if (!didRehydrate.current && workingStateRef.current && initialState?.coreMessages?.length) {
    didRehydrate.current = true;
    const wsm = workingStateRef.current;
    for (const msg of initialState.coreMessages) {
      if (msg.role === "user") {
        extractFromUserMessage(wsm, msg);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        extractFromAssistantMessage(wsm, msg);
        for (const part of msg.content) {
          if (typeof part === "object" && "type" in part && part.type === "tool-call") {
            const tc = part as { toolName: string; input: Record<string, unknown> };
            extractFromToolCall(wsm, tc.toolName, tc.input);
          }
        }
      } else if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "object" && "type" in part && part.type === "tool-result") {
            const tr = part as { toolName: string; output: unknown };
            extractFromToolResult(wsm, tr.toolName, tr.output);
          }
        }
      }
    }
  }
  const prevCompactionStrategy = useRef(effectiveConfig.compaction?.strategy);

  // Sync store on mount (useRef initializer doesn't trigger the change block)
  const didInitCompaction = useRef(false);
  if (!didInitCompaction.current) {
    didInitCompaction.current = true;
    if (visible) useStatusBarStore.getState().setCompactionStrategy(initialStrategy);
  }

  // React to compaction strategy changes: create/destroy WSM as needed
  if (effectiveConfig.compaction?.strategy !== prevCompactionStrategy.current) {
    prevCompactionStrategy.current = effectiveConfig.compaction?.strategy;
    const strategy = effectiveConfig.compaction?.strategy ?? "v1";
    if (visible) useStatusBarStore.getState().setCompactionStrategy(strategy);
    logCompaction("strategy-change", `Strategy → ${strategy}`);
    if (strategy === "v2") {
      workingStateRef.current = new WorkingStateManager(effectiveConfig.compaction);
    } else {
      workingStateRef.current = null;
      if (visible) useStatusBarStore.getState().setV2Slots(0);
    }
  }

  const syncV2SlotsRef = useRef(() => {
    if (workingStateRef.current && visibleRef.current) {
      useStatusBarStore.getState().setV2Slots(workingStateRef.current.slotCount());
    }
  });
  const syncV2Slots = syncV2SlotsRef.current;

  const handleSubmitRef = useRef<(input: string) => void>(() => {});
  const summarizeConversationRef = useRef<(opts?: { skipQueueDrain?: boolean }) => Promise<void>>(
    async () => {},
  );

  const summarizeConversation = useCallback(
    async (opts?: { skipQueueDrain?: boolean }) => {
      if (isCompactingRef.current) return;

      // If a generation is in progress, defer compact until it settles
      if (abortRef.current) {
        pendingCompactRef.current = true;
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Compact queued — will run after current generation settles, then continue.",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      const currentCore = coreMessagesRef.current;
      if (currentCore.length < 4) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Not enough conversation to compact (need at least 4 messages).",
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      isCompactingRef.current = true;
      setIsCompacting(true);
      if (visibleRef.current) useStatusBarStore.getState().setCompacting(true);

      const compactAbort = new AbortController();
      compactAbortRef.current = compactAbort;
      const startTime = Date.now();
      const compactTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (visibleRef.current) useStatusBarStore.getState().setCompactElapsed(elapsed);
      }, 1000);

      try {
        const compactModelId = resolveTaskModel(
          "compact",
          effectiveConfig.taskRouter,
          activeModelRef.current,
        );
        const model = resolveModel(compactModelId);
        const modelLabel = getShortModelLabel(compactModelId);

        const contextWindow = getModelContextWindow(activeModelRef.current);
        const charsPerToken = 3;
        const systemChars = contextManager
          .getContextBreakdown()
          .reduce((sum, s) => sum + s.chars, 0);
        const beforeChars =
          systemChars +
          currentCore.reduce((s, m) => {
            if (typeof m.content === "string") return s + m.content.length;
            if (Array.isArray(m.content))
              return (
                s +
                m.content.reduce((a: number, p: unknown) => {
                  if (typeof p === "object" && p !== null && "text" in p)
                    return a + String((p as { text: string }).text).length;
                  if (typeof p === "string") return a + p.length;
                  return a + 100;
                }, 0)
              );
            return s;
          }, 0);
        const beforePct = Math.round((beforeChars / charsPerToken / contextWindow) * 100);

        const compactionCfg = effectiveConfig.compaction;
        const isV2 = compactionCfg?.strategy === "v2";
        const KEEP_RECENT = compactionCfg?.keepRecent ?? 4;
        let keepStart = Math.max(0, currentCore.length - KEEP_RECENT);
        // Never split between assistant tool-call and its tool-result pair
        while (keepStart > 0 && currentCore[keepStart]?.role === "tool") {
          keepStart--;
        }
        // After ackMsg (assistant), recentMessages must start with "user" to maintain alternation.
        // If it starts with "assistant", back up one more to include the preceding user message.
        if (keepStart > 0 && currentCore[keepStart]?.role === "assistant") {
          keepStart--;
        }
        const olderMessages = currentCore.slice(0, keepStart);
        const recentMessages = currentCore.slice(keepStart);

        if (olderMessages.length < 2) {
          isCompactingRef.current = false;
          setIsCompacting(false);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                "Not enough older messages to compact (recent messages are already preserved).",
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        const strategyLabel = isV2 ? "v2 incremental" : modelLabel;
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Compacting ${olderMessages.length} messages with ${strategyLabel}...`,
            timestamp: Date.now(),
          },
        ]);

        const planContext = (() => {
          const plan = activePlanRef.current;
          if (!plan) return "";
          const lines = [`\n## Active Plan: ${plan.title}`];
          for (const step of plan.steps) {
            const icon =
              step.status === "done"
                ? "✓"
                : step.status === "active"
                  ? "▸"
                  : step.status === "skipped"
                    ? "⊘"
                    : "○";
            lines.push(`  ${icon} [${step.id}] ${step.label} — ${step.status}`);
          }
          return lines.join("\n");
        })();

        const { providerOptions, headers } = buildProviderOptions(compactModelId, effectiveConfig);

        let summary: string;

        if (isV2 && workingStateRef.current) {
          // ─── V2: Incremental structured extraction ───
          // The working state was built incrementally during the conversation.
          // Inject plan context if active, then serialize + optional gap-fill.
          const wsm = workingStateRef.current;
          if (activePlanRef.current) {
            wsm.setPlan(
              activePlanRef.current.steps.map((s) => ({
                id: s.id,
                label: s.label,
                status: s.status,
              })),
            );
          }
          summary = await buildV2Summary({
            wsm,
            olderMessages,
            model: compactionCfg?.llmExtraction !== false ? model : undefined,
            providerOptions,
            headers,
            skipLlm: compactionCfg?.llmExtraction === false,
            abortSignal: compactAbort.signal,
          });
          wsm.reset();
        } else {
          // ─── V1: Full LLM batch summarization ───
          const formatMessage = (m: ModelMessage, charLimit: number) => {
            const role = m.role;
            if (typeof m.content === "string") {
              return `${role}: ${m.content.slice(0, charLimit)}`;
            }
            if (Array.isArray(m.content)) {
              const parts = m.content
                .map((p) => {
                  if (typeof p === "object" && p !== null) {
                    if ("text" in p)
                      return String((p as { text: string }).text).slice(0, charLimit);
                    if ("type" in p && (p as { type: string }).type === "tool-result") {
                      const tr = p as { toolName?: string; result?: unknown };
                      const resultStr = tr.result != null ? JSON.stringify(tr.result) : "null";
                      return `[tool-result: ${tr.toolName ?? "unknown"} → ${resultStr.slice(0, 8000)}]`;
                    }
                  }
                  return JSON.stringify(p).slice(0, 3000);
                })
                .join("\n");
              return `${role}: ${parts}`;
            }
            return `${role}: [complex content]`;
          };

          const convoText = olderMessages.map((m) => formatMessage(m, 6000)).join("\n\n");

          const { text: v1Summary } = await generateText({
            model,
            maxOutputTokens: 8192,
            abortSignal: compactAbort.signal,
            ...(providerOptions && Object.keys(providerOptions).length > 0
              ? { providerOptions }
              : {}),
            ...(headers ? { headers } : {}),
            prompt: [
              "You are compacting the OLDER portion of a coding assistant conversation.",
              "The most recent messages will be preserved verbatim — focus on summarizing what came before.",
              "",
              "Create a structured summary with these sections:",
              "",
              "## Environment",
              "Project type, key technologies, working directory, any config details mentioned.",
              "",
              "## Files Touched",
              "Every file path that was read, edited, or created. For EDITS: include the specific old→new changes (function signatures, variable names, logic). For READS: note key content found.",
              "",
              "## Tool Results",
              "Key tool results that inform future decisions: grep matches, test output, diagnostics, build errors. Include literal output where it matters — don't just say 'tests passed', say which tests and any warnings.",
              "",
              "## Key Decisions",
              "Architectural choices, design patterns chosen, trade-offs discussed.",
              "",
              "## Work Completed",
              "What was accomplished. Include specific function names, variable names, code patterns.",
              "",
              "## Errors & Resolutions",
              "Problems encountered and how they were resolved. Include the actual error messages.",
              "",
              "## Current State",
              "What was being worked on at the end of this section. What remains to be done.",
              planContext
                ? `\n${planContext}\nINCLUDE the plan progress above VERBATIM in ## Current State so the agent knows which steps are done/active/pending.`
                : "",
              "",
              "Be thorough — this summary is the only record of the older conversation.",
              "CRITICAL: Preserve specific details from tool results (file contents, error messages, test output). Generic summaries like 'edited file X' are useless — include WHAT was changed.",
              "",
              "CONVERSATION TO SUMMARIZE:",
              convoText,
            ].join("\n"),
          });
          summary = v1Summary;
        }

        if (!summary || summary.trim().length < 50) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                "Compaction produced an empty or too-short summary — aborting to preserve context.",
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        const summaryMsg: ModelMessage = {
          role: "user" as const,
          content: [
            "[CONTEXT COMPACTION — Summary of earlier conversation]",
            "",
            summary,
            "",
            "[End of compacted context. Recent messages follow.]",
          ].join("\n"),
        };

        const ackMsg: ModelMessage = {
          role: "assistant" as const,
          content:
            "Understood. I have the context from our earlier conversation and will continue seamlessly.",
        };

        const newMessages = [summaryMsg, ackMsg, ...recentMessages];
        setCoreMessages(newMessages);

        const trackedFiles = contextManager.getTrackedFiles();
        contextManager.resetConversationTracking();
        for (const f of trackedFiles.edited) {
          try {
            contextManager.onFileChanged(f);
          } catch {
            // File may have been deleted — skip re-tracking
          }
        }
        for (const f of trackedFiles.mentioned) contextManager.trackMentionedFile(f);
        reprimeContextFromMessages(contextManager, recentMessages);

        const newCoreChars = newMessages.reduce((sum, m) => {
          if (typeof m.content === "string") return sum + m.content.length;
          if (Array.isArray(m.content)) {
            return (
              sum + m.content.reduce((s: number, p: unknown) => s + JSON.stringify(p).length, 0)
            );
          }
          return sum;
        }, 0);
        const afterChars = systemChars + newCoreChars;
        const afterPct = Math.round((afterChars / charsPerToken / contextWindow) * 100);
        const estimatedTokens = Math.ceil(afterChars / charsPerToken);
        setContextTokens(0);
        setStreamingChars(0);
        setTokenUsage({ ...ZERO_USAGE, prompt: estimatedTokens, total: estimatedTokens });

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Context compacted: ${beforePct}% → ${afterPct}%\n${currentCore.length} messages summarized into ${newMessages.length} (summary + ${recentMessages.length} recent). Messages above are no longer in context.`,
            timestamp: Date.now(),
            showInChat: true,
          },
        ]);

        logCompaction("compact", `${beforePct}% → ${afterPct}%`, {
          model: modelLabel,
          strategy: isV2 ? "v2" : "v1",
          slotsBefore:
            isV2 && workingStateRef.current ? workingStateRef.current.slotCount() : undefined,
          contextBefore: `${beforePct}%`,
          contextAfter: `${afterPct}%`,
          messagesBefore: currentCore.length,
          messagesAfter: newMessages.length,
          summaryLength: summary.length,
          summarySnippet: summary.slice(0, 2000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logBackgroundError("compact", msg);
        logCompaction("error", msg);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Failed to compact: ${msg}`,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        clearInterval(compactTimer);
        compactAbortRef.current = null;
        isCompactingRef.current = false;
        setIsCompacting(false);
        if (visibleRef.current) useStatusBarStore.getState().setCompacting(false);
        if (!opts?.skipQueueDrain) {
          setMessageQueue((queue) => {
            if (queue.length > 0) {
              const [next, ...rest] = queue;
              if (next) {
                setTimeout(() => handleSubmitRef.current(next.content), 0);
              }
              return rest;
            }
            return queue;
          });
        }
      }
    },
    [setTokenUsage, effectiveConfig, contextManager],
  );
  summarizeConversationRef.current = summarizeConversation;

  const autoSummarizedRef = useRef(false);
  useEffect(() => {
    if (activeModelRef.current === "none") return;
    if (contextTokens <= 0) return;
    const ctxWindow = getModelContextWindow(activeModelRef.current);
    const pct = contextTokens / ctxWindow;
    const triggerAt = effectiveConfig.compaction?.triggerThreshold ?? 0.7;
    const resetAt = effectiveConfig.compaction?.resetThreshold ?? 0.4;
    if (pct > triggerAt && !autoSummarizedRef.current && coreMessagesRef.current.length >= 6) {
      autoSummarizedRef.current = true;
      const strategy = effectiveConfig.compaction?.strategy === "v2" ? "v2" : "v1";
      logCompaction(
        "auto-trigger",
        `Context at ${Math.round(pct * 100)}% — strategy: ${strategy}`,
        {
          contextBefore: `${Math.round(pct * 100)}%`,
          messagesBefore: coreMessagesRef.current.length,
        },
      );
      summarizeConversation();
    }
    if (pct < resetAt) {
      autoSummarizedRef.current = false;
    }
  }, [
    contextTokens,
    summarizeConversation,
    effectiveConfig.compaction?.triggerThreshold,
    effectiveConfig.compaction?.resetThreshold,
    effectiveConfig.compaction?.strategy,
  ]);

  const promptWebAccess = useCallback((label: string): Promise<boolean> => {
    if (autoApproveWebAccessRef.current) return Promise.resolve(true);
    const result = webAccessMutexRef.current.then(() => {
      if (autoApproveWebAccessRef.current) return true;
      return new Promise<boolean>((resolve) => {
        setPendingQuestion({
          id: crypto.randomUUID(),
          question: `Forge wants to access the web:\n\n${label}`,
          options: [
            { label: "Allow", value: "allow", description: "Allow this request" },
            {
              label: "Always Allow",
              value: "always",
              description: "Auto-approve all web access this session",
            },
            { label: "Deny", value: "deny", description: "Block this request" },
          ],
          allowSkip: false,
          resolve: (answer: string) => {
            setPendingQuestion(null);
            const allowed = answer === "allow" || answer === "always";
            if (answer === "always") autoApproveWebAccessRef.current = true;
            resolve(allowed);
          },
        });
      });
    });
    webAccessMutexRef.current = result.then(() => {});
    return result;
  }, []);

  const promptOutsideCwd = useCallback((toolName: string, path: string): Promise<boolean> => {
    if (autoApproveOutsideCwdRef.current) return Promise.resolve(true);
    const result = outsideCwdMutexRef.current.then(() => {
      if (autoApproveOutsideCwdRef.current) return true;
      return new Promise<boolean>((resolve) => {
        setPendingQuestion({
          id: crypto.randomUUID(),
          question: `Forge wants to ${toolName} outside project directory:\n\n${path}`,
          options: [
            { label: "Allow", value: "allow", description: "Allow this action" },
            {
              label: "Always Allow",
              value: "always",
              description: "Auto-approve all outside-cwd actions this session",
            },
            { label: "Deny", value: "deny", description: "Block this action" },
          ],
          allowSkip: false,
          resolve: (answer: string) => {
            setPendingQuestion(null);
            const allowed = answer === "allow" || answer === "always";
            if (answer === "always") autoApproveOutsideCwdRef.current = true;
            resolve(allowed);
          },
        });
      });
    });
    outsideCwdMutexRef.current = result.then(() => {});
    return result;
  }, []);

  const promptDestructive = useCallback((description: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPendingQuestion({
        id: crypto.randomUUID(),
        question: `⚠ Potentially destructive action:\n\n${description}`,
        options: [
          { label: "Allow", value: "allow", description: "Allow this action" },
          { label: "Deny", value: "deny", description: "Block this action" },
        ],
        allowSkip: false,
        resolve: (answer: string) => {
          setPendingQuestion(null);
          resolve(answer === "allow");
        },
      });
    });
  }, []);

  // Interactive callbacks for plan/question tools
  const interactiveCallbacks = useMemo<InteractiveCallbacks>(
    () => ({
      onPlanCreate: (plan: Plan) => {
        setActivePlan(plan);
        setSidebarPlan(plan);
      },
      onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => {
        const updater = (prev: Plan | null) => {
          if (!prev) return prev;
          return {
            ...prev,
            steps: prev.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
          };
        };
        setActivePlan(updater);
        setSidebarPlan(updater);
      },
      onPlanReview: (plan: Plan, planFile: string, planContent: string) => {
        return new Promise<PlanReviewAction>((resolve) => {
          setPendingPlanReview({
            plan,
            planFile,
            planContent,
            resolve: (action: PlanReviewAction) => {
              setPendingPlanReview(null);

              if (action === "execute" || action === "clear_execute") {
                let content: string | null = null;
                try {
                  content = readFileSync(
                    join(cwd, ".soulforge", "plans", planFileName(sessionIdRef.current)),
                    "utf-8",
                  );
                } catch {
                  content = planContent;
                }
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant" as const,
                    content: `Plan: ${plan.title}`,
                    timestamp: Date.now(),
                    segments: [{ type: "plan" as const, plan }],
                  },
                ]);
                planPostActionRef.current = {
                  action: action === "clear_execute" ? "clear_execute" : "execute",
                  planContent: content,
                  plan,
                };
              } else if (action === "cancel") {
                planPostActionRef.current = { action: "cancel", planContent: null, plan };
              } else {
                planPostActionRef.current = {
                  action: "revise",
                  planContent: null,
                  reviseFeedback: action,
                };
              }

              resolve(action);
              abortRef.current?.abort();
            },
          });
        });
      },
      onAskUser: (question, options, allowSkip) => {
        return new Promise<string>((resolve) => {
          setPendingQuestion({
            id: crypto.randomUUID(),
            question,
            options,
            allowSkip,
            resolve: (answer) => {
              setPendingQuestion(null);
              resolve(answer);
            },
          });
        });
      },
      onOpenEditor: async (file?: string) => {
        if (file) {
          openEditorWithFile(file);
        } else {
          openEditor();
        }
      },
      onWebSearchApproval: (query: string) => promptWebAccess(`Search: "${query}"`),
      onFetchPageApproval: (url: string) => promptWebAccess(`Fetch: ${url}`),
    }),
    [openEditor, openEditorWithFile, cwd, setActivePlan, promptWebAccess],
  );

  const handleSubmit = useCallback(
    async (input: string) => {
      if (activeModelRef.current === "none") {
        const hint: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "No model selected. Press **Ctrl+L** or type **/model** to choose a provider and model.",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, hint]);
        return;
      }

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const currentCoreMessages = coreMessagesRef.current;
      const userCoreMsg: ModelMessage = { role: "user" as const, content: input };
      const newCoreMessages: ModelMessage[] = [...currentCoreMessages, userCoreMsg];
      setCoreMessages(newCoreMessages);

      if (workingStateRef.current) {
        extractFromUserMessage(workingStateRef.current, userCoreMsg);
        syncV2Slots();
      }

      const estimatedTokens = tokenUsageRef.current.total;
      contextManager.updateConversationContext(input, estimatedTokens);

      setIsLoading(true);
      setPendingPlanReview(null);
      streamSegmentsBuffer.current = [];
      liveToolCallsBuffer.current = [];
      lastFlushedSegments.current = [];
      lastFlushedToolCalls.current = [];
      lastFlushedStreamingChars.current = 0;
      setStreamSegments([]);
      setLiveToolCalls([]);
      if (!planExecutionRef.current) setActivePlan(null);
      setPendingQuestion(null);

      // Capture pre-stream token baseline for live estimation
      streamingCharsRef.current = 0;
      toolCharsRef.current = 0;
      const currentUsage = tokenUsageRef.current;
      baseTokenUsageRef.current = { ...currentUsage };

      // Abort controller for Ctrl+X
      const abortController = new AbortController();
      abortRef.current = abortController;

      let fullText = "";
      let lastIncrementalSave = 0;
      const completedCalls: import("../types/index.js").ToolCall[] = [];
      const finalSegments: MessageSegment[] = [];

      // Track subagent token usage and aggregate into the main total
      const subagentCumulative = new Map<string, { input: number; output: number }>();
      const completedResultChars = new Map<string, number>();

      // All values in chars for consistent units with ContextBar (divides by CHARS_PER_TOKEN)
      const updateSubagentChars = () => {
        let total = 0;
        for (const chars of completedResultChars.values()) total += chars;
        for (const [id, stats] of subagentCumulative) {
          if (!completedResultChars.has(id)) total += stats.output * 4;
        }
        if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(total);
      };

      const unsubAgentStats = onAgentStats((event) => {
        const prev = subagentCumulative.get(event.agentId) ?? { input: 0, output: 0 };
        const deltaIn = event.tokenUsage.input - prev.input;
        const deltaOut = event.tokenUsage.output - prev.output;
        subagentCumulative.set(event.agentId, {
          input: event.tokenUsage.input,
          output: event.tokenUsage.output,
        });
        if (deltaIn > 0 || deltaOut > 0) {
          const base = baseTokenUsageRef.current;
          const newUsage: TokenUsage = {
            ...base,
            total: base.total + deltaIn + deltaOut,
            subagentInput: base.subagentInput + deltaIn,
            subagentOutput: base.subagentOutput + deltaOut,
          };
          pendingTokenUsage.current = newUsage;
          baseTokenUsageRef.current = newUsage;
          updateSubagentChars();
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
      });

      const unsubMultiAgent = onMultiAgentEvent((event) => {
        if (event.type === "agent-done" && event.agentId) {
          completedResultChars.set(event.agentId, event.resultChars ?? 0);
          updateSubagentChars();
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
        if (event.type === "dispatch-done") {
          completedResultChars.clear();
          subagentCumulative.clear();
          if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(0);
          toolCallsDirty.current = true;
          queueMicrotaskFlush();
        }
      });

      // Steering messages are now flushed immediately in drainSteering —
      // no longer accumulated and appended at the end.

      try {
        const taskType = detectTaskType(input);
        const modelId = resolveTaskModel(
          taskType,
          effectiveConfig.taskRouter,
          activeModelRef.current,
        );
        const model = resolveModel(modelId);

        // Resolve subagent models from task router
        const tr = effectiveConfig.taskRouter;
        const explorationModelId = tr?.exploration ?? undefined;
        const codingModelId = tr?.coding ?? undefined;
        const webSearchModelId = tr?.webSearch ?? undefined;
        const trivialModelId = tr?.trivial ?? undefined;
        const desloppifyModelId = tr?.desloppify ?? undefined;
        const verifyModelId = tr?.verify ?? undefined;
        const hasSubagentModels =
          explorationModelId ||
          codingModelId ||
          trivialModelId ||
          desloppifyModelId ||
          verifyModelId;
        const subagentModels = hasSubagentModels
          ? {
              exploration: explorationModelId ? resolveModel(explorationModelId) : undefined,
              coding: codingModelId ? resolveModel(codingModelId) : undefined,
              trivial: trivialModelId ? resolveModel(trivialModelId) : undefined,
              desloppify: desloppifyModelId ? resolveModel(desloppifyModelId) : undefined,
              verify: verifyModelId ? resolveModel(verifyModelId) : undefined,
            }
          : undefined;
        const webSearchModel = webSearchModelId ? resolveModel(webSearchModelId) : undefined;
        webSearchModelLabelRef.current = webSearchModelId
          ? getShortModelLabel(webSearchModelId)
          : null;

        // Web access: when disabled, null out both approval AND model so the tool is inert
        const webSearchEnabled = effectiveConfig.webSearch !== false;
        const webSearchApproval = webSearchEnabled
          ? interactiveCallbacks.onWebSearchApproval
          : undefined;
        const fetchPageApproval = interactiveCallbacks.onFetchPageApproval;
        const effectiveWebSearchModel = webSearchEnabled ? webSearchModel : undefined;

        // Build Anthropic-specific providerOptions (thinking, effort, context management)
        const { providerOptions, headers } = buildProviderOptions(
          modelId,
          effectiveConfig,
          taskType,
        );

        await contextManager.ensureGitContext();

        steeringAbortedRef.current = false;
        /**
         * flushBeforeSteering — commit accumulated assistant content + steering
         * messages into the messages list so the UI shows:
         *   <previous assistant response> → <steering> → <new streaming>
         * instead of lumping steering before the final combined response.
         */
        const flushBeforeSteering = (steeringMsgs: ChatMessage[]) => {
          // Merge completed tool calls + in-progress ones from the live buffer
          const completedIds = new Set(completedCalls.map((c) => c.id));
          const livePending = liveToolCallsBuffer.current
            .filter((tc) => !completedIds.has(tc.id))
            .map((tc) => ({
              id: tc.id,
              name: tc.toolName,
              args: safeParseArgs(tc.args),
              ...(tc.state === "done" && tc.result
                ? { result: { success: true as const, output: tc.result } }
                : tc.state === "error" && tc.error
                  ? { result: { success: false as const, output: tc.error, error: tc.error } }
                  : {}),
            }));
          const allCalls = [...completedCalls, ...livePending];
          const hasContent = fullText.trim().length > 0 || allCalls.length > 0;

          if (!hasContent) {
            setMessages((prev) => [...prev, ...steeringMsgs]);
          } else {
            const flushedAssistant: ChatMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: fullText,
              timestamp: Date.now(),
              toolCalls: allCalls.length > 0 ? allCalls : undefined,
              segments: finalSegments.length > 0 ? [...finalSegments] : undefined,
            };
            setMessages((prev) => [...prev, flushedAssistant, ...steeringMsgs]);
          }

          // Reset accumulators so subsequent steps start fresh
          fullText = "";
          completedCalls.length = 0;
          finalSegments.length = 0;

          // Clear streaming display buffers
          streamSegmentsBuffer.current = [];
          liveToolCallsBuffer.current = [];
          lastFlushedSegments.current = [];
          lastFlushedToolCalls.current = [];
          lastFlushedStreamingChars.current = 0;
          streamingCharsRef.current = 0;
          toolCharsRef.current = 0;
          segmentsDirty.current = false;
          toolCallsDirty.current = false;
          setStreamSegments([]);
          setLiveToolCalls([]);
        };

        const drainSteering = (): string | null => {
          if (steeringAbortedRef.current) return null;
          const queue = messageQueueRef.current;
          if (queue.length === 0) return null;
          // Drain ALL queued steering messages at once
          const drained: ChatMessage[] = [];
          const texts: string[] = [];
          for (const item of queue) {
            const content = item?.content;
            if (content) {
              drained.push({
                id: crypto.randomUUID(),
                role: "user" as const,
                content,
                timestamp: Date.now(),
                showInChat: true,
                isSteering: true,
              });
              texts.push(content);
            }
          }
          messageQueueRef.current = [];
          setMessageQueue([]);

          if (drained.length > 0) {
            // Flush current progress + steering into messages
            flushBeforeSteering(drained);
          }

          return texts.length > 0 ? texts.join("\n\n") : null;
        };

        const agent = createForgeAgent({
          model,
          contextManager,
          forgeMode: contextManager.getForgeMode(),
          interactive: interactiveCallbacks,
          editorIntegration: effectiveConfig.editorIntegration,
          subagentModels,
          webSearchModel: effectiveWebSearchModel,
          onApproveWebSearch: webSearchApproval,
          onApproveFetchPage: fetchPageApproval,
          onApproveOutsideCwd: promptOutsideCwd,
          onApproveDestructive: promptDestructive,
          providerOptions,
          headers,
          codeExecution: effectiveConfig.codeExecution,
          cwd,
          sessionId: sessionIdRef.current,
          sharedCacheRef: sharedCacheRef.current,
          agentFeatures: effectiveConfig.agentFeatures,
          planExecution: planExecutionRef.current,
          drainSteering,
        });
        let result!: StreamTextResult<ToolSet, never>;
        const MAX_TRANSIENT_RETRIES = 3;
        for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
          if (abortController.signal.aborted) break;
          try {
            for (let degradeLevel = 0; degradeLevel <= 2; degradeLevel++) {
              if (abortController.signal.aborted) break;
              try {
                const currentAgent =
                  degradeLevel === 0
                    ? agent
                    : (() => {
                        const degraded = degradeProviderOptions(
                          activeModelRef.current,
                          degradeLevel,
                        );
                        return createForgeAgent({
                          model,
                          contextManager,
                          forgeMode: contextManager.getForgeMode(),
                          interactive: interactiveCallbacks,
                          editorIntegration: effectiveConfig.editorIntegration,
                          subagentModels,
                          onApproveWebSearch: webSearchApproval,
                          onApproveFetchPage: fetchPageApproval,
                          onApproveOutsideCwd: promptOutsideCwd,
                          onApproveDestructive: promptDestructive,
                          providerOptions: degraded.providerOptions,
                          headers: degraded.headers,
                          codeExecution: effectiveConfig.codeExecution,
                          cwd,
                          sessionId: sessionIdRef.current,
                          agentFeatures: effectiveConfig.agentFeatures,
                          planExecution: planExecutionRef.current,
                        });
                      })();
                result = (await currentAgent.stream({
                  messages: newCoreMessages,
                  abortSignal: abortController.signal,
                  options: { userMessage: input },
                  ...smoothStreamOptions,
                })) as unknown as StreamTextResult<ToolSet, never>;
                break;
              } catch (err: unknown) {
                if (!isProviderOptionsError(err) || degradeLevel === 2) throw err;
              }
            }
            break;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const isTransient =
              /overloaded|529|429|rate.?limit|too many requests|503|502|timeout/i.test(msg);
            if (!isTransient || retry === MAX_TRANSIENT_RETRIES || abortController.signal.aborted) {
              throw err;
            }
            const delay = 1000 * 2 ** retry + Math.random() * 500;
            const delaySec = Math.round(delay / 1000);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Retry ${String(retry + 1)}/${String(MAX_TRANSIENT_RETRIES)}: ${msg} [delay:${String(delaySec)}s]`,
                timestamp: Date.now(),
              },
            ]);
            await new Promise((r) => setTimeout(r, delay));
          }
        }

        const toolCallArgs = new Map<string, string>();
        const thinkingParser = createThinkingParser();
        let hasNativeReasoning = false;
        let thinkingIdCounter = 0;
        const streamErrors: string[] = [];

        const buf = streamSegmentsBuffer.current;
        const tcBuf = liveToolCallsBuffer.current;

        const updateStreamingEstimate = (newChars: number) => {
          streamingCharsRef.current += newChars;
          const estimatedNewTokens = Math.round(streamingCharsRef.current / 3);
          const base = baseTokenUsageRef.current;
          pendingTokenUsage.current = {
            ...base,
            completion: base.completion + estimatedNewTokens,
            total: base.total + estimatedNewTokens,
          };
          pendingLastStepOutput.current = estimatedNewTokens;
        };

        const appendText = (text: string) => {
          fullText += text;
          updateStreamingEstimate(text.length);
          segmentsDirty.current = true;
          const lastSeg = finalSegments[finalSegments.length - 1];
          if (lastSeg?.type === "text") {
            lastSeg.content += text;
          } else {
            finalSegments.push({ type: "text", content: text });
          }
          const lastBuf = buf[buf.length - 1];
          if (lastBuf?.type === "text") {
            lastBuf.content += text;
          } else {
            buf.push({ type: "text" as const, content: text });
          }
        };

        const pushReasoningSegment = (id: string) => {
          segmentsDirty.current = true;
          finalSegments.push({ type: "reasoning", content: "", id });
          buf.push({ type: "reasoning", content: "", id, done: false } as StreamSegment);
        };

        const appendReasoningContent = (text: string) => {
          updateStreamingEstimate(text.length);
          segmentsDirty.current = true;
          const lastSeg = finalSegments[finalSegments.length - 1];
          if (lastSeg?.type === "reasoning") {
            lastSeg.content += text;
          }
          const lastBuf = buf[buf.length - 1];
          if (lastBuf?.type === "reasoning") {
            lastBuf.content += text;
          }
        };

        const markReasoningDone = () => {
          const lastBuf = buf[buf.length - 1];
          if (lastBuf?.type === "reasoning" && !lastBuf.done) {
            segmentsDirty.current = true;
            lastBuf.done = true;
          }
        };

        flushTimerRef.current = setInterval(() => {
          if (Date.now() - lastFlushTime.current < 100) return;
          lastFlushTime.current = Date.now();
          flushStreamState();
        }, 150);

        let streamEventCount = 0;
        for await (const part of result.fullStream) {
          if (++streamEventCount % 5 === 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
          }
          switch (part.type) {
            case "reasoning-start": {
              hasNativeReasoning = true;
              pushReasoningSegment(part.id);
              break;
            }
            case "reasoning-delta": {
              appendReasoningContent(part.text);
              break;
            }
            case "reasoning-end":
              markReasoningDone();
              break;
            case "text-delta": {
              if (hasNativeReasoning) {
                appendText(part.text);
              } else {
                const parsed = thinkingParser.feed(part.text);
                for (const chunk of parsed) {
                  switch (chunk.type) {
                    case "text":
                      appendText(chunk.content);
                      break;
                    case "reasoning-start":
                      pushReasoningSegment(`thinking-${String(thinkingIdCounter++)}`);
                      break;
                    case "reasoning-content":
                      appendReasoningContent(chunk.content);
                      break;
                    case "reasoning-end":
                      markReasoningDone();
                      break;
                  }
                }
              }
              queueMicrotaskFlush();
              break;
            }
            case "tool-input-start": {
              segmentsDirty.current = true;
              toolCallsDirty.current = true;
              const lastToolSeg = finalSegments[finalSegments.length - 1];
              if (lastToolSeg?.type === "tools") {
                lastToolSeg.toolCallIds.push(part.id);
              } else {
                finalSegments.push({ type: "tools", toolCallIds: [part.id] });
              }
              tcBuf.push({
                id: part.id,
                toolName: part.toolName,
                state: "running",
                ...(part.toolName === "web_search" && webSearchModelLabelRef.current
                  ? { backend: webSearchModelLabelRef.current }
                  : {}),
              });
              const lastBufSeg = buf[buf.length - 1];
              if (lastBufSeg?.type === "tools") {
                lastBufSeg.callIds.push(part.id);
              } else {
                buf.push({ type: "tools" as const, callIds: [part.id] });
              }
              toolCallArgs.set(part.id, "");
              queueMicrotaskFlush();
              break;
            }
            case "tool-input-delta": {
              toolCallArgs.set(part.id, (toolCallArgs.get(part.id) ?? "") + part.delta);
              const tc = tcBuf.find((c) => c.id === part.id);
              if (tc) {
                tc.args = toolCallArgs.get(part.id);
                if (
                  tc.toolName === "dispatch" ||
                  tc.toolName === "plan" ||
                  tc.toolName === "write_plan"
                ) {
                  toolCallsDirty.current = true;
                  queueMicrotaskFlush();
                }
              }
              toolCharsRef.current += part.delta.length;
              break;
            }
            case "tool-result": {
              toolCallsDirty.current = true;
              const resultStr =
                typeof part.output === "string" ? part.output : JSON.stringify(part.output);
              const tc = tcBuf.find((c) => c.id === part.toolCallId);
              if (tc) {
                tc.state = "done";
                tc.result = resultStr;
              }
              toolCharsRef.current += resultStr.length;
              const parsedArgs = safeParseArgs(toolCallArgs.get(part.toolCallId));
              completedCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: parsedArgs,
                result: { success: true, output: resultStr },
              });
              if (workingStateRef.current) {
                extractFromToolCall(workingStateRef.current, part.toolName, parsedArgs);
                extractFromToolResult(
                  workingStateRef.current,
                  part.toolName,
                  resultStr,
                  parsedArgs,
                );
                syncV2Slots();
              }
              queueMicrotaskFlush();
              break;
            }
            case "tool-error": {
              toolCallsDirty.current = true;
              const tc = tcBuf.find((c) => c.id === part.toolCallId);
              if (tc) {
                tc.state = "error";
                tc.error = String(part.error);
              }
              const errorArgs = safeParseArgs(toolCallArgs.get(part.toolCallId));
              completedCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: errorArgs,
                result: { success: false, output: "", error: String(part.error) },
              });
              if (workingStateRef.current) {
                extractFromToolCall(workingStateRef.current, part.toolName, errorArgs);
                workingStateRef.current.addFailure(
                  `${part.toolName}: ${String(part.error).slice(0, 200)}`,
                );
                syncV2Slots();
              }
              queueMicrotaskFlush();
              break;
            }
            case "finish-step": {
              const stepIn = part.usage.inputTokens ?? 0;
              const stepOut = part.usage.outputTokens ?? 0;
              const stepCache =
                (
                  part.usage as {
                    inputTokenDetails?: { cacheReadTokens?: number };
                  }
                ).inputTokenDetails?.cacheReadTokens ?? 0;
              const base = baseTokenUsageRef.current;
              const newUsage: TokenUsage = {
                ...base,
                prompt: base.prompt + stepIn,
                completion: base.completion + stepOut,
                total: base.total + stepIn + stepOut,
                cacheRead: base.cacheRead + stepCache,
              };
              pendingTokenUsage.current = newUsage;
              baseTokenUsageRef.current = newUsage;
              streamingCharsRef.current = 0;
              if (stepIn > 0) pendingContextTokens.current = stepIn;
              pendingLastStepOutput.current = stepOut;
              queueMicrotaskFlush();

              if (completedCalls.length > 0 && Date.now() - lastIncrementalSave > 10_000) {
                lastIncrementalSave = Date.now();
                queueMicrotask(() => {
                  try {
                    const snapshot = getWorkspaceSnapshot?.();
                    if (!snapshot) return;
                    const partialMsg: ChatMessage = {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: fullText,
                      timestamp: Date.now(),
                      toolCalls: [...completedCalls],
                      segments: finalSegments.length > 0 ? [...finalSegments] : undefined,
                    };
                    setMessages((prev) => {
                      const allMsgs = [...prev, partialMsg];
                      const { meta, tabMessages } = buildSessionMeta({
                        sessionId: sessionIdRef.current,
                        title: SessionManager.deriveTitle(allMsgs),
                        cwd,
                        snapshot,
                        currentTabMessages: allMsgs.filter(
                          (m) => m.role !== "system" || m.showInChat,
                        ),
                      });
                      try {
                        sessionManager.saveSession(meta, tabMessages);
                      } catch {
                        // Incremental save is best-effort — final save will retry
                      }
                      return prev;
                    });
                  } catch {
                    // Don't let checkpoint failures interrupt streaming
                  }
                });
              }
              break;
            }
            case "error": {
              const err = part.error;
              const errText =
                (err instanceof Error ? err.message : null) ||
                (typeof err === "string" ? err : null) ||
                JSON.stringify(err);
              const errStack = err instanceof Error ? err.stack : undefined;
              appendText(`\n\n_Error: ${errText}_`);
              if (streamErrors.length < 50) {
                streamErrors.push(
                  errStack ? `Error: ${errText}\n\n${errStack}` : `Error: ${errText}`,
                );
              }
              break;
            }
          }
        }

        // Log agent stop reason for debugging (visible via /errors)
        try {
          const resp = await Promise.race([
            result.response,
            new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
          ]);
          if (resp) {
            const lastStep = resp.messages?.length ?? 0;
            const reason = (resp as { finishReason?: string }).finishReason ?? "unknown";
            logBackgroundError(
              "agent-stop",
              `finishReason=${reason} steps=${String(lastStep)} streamErrors=${String(streamErrors.length)}`,
            );
          }
        } catch {}

        if (flushTimerRef.current) {
          clearInterval(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushStreamState();

        if (!hasNativeReasoning) {
          for (const chunk of thinkingParser.flush()) {
            switch (chunk.type) {
              case "text":
                appendText(chunk.content);
                break;
              case "reasoning-content":
                appendReasoningContent(chunk.content);
                break;
              default:
                break;
            }
          }
        }

        let responseMessages: ModelMessage[];
        try {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("response timeout")), 10_000),
          );
          const responseData = await Promise.race([result.response, timeout]);
          responseMessages = responseData.messages;
        } catch {
          responseMessages =
            fullText.length > 0 ? [{ role: "assistant" as const, content: fullText }] : [];
        }

        // Embed plan as a segment if one was created (skip when plan post-action will handle it)
        if (activePlanRef.current && !planPostActionRef.current) {
          finalSegments.push({ type: "plan", plan: activePlanRef.current });
        }
        setActivePlan(null);

        if (workingStateRef.current && fullText.length > 0) {
          extractFromAssistantMessage(workingStateRef.current, {
            role: "assistant",
            content: fullText,
          });
          syncV2Slots();
        }

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullText,
          timestamp: Date.now(),
          toolCalls: completedCalls.length > 0 ? completedCalls : undefined,
          segments: finalSegments.length > 0 ? finalSegments : undefined,
        };

        const errorMsgs: ChatMessage[] = streamErrors.map((errContent) => ({
          id: crypto.randomUUID(),
          role: "system" as const,
          content: errContent,
          timestamp: Date.now(),
        }));

        setMessages((prev) => {
          const allMsgs = [...prev, assistantMsg, ...errorMsgs];
          queueMicrotask(() => {
            const snapshot = getWorkspaceSnapshot?.();
            if (snapshot) {
              try {
                const { meta, tabMessages } = buildSessionMeta({
                  sessionId: sessionIdRef.current,
                  title: SessionManager.deriveTitle(allMsgs),
                  cwd,
                  snapshot,
                  currentTabMessages: allMsgs.filter((m) => m.role !== "system" || m.showInChat),
                });
                sessionManager.saveSession(meta, tabMessages);
              } catch {
                // best-effort — exit save is the final fallback
              }
            }
          });
          return allMsgs;
        });

        setCoreMessages((prev) => [...prev, ...responseMessages]);
        streamSegmentsBuffer.current = [];
        liveToolCallsBuffer.current = [];
        lastFlushedSegments.current = [];
        lastFlushedToolCalls.current = [];
        lastFlushedStreamingChars.current = 0;
        streamingCharsRef.current = 0;
        toolCharsRef.current = 0;
        setStreamingChars(0);
        setStreamSegments([]);
        setLiveToolCalls([]);
      } catch (err: unknown) {
        if (flushTimerRef.current) {
          clearInterval(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        const isAbort = abortController.signal.aborted;
        const rawMsg = err instanceof Error ? err.message : String(err);
        const isTransientStream = /overloaded|529|429|rate.?limit|too many requests|503|502/i.test(
          rawMsg,
        );
        const errorMsg = isTransientStream
          ? `Provider returned a transient error (${rawMsg.slice(0, 120)}). Please retry.`
          : rawMsg;
        const errorStack = !isTransientStream && err instanceof Error ? err.stack : undefined;
        // Mark in-flight tool calls as interrupted so they don't show stuck spinners
        if (isAbort) {
          const completedIds = new Set(completedCalls.map((c) => c.id));
          // Use snapshot saved before abort() cleared the buffers
          const liveBuf =
            abortedToolCallsSnapshot.current.length > 0
              ? abortedToolCallsSnapshot.current
              : liveToolCallsBuffer.current;
          for (const seg of finalSegments) {
            if (seg.type === "tools") {
              for (const id of seg.toolCallIds) {
                if (!completedIds.has(id)) {
                  const live = liveBuf.find((c: LiveToolCall) => c.id === id);
                  const args = live?.args ? safeParseArgs(live.args) : {};
                  completedCalls.push({
                    id,
                    name: live?.toolName ?? "unknown",
                    args,
                    result: { success: false, output: "", error: "Interrupted by user (Ctrl+X)" },
                  });
                }
              }
            }
          }
          abortedSegmentsSnapshot.current = [];
          abortedToolCallsSnapshot.current = [];
        }

        const hasPlanPostAction = !!planPostActionRef.current;
        if (!hasPlanPostAction && (fullText.trim().length > 0 || completedCalls.length > 0)) {
          const partialMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
            toolCalls: completedCalls.length > 0 ? completedCalls : undefined,
            segments: finalSegments.length > 0 ? finalSegments : undefined,
          };
          setMessages((prev) => [...prev, partialMsg]);

          if (completedCalls.length > 0) {
            const assistantContent: Array<TextPart | ToolCallPart> = [];
            if (fullText.length > 0) {
              assistantContent.push({ type: "text", text: fullText });
            }
            for (const call of completedCalls) {
              const args = call.args;
              assistantContent.push({
                type: "tool-call",
                toolCallId: call.id,
                toolName: call.name,
                input:
                  typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
              });
            }
            const toolContent = completedCalls.map((call) => ({
              type: "tool-result" as const,
              toolCallId: call.id,
              toolName: call.name,
              output: { type: "text" as const, value: call.result?.output ?? "" },
            }));
            setCoreMessages((prev) => [
              ...prev,
              { role: "assistant" as const, content: assistantContent },
              { role: "tool" as const, content: toolContent },
            ]);
          } else {
            setCoreMessages((prev) => [...prev, { role: "assistant" as const, content: fullText }]);
          }
        }
        if (!hasPlanPostAction) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: isAbort
                ? "Generation interrupted."
                : errorStack
                  ? `Error: ${errorMsg}\n\n${errorStack}`
                  : `Error: ${errorMsg}`,
              timestamp: Date.now(),
            },
          ]);
        }
        streamSegmentsBuffer.current = [];
        liveToolCallsBuffer.current = [];
        lastFlushedSegments.current = [];
        lastFlushedToolCalls.current = [];
        lastFlushedStreamingChars.current = 0;
        streamingCharsRef.current = 0;
        toolCharsRef.current = 0;
        setStreamingChars(0);
        setStreamSegments([]);
        setLiveToolCalls([]);
      } finally {
        unsubAgentStats();
        unsubMultiAgent();
        if (visibleRef.current) useStatusBarStore.getState().setSubagentChars(0);
        setIsLoading(false);
        abortRef.current = null;
        planExecutionRef.current = false;
        setPendingQuestion(null);
        setPendingPlanReview(null);
        contextManager.invalidateFileTree();

        const postAction = planPostActionRef.current;
        let willContinue = false;
        if (postAction) {
          planPostActionRef.current = null;
          const pContent = postAction.planContent;

          if (postAction.action === "revise") {
            willContinue = true;
            setActivePlan(null);
            setSidebarPlan(null);
            setCoreMessages((prev) => {
              let planIdx = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i];
                if (
                  m?.role === "assistant" &&
                  Array.isArray(m.content) &&
                  m.content.some(
                    (p: unknown) =>
                      typeof p === "object" &&
                      p !== null &&
                      "type" in p &&
                      (p as { type: string }).type === "tool-call" &&
                      "toolName" in p &&
                      (p as { toolName: string }).toolName === "plan",
                  )
                ) {
                  planIdx = i;
                  break;
                }
              }
              if (planIdx < 0) return prev;
              return prev.slice(0, planIdx);
            });
            setTimeout(() => handleSubmit(postAction.reviseFeedback ?? "Revise the plan."), 0);
          } else {
            planModeRef.current = false;
            planRequestRef.current = null;
            contextManager.setForgeMode("default");

            if (postAction.action === "cancel") {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Plan cancelled: ${postAction.plan?.title ?? ""}`,
                  timestamp: Date.now(),
                  showInChat: true,
                },
              ]);
            } else if (
              (postAction.action === "clear_execute" || postAction.action === "execute") &&
              pContent
            ) {
              willContinue = true;
              const isClear = postAction.action === "clear_execute";
              if (isClear) {
                contextManager.resetConversationTracking();
                setCoreMessages([]);
                setTokenUsage({ ...ZERO_USAGE });
              }
              const statusMsg: ChatMessage = {
                id: crypto.randomUUID(),
                role: "system",
                content: isClear
                  ? "Context cleared — executing plan with fresh context..."
                  : "Plan accepted — executing...",
                timestamp: Date.now(),
              };
              setMessages(isClear ? [statusMsg] : (prev) => [...prev, statusMsg]);
              if (postAction.plan) {
                setActivePlan(postAction.plan);
                setSidebarPlan(postAction.plan);
              }
              planExecutionRef.current = true;
              const isFullPlan = postAction.plan?.depth !== "light";
              const execPrompt = isFullPlan
                ? `Execute this plan. The checklist is already live in the UI.\n` +
                  `Workflow per step:\n` +
                  `1. update_plan_step(stepId, "active")\n` +
                  `2. Apply edits: each step has old→new diffs — use edit_file with the exact old/new text.\n` +
                  `3. Run shell commands from the step if present.\n` +
                  `4. update_plan_step(stepId, "done")\n\n` +
                  `All file content is included in the code_snippets below. Edits are pre-validated against this content.\n\n${pContent}`
                : `Execute this plan. The checklist is already live in the UI.\n` +
                  `Workflow per step:\n` +
                  `1. update_plan_step(stepId, "active")\n` +
                  `2. Read the target files, then apply the changes described in the step details.\n` +
                  `3. Run shell commands from the step if present.\n` +
                  `4. update_plan_step(stepId, "done")\n\n` +
                  `This is a light plan — read files as needed before editing.\n\n${pContent}`;
              setTimeout(() => handleSubmit(execPrompt), 0);
            }
          }
        } else if (pendingCompactRef.current) {
          willContinue = true;
          pendingCompactRef.current = false;
          const planSnapshot = activePlanRef.current;
          summarizeConversationRef
            .current({ skipQueueDrain: true })
            .then(() => {
              const planHint = planSnapshot
                ? (() => {
                    const active = planSnapshot.steps.find((s) => s.status === "active");
                    const done = planSnapshot.steps.filter((s) => s.status === "done").length;
                    const total = planSnapshot.steps.length;
                    return ` You are executing plan "${planSnapshot.title}" — ${String(done)}/${String(total)} steps done.${active ? ` Currently on step [${active.id}]: ${active.label}.` : ""}`;
                  })()
                : "";
              setTimeout(
                () =>
                  handleSubmitRef.current(
                    `Continue from where you left off.${planHint} Complete any remaining work.`,
                  ),
                0,
              );
            })
            .catch(() => {});
        }

        if (!willContinue) {
          setActivePlan(null);
          setMessageQueue((queue) => {
            if (queue.length > 0) {
              const [next, ...rest] = queue;
              if (next) {
                setTimeout(() => handleSubmitRef.current(next.content), 0);
              }
              return rest;
            }
            return queue;
          });
        }
      }
    },
    [
      contextManager,
      sessionManager,
      interactiveCallbacks,
      cwd,
      effectiveConfig,
      flushStreamState,
      queueMicrotaskFlush,
      getWorkspaceSnapshot,
      setTokenUsage,
      setActivePlan,
      syncV2Slots,
      promptOutsideCwd,
      promptDestructive,
    ],
  );
  handleSubmitRef.current = handleSubmit;

  const pendingQuestionRef = useRef(pendingQuestion);
  pendingQuestionRef.current = pendingQuestion;

  const abort = useCallback(() => {
    if (compactAbortRef.current) {
      compactAbortRef.current.abort();
      compactAbortRef.current = null;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system" as const,
          content: "Compaction aborted.",
          timestamp: Date.now(),
        },
      ]);
      return;
    }
    if (abortRef.current) {
      const pq = pendingQuestionRef.current;
      if (pq) {
        pq.resolve("__skipped__");
        setPendingQuestion(null);
      }
      setActivePlan(null);
      steeringAbortedRef.current = true;
      // Snapshot buffers before clearing so the catch block can reconstruct partial content
      abortedSegmentsSnapshot.current = [...streamSegmentsBuffer.current];
      abortedToolCallsSnapshot.current = [...liveToolCallsBuffer.current];
      abortRef.current.abort();
      abortRef.current = null;
      setIsLoading(false);
      resetInProgressTasks();
      setLiveToolCalls([]);
      setStreamSegments([]);
      messageQueueRef.current = [];
      setMessageQueue([]);
      liveToolCallsBuffer.current = [];
      streamSegmentsBuffer.current = [];
      lastFlushedToolCalls.current = [];
      streamingCharsRef.current = 0;
      toolCharsRef.current = 0;
      segmentsDirty.current = false;
      toolCallsDirty.current = false;
    }
  }, [setActivePlan]);

  // Snapshot current state for tab switching
  const snapshot = useCallback(
    (label: string): TabState => ({
      id: sessionIdRef.current,
      label,
      messages,
      coreMessages,
      activeModel,
      activePlan,
      sidebarPlan,
      tokenUsage,
      coAuthorCommits,
      sessionId: sessionIdRef.current,
      planMode: planModeRef.current,
      planRequest: planRequestRef.current,
    }),
    [messages, coreMessages, activeModel, activePlan, sidebarPlan, tokenUsage, coAuthorCommits],
  );

  const setPlanMode = useCallback((on: boolean) => {
    planModeRef.current = on;
  }, []);

  const setPlanRequest = useCallback((req: string | null) => {
    planRequestRef.current = req;
  }, []);

  return {
    messages,
    setMessages,
    coreMessages,
    setCoreMessages,
    isLoading,
    isCompacting,
    streamSegments,
    liveToolCalls,
    activePlan,
    setActivePlan,
    sidebarPlan,
    setSidebarPlan,
    pendingQuestion,
    setPendingQuestion,
    messageQueue,
    setMessageQueue,
    activeModel,
    setActiveModel,
    coAuthorCommits,
    setCoAuthorCommits,
    tokenUsage,
    setTokenUsage,
    contextTokens,
    lastStepOutput,
    chatChars,
    sessionId: sessionIdRef.current,
    planFile: planFileName(sessionIdRef.current),
    planMode: planModeRef.current,
    planRequest: planRequestRef.current,
    handleSubmit,
    summarizeConversation,
    abort,
    interactiveCallbacks,
    setPlanMode,
    setPlanRequest,
    pendingPlanReview,
    setPendingPlanReview,
    snapshot,
    contextManager,
  };
}
