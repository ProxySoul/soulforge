import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { generateText, stepCountIs, ToolLoopAgent } from "ai";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeConfigs, saveConfig } from "../config/index.js";
import { createForgeAgent } from "../core/agents/index.js";
import { buildSubagentTools } from "../core/agents/subagent-tools.js";
import { ContextManager } from "../core/context/manager.js";
import { providerIcon, UI_ICONS } from "../core/icons.js";
import { getModelContextWindow } from "../core/llm/models.js";
import { resolveModel } from "../core/llm/provider.js";
import { detectTaskType, resolveTaskModel } from "../core/llm/task-router.js";
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { suspendAndRun } from "../core/terminal/suspend.js";
import { createThinkingParser } from "../core/thinking-parser.js";
import { buildInteractiveTools, buildPlanModeTools } from "../core/tools/index.js";
import { useEditorFocus } from "../hooks/useEditorFocus.js";
import { useEditorInput } from "../hooks/useEditorInput.js";
import { useForgeMode } from "../hooks/useForgeMode.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useMouse } from "../hooks/useMouse.js";
import { useNeovim } from "../hooks/useNeovim.js";
import type {
  AppConfig,
  ChatMessage,
  ChatStyle,
  EditorIntegration,
  InteractiveCallbacks,
  MessageSegment,
  PendingQuestion,
  Plan,
  PlanStepStatus,
  QueuedMessage,
  TaskRouter,
} from "../types/index.js";
import { ContextBar } from "./ContextBar.js";
import { handleCommand } from "./commands.js";
import { EditorPanel } from "./EditorPanel.js";
import { EditorSettings } from "./EditorSettings.js";
import { ErrorLog } from "./ErrorLog.js";
import { Footer } from "./Footer.js";
import { GhostLogo } from "./GhostLogo.js";
import { GitCommitModal } from "./GitCommitModal.js";
import { GitMenu } from "./GitMenu.js";
import { HealthCheck } from "./HealthCheck.js";
import { HelpPopup } from "./HelpPopup.js";
import { InputBox } from "./InputBox.js";
import { LlmSelector } from "./LlmSelector.js";
import { CodeExpandedProvider } from "./Markdown.js";
import { MessageList } from "./MessageList.js";
import { PlanReviewPrompt } from "./PlanReviewPrompt.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { RightSidebar } from "./RightSidebar.js";
import { RouterSettings } from "./RouterSettings.js";
import { SessionPicker } from "./SessionPicker.js";
import { SetupGuide } from "./SetupGuide.js";
import { SkillSearch } from "./SkillSearch.js";
import { type StreamSegment, StreamSegmentList } from "./StreamSegmentList.js";
import { SystemBanner } from "./SystemBanner.js";
import { TokenDisplay } from "./TokenDisplay.js";
import type { LiveToolCall } from "./ToolCallDisplay.js";

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

interface Props {
  config: AppConfig;
  projectConfig?: Partial<AppConfig> | null;
}

