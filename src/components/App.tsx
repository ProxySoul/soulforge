import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Selection, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  applyConfigPatch,
  mergeConfigs,
  removeGlobalConfigKeys,
  removeProjectConfigKeys,
  saveGlobalConfig,
  saveProjectConfig,
  stripConfigKeys,
} from "../config/index.js";
import { ContextManager } from "../core/context/manager.js";
import { icon, providerIcon, UI_ICONS } from "../core/icons.js";
import { fetchOpenRouterMetadata } from "../core/llm/models.js";
import { notifyProviderSwitch } from "../core/llm/provider.js";
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { suspendAndRun } from "../core/terminal/suspend.js";
import type { ChatInstance, WorkspaceSnapshot } from "../hooks/useChat.js";
import { useEditorFocus } from "../hooks/useEditorFocus.js";
import { useEditorInput } from "../hooks/useEditorInput.js";
import { useForgeMode } from "../hooks/useForgeMode.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useNeovim } from "../hooks/useNeovim.js";
import { buildSessionMeta } from "../hooks/useSessionBuilder.js";
import { useTabs } from "../hooks/useTabs.js";
import { cleanupAndExit, setExitSessionId } from "../index.js";
import { logBackgroundError } from "../stores/errors.js";
import { startMemoryPoll } from "../stores/statusbar.js";
import { type ModalName, selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import type { AppConfig, ChatMessage, EditorIntegration } from "../types/index.js";
import { BrandTag } from "./BrandTag.js";
import { CommandPicker } from "./CommandPicker.js";
import { CompactionLog } from "./CompactionLog.js";
import { ContextBar } from "./ContextBar.js";
import { handleCommand } from "./commands.js";
import { EditorPanel } from "./EditorPanel.js";
import { EditorSettings } from "./EditorSettings.js";
import { ErrorLog } from "./ErrorLog.js";
import { Footer } from "./Footer.js";
import { GitCommitModal } from "./GitCommitModal.js";
import { GitMenu } from "./GitMenu.js";
import { HelpPopup } from "./HelpPopup.js";
import { InfoPopup } from "./InfoPopup.js";
import { LlmSelector } from "./LlmSelector.js";
import { LspInstallSearch } from "./LspInstallSearch.js";
import { LspStatusPopup } from "./LspStatusPopup.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { RepoMapStatusPopup } from "./RepoMapStatusPopup.js";
import { RouterSettings } from "./RouterSettings.js";
import { SessionPicker } from "./SessionPicker.js";
import { SetupGuide } from "./SetupGuide.js";
import { SkillSearch } from "./SkillSearch.js";
import type { ConfigScope } from "./shared.js";
import { garble, WORDMARK as SHUTDOWN_WORDMARK } from "./splash.js";
import { TabBar } from "./TabBar.js";
import { TabInstance } from "./TabInstance.js";
import { TokenDisplay } from "./TokenDisplay.js";
import { WebSearchSettings } from "./WebSearchSettings.js";

startMemoryPoll();

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const ABORT_ON_LOADING = new Set(["/clear", "/compact", "/plan"]);

const SHUTDOWN_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SHUTDOWN_STEPS = [
  "Quenching active flames…",
  "Forging session to disk…",
  "Sealing the vault…",
  "Until next time, forgemaster.",
];

function ShutdownSplash({
  phase,
  sessionId,
  height,
}: {
  phase: number;
  sessionId: string | null;
  height: number;
}) {
  const shortId = sessionId?.slice(0, 8);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(timer);
  }, []);

  const ghostFade = ["▓", "▒", "░", " ", " ", "░", "▒", "▓"];
  const fadeIdx = Math.min(tick, ghostFade.length - 1);
  const ghostChar = tick < ghostFade.length ? ghostFade[fadeIdx] : icon("ghost");
  const spin = SHUTDOWN_SPINNER[tick % SHUTDOWN_SPINNER.length];

  return (
    <box flexDirection="column" height={height} justifyContent="center" alignItems="center">
      <text fg="#9B30FF" attributes={TextAttributes.BOLD}>
        {ghostChar}
      </text>
      <text fg="#4a1a6b" attributes={TextAttributes.DIM}>
        ∿~∿
      </text>
      <box height={1} />
      {SHUTDOWN_WORDMARK.map((line) => (
        <text key={line} fg="#9B30FF" attributes={TextAttributes.BOLD}>
          {tick < 4 ? garble(line) : line}
        </text>
      ))}
      <box height={1} />
      <box flexDirection="column" gap={0} alignItems="center" height={SHUTDOWN_STEPS.length + 3}>
        {SHUTDOWN_STEPS.map((label, i) => {
          if (i > phase) return null;
          const done = i < phase;
          return (
            <box key={label} gap={1} flexDirection="row">
              <text fg={done ? "#4a7" : "#9B30FF"}>{done ? "✓" : spin}</text>
              <text fg={done ? "#555" : "#aaa"}>{label}</text>
            </box>
          );
        })}
        {shortId && phase >= 3 && (
          <>
            <box height={1} />
            <text>
              <span fg="#555">Resume: </span>
              <span fg="#8B5CF6">soulforge --session {shortId}</span>
            </text>
          </>
        )}
      </box>
    </box>
  );
}

import type { ProviderStatus } from "../core/llm/provider.js";
import type { PrerequisiteStatus } from "../core/setup/prerequisites.js";

interface Props {
  config: AppConfig;
  projectConfig?: Partial<AppConfig> | null;
  resumeSessionId?: string;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  preloadedContextManager?: ContextManager;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal protocol responses
const KITTY_PROTOCOL_RESPONSE_RE = /\x1b\[\?\d+u/g;

function nativeCopy(text: string): void {
  const cmd = process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
  const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  proc.stdin.write(text);
  proc.stdin.end();
}

export function App({
  config,
  projectConfig,
  resumeSessionId,
  bootProviders,
  bootPrereqs,
  preloadedContextManager,
}: Props) {
  const renderer = useRenderer();
  const { height: termHeight, width: termWidth } = useTerminalDimensions();
  const [shutdownPhase, setShutdownPhase] = useState(-1);
  const savedSessionIdRef = useRef<string | null>(null);

  // Strip Kitty keyboard protocol query responses (\x1b[?<n>u) from stdin.
  // These leak when Neovim queries the terminal's protocol state.
  useEffect(() => {
    const stdin = process.stdin;
    const originalRead = stdin.read.bind(stdin);
    const patchedRead = (size?: number) => {
      const chunk = originalRead(size);
      if (chunk === null) return null;
      const str = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8");
      KITTY_PROTOCOL_RESPONSE_RE.lastIndex = 0;
      if (!KITTY_PROTOCOL_RESPONSE_RE.test(str)) return chunk;
      const cleaned = str.replace(KITTY_PROTOCOL_RESPONSE_RE, "");
      if (cleaned.length === 0) return null;
      if (typeof chunk === "string") return cleaned;
      return Buffer.from(cleaned, "utf-8");
    };
    stdin.read = patchedRead as typeof stdin.read;
    return () => {
      stdin.read = originalRead;
    };
  }, []);

  const copyToClipboard = useCallback(
    (text: string) => {
      if (!renderer.copyToClipboardOSC52(text)) {
        nativeCopy(text);
      }
    },
    [renderer],
  );

  // Auto-copy to clipboard when mouse selection finishes
  useEffect(() => {
    const onSelection = (sel: Selection) => {
      const text = sel.getSelectedText();
      if (text) copyToClipboard(text);
    };
    renderer.on("selection", onSelection);
    return () => {
      renderer.off("selection", onSelection);
    };
  }, [renderer, copyToClipboard]);

  // Pre-fetch OpenRouter model metadata (background, no auth needed)
  useEffect(() => {
    fetchOpenRouterMetadata();
  }, []);

  // Tiered config: project > global
  const [globalConfig, setGlobalConfig] = useState<AppConfig>(config);
  const [projConfig, setProjConfig] = useState<Partial<AppConfig> | null>(projectConfig ?? null);
  const [routerScope, setRouterScope] = useState<ConfigScope>(() =>
    projectConfig && "taskRouter" in projectConfig ? "project" : "global",
  );
  const modelScope = useMemo(
    () =>
      projConfig && "defaultModel" in projConfig
        ? ("project" as ConfigScope)
        : ("global" as ConfigScope),
    [projConfig],
  );
  const effectiveConfig = useMemo(
    () => mergeConfigs(globalConfig, projConfig),
    [globalConfig, projConfig],
  );

  // Editor state
  const { focusMode, editorOpen, toggleEditor, openEditor, closeEditor, focusChat, focusEditor } =
    useEditorFocus();
  const [editorVisible, setEditorVisible] = useState(false);
  const hasTabBarRef = useRef(false);
  const editorSplitRef = useRef(60);
  const {
    ready: nvimReady,
    screenLines,
    defaultBg,
    modeName: nvimMode,
    fileName: editorFile,
    cursorLine,
    cursorCol,
    visualSelection,
    clearSelection: clearNvimSelection,
    openFile: nvimOpen,
    sendKeys,
    sendMouse,
    error: nvimError,
  } = useNeovim(
    editorOpen,
    effectiveConfig.nvimPath,
    effectiveConfig.nvimConfig,
    closeEditor,
    effectiveConfig.vimHints !== false,
    hasTabBarRef.current,
    editorSplitRef.current,
  );

  const pendingEditorFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (nvimReady && pendingEditorFileRef.current) {
      const file = pendingEditorFileRef.current;
      pendingEditorFileRef.current = null;
      nvimOpen(file).catch((err) => {
        logBackgroundError(
          "editor",
          `failed to open ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }, [nvimReady, nvimOpen]);

  const openEditorWithFile = useCallback(
    (file: string) => {
      if (editorOpen && nvimReady) {
        nvimOpen(file).catch((err) => {
          logBackgroundError(
            "editor",
            `failed to open ${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } else {
        pendingEditorFileRef.current = file;
        openEditor();
      }
    },
    [editorOpen, nvimReady, nvimOpen, openEditor],
  );

  useEffect(() => {
    if (editorOpen) setEditorVisible(true);
  }, [editorOpen]);

  // Kick the renderer after layout-affecting transitions to prevent stale paints.
  // requestRender() is a no-op if nothing is dirty — safe to call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on layout transitions, not just renderer change
  useEffect(() => {
    renderer.requestRender();
  }, [editorOpen, editorVisible, focusMode, renderer]);

  const handleEditorClosed = useCallback(() => {
    setEditorVisible(false);
  }, []);

  useEditorInput({
    sendKeys,
    sendMouse,
    isEditorFocused: focusMode === "editor" && nvimReady,
    isEditorVisible: editorVisible,
    onFocusChat: focusChat,
    onFocusEditor: focusEditor,
    hasTabBar: hasTabBarRef.current,
    editorSplit: editorSplitRef.current,
  });

  const { modals, routerSlotPicking, commandPickerConfig, infoPopupConfig, suspended } = useUIStore(
    useShallow((s) => ({
      modals: s.modals,
      routerSlotPicking: s.routerSlotPicking,
      commandPickerConfig: s.commandPickerConfig,
      infoPopupConfig: s.infoPopupConfig,
      suspended: s.suspended,
    })),
  );
  const isModalOpen = useUIStore(selectIsAnyModalOpen);
  const editorSplit = useUIStore((s) => s.editorSplit);

  // Stable close handlers — cached in ref so memo'd children see stable refs
  const closerCache = useRef<Partial<Record<ModalName, () => void>>>({});
  const getCloser = (name: ModalName) =>
    (closerCache.current[name] ??= () => useUIStore.getState().closeModal(name));

  useEffect(() => {
    if (getMissingRequired().length > 0) useUIStore.getState().openModal("setup");
  }, []);

  const cwd = process.cwd();

  const saveToScope = useCallback(
    (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => {
      if (toScope === "global") {
        saveGlobalConfig(patch);
        setGlobalConfig((prev) => applyConfigPatch(prev, patch));
      } else if (toScope === "project") {
        saveProjectConfig(cwd, patch);
        setProjConfig((prev) => applyConfigPatch(prev ?? {}, patch));
      }

      if (fromScope && fromScope !== toScope) {
        const keys = Object.keys(patch);
        if (fromScope === "global") {
          removeGlobalConfigKeys(keys);
          setGlobalConfig((prev) => stripConfigKeys(prev, keys));
        }
        if (fromScope === "project") {
          removeProjectConfigKeys(cwd, keys);
          setProjConfig((prev) => (prev ? stripConfigKeys(prev, keys) : prev));
        }
      }
    },
    [cwd],
  );

  const detectScope = useCallback(
    (key: string): ConfigScope => {
      if (projConfig && key in projConfig) return "project";
      return "global";
    },
    [projConfig],
  );

  // Initialize security guard once
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    initForbidden(cwd);
  }, []);

  const contextManager = useMemo(
    () => preloadedContextManager ?? new ContextManager(cwd),
    [cwd, preloadedContextManager],
  );
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);

  const restoreSessionMemory = useCallback((_sessionId: string) => {
    // Session-scoped memory was removed — memories are now always persisted to project/global
  }, []);
  const git = useGitStatus(cwd);
  const {
    mode: forgeMode,
    cycleMode,
    modeLabel,
    modeColor,
    setMode: setForgeMode,
  } = useForgeMode();

  useEffect(() => {
    contextManager.setForgeMode(forgeMode);
  }, [forgeMode, contextManager]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init from config
  useEffect(() => {
    if (effectiveConfig.defaultForgeMode) setForgeMode(effectiveConfig.defaultForgeMode);
  }, []);

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

  useEffect(() => {
    if (effectiveConfig.editorIntegration) {
      contextManager.setEditorIntegration(effectiveConfig.editorIntegration);
    }
  }, [effectiveConfig.editorIntegration, contextManager]);

  useEffect(() => {
    if (effectiveConfig.repoMap !== undefined) {
      contextManager.setRepoMapEnabled(effectiveConfig.repoMap);
    }
  }, [effectiveConfig.repoMap, contextManager]);

  useEffect(() => {
    contextManager.setTaskRouter(effectiveConfig.taskRouter);
  }, [effectiveConfig.taskRouter, contextManager]);

  useEffect(() => {
    if (effectiveConfig.semanticSummaries !== undefined) {
      contextManager.setSemanticSummaries(effectiveConfig.semanticSummaries);
    }
  }, [effectiveConfig.semanticSummaries, contextManager]);

  useEffect(() => {
    if (effectiveConfig.chatStyle) useUIStore.getState().setChatStyle(effectiveConfig.chatStyle);
  }, [effectiveConfig.chatStyle]);

  useEffect(() => {
    if (effectiveConfig.showReasoning !== undefined)
      useUIStore.getState().setShowReasoning(effectiveConfig.showReasoning);
  }, [effectiveConfig.showReasoning]);

  useEffect(() => {
    if (effectiveConfig.editorSplit !== undefined)
      useUIStore.setState({ editorSplit: effectiveConfig.editorSplit });
  }, [effectiveConfig.editorSplit]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: contextManager is stable (useMemo on cwd)
  useEffect(() => {
    contextManager.refreshGitContext();
  }, []);

  const handleSuspend = useCallback(
    async (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => {
      useUIStore.getState().setSuspended(true);
      await new Promise((r) => setTimeout(r, 50));
      const result = await suspendAndRun({ ...opts, cwd });
      useUIStore.getState().setSuspended(false);
      if (result.exitCode === null) {
        const activeChat = tabMgrRef.current?.getActiveChat();
        activeChat?.setMessages((prev: ChatMessage[]) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system" as const,
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

  // ─── Tab management (no freeze/restore — each tab owns its own useChat) ───
  const tabMgr = useTabs();
  const tabMgrRef = useRef(tabMgr);
  tabMgrRef.current = tabMgr;
  hasTabBarRef.current = tabMgr.tabCount > 1;
  editorSplitRef.current = editorSplit;

  const sharedResources = useMemo(() => contextManager.getSharedResources(), [contextManager]);

  const workspaceSnapshotRef = useRef<(() => WorkspaceSnapshot) | null>(null);
  workspaceSnapshotRef.current = () => ({
    forgeMode,
    tabStates: tabMgr.getAllTabStates(),
    activeTabId: tabMgr.activeTabId,
  });

  const getWorkspaceSnapshot = useCallback(
    (): WorkspaceSnapshot =>
      workspaceSnapshotRef.current?.() ?? { forgeMode, tabStates: [], activeTabId: "" },
    [forgeMode],
  );

  const addSystemMessage = useCallback((msg: string) => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    activeChat?.setMessages((prev: ChatMessage[]) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system" as const, content: msg, timestamp: Date.now() },
    ]);
  }, []);

  const refreshGit = useCallback(() => {
    git.refresh();
    contextManager.refreshGitContext();
  }, [git, contextManager]);

  const handleExit = useCallback(() => {
    if (shutdownPhase >= 0) return;
    setShutdownPhase(0);

    setTimeout(() => {
      // Abort all active tabs
      for (const tab of tabMgrRef.current.tabs) {
        tabMgrRef.current.getChat(tab.id)?.abort();
      }
      setShutdownPhase(1);

      setTimeout(() => {
        try {
          const activeChat = tabMgrRef.current.getActiveChat();
          const hasUserMessages = activeChat?.messages.some(
            (m: ChatMessage) => m.role === "user" || m.role === "assistant",
          );
          const snapshot = workspaceSnapshotRef.current?.();
          if (snapshot && hasUserMessages && activeChat) {
            const { meta, tabMessages } = buildSessionMeta({
              sessionId: activeChat.sessionId,
              title: SessionManager.deriveTitle(activeChat.messages),
              cwd,
              snapshot,
              currentTabMessages: activeChat.messages.filter(
                (m: ChatMessage) => m.role !== "system" || m.showInChat,
              ),
            });
            sessionManager.saveSession(meta, tabMessages);
            setExitSessionId(meta.id);
            savedSessionIdRef.current = meta.id;
          }
        } catch (err) {
          logBackgroundError(
            "shutdown",
            `session save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setShutdownPhase(2);

        setTimeout(() => {
          setShutdownPhase(3);
          setTimeout(() => {
            renderer.destroy();
            try {
              contextManager.dispose();
            } catch (err) {
              logBackgroundError(
                "shutdown",
                `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            cleanupAndExit(0);
          }, 1000);
        }, 350);
      }, 300);
    }, 250);
  }, [shutdownPhase, cwd, sessionManager, contextManager, renderer]);

  // ─── Session restore on mount ───
  const hasRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time restore on mount
  useEffect(() => {
    if (hasRestoredRef.current || !resumeSessionId) return;
    hasRestoredRef.current = true;

    const fullId = sessionManager.findByPrefix(resumeSessionId);
    if (!fullId) {
      addSystemMessage(`Session not found: ${resumeSessionId}`);
      return;
    }

    const data = sessionManager.loadSession(fullId);
    if (data) {
      tabMgr.restoreFromMeta(data.meta.tabs, data.meta.activeTabId, data.tabMessages);
      setForgeMode(data.meta.forgeMode);
      restoreSessionMemory(data.meta.id);
      setExitSessionId(data.meta.id);
    }
  }, []);

  // Track exit session from active tab
  const [activeModelForHeader, setActiveModelForHeader] = useState(effectiveConfig.defaultModel);
  const activeChatRef = useRef<ChatInstance | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs every render to keep activeChatRef in sync
  useEffect(() => {
    const chat = tabMgr.getActiveChat();
    activeChatRef.current = chat;
    if (chat) {
      setActiveModelForHeader(chat.activeModel);
      const hasContent = chat.messages.some(
        (m: ChatMessage) => m.role === "user" || m.role === "assistant",
      );
      setExitSessionId(hasContent ? chat.sessionId : null);
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run on tab count/active changes
  useEffect(() => {
    if (tabMgr.tabCount <= 1) return;
    try {
      const dir = join(cwd, ".soulforge");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const activeChat = tabMgr.getActiveChat();
      const layout = tabMgr.tabs.map((t) => ({
        id: t.id,
        label: t.label,
        activeModel: t.id === tabMgr.activeTabId ? activeChat?.activeModel : undefined,
      }));
      writeFileSync(join(dir, "tabs.json"), JSON.stringify(layout, null, 2));
    } catch {}
  }, [tabMgr.tabCount, tabMgr.activeTabId]);

  const { displayProvider, displayModel, isGateway, isProxy } = useMemo(() => {
    const model = activeModelForHeader;
    if (model === "none") {
      return {
        displayProvider: "none",
        displayModel: "Ctrl+L to select",
        isGateway: false,
        isProxy: false,
      };
    }
    const isGw = model.startsWith("vercel_gateway/");
    const isPrx = model.startsWith("proxy/");
    if (isGw || isPrx) {
      const prefix = isGw ? "vercel_gateway/" : "proxy/";
      const rest = model.slice(prefix.length);
      const idx = rest.indexOf("/");
      return {
        displayProvider: idx >= 0 ? rest.slice(0, idx) : rest,
        displayModel: idx >= 0 ? rest.slice(idx + 1) : rest,
        isGateway: isGw,
        isProxy: isPrx,
      };
    }
    const idx = model.indexOf("/");
    return {
      displayProvider: idx >= 0 ? model.slice(0, idx) : "unknown",
      displayModel: idx >= 0 ? model.slice(idx + 1) : model,
      isGateway: false,
      isProxy: false,
    };
  }, [activeModelForHeader]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run when nvimError changes
  useEffect(() => {
    if (nvimError) addSystemMessage(`Neovim error: ${nvimError}`);
  }, [nvimError]);

  const handleTabCommand = useCallback(
    (input: string, chat: ChatInstance) => {
      const cmd = input.trim().toLowerCase().split(/\s+/)[0] ?? "";
      if (chat.isLoading && ABORT_ON_LOADING.has(cmd)) {
        chat.abort();
        chat.setMessageQueue([]);
      }

      if (cmd === "/continue") {
        chat.handleSubmit("Continue from where you left off. Complete any remaining work.");
        return;
      }
      if (cmd === "/plan" || input.trim().toLowerCase().startsWith("/plan ")) {
        const desc = input.trim().slice(5).trim();
        if (chat.planMode) {
          chat.setPlanMode(false);
          chat.setPlanRequest(null);
          setForgeMode("default");
          chat.setPendingPlanReview(null);
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode OFF",
              timestamp: Date.now(),
            },
          ]);
        } else {
          chat.setPlanMode(true);
          chat.setPlanRequest(desc || null);
          setForgeMode("plan");
          chat.setMessages((prev: ChatMessage[]) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system" as const,
              content: "Plan mode ON — Forge will research and plan without making changes.",
              timestamp: Date.now(),
            },
          ]);
          if (desc) {
            setTimeout(() => chat.handleSubmit(desc), 0);
          }
        }
        return;
      }
      const uiState = useUIStore.getState();
      handleCommand(input, {
        chat,
        tabMgr,
        toggleFocus: toggleEditor,
        nvimOpen,
        exit: handleExit,
        openSkills: () => uiState.openModal("skillSearch"),
        openLspInstall: () => uiState.openModal("lspInstall"),
        openGitCommit: () => uiState.openModal("gitCommit"),
        openSessions: () => uiState.openModal("sessionPicker"),
        openHelp: () => uiState.openModal("helpPopup"),
        openErrorLog: () => uiState.openModal("errorLog"),
        cwd,
        refreshGit: () => {
          git.refresh();
          contextManager.refreshGitContext();
        },
        setForgeMode,
        currentMode: forgeMode,
        currentModeLabel: modeLabel,
        contextManager,
        chatStyle: uiState.chatStyle,
        setChatStyle: uiState.setChatStyle,
        handleSuspend,
        openGitMenu: () => uiState.openModal("gitMenu"),
        openEditorWithFile,
        effectiveNvimConfig: effectiveConfig.nvimConfig,
        vimHints: effectiveConfig.vimHints !== false,
        verbose: effectiveConfig.verbose === true,
        diffStyle: effectiveConfig.diffStyle ?? "default",
        compactionStrategy: effectiveConfig.compaction?.strategy ?? "v1",
        showReasoning: uiState.showReasoning,
        setShowReasoning: uiState.setShowReasoning,
        openSetup: () => uiState.openModal("setup"),
        openEditorSettings: () => uiState.openModal("editorSettings"),
        openRouterSettings: () => {
          setRouterScope(detectScope("taskRouter"));
          uiState.openModal("routerSettings");
        },
        openProviderSettings: () => uiState.openModal("providerSettings"),
        openWebSearchSettings: () => uiState.openModal("webSearchSettings"),
        openLspStatus: () => uiState.openModal("lspStatus"),
        openCompactionLog: () => uiState.openModal("compactionLog"),
        openCommandPicker: (pickerConfig) => uiState.openCommandPicker(pickerConfig),
        openInfoPopup: (popupConfig) => uiState.openInfoPopup(popupConfig),
        toggleChanges: () => uiState.toggleChangesExpanded(),
        saveToScope,
        detectScope,
        agentFeatures: effectiveConfig.agentFeatures,
      });
    },
    [
      tabMgr,
      toggleEditor,
      nvimOpen,
      handleExit,
      cwd,
      git,
      forgeMode,
      modeLabel,
      setForgeMode,
      contextManager,
      handleSuspend,
      openEditorWithFile,
      effectiveConfig.nvimConfig,
      effectiveConfig.vimHints,
      effectiveConfig.verbose,
      effectiveConfig.diffStyle,
      effectiveConfig.compaction?.strategy,
      saveToScope,
      detectScope,
      effectiveConfig.agentFeatures,
    ],
  );

  const closeLlmSelector = useCallback(() => {
    useUIStore.getState().closeModal("llmSelector");
    useUIStore.getState().setRouterSlotPicking(null);
  }, []);

  const closeInfoPopup = useCallback(() => {
    const cfg = useUIStore.getState().infoPopupConfig;
    useUIStore.getState().closeInfoPopup();
    cfg?.onClose?.();
  }, []);

  const onGitMenuCommit = useCallback(() => {
    useUIStore.getState().closeModal("gitMenu");
    useUIStore.getState().openModal("gitCommit");
  }, []);

  // Global keybindings
  useKeyboard((evt) => {
    if (shutdownPhase >= 0 || selectIsAnyModalOpen(useUIStore.getState())) return;

    if (evt.ctrl && evt.name === "e") {
      toggleEditor();
      return;
    }
    if (focusMode === "editor") {
      // Editor is focused — only handle Ctrl+C (exit) here; all other keys go to Neovim.
      if (evt.ctrl && evt.name === "c") {
        handleExit();
        return;
      }
      return;
    }
    if (evt.ctrl && evt.name === "o") {
      useUIStore.getState().toggleCodeExpanded();
      return;
    }

    // Copy must be checked BEFORE snap-scroll (scroll can invalidate selection)
    if ((evt.ctrl || evt.super) && evt.name === "c") {
      const sel = renderer.getSelection();
      if (sel) {
        const text = sel.getSelectedText();
        if (text) {
          copyToClipboard(text);
          return;
        }
      }
      // When chat is focused, let InputBox handle Ctrl+C (clears input if non-empty)
      if (evt.ctrl && focusMode === "chat") return;
      if (evt.ctrl) handleExit();
      return;
    }

    if (evt.ctrl && evt.name === "x") {
      activeChatRef.current?.abort();
      return;
    }
    if (evt.ctrl && evt.name === "l") {
      useUIStore.getState().toggleModal("llmSelector");
    }
    if (evt.ctrl && evt.name === "s") {
      useUIStore.getState().toggleModal("skillSearch");
    }

    if (evt.ctrl && evt.name === "t") {
      useUIStore.getState().toggleReasoningExpanded();
      return;
    }
    if (evt.ctrl && evt.name === "d") {
      cycleMode();
    }
    if (evt.ctrl && evt.name === "g") {
      useUIStore.getState().toggleModal("gitMenu");
    }
    if (evt.ctrl && evt.name === "h") {
      useUIStore.getState().toggleModal("helpPopup");
    }
    if (evt.ctrl && evt.name === "p") {
      useUIStore.getState().toggleModal("sessionPicker");
    }
    if (evt.meta && evt.name === "r") {
      useUIStore.getState().toggleModal("errorLog");
    }
    if (evt.meta && evt.name === "t") {
      tabMgr.createTab();
    }
    if (evt.meta && evt.name === "w") {
      if (tabMgr.tabCount > 1) {
        tabMgr.closeTab(tabMgr.activeTabId);
      }
    }
    if ((evt.meta || evt.ctrl) && evt.name >= "1" && evt.name <= "9") {
      tabMgr.switchToIndex(Number(evt.name) - 1);
    }
    if (evt.meta && evt.name === "[") {
      tabMgr.prevTab();
    }
    if (evt.meta && evt.name === "]") {
      tabMgr.nextTab();
    }
    // PageUp/PageDown are now handled by TabInstance's own scrollRef
  });

  if (suspended) {
    return <box height={termHeight} />;
  }

  if (shutdownPhase >= 0) {
    return (
      <ShutdownSplash
        phase={shutdownPhase}
        sessionId={savedSessionIdRef.current}
        height={termHeight}
      />
    );
  }

  const anyModalOpen = shutdownPhase >= 0 || isModalOpen;

  return (
    <box flexDirection="column" height={termHeight}>
      <box
        flexShrink={0}
        width="100%"
        paddingX={1}
        justifyContent="space-between"
        height={1}
        flexDirection="row"
      >
        <box flexShrink={0}>
          <text fg="#9B30FF" attributes={TextAttributes.BOLD}>
            {icon("ghost")} SoulForge
          </text>
        </box>
        <box gap={1} flexShrink={1} flexDirection="row" justifyContent="center" overflow="hidden">
          <text truncate>
            {isProxy && (
              <span fg="#8B5CF6">
                {icon("proxy")} proxy<span fg="#444">›</span>
              </span>
            )}
            {isGateway && (
              <span fg="#555">
                {icon("vercel_gateway")} gateway<span fg="#444">›</span>
              </span>
            )}
            <span fg="#666">{providerIcon(displayProvider)} </span>
            <span fg="#888">{truncate(displayModel, isProxy || isGateway ? 24 : 32)}</span>
          </text>
          {git.isRepo && (
            <>
              <text fg="#333">·</text>
              <text fg={git.isDirty ? "#b87333" : "#4a7"} truncate>
                {UI_ICONS.git} {truncate(git.branch ?? "HEAD", termWidth >= 120 ? 30 : 15)}
                {git.isDirty ? "*" : ""}
              </text>
            </>
          )}
          {forgeMode !== "default" && (
            <>
              <text fg="#333">·</text>
              <text fg={modeColor} attributes={TextAttributes.BOLD}>
                [{modeLabel}]
              </text>
            </>
          )}
          <text fg="#333">│</text>
          <ContextBar contextManager={contextManager} modelId={activeModelForHeader} />
          <text fg="#222">·</text>
          <TokenDisplay />
        </box>
        {termWidth >= 80 && <BrandTag />}
      </box>

      {tabMgr.tabCount > 1 ? (
        <box flexShrink={0} marginTop={1}>
          <TabBar
            tabs={tabMgr.tabs}
            activeTabId={tabMgr.activeTabId}
            onSwitch={tabMgr.switchTab}
            getActivity={tabMgr.getTabActivity}
          />
        </box>
      ) : !editorVisible ? (
        <box height={1} flexShrink={0} />
      ) : null}

      <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
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
          showHints={effectiveConfig.vimHints !== false}
          error={nvimError}
          split={editorSplit}
        />

        {tabMgr.tabs.map((tab) => (
          <TabInstance
            key={tab.id}
            tabId={tab.id}
            visible={tab.id === tabMgr.activeTabId}
            effectiveConfig={effectiveConfig}
            sharedResources={sharedResources}
            sessionManager={sessionManager}
            cwd={cwd}
            openEditorWithFile={openEditorWithFile}
            openEditor={openEditor}
            onSuspend={handleSuspend}
            onCommand={handleTabCommand}
            onExit={handleExit}
            registerChat={tabMgr.registerChat}
            unregisterChat={tabMgr.unregisterChat}
            setTabActivity={tabMgr.setTabActivity}
            autoLabel={tabMgr.autoLabel}
            initialState={tabMgr.initialStates.current.get(tab.id)}
            editorVisible={editorVisible}
            focusMode={focusMode}
            anyModalOpen={anyModalOpen}
            bootProviders={bootProviders}
            bootPrereqs={bootPrereqs}
            getWorkspaceSnapshot={getWorkspaceSnapshot}
            editorIntegration={effectiveConfig.editorIntegration}
            forgeMode={forgeMode}
            editorOpen={editorOpen}
            editorFile={editorFile}
            editorModeName={nvimMode}
            editorCursorLine={cursorLine}
            editorCursorCol={cursorCol}
            editorVisualSelection={visualSelection}
            clearEditorSelection={clearNvimSelection}
          />
        ))}
      </box>

      <box flexShrink={0} width="100%">
        <Footer />
      </box>

      <LlmSelector
        visible={modals.llmSelector}
        activeModel={activeModelForHeader}
        onSelect={(modelId) => {
          const slot = useUIStore.getState().routerSlotPicking;
          if (slot) {
            const current = effectiveConfig.taskRouter ?? {
              planning: null,
              coding: null,
              exploration: null,
              webSearch: null,
              compact: null,
              semantic: null,
              trivial: null,
              desloppify: null,
              default: null,
            };
            const updated = { ...current, [slot]: modelId };
            saveToScope({ taskRouter: updated }, routerScope);
            useUIStore.getState().setRouterSlotPicking(null);
          } else {
            activeChatRef.current?.setActiveModel(modelId);
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
          }
        }}
        onClose={closeLlmSelector}
      />

      <GitCommitModal
        visible={modals.gitCommit}
        cwd={cwd}
        coAuthor={activeChatRef.current?.coAuthorCommits ?? true}
        onClose={getCloser("gitCommit")}
        onCommitted={(msg) => addSystemMessage(`Committed: ${msg}`)}
        onRefresh={refreshGit}
      />

      <GitMenu
        visible={modals.gitMenu}
        cwd={cwd}
        onClose={getCloser("gitMenu")}
        onCommit={onGitMenuCommit}
        onSuspend={handleSuspend}
        onSystemMessage={addSystemMessage}
        onRefresh={refreshGit}
      />

      <SessionPicker
        visible={modals.sessionPicker}
        cwd={cwd}
        onClose={getCloser("sessionPicker")}
        onRestore={(sessionId) => {
          const data = sessionManager.loadSession(sessionId);
          if (data) {
            tabMgr.restoreFromMeta(data.meta.tabs, data.meta.activeTabId, data.tabMessages);
            setForgeMode(data.meta.forgeMode);
            restoreSessionMemory(data.meta.id);
            setExitSessionId(data.meta.id);
          }
        }}
        onSystemMessage={addSystemMessage}
      />

      <SkillSearch
        visible={modals.skillSearch}
        contextManager={contextManager}
        onClose={getCloser("skillSearch")}
        onSystemMessage={addSystemMessage}
      />

      <LspInstallSearch
        visible={modals.lspInstall}
        cwd={cwd}
        onClose={getCloser("lspInstall")}
        onSystemMessage={addSystemMessage}
        saveToScope={saveToScope}
        detectScope={detectScope}
        disabledServers={effectiveConfig.disabledLspServers ?? []}
      />

      <HelpPopup visible={modals.helpPopup} onClose={getCloser("helpPopup")} />

      <EditorSettings
        visible={modals.editorSettings}
        settings={effectiveConfig.editorIntegration}
        initialScope={detectScope("editorIntegration")}
        onUpdate={(settings: EditorIntegration, toScope, fromScope) => {
          saveToScope({ editorIntegration: settings }, toScope, fromScope);
        }}
        onClose={getCloser("editorSettings")}
      />

      <ProviderSettings
        visible={modals.providerSettings}
        globalConfig={globalConfig}
        projectConfig={projConfig}
        onUpdate={(patch, toScope, fromScope) => saveToScope(patch, toScope, fromScope)}
        onClose={getCloser("providerSettings")}
      />

      <WebSearchSettings
        visible={modals.webSearchSettings}
        onClose={getCloser("webSearchSettings")}
      />

      <RouterSettings
        visible={modals.routerSettings && !routerSlotPicking}
        router={effectiveConfig.taskRouter}
        activeModel={activeModelForHeader}
        scope={routerScope}
        onScopeChange={(toScope, fromScope) => {
          setRouterScope(toScope);
          if (effectiveConfig.taskRouter) {
            saveToScope({ taskRouter: effectiveConfig.taskRouter }, toScope, fromScope);
          }
        }}
        onPickSlot={(slot) => {
          useUIStore.getState().setRouterSlotPicking(slot);
          useUIStore.getState().openModal("llmSelector");
        }}
        onClearSlot={(slot) => {
          const current = effectiveConfig.taskRouter ?? {
            planning: null,
            coding: null,
            exploration: null,
            webSearch: null,
            compact: null,
            semantic: null,
            trivial: null,
            desloppify: null,
            default: null,
          };
          const updated = { ...current, [slot]: null };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onClose={getCloser("routerSettings")}
      />

      <SetupGuide
        visible={modals.setup}
        onClose={getCloser("setup")}
        onSystemMessage={addSystemMessage}
      />

      <ErrorLog
        visible={modals.errorLog}
        messages={activeChatRef.current?.messages ?? []}
        onClose={getCloser("errorLog")}
      />

      <CommandPicker
        visible={modals.commandPicker}
        config={commandPickerConfig}
        onClose={getCloser("commandPicker")}
      />

      <InfoPopup visible={modals.infoPopup} config={infoPopupConfig} onClose={closeInfoPopup} />

      <RepoMapStatusPopup visible={modals.repoMapStatus} onClose={getCloser("repoMapStatus")} />

      <LspStatusPopup visible={modals.lspStatus} onClose={getCloser("lspStatus")} />

      <CompactionLog visible={modals.compactionLog} onClose={getCloser("compactionLog")} />
    </box>
  );
}