export function App({ config, projectConfig }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [coreMessages, setCoreMessages] = useState<ModelMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);

  // Interactive state
  const abortRef = useRef<AbortController | null>(null);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [sidebarPlan, setSidebarPlan] = useState<Plan | null>(null);
  const [showPlanPanel, setShowPlanPanel] = useState(true);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);

  // Tiered config: session > project > global
  const [sessionConfig, setSessionConfig] = useState<Partial<AppConfig> | null>(null);
  const effectiveConfig = useMemo(
    () => mergeConfigs(config, projectConfig ?? null, sessionConfig),
    [config, projectConfig, sessionConfig],
  );

  // Editor state
  const { focusMode, editorOpen, toggleFocus, setFocus, openEditor, closeEditor } =
    useEditorFocus();
  const [editorVisible, setEditorVisible] = useState(false);
  const {
    ready: nvimReady,
    screenLines,
    defaultBg,
    modeName: nvimMode,
    fileName: editorFile,
    cursorLine,
    cursorCol,
    visualSelection,
    openFile: nvimOpen,
    sendKeys,
    error: nvimError,
  } = useNeovim(editorOpen, effectiveConfig.nvimPath, effectiveConfig.nvimConfig, closeEditor);

  // Queue a file to open once neovim is ready
  const pendingEditorFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (nvimReady && pendingEditorFileRef.current) {
      const file = pendingEditorFileRef.current;
      pendingEditorFileRef.current = null;
      nvimOpen(file).catch(() => {});
    }
  }, [nvimReady, nvimOpen]);

  const openEditorWithFile = useCallback(
    (file: string) => {
      if (editorOpen && nvimReady) {
        nvimOpen(file).catch(() => {});
      } else {
        pendingEditorFileRef.current = file;
        openEditor();
      }
    },
    [editorOpen, nvimReady, nvimOpen, openEditor],
  );

  // Track visual presence: visible when open, stays visible during close animation
  useEffect(() => {
    if (editorOpen) setEditorVisible(true);
  }, [editorOpen]);

  const handleEditorClosed = useCallback(() => {
    setEditorVisible(false);
  }, []);

  useEditorInput(sendKeys, focusMode === "editor" && nvimReady);

  // LLM state
  const [activeModel, setActiveModel] = useState(effectiveConfig.defaultModel);
  const [showLlmSelector, setShowLlmSelector] = useState(false);
  const [showSkillSearch, setShowSkillSearch] = useState(false);
  const [showGitCommit, setShowGitCommit] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showHelpPopup, setShowHelpPopup] = useState(false);
  const [showErrorLog, setShowErrorLog] = useState(false);
  const [showGitMenu, setShowGitMenu] = useState(false);
  const [showEditorSettings, setShowEditorSettings] = useState(false);
  const [showRouterSettings, setShowRouterSettings] = useState(false);
  const [routerSlotPicking, setRouterSlotPicking] = useState<keyof TaskRouter | null>(null);
  const [showSetup, setShowSetup] = useState(() => getMissingRequired().length > 0);
  const [suspended, setSuspended] = useState(false);
  const [coAuthorCommits, setCoAuthorCommits] = useState(true);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [chatStyle, setChatStyle] = useState<ChatStyle>("accent");
  const scrollRef = useRef<ScrollViewRef>(null);
  const shouldAutoScroll = useRef(true);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [chatViewportHeight, setChatViewportHeight] = useState(0);
  // Reasoning is always shown during streaming, auto-collapsed after
  const [tokenUsage, setTokenUsage] = useState({ prompt: 0, completion: 0, total: 0 });
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const cwd = process.cwd();
  const [showPlanReview, setShowPlanReview] = useState(false);
  const planModeRef = useRef(false);
  const planRequestRef = useRef<string | null>(null);

  // Initialize security guard once
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    initForbidden(cwd);
  }, []);

  const contextManager = useMemo(() => new ContextManager(cwd), [cwd]);
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);
  const git = useGitStatus(cwd);
  const {
    mode: forgeMode,
    cycleMode,
    modeLabel,
    modeColor,
    setMode: setForgeMode,
  } = useForgeMode();

  // Sync forge mode to context manager
  useEffect(() => {
    contextManager.setForgeMode(forgeMode);
  }, [forgeMode, contextManager]);

  // Sync editor state to context manager
  useEffect(() => {
    contextManager.setEditorState(
      editorOpen,
      editorFile,
      nvimMode,
      cursorLine,
      cursorCol,
      visualSelection,
    );
  }, [editorOpen, editorFile, nvimMode, cursorLine, cursorCol, visualSelection, contextManager]);

  // Sync editor integration settings to context manager
  useEffect(() => {
    if (effectiveConfig.editorIntegration) {
      contextManager.setEditorIntegration(effectiveConfig.editorIntegration);
    }
  }, [effectiveConfig.editorIntegration, contextManager]);

  // Refresh git context on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: contextManager is stable (useMemo on cwd)
  useEffect(() => {
    contextManager.refreshGitContext();
  }, []);
  const termHeight = stdout?.rows ?? 40;

  const chatChars = useMemo(
    () =>
      coreMessages.reduce((sum, m) => {
        if (typeof m.content === "string") return sum + m.content.length;
        if (Array.isArray(m.content)) {
          return (
            sum +
            m.content.reduce(
              (s: number, part: unknown) =>
                s +
                (typeof part === "object" && part !== null && "text" in part
                  ? String((part as { text: string }).text).length
                  : JSON.stringify(part).length),
              0,
            )
          );
        }
        return sum;
      }, 0),
    [coreMessages],
  );

  const summarizeConversation = useCallback(async () => {
    if (coreMessages.length < 4) return;
    try {
      const model = resolveModel(activeModel);
      const convoText = coreMessages
        .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : ""}`)
        .join("\n");
      const { text: summary } = await generateText({
        model,
        prompt: `Summarize this conversation in 2-3 concise sentences, preserving key decisions and context:\n\n${convoText}`,
      });
      const summaryMsg: ModelMessage = {
        role: "user" as const,
        content: `[Previous conversation summary: ${summary}]`,
      };
      setCoreMessages([summaryMsg]);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Context compressed. Summary: ${summary}`,
          timestamp: Date.now(),
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Failed to summarize conversation.",
          timestamp: Date.now(),
        },
      ]);
    }
  }, [coreMessages, activeModel]);

  // Auto-summarize when context is getting large (>80% of budget)
  const autoSummarizedRef = useRef(false);
  useEffect(() => {
    const systemChars = contextManager.getContextBreakdown().reduce((sum, s) => sum + s.chars, 0);
    const totalChars = systemChars + chatChars;
    const contextBudgetChars = getModelContextWindow(activeModel) * 4; // ~4 chars/token
    const pct = totalChars / contextBudgetChars;
    if (pct > 0.8 && !autoSummarizedRef.current && coreMessages.length >= 6) {
      autoSummarizedRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Context at >80% capacity. Auto-summarizing conversation...",
          timestamp: Date.now(),
        },
      ]);
      summarizeConversation();
    }
    if (pct < 0.5) {
      autoSummarizedRef.current = false;
    }
  }, [chatChars, contextManager, coreMessages.length, summarizeConversation, activeModel]);

  const handleSuspend = useCallback(
    async (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => {
      setSuspended(true);
      // Small delay to let Ink flush before we steal the terminal
      await new Promise((r) => setTimeout(r, 50));
      const result = await suspendAndRun({ ...opts, cwd });
      setSuspended(false);
      if (result.exitCode === null) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Failed to launch ${opts.command}. Is it installed?`,
            timestamp: Date.now(),
          },
        ]);
      }
      git.refresh();
      contextManager.refreshGitContext();
    },
    [cwd, git, contextManager],
  );

  const { displayProvider, displayModel, isGateway, isProxy } = useMemo(() => {
    const isGw = activeModel.startsWith("gateway/");
    const isPrx = activeModel.startsWith("proxy/");
    if (isGw || isPrx) {
      const prefix = isGw ? "gateway/" : "proxy/";
      const rest = activeModel.slice(prefix.length);
      const idx = rest.indexOf("/");
      return {
        displayProvider: idx >= 0 ? rest.slice(0, idx) : rest,
        displayModel: idx >= 0 ? rest.slice(idx + 1) : rest,
        isGateway: isGw,
        isProxy: isPrx,
      };
    }
    const idx = activeModel.indexOf("/");
    return {
      displayProvider: idx >= 0 ? activeModel.slice(0, idx) : "unknown",
      displayModel: idx >= 0 ? activeModel.slice(idx + 1) : activeModel,
      isGateway: false,
      isProxy: false,
    };
  }, [activeModel]);

  // Restore a session from disk
  const handleRestoreSession = useCallback(
    (sessionId: string) => {
      const session = sessionManager.loadSession(sessionId);
      if (!session) return;
      sessionIdRef.current = session.id;
      setMessages(session.messages);
      setCoreMessages(session.coreMessages);
      setSessionConfig(session.configOverrides ?? null);
      setStreamSegments([]);
      setLiveToolCalls([]);
      setTokenUsage({ prompt: 0, completion: 0, total: 0 });
    },
    [sessionManager],
  );

  // Auto-scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset on message count change
  useEffect(() => {
    shouldAutoScroll.current = true;
    scrollRef.current?.scrollToBottom();
  }, [messages.length]);

  // Keep viewport pinned to bottom during streaming
  const handleContentHeightChange = useCallback(() => {
    if (shouldAutoScroll.current) {
      scrollRef.current?.scrollToBottom();
    }
  }, []);

  // Track viewport size for bottom-alignment
  const handleViewportSizeChange = useCallback((size: { width: number; height: number }) => {
    setChatViewportHeight(size.height);
  }, []);

  // Track scroll position for auto-scroll + indicator
  const handleScroll = useCallback((offset: number) => {
    const sr = scrollRef.current;
    if (!sr) return;
    const ch = sr.getContentHeight();
    const vh = sr.getViewportHeight();
    const atBottom = ch <= vh || offset >= ch - vh - 1;
    shouldAutoScroll.current = atBottom;
    setIsScrolledUp(!atBottom);
  }, []);

  // Re-measure on terminal resize
  useEffect(() => {
    const handleResize = () => scrollRef.current?.remeasure();
    stdout?.on("resize", handleResize);
    return () => {
      stdout?.off("resize", handleResize);
    };
  }, [stdout]);

  // Show nvim errors in chat
  useEffect(() => {
    if (nvimError) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Neovim error: ${nvimError}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [nvimError]);

  // Global keybindings
  useInput(
    (input, key) => {
      if (key.ctrl && input === "e") {
        toggleFocus();
        return;
      }
      if (key.ctrl && input === "o") {
        setCodeExpanded((prev) => !prev);
        return;
      }
      if (focusMode === "editor") return;

      if (key.ctrl && input === "x") {
        if (abortRef.current) {
          // Resolve any pending question before aborting
          if (pendingQuestion) {
            pendingQuestion.resolve("__skipped__");
            setPendingQuestion(null);
          }
          setActivePlan(null);
          abortRef.current.abort();
        }
        return;
      }
      if (key.ctrl && input === "c") {
        exit();
      }
      if (key.ctrl && input === "l") {
        setShowLlmSelector((prev) => !prev);
      }
      if (key.ctrl && input === "s") {
        setShowSkillSearch((prev) => !prev);
      }
      if (key.ctrl && input === "k") {
        setMessages([]);
        setCoreMessages([]);
        setStreamSegments([]);
        setTokenUsage({ prompt: 0, completion: 0, total: 0 });
      }
      if (key.ctrl && input === "d") {
        cycleMode();
      }
      if (key.ctrl && input === "g") {
        setShowGitMenu((prev) => !prev);
      }
      // Ctrl+H sends backspace (0x08) in most terminals
      if ((key.ctrl && input === "h") || key.backspace) {
        setShowHelpPopup((prev) => !prev);
      }
      if (key.ctrl && input === "p") {
        setShowSessionPicker((prev) => !prev);
      }
      if (key.ctrl && input === "r") {
        setShowErrorLog((prev) => !prev);
      }
      if (key.ctrl && input === "t") {
        setShowPlanPanel((prev) => !prev);
      }
      // PageUp / PageDown for chat scroll (line-based)
      if (key.pageUp) {
        const vh = scrollRef.current?.getViewportHeight() ?? 20;
        scrollRef.current?.scrollBy(-vh);
      }
      if (key.pageDown) {
        const vh = scrollRef.current?.getViewportHeight() ?? 20;
        scrollRef.current?.scrollBy(vh);
      }
    },
    {
      isActive:
        !showLlmSelector &&
        !showSkillSearch &&
        !showGitCommit &&
        !showGitMenu &&
        !showSetup &&
        !showSessionPicker &&
        !showHelpPopup &&
        !showErrorLog &&
        !showEditorSettings &&
        !showRouterSettings,
    },
  );

  // Mouse scroll + click-to-focus (3 lines per tick)
  const handleMouseScroll = useCallback((direction: "up" | "down") => {
    scrollRef.current?.scrollBy(direction === "up" ? -3 : 3);
  }, []);

  const handleMouseClick = useCallback(
    (col: number, _row: number) => {
      if (!editorVisible) return;
      const termWidth = stdout?.columns ?? 80;
      const editorWidth = Math.floor(termWidth * 0.6);
      if (col <= editorWidth) {
        setFocus("editor");
      } else {
        setFocus("chat");
      }
    },
    [editorVisible, stdout?.columns, setFocus],
  );

  useMouse({
    onScroll: handleMouseScroll,
    onClick: handleMouseClick,
    isActive:
      !showLlmSelector &&
      !showSkillSearch &&
      !showGitCommit &&
      !showGitMenu &&
      !showSetup &&
      !showSessionPicker &&
      !showHelpPopup &&
      !showErrorLog &&
      !showEditorSettings &&
      !showRouterSettings,
  });

  // Interactive callbacks for plan/question tools
  const interactiveCallbacks = useMemo<InteractiveCallbacks>(
    () => ({
      onPlanCreate: (plan: Plan) => {
        setActivePlan(plan);
        setSidebarPlan(plan);
        setShowPlanPanel(true);
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
      onAskUser: (question, options, allowSkip) => {
        return new Promise<string>((resolve) => {
          setPendingQuestion({
            id: crypto.randomUUID(),
            question,
            options,
            allowSkip,
            resolve,
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
    }),
    [openEditor, openEditorWithFile],
  );

  const handleSubmit = useCallback(
    async (input: string) => {
      if (input.startsWith("/")) {
        // Handle /continue
        if (input.trim().toLowerCase() === "/continue") {
          handleSubmit("Continue from where you left off. Complete any remaining work.");
          return;
        }
        // Handle /plan — toggle plan mode
        if (
          input.trim().toLowerCase() === "/plan" ||
          input.trim().toLowerCase().startsWith("/plan ")
        ) {
          const desc = input.trim().slice(5).trim();
          if (planModeRef.current) {
            // Already in plan mode — toggle OFF
            planModeRef.current = false;
            planRequestRef.current = null;
            setForgeMode("default");
            setShowPlanReview(false);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: "Plan mode OFF",
                timestamp: Date.now(),
              },
            ]);
          } else {
            // Enter plan mode
            planModeRef.current = true;
            planRequestRef.current = desc || null;
            setForgeMode("plan");
            contextManager.setForgeMode("plan");
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: "Plan mode ON — Forge will research and plan without making changes.",
                timestamp: Date.now(),
              },
            ]);
            if (desc) {
              setTimeout(() => handleSubmit(desc), 0);
            }
          }
          return;
        }
        handleCommand(input, {
          setMessages,
          setCoreMessages,
          toggleFocus,
          nvimOpen,
          exit,
          openSkills: () => setShowSkillSearch(true),
          openGitCommit: () => setShowGitCommit(true),
          openSessions: () => setShowSessionPicker(true),
          openHelp: () => setShowHelpPopup(true),
          openErrorLog: () => setShowErrorLog(true),
          cwd,
          refreshGit: () => {
            git.refresh();
            contextManager.refreshGitContext();
          },
          setForgeMode,
          currentMode: forgeMode,
          currentModeLabel: modeLabel,
          contextManager,
          summarizeConversation,
          coAuthorCommits,
          setCoAuthorCommits,
          chatStyle,
          setChatStyle,
          handleSuspend,
          openGitMenu: () => setShowGitMenu(true),
          openEditorWithFile,
          setSessionConfig,
          effectiveNvimConfig: effectiveConfig.nvimConfig,
          openSetup: () => setShowSetup(true),
          openEditorSettings: () => setShowEditorSettings(true),
          openRouterSettings: () => setShowRouterSettings(true),
          togglePlanPanel: () => setShowPlanPanel((prev) => !prev),
        });
        return;
      }

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const newCoreMessages: ModelMessage[] = [
        ...coreMessages,
        { role: "user" as const, content: input },
      ];
      setCoreMessages(newCoreMessages);
      setIsLoading(true);
      setStreamSegments([]);
      setLiveToolCalls([]);
      setActivePlan(null);
      setPendingQuestion(null);

      // Abort controller for Ctrl+X
      const abortController = new AbortController();
      abortRef.current = abortController;

      let fullText = "";
      const completedCalls: import("../types/index.js").ToolCall[] = [];
      const finalSegments: MessageSegment[] = [];

      try {
        const taskType = detectTaskType(input);
        const modelId = resolveTaskModel(taskType, effectiveConfig.taskRouter, activeModel);
        const model = resolveModel(modelId);

        // Resolve subagent models from task router
        const tr = effectiveConfig.taskRouter;
        const explorationModelId = tr?.exploration ?? undefined;
        const codingModelId = tr?.coding ?? undefined;
        const subagentModels =
          explorationModelId || codingModelId
            ? {
                exploration: explorationModelId ? resolveModel(explorationModelId) : undefined,
                coding: codingModelId ? resolveModel(codingModelId) : undefined,
              }
            : undefined;

        const agent = planModeRef.current
          ? new ToolLoopAgent({
              id: "forge-plan",
              model,
              tools: {
                ...buildPlanModeTools(cwd, effectiveConfig.editorIntegration),
                explore: buildSubagentTools({ defaultModel: model }).explore,
                ...(interactiveCallbacks ? buildInteractiveTools(interactiveCallbacks) : {}),
              },
              instructions: contextManager.buildSystemPrompt(),
              stopWhen: stepCountIs(50),
            })
          : createForgeAgent({
              model,
              contextManager,
              interactive: interactiveCallbacks,
              editorIntegration: effectiveConfig.editorIntegration,
              subagentModels,
            });
        const result = await agent.stream({
          messages: newCoreMessages,
          abortSignal: abortController.signal,
        });

        const toolCallArgs = new Map<string, string>();
        const thinkingParser = createThinkingParser();
        let hasNativeReasoning = false;
        let thinkingIdCounter = 0;

        // Helpers for accumulating text/reasoning into finalSegments + streamSegments
        const appendText = (text: string) => {
          fullText += text;
          const lastSeg = finalSegments[finalSegments.length - 1];
          if (lastSeg?.type === "text") {
            lastSeg.content += text;
          } else {
            finalSegments.push({ type: "text", content: text });
          }
          setStreamSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === "text") {
              return [
                ...prev.slice(0, -1),
                { type: "text" as const, content: last.content + text },
              ];
            }
            return [...prev, { type: "text" as const, content: text }];
          });
        };

        const pushReasoningSegment = (id: string) => {
          finalSegments.push({ type: "reasoning", content: "", id });
          setStreamSegments((prev) => [...prev, { type: "reasoning" as const, content: "", id }]);
        };

        const appendReasoningContent = (text: string) => {
          const lastSeg = finalSegments[finalSegments.length - 1];
          if (lastSeg?.type === "reasoning") {
            lastSeg.content += text;
          }
          setStreamSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === "reasoning") {
              return [...prev.slice(0, -1), { ...last, content: last.content + text }];
            }
            return prev;
          });
        };

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "reasoning-start": {
              hasNativeReasoning = true;
              const id = (part as { id?: string }).id ?? `reasoning-${String(thinkingIdCounter++)}`;
              pushReasoningSegment(id);
              break;
            }
            case "reasoning-delta": {
              appendReasoningContent((part as { text: string }).text);
              break;
            }
            case "reasoning-end":
              // Segment already accumulated
              break;
            case "text-delta": {
              if (hasNativeReasoning) {
                // SDK reasoning is structured — no tag parsing needed
                appendText(part.text);
              } else {
                // Feed through thinking parser to extract <thinking> tags
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
                      break;
                  }
                }
              }
              break;
            }
            case "tool-input-start": {
              // Mirror into local segments
              const lastToolSeg = finalSegments[finalSegments.length - 1];
              if (lastToolSeg?.type === "tools") {
                lastToolSeg.toolCallIds.push(part.id);
              } else {
                finalSegments.push({ type: "tools", toolCallIds: [part.id] });
              }
              setLiveToolCalls((prev) => [
                ...prev,
                { id: part.id, toolName: part.toolName, state: "running" },
              ]);
              setStreamSegments((prev) => {
                const last = prev[prev.length - 1];
                if (last?.type === "tools") {
                  return [
                    ...prev.slice(0, -1),
                    { type: "tools" as const, callIds: [...last.callIds, part.id] },
                  ];
                }
                return [...prev, { type: "tools" as const, callIds: [part.id] }];
              });
              toolCallArgs.set(part.id, "");
              break;
            }
            case "tool-input-delta":
              toolCallArgs.set(part.id, (toolCallArgs.get(part.id) ?? "") + part.delta);
              setLiveToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === part.id ? { ...tc, args: toolCallArgs.get(part.id) } : tc,
                ),
              );
              break;
            case "tool-result": {
              const resultStr =
                typeof part.output === "string" ? part.output : JSON.stringify(part.output);
              setLiveToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === part.toolCallId ? { ...tc, state: "done", result: resultStr } : tc,
                ),
              );
              completedCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: JSON.parse(toolCallArgs.get(part.toolCallId) ?? "{}"),
                result: { success: true, output: resultStr },
              });
              break;
            }
            case "tool-error":
              setLiveToolCalls((prev) =>
                prev.map((tc) =>
                  tc.id === part.toolCallId
                    ? { ...tc, state: "error", error: String(part.error) }
                    : tc,
                ),
              );
              completedCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: JSON.parse(toolCallArgs.get(part.toolCallId) ?? "{}"),
                result: { success: false, output: "", error: String(part.error) },
              });
              break;
            case "finish-step": {
              const su = part.usage as { inputTokens?: number; outputTokens?: number } | undefined;
              const stepIn = su?.inputTokens ?? 0;
              const stepOut = su?.outputTokens ?? 0;
              setTokenUsage((prev) => ({
                prompt: prev.prompt + stepIn,
                completion: prev.completion + stepOut,
                total: prev.total + stepIn + stepOut,
              }));
              break;
            }
            case "error": {
              // Stream error (e.g. second API call after tool results failed).
              // Extract error from whatever shape the SDK sends.
              const ep = part as Record<string, unknown>;
              const errText =
                (typeof ep.errorText === "string" && ep.errorText) ||
                (ep.error instanceof Error ? ep.error.message : null) ||
                (typeof ep.error === "string" ? ep.error : null) ||
                JSON.stringify(ep);
              appendText(`\n\n_Error: ${errText}_`);
              break;
            }
          }
        }

        // Flush any buffered partial tags from the thinking parser
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

        // Get response messages from AI SDK (includes tool calls + results).
        // Falls back to text-only if the provider didn't produce proper steps
        // (e.g. proxy/OpenAI-compat providers that omit finish markers).
        let responseMessages: ModelMessage[];
        try {
          const responseData = await result.response;
          responseMessages = responseData.messages;
        } catch {
          // NoOutputGeneratedError — stream completed without finish-step events.
          // Fall back to text-only so we don't lose the assistant's response.
          responseMessages =
            fullText.length > 0 ? [{ role: "assistant" as const, content: fullText }] : [];
        }

        // Embed plan as a segment if one was created
        setActivePlan((currentPlan) => {
          if (currentPlan) {
            finalSegments.push({ type: "plan", plan: currentPlan });
          }
          return null;
        });

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fullText,
          timestamp: Date.now(),
          toolCalls: completedCalls.length > 0 ? completedCalls : undefined,
          segments: finalSegments.length > 0 ? finalSegments : undefined,
        };

        setMessages((prev) => {
          const next = [...prev, assistantMsg];
          // Auto-save session after each exchange — include full tool call history
          const updatedCore: ModelMessage[] = [
            ...coreMessages,
            { role: "user" as const, content: input },
            ...responseMessages,
          ];
          sessionManager.saveSession({
            id: sessionIdRef.current,
            title: SessionManager.deriveTitle(next),
            messages: next.filter((m) => m.role !== "system"),
            coreMessages: updatedCore,
            cwd,
            startedAt: next[0]?.timestamp ?? Date.now(),
            updatedAt: Date.now(),
            configOverrides: sessionConfig ?? undefined,
          });
          return next;
        });
        setCoreMessages((prev) => [...prev, ...responseMessages]);
        setStreamSegments([]);
        setLiveToolCalls([]);
      } catch (err: unknown) {
        const isAbort = abortController.signal.aborted;
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Preserve any partial content the AI streamed before the error
        if (fullText.trim().length > 0 || completedCalls.length > 0) {
          const partialMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: fullText,
            timestamp: Date.now(),
            toolCalls: completedCalls.length > 0 ? completedCalls : undefined,
            segments: finalSegments.length > 0 ? finalSegments : undefined,
          };
          setMessages((prev) => [...prev, partialMsg]);
          setCoreMessages((prev) => [...prev, { role: "assistant" as const, content: fullText }]);
        }
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: isAbort ? "Generation interrupted." : `Error: ${errorMsg}`,
            timestamp: Date.now(),
          },
        ]);
        setStreamSegments([]);
        setLiveToolCalls([]);
      } finally {
        setIsLoading(false);
        abortRef.current = null;
        setPendingQuestion(null);
        setActivePlan(null);

        // In plan mode, populate sidebar from structured write_plan data + show review
        if (planModeRef.current) {
          const writePlanCall = completedCalls.find(
            (c) => c.name === "write_plan" && c.result?.success,
          );
          if (writePlanCall && Array.isArray(writePlanCall.args.steps)) {
            const planSteps = writePlanCall.args.steps as Array<{
              id: string;
              label: string;
            }>;
            const sidebarData: Plan = {
              title: String(writePlanCall.args.title ?? "Plan"),
              steps: planSteps.map((s) => ({
                id: s.id,
                label: s.label,
                status: "pending" as const,
              })),
              createdAt: Date.now(),
            };
            setSidebarPlan(sidebarData);
            setShowPlanPanel(true);
          }
          setShowPlanReview(true);
        } else {
          // Process message queue
          setMessageQueue((queue) => {
            if (queue.length > 0) {
              const [next, ...rest] = queue;
              if (next) {
                setTimeout(() => handleSubmit(next.content), 0);
              }
              return rest;
            }
            return queue;
          });
        }
      }
    },
    [
      coreMessages,
      activeModel,
      contextManager,
      sessionManager,
      interactiveCallbacks,
      toggleFocus,
      nvimOpen,
      exit,
      cwd,
      git,
      forgeMode,
      modeLabel,
      setForgeMode,
      summarizeConversation,
      sessionConfig,
      coAuthorCommits,
      chatStyle,
      handleSuspend,
      openEditorWithFile,
      effectiveConfig.nvimConfig,
      effectiveConfig.editorIntegration,
      effectiveConfig.taskRouter,
    ],
  );

  if (suspended) {
    return <Box height={termHeight} />;
  }

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header — SoulForge | model | by ProxySoul */}
      <Box flexShrink={0} width="100%" paddingX={1} justifyContent="space-between" height={1}>
        <Box gap={1} flexShrink={1}>
          <Text color="#9B30FF" bold>
            󰊠 SoulForge
          </Text>
          <Text color="#333">│</Text>
          <TokenDisplay
            prompt={tokenUsage.prompt}
            completion={tokenUsage.completion}
            total={tokenUsage.total}
          />
          <Text color="#333">│</Text>
          <ContextBar contextManager={contextManager} chatChars={chatChars} modelId={activeModel} />
          <Text color="#333">│</Text>
          {git.isRepo ? (
            <Text color={git.isDirty ? "#FF8C00" : "#2d5"} wrap="truncate">
              {UI_ICONS.git} {truncate(git.branch ?? "HEAD", 30)}
              {git.isDirty ? "*" : ""}
            </Text>
          ) : (
            <Text color="#333">{UI_ICONS.git} no repo</Text>
          )}
          <Text color="#333">│</Text>
          <Text color="#6A0DAD" wrap="truncate">
            {isProxy ? (
              <>
                <Text color="#8B5CF6">󰌆 </Text>
                <Text color="#555">sub</Text>
                <Text color="#333">·</Text>
                {providerIcon(displayProvider)} {truncate(displayModel, 24)}
              </>
            ) : isGateway ? (
              <>
                <Text color="#555">󰒍 gw</Text>
                <Text color="#333">·</Text>
                {providerIcon(displayProvider)} {truncate(displayModel, 25)}
              </>
            ) : (
              <>
                {providerIcon(displayProvider)} {truncate(displayModel, 32)}
              </>
            )}
          </Text>
          {forgeMode !== "default" && (
            <>
              <Text color="#333">│</Text>
              <Text color={modeColor} bold>
                [{modeLabel}]
              </Text>
            </>
          )}
        </Box>
        <Text italic>
          <Text color="#333">by </Text>
          <Text color="#9B30FF">Proxy</Text>
          <Text color="#FF0040">Soul</Text>
        </Text>
      </Box>

      {/* System banner — ephemeral notifications between header and chat */}
      <SystemBanner messages={messages} expanded={codeExpanded} />

      {/* Main content — LLM selector lives here so its scrim stays within bounds */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
        {/* Editor panel */}
        <EditorPanel
          isOpen={editorOpen}
          fileName={editorFile}
          screenLines={screenLines}
          defaultBg={defaultBg}
          modeName={nvimMode}
          focused={focusMode === "editor"}
          cursorLine={cursorLine}
          cursorCol={cursorCol}
          onClosed={handleEditorClosed}
        />

        {/* Chat — full width, no border */}
        <Box flexDirection="column" width={editorVisible ? "40%" : "100%"}>
          {/* Messages */}
          {messages.length === 0 && streamSegments.length === 0 ? (
            <Box
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              justifyContent="center"
            >
              <Box flexDirection="column" alignItems="center" paddingX={2}>
                <GhostLogo />
                <Text color="#9B30FF" bold>
                  SoulForge
                </Text>
                <Text color="#333"> </Text>
                <Text color="#555">AI-Powered Terminal IDE</Text>
                <Text color="#333"> </Text>
                <Text color="#444">Ask anything, or try:</Text>
                <Text color="#666">
                  {"  "}/help{"    "}/open {"<file>"}
                  {"    "}/editor
                </Text>
                <Text color="#333"> </Text>
                <HealthCheck />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
              {/* Chat scroll area */}
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
                {isScrolledUp && (
                  <Box height={1} flexShrink={0} justifyContent="center">
                    <Text color="#555">▲ scrolled up — scroll down to return</Text>
                  </Box>
                )}
                <ScrollView
                  ref={scrollRef}
                  flexGrow={1}
                  flexShrink={1}
                  minHeight={0}
                  onScroll={handleScroll}
                  onContentHeightChange={handleContentHeightChange}
                  onViewportSizeChange={handleViewportSizeChange}
                >
                  <CodeExpandedProvider value={codeExpanded}>
                    <Box
                      key="chat-content"
                      flexDirection="column"
                      minHeight={chatViewportHeight}
                      justifyContent="flex-end"
                    >
                      <MessageList
                        messages={(messages.length > 100 ? messages.slice(-100) : messages).filter(
                          (m) => m.role !== "system",
                        )}
                        chatStyle={chatStyle}
                      />

                      {streamSegments.length > 0 && (
                        <Box paddingX={1} flexShrink={0} marginBottom={1}>
                          <Box
                            flexDirection="column"
                            borderStyle="bold"
                            borderLeft
                            borderTop={false}
                            borderBottom={false}
                            borderRight={false}
                            borderColor="#9B30FF"
                            paddingLeft={1}
                          >
                            <Box>
                              <Text color="#9B30FF">󰚩 Forge</Text>
                            </Box>
                            <StreamSegmentList
                              segments={streamSegments}
                              toolCalls={liveToolCalls}
                            />
                          </Box>
                        </Box>
                      )}
                    </Box>
                  </CodeExpandedProvider>
                </ScrollView>
              </Box>
              {/* Right sidebar — plan + changed files */}
              <RightSidebar
                plan={showPlanPanel ? (activePlan ?? sidebarPlan) : null}
                messages={messages}
                cwd={cwd}
              />
            </Box>
          )}

          {/* Bottom area — PlanReview, QuestionPrompt, or InputBox */}
          {showPlanReview ? (
            <Box flexShrink={0} paddingX={1}>
              <PlanReviewPrompt
                isActive={
                  focusMode === "chat" &&
                  !showLlmSelector &&
                  !showSkillSearch &&
                  !showGitCommit &&
                  !showGitMenu &&
                  !showSetup &&
                  !showSessionPicker &&
                  !showHelpPopup &&
                  !showErrorLog &&
                  !showEditorSettings &&
                  !showRouterSettings
                }
                onAccept={() => {
                  setShowPlanReview(false);

                  // Build execution prompt from plan file, or original request + context
                  let executionPrompt: string | null = null;
                  const planPath = join(cwd, ".soulforge", "plan.md");
                  try {
                    const planContent = readFileSync(planPath, "utf-8");
                    executionPrompt = `Execute the following plan step by step. Create a plan checklist and update steps as you go.\n\n${planContent}`;
                  } catch {
                    // No plan file — build from original request + AI context
                    const originalRequest = planRequestRef.current;
                    const lastAssistant = [...messages]
                      .reverse()
                      .find((m) => m.role === "assistant");
                    if (originalRequest) {
                      const ctx = lastAssistant
                        ? `\n\nContext from planning:\n${lastAssistant.content}`
                        : "";
                      executionPrompt = `Implement the following: ${originalRequest}${ctx}`;
                    } else if (lastAssistant) {
                      executionPrompt = `Implement the changes described below:\n\n${lastAssistant.content}`;
                    }
                  }

                  if (!executionPrompt) {
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: crypto.randomUUID(),
                        role: "system",
                        content: "No plan found to execute.",
                        timestamp: Date.now(),
                      },
                    ]);
                    return;
                  }

                  // Exit plan mode — refs update immediately (no stale closure issues)
                  planModeRef.current = false;
                  planRequestRef.current = null;
                  setForgeMode("default");
                  contextManager.setForgeMode("default");

                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: "system",
                      content: "Plan accepted — executing...",
                      timestamp: Date.now(),
                    },
                  ]);

                  // Direct call — planModeRef is already false so handleSubmit creates full agent.
                  // contextManager already has "default" mode so system prompt is correct.
                  handleSubmit(executionPrompt);
                }}
                onRevise={(feedback) => {
                  setShowPlanReview(false);
                  handleSubmit(feedback);
                }}
                onCancel={() => {
                  planModeRef.current = false;
                  planRequestRef.current = null;
                  setShowPlanReview(false);
                  setForgeMode("default");
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: "system",
                      content: "Plan cancelled.",
                      timestamp: Date.now(),
                    },
                  ]);
                }}
              />
            </Box>
          ) : pendingQuestion ? (
            <Box flexShrink={0} paddingX={1}>
              <QuestionPrompt
                question={pendingQuestion}
                isActive={
                  focusMode === "chat" &&
                  !showLlmSelector &&
                  !showSkillSearch &&
                  !showGitCommit &&
                  !showGitMenu &&
                  !showSetup &&
                  !showSessionPicker &&
                  !showHelpPopup &&
                  !showErrorLog &&
                  !showEditorSettings &&
                  !showRouterSettings
                }
              />
            </Box>
          ) : (
            <InputBox
              onSubmit={handleSubmit}
              isLoading={isLoading}
              isFocused={
                focusMode === "chat" &&
                !showLlmSelector &&
                !showSkillSearch &&
                !showGitCommit &&
                !showGitMenu &&
                !showSetup &&
                !showSessionPicker &&
                !showHelpPopup &&
                !showErrorLog &&
                !showEditorSettings &&
                !showRouterSettings
              }
              onQueue={(msg) =>
                setMessageQueue((prev) => [...prev, { content: msg, queuedAt: Date.now() }])
              }
              queueCount={messageQueue.length}
            />
          )}
        </Box>

        {/* LLM Selector — inside main content so scrim doesn't cover header/footer */}
        <LlmSelector
          visible={showLlmSelector}
          activeModel={activeModel}
          onSelect={(modelId) => {
            if (routerSlotPicking) {
              // Assign to router slot
              const current = effectiveConfig.taskRouter ?? {
                planning: null,
                coding: null,
                exploration: null,
                default: null,
              };
              const updated = { ...current, [routerSlotPicking]: modelId };
              const newConfig = { ...config, taskRouter: updated };
              saveConfig(newConfig);
              setSessionConfig((prev) => ({ ...prev, taskRouter: updated }));
              setRouterSlotPicking(null);
            } else {
              setActiveModel(modelId);
            }
          }}
          onClose={() => {
            setShowLlmSelector(false);
            setRouterSlotPicking(null);
          }}
        />

        {/* Git Commit Modal */}
        <GitCommitModal
          visible={showGitCommit}
          cwd={cwd}
          coAuthor={coAuthorCommits}
          onClose={() => setShowGitCommit(false)}
          onCommitted={(msg) => {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Committed: ${msg}`,
                timestamp: Date.now(),
              },
            ]);
          }}
          onRefresh={() => {
            git.refresh();
            contextManager.refreshGitContext();
          }}
        />

        {/* Git Menu */}
        <GitMenu
          visible={showGitMenu}
          cwd={cwd}
          onClose={() => setShowGitMenu(false)}
          onCommit={() => {
            setShowGitMenu(false);
            setShowGitCommit(true);
          }}
          onSuspend={handleSuspend}
          onSystemMessage={(msg) => {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "system", content: msg, timestamp: Date.now() },
            ]);
          }}
          onRefresh={() => {
            git.refresh();
            contextManager.refreshGitContext();
          }}
        />

        {/* Session Picker */}
        <SessionPicker
          visible={showSessionPicker}
          cwd={cwd}
          onClose={() => setShowSessionPicker(false)}
          onRestore={handleRestoreSession}
          onSystemMessage={(msg) => {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "system", content: msg, timestamp: Date.now() },
            ]);
          }}
        />

        {/* Skills Search */}
        <SkillSearch
          visible={showSkillSearch}
          contextManager={contextManager}
          onClose={() => setShowSkillSearch(false)}
          onSystemMessage={(msg) => {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "system", content: msg, timestamp: Date.now() },
            ]);
          }}
        />

        {/* Help Popup */}
        <HelpPopup visible={showHelpPopup} onClose={() => setShowHelpPopup(false)} />

        {/* Editor Settings */}
        <EditorSettings
          visible={showEditorSettings}
          settings={effectiveConfig.editorIntegration}
          onUpdate={(settings: EditorIntegration) => {
            setSessionConfig((prev) => ({ ...prev, editorIntegration: settings }));
            saveConfig({ ...config, editorIntegration: settings });
          }}
          onClose={() => setShowEditorSettings(false)}
        />

        {/* Router Settings */}
        <RouterSettings
          visible={showRouterSettings && !routerSlotPicking}
          router={effectiveConfig.taskRouter}
          activeModel={activeModel}
          onPickSlot={(slot) => {
            setRouterSlotPicking(slot);
            setShowLlmSelector(true);
          }}
          onClearSlot={(slot) => {
            const current = effectiveConfig.taskRouter ?? {
              planning: null,
              coding: null,
              exploration: null,
              default: null,
            };
            const updated = { ...current, [slot]: null };
            const newConfig = { ...config, taskRouter: updated };
            saveConfig(newConfig);
            setSessionConfig((prev) => ({ ...prev, taskRouter: updated }));
          }}
          onClose={() => setShowRouterSettings(false)}
        />

        {/* Setup Guide */}
        <SetupGuide
          visible={showSetup}
          onClose={() => setShowSetup(false)}
          onSystemMessage={(msg) => {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "system", content: msg, timestamp: Date.now() },
            ]);
          }}
        />

        {/* Error Log */}
        <ErrorLog
          visible={showErrorLog}
          messages={messages}
          onClose={() => setShowErrorLog(false)}
        />
      </Box>

      {/* Footer — branding + shortcuts */}
      <Box flexShrink={0} width="100%">
        <Footer />
      </Box>
    </Box>
  );
}
