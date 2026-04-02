import { spawn } from "node:child_process";
import { join } from "node:path";
import { type Selection, TextAttributes } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
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
import { handleCommand } from "../core/commands/registry.js";
import { ContextManager } from "../core/context/manager.js";
import { getWorkspaceCoordinator } from "../core/coordination/WorkspaceCoordinator.js";
import { setEditorRequestCallback } from "../core/editor/instance.js";
import { icon, providerIcon, UI_ICONS } from "../core/icons.js";
import { runIntelligenceHealthCheck } from "../core/intelligence/index.js";
import { fetchOpenRouterMetadata, getShortModelLabel } from "../core/llm/models.js";
import { notifyProviderSwitch } from "../core/llm/provider.js";
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { suspendAndRun } from "../core/terminal/suspend.js";
import { useTheme, useThemeStore } from "../core/theme/index.js";
import { garble, WORDMARK as SHUTDOWN_WORDMARK } from "../core/utils/splash.js";
import { isDismissed } from "../core/version.js";
import type { ChatInstance, WorkspaceSnapshot } from "../hooks/useChat.js";
import { useConfigSync } from "../hooks/useConfigSync.js";
import { useEditorFocus } from "../hooks/useEditorFocus.js";
import { useEditorInput } from "../hooks/useEditorInput.js";
import { getModeColor, getModeLabel } from "../hooks/useForgeMode.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useGlobalKeyboard } from "../hooks/useGlobalKeyboard.js";
import { useNeovim } from "../hooks/useNeovim.js";
import { buildSessionMeta } from "../hooks/useSessionBuilder.js";
import { useTabs } from "../hooks/useTabs.js";
import { useVersionCheck } from "../hooks/useVersionCheck.js";
import { cleanupAndExit, restart, setExitSessionId } from "../index.js";
import { logBackgroundError } from "../stores/errors.js";
import { startMemoryPoll } from "../stores/statusbar.js";
import { useToolsStore } from "../stores/tools.js";
import { type ModalName, selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import { useVersionStore } from "../stores/version.js";
import type { AppConfig, ChatMessage, EditorIntegration, TaskRouter } from "../types/index.js";
import { BrandTag } from "./layout/BrandTag.js";
import { ContextBar } from "./layout/ContextBar.js";
import { EditorPanel } from "./layout/EditorPanel.js";
import { FloatingTerminal } from "./layout/FloatingTerminal.js";
import { Footer } from "./layout/Footer.js";
import type { ConfigScope } from "./layout/shared.js";
import { TabBar } from "./layout/TabBar.js";
import { TabInstance } from "./layout/TabInstance.js";
import { TokenDisplay } from "./layout/TokenDisplay.js";
import { SimpleModalLayer } from "./ModalLayer.js";
import { CommandPalette } from "./modals/CommandPalette.js";
import { CommandPicker } from "./modals/CommandPicker.js";
import { DiagnosePopup } from "./modals/DiagnosePopup.js";
import { FirstRunWizard } from "./modals/FirstRunWizard.js";
import { GitCommitModal } from "./modals/GitCommitModal.js";
import { GitMenu } from "./modals/GitMenu.js";
import { InfoPopup } from "./modals/InfoPopup.js";
import { LlmSelector } from "./modals/LlmSelector.js";
import { SessionPicker } from "./modals/SessionPicker.js";
import { StatusDashboard } from "./modals/StatusDashboard.js";
import { UpdateModal } from "./modals/UpdateModal.js";
import { EditorSettings } from "./settings/EditorSettings.js";
import { LspInstallSearch } from "./settings/LspInstallSearch.js";
import { ProviderSettings } from "./settings/ProviderSettings.js";
import { RepoMapStatusPopup } from "./settings/RepoMapStatusPopup.js";
import { RouterSettings } from "./settings/RouterSettings.js";
import { SkillSearch } from "./settings/SkillSearch.js";
import { ToolsPopup } from "./settings/ToolsPopup.js";

startMemoryPoll();

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const ABORT_ON_LOADING = new Set([
  "/clear",
  "/compact",
  "/plan",
  "/session clear",
  "/session compact",
  "/session plan",
]);

const DEFAULT_TASK_ROUTER: TaskRouter = {
  coding: null,
  exploration: null,
  webSearch: null,
  compact: null,
  semantic: null,
  trivial: null,
  desloppify: null,
  verify: null,
  default: null,
};

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

  const t = useTheme();
  const ghostFade = ["▓", "▒", "░", " ", " ", "░", "▒", "▓"];
  const fadeIdx = Math.min(tick, ghostFade.length - 1);
  const ghostChar = tick < ghostFade.length ? ghostFade[fadeIdx] : icon("ghost");
  const spin = SHUTDOWN_SPINNER[tick % SHUTDOWN_SPINNER.length];

  return (
    <box flexDirection="column" height={height} justifyContent="center" alignItems="center">
      <text fg={t.brand} attributes={TextAttributes.BOLD}>
        {ghostChar}
      </text>
      <text fg={t.brandDim} attributes={TextAttributes.DIM}>
        ∿~∿
      </text>
      <box height={1} />
      {SHUTDOWN_WORDMARK.map((line: string) => (
        <text key={line} fg={t.brand} attributes={TextAttributes.BOLD}>
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
              <text fg={done ? t.success : t.brand}>{done ? "✓" : spin}</text>
              <text fg={done ? t.textSecondary : t.textPrimary}>{label}</text>
            </box>
          );
        })}
        {shortId && phase >= 3 && (
          <>
            <box height={1} />
            <text>
              <span fg={t.textMuted}>Resume: </span>
              <span fg={t.brandAlt}>soulforge --session {shortId}</span>
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
  forceWizard?: boolean;
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
  forceWizard,
  bootProviders,
  bootPrereqs,
  preloadedContextManager,
}: Props) {
  const renderer = useRenderer();
  const { height: termHeight, width: termWidth } = useTerminalDimensions();
  // Subscribe to theme changes so the entire tree re-renders with new colors
  useThemeStore((s) => s.name);
  const t = useTheme();
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

  useEffect(() => {
    fetchOpenRouterMetadata();
  }, []);

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

  const { focusMode, editorOpen, toggleEditor, openEditor, closeEditor, focusChat, focusEditor } =
    useEditorFocus();
  const [editorVisible, setEditorVisible] = useState(false);

  const tabMgr = useTabs();
  const tabMgrRef = useRef(tabMgr);
  tabMgrRef.current = tabMgr;

  const hasTabBarRef = useRef(false);
  hasTabBarRef.current = tabMgr.tabCount > 1;
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
    true,
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
    setEditorRequestCallback((file) => {
      if (file) openEditorWithFile(file);
    });
    return () => setEditorRequestCallback(null);
  }, [openEditorWithFile]);

  useEffect(() => {
    if (editorOpen) setEditorVisible(true);
  }, [editorOpen]);

  // Kick the renderer after layout-affecting transitions to prevent stale paints.
  // requestRender() is a no-op if nothing is dirty — safe to call.
  const reasoningExpanded = useUIStore((s) => s.reasoningExpanded);
  const codeExpanded = useUIStore((s) => s.codeExpanded);
  const hasTabBar = tabMgr.tabCount > 1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on layout transitions, not just renderer change
  useEffect(() => {
    renderer.requestRender();
  }, [editorOpen, editorVisible, focusMode, reasoningExpanded, codeExpanded, hasTabBar, renderer]);

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

  const { routerSlotPicking, commandPickerConfig, infoPopupConfig, suspended, editorSplit } =
    useUIStore(
      useShallow((s) => ({
        routerSlotPicking: s.routerSlotPicking,
        commandPickerConfig: s.commandPickerConfig,
        infoPopupConfig: s.infoPopupConfig,
        suspended: s.suspended,
        editorSplit: s.editorSplit,
      })),
    );

  const modalLlmSelector = useUIStore((s) => s.modals.llmSelector);
  const modalGitCommit = useUIStore((s) => s.modals.gitCommit);
  const modalGitMenu = useUIStore((s) => s.modals.gitMenu);
  const modalSessionPicker = useUIStore((s) => s.modals.sessionPicker);
  const modalSkillSearch = useUIStore((s) => s.modals.skillSearch);
  const modalLspInstall = useUIStore((s) => s.modals.lspInstall);
  const modalEditorSettings = useUIStore((s) => s.modals.editorSettings);
  const modalProviderSettings = useUIStore((s) => s.modals.providerSettings);
  const modalRouterSettings = useUIStore((s) => s.modals.routerSettings);
  const modalCommandPicker = useUIStore((s) => s.modals.commandPicker);
  const modalCommandPalette = useUIStore((s) => s.modals.commandPalette);
  const modalInfoPopup = useUIStore((s) => s.modals.infoPopup);
  const modalDiagnose = useUIStore((s) => s.modals.diagnosePopup);
  const modalStatusDashboard = useUIStore((s) => s.modals.statusDashboard);
  const modalToolsPopup = useUIStore((s) => s.modals.toolsPopup);
  const modalFirstRunWizard = useUIStore((s) => s.modals.firstRunWizard);
  const modalUpdateModal = useUIStore((s) => s.modals.updateModal);
  const toolsState = useToolsStore();

  // Init tools store from config and persist changes
  useEffect(() => {
    toolsState.initFromConfig(effectiveConfig.disabledTools);
  }, [effectiveConfig.disabledTools, toolsState.initFromConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveGlobalConfig({ disabledTools: [...toolsState.disabledTools] });
  }, [toolsState.disabledTools]);
  const statusDashboardTab = useUIStore((s) => s.statusDashboardTab);
  const modalRepoMapStatus = useUIStore((s) => s.modals.repoMapStatus);
  const isModalOpen = useUIStore(selectIsAnyModalOpen);

  const wizardOpenedLlm = useRef(false);
  const closerCache = useRef<Partial<Record<ModalName, () => void>>>({});
  const getCloser = (name: ModalName) =>
    (closerCache.current[name] ??= () => useUIStore.getState().closeModal(name));

  useVersionCheck();
  const versionCurrent = useVersionStore((s) => s.current);
  const versionLatest = useVersionStore((s) => s.latest);
  const versionUpdateAvailable = useVersionStore((s) => s.updateAvailable);

  // Show update modal on first launch when a new version is available
  const updateModalShown = useRef(false);
  useEffect(() => {
    if (!versionUpdateAvailable || !versionLatest || updateModalShown.current) return;
    if (isDismissed(versionLatest)) return;
    updateModalShown.current = true;
    // Small delay so it doesn't fight with wizard/setup modals
    const timer = setTimeout(() => {
      const ui = useUIStore.getState();
      if (!ui.modals.firstRunWizard && !ui.modals.setup) {
        ui.openModal("updateModal");
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [versionUpdateAvailable, versionLatest]);

  useEffect(() => {
    if (getMissingRequired().length > 0) {
      useUIStore.getState().openModal("setup");
    } else if (forceWizard || (!config.onboardingComplete && !resumeSessionId)) {
      useUIStore.getState().openModal("firstRunWizard");
    }
  }, [config.onboardingComplete, forceWizard, resumeSessionId]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    initForbidden(cwd);
  }, []);

  const contextManager = useMemo(
    () => preloadedContextManager ?? new ContextManager(cwd),
    [cwd, preloadedContextManager],
  );
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);

  const git = useGitStatus(cwd);
  const [forgeMode, setForgeModeHeader] =
    useState<import("../types/index.js").ForgeMode>("default");
  const modeLabel = getModeLabel(forgeMode);
  const modeColor = getModeColor(forgeMode);

  useConfigSync({
    effectiveConfig,
    contextManager,
    cwd,
    editorOpen,
    editorFile,
    nvimMode,
    cursorLine,
    cursorCol,
    visualSelection,
  });

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
    },
    [cwd, git],
  );

  editorSplitRef.current = editorSplit;

  const sharedResources = useMemo(
    () => ({
      ...contextManager.getSharedResources(),
      workspaceCoordinator: getWorkspaceCoordinator(),
    }),
    [contextManager],
  );

  const workspaceSnapshotRef = useRef<(() => WorkspaceSnapshot) | null>(null);
  workspaceSnapshotRef.current = () => ({
    tabStates: tabMgr.getAllTabStates(),
    activeTabId: tabMgr.activeTabId,
  });

  const getWorkspaceSnapshot = useCallback(
    (): WorkspaceSnapshot =>
      workspaceSnapshotRef.current?.() ?? {
        tabStates: [],
        activeTabId: "",
      },
    [],
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
  }, [git]);

  const shutdownPhaseRef = useRef(shutdownPhase);
  shutdownPhaseRef.current = shutdownPhase;
  const exitTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const handleExit = useCallback(() => {
    if (shutdownPhaseRef.current >= 0) return;
    setShutdownPhase(0);

    const schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      exitTimersRef.current.push(t);
      return t;
    };

    schedule(() => {
      for (const tab of tabMgrRef.current.tabs) {
        tabMgrRef.current.getChat(tab.id)?.abort();
      }
      setShutdownPhase(1);

      schedule(async () => {
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
            await sessionManager.saveSession(meta, tabMessages);
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

        schedule(() => {
          setShutdownPhase(3);
          schedule(() => {
            renderer.destroy();
            try {
              contextManager.dispose();
              getWorkspaceCoordinator().releaseAllGlobal();
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
  }, [cwd, sessionManager, contextManager, renderer]);

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
      setForgeModeHeader(data.meta.forgeMode);
      setExitSessionId(data.meta.id);
    }
  }, []);

  const [activeModelForHeader, setActiveModelForHeader] = useState(effectiveConfig.defaultModel);
  const activeChatRef = useRef<ChatInstance | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from activeTabId — stable trigger
  useEffect(() => {
    const chat = tabMgr.getActiveChat();
    activeChatRef.current = chat;
    if (chat) {
      setActiveModelForHeader(chat.activeModel);
      setForgeModeHeader(chat.forgeMode);
      const hasContent = chat.messages.some(
        (m: ChatMessage) => m.role === "user" || m.role === "assistant",
      );
      setExitSessionId(hasContent ? chat.sessionId : null);
    }
  }, [tabMgr.activeTabId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run on tab count/active changes
  useEffect(() => {
    if (tabMgr.tabCount <= 1) return;
    (async () => {
      try {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const dir = join(cwd, ".soulforge");
        await mkdir(dir, { recursive: true });
        const activeChat = tabMgr.getActiveChat();
        const layout = tabMgr.tabs.map((t) => ({
          id: t.id,
          label: t.label,
          activeModel: t.id === tabMgr.activeTabId ? activeChat?.activeModel : undefined,
        }));
        await writeFile(join(dir, "tabs.json"), JSON.stringify(layout, null, 2));
      } catch {}
    })();
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
      const twoWord = input.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" ");
      if (chat.isLoading && (ABORT_ON_LOADING.has(cmd) || ABORT_ON_LOADING.has(twoWord))) {
        chat.abort();
        chat.setMessageQueue([]);
      }

      if (cmd === "/continue" || twoWord === "/session continue") {
        chat.handleSubmit("Continue from where you left off. Complete any remaining work.");
        return;
      }
      if (
        cmd === "/plan" ||
        input.trim().toLowerCase().startsWith("/plan ") ||
        twoWord === "/session plan" ||
        input.trim().toLowerCase().startsWith("/session plan ")
      ) {
        const desc = input
          .trim()
          .replace(/^\/(session\s+)?plan\s*/i, "")
          .trim();
        if (chat.planMode) {
          chat.setPlanMode(false);
          chat.setPlanRequest(null);
          chat.setForgeMode("default");
          setForgeModeHeader("default");
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
          chat.setForgeMode("plan");
          setForgeModeHeader("plan");
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
        },
        setForgeMode: (mode: import("../types/index.js").ForgeMode) => {
          chat.setForgeMode(mode);
          setForgeModeHeader(mode);
        },
        currentMode: chat.forgeMode,
        currentModeLabel: getModeLabel(chat.forgeMode),
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
        autoCompactDiffs: effectiveConfig.autoCompactDiffs === true,
        compactionStrategy: effectiveConfig.compaction?.strategy ?? "v2",
        showReasoning: uiState.showReasoning,
        setShowReasoning: uiState.setShowReasoning,
        lockIn: uiState.lockIn,
        setLockIn: uiState.setLockIn,
        openSetup: () => uiState.openModal("setup"),
        openEditorSettings: () => uiState.openModal("editorSettings"),
        openRouterSettings: () => {
          setRouterScope(detectScope("taskRouter"));
          uiState.openModal("routerSettings");
        },
        openProviderSettings: () => uiState.openModal("providerSettings"),
        openWebSearchSettings: () => uiState.openModal("webSearchSettings"),
        openApiKeySettings: () => uiState.openModal("apiKeySettings"),
        openLspStatus: () => uiState.openModal("lspStatus"),
        openCompactionLog: () => uiState.openModal("compactionLog"),
        openCommandPicker: (pickerConfig) => uiState.openCommandPicker(pickerConfig),
        openInfoPopup: (popupConfig) => uiState.openInfoPopup(popupConfig),
        toggleChanges: () => uiState.toggleChangesExpanded(),
        saveToScope,
        detectScope,
        agentFeatures: effectiveConfig.agentFeatures,
        instructionFiles: effectiveConfig.instructionFiles,
        syncActiveModel: (modelId: string) => {
          chat.setActiveModel(modelId);
          setActiveModelForHeader(modelId);
        },
      });
    },
    [
      tabMgr,
      toggleEditor,
      nvimOpen,
      handleExit,
      cwd,
      git,
      contextManager,
      handleSuspend,
      openEditorWithFile,
      effectiveConfig.nvimConfig,
      effectiveConfig.vimHints,
      effectiveConfig.verbose,
      effectiveConfig.diffStyle,
      effectiveConfig.autoCompactDiffs,
      effectiveConfig.compaction?.strategy,
      saveToScope,
      detectScope,
      effectiveConfig.agentFeatures,
      effectiveConfig.instructionFiles,
    ],
  );

  const closeLlmSelector = useCallback(() => {
    const wasPickingSlot = useUIStore.getState().routerSlotPicking != null;
    const wasFromWizard = wizardOpenedLlm.current;
    useUIStore.getState().closeModal("llmSelector");
    useUIStore.getState().setRouterSlotPicking(null);
    wizardOpenedLlm.current = false;
    if (wasPickingSlot) {
      useUIStore.getState().openModal("routerSettings");
    } else if (wasFromWizard) {
      useUIStore.getState().openModal("firstRunWizard");
    }
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

  const handleNewSession = useCallback(async () => {
    const activeChat = tabMgrRef.current?.getActiveChat();
    const hasContent = activeChat?.messages.some(
      (m: ChatMessage) => m.role === "user" || m.role === "assistant",
    );
    if (hasContent && activeChat) {
      const snapshot = workspaceSnapshotRef.current?.();
      if (snapshot) {
        try {
          const { meta, tabMessages } = buildSessionMeta({
            sessionId: activeChat.sessionId,
            title: SessionManager.deriveTitle(activeChat.messages),
            cwd,
            snapshot,
            currentTabMessages: activeChat.messages.filter(
              (m: ChatMessage) => m.role !== "system" || m.showInChat,
            ),
          });
          await sessionManager.saveSession(meta, tabMessages);
        } catch (err) {
          logBackgroundError(
            "new-session",
            `session save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    restart();
  }, [cwd, sessionManager]);

  useGlobalKeyboard({
    shutdownPhase,
    handleExit,
    newSession: handleNewSession,
    toggleEditor,
    focusMode,
    renderer,
    copyToClipboard,
    activeChatRef,
    cycleMode: useCallback(() => {
      const chat = tabMgrRef.current?.getActiveChat();
      if (chat) {
        const next = chat.cycleMode();
        setForgeModeHeader(next);
      }
    }, []),
    tabMgr,
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
    <box flexDirection="column" height={termHeight} backgroundColor={t.bgApp}>
      <box
        flexShrink={0}
        width="100%"
        paddingX={1}
        justifyContent="space-between"
        height={1}
        flexDirection="row"
      >
        <box flexShrink={0} flexDirection="row" gap={0}>
          <text fg={t.brand} attributes={TextAttributes.BOLD}>
            {icon("ghost")} SoulForge
          </text>
          <text fg={t.textFaint}> v{versionCurrent}</text>
          {versionUpdateAvailable && <text fg={t.success}> ({versionLatest} available)</text>}
        </box>
        <box gap={1} flexShrink={1} flexDirection="row" justifyContent="center" overflow="hidden">
          <text truncate>
            {isProxy && (
              <span fg={t.brandAlt}>
                {icon("proxy")} proxy<span fg={t.textDim}>›</span>
              </span>
            )}
            {isGateway && (
              <span fg={t.textMuted}>
                {icon("vercel_gateway")} gateway<span fg={t.textDim}>›</span>
              </span>
            )}
            <span fg={t.textMuted}>{providerIcon(displayProvider)} </span>
            {displayProvider !== displayModel && (
              <>
                <span fg={t.textMuted}>{displayProvider}</span>
                <span fg={t.textDim}>›</span>
              </>
            )}
            <span fg={t.textSecondary}>
              {truncate(displayModel, isProxy || isGateway ? 20 : 28)}
            </span>
          </text>
          {git.isRepo && (
            <>
              <text fg={t.textFaint}>│</text>
              <text fg={git.isDirty ? t.amber : t.success} truncate>
                {UI_ICONS.git} {truncate(git.branch ?? "HEAD", termWidth >= 120 ? 30 : 15)}
                {git.isDirty ? "*" : ""}
              </text>
            </>
          )}
          {tabMgr.tabCount <= 1 && forgeMode !== "default" && (
            <>
              <text fg={t.textFaint}>│</text>
              <text fg={modeColor} attributes={TextAttributes.BOLD}>
                [{modeLabel}]
              </text>
            </>
          )}
          <text fg={t.textFaint}>│</text>
          <ContextBar
            contextManager={contextManager}
            modelId={activeModelForHeader}
            suppressCompacting={tabMgr.tabCount > 1}
          />
          <text fg={t.textFaint}>│</text>
          <TokenDisplay />
        </box>
        {termWidth >= 80 && <BrandTag />}
      </box>

      {tabMgr.tabCount > 1 ? (
        <box key="tab-bar" flexShrink={0} marginTop={1}>
          <TabBar
            tabs={tabMgr.tabs}
            activeTabId={tabMgr.activeTabId}
            onSwitch={tabMgr.switchTab}
            getActivity={tabMgr.getTabActivity}
            getMode={(id) =>
              id === tabMgr.activeTabId ? forgeMode : (tabMgr.getChat(id)?.forgeMode ?? "default")
            }
            getModelLabel={(id) => {
              const model =
                id === tabMgr.activeTabId
                  ? activeModelForHeader
                  : (tabMgr.getChat(id)?.activeModel ?? null);
              if (!model || model === "none" || model === effectiveConfig.defaultModel) return null;
              return getShortModelLabel(model);
            }}
          />
        </box>
      ) : !editorVisible ? (
        <box key="tab-spacer" height={1} flexShrink={0} />
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
            tabLabel={tab.label}
            visible={tab.id === tabMgr.activeTabId}
            effectiveConfig={effectiveConfig}
            sharedResources={sharedResources}
            sessionManager={sessionManager}
            cwd={cwd}
            openEditorWithFile={openEditorWithFile}
            openEditor={openEditor}
            onSuspend={handleSuspend}
            onCommand={handleTabCommand}
            onModeChange={setForgeModeHeader}
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
        visible={modalLlmSelector}
        activeModel={activeModelForHeader}
        onSelect={(modelId) => {
          const slot = useUIStore.getState().routerSlotPicking;
          if (slot) {
            const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
            const updated = { ...current, [slot]: modelId };
            saveToScope({ taskRouter: updated }, routerScope);
            useUIStore.getState().setRouterSlotPicking(null);
            useUIStore.getState().closeModal("llmSelector");
            useUIStore.getState().openModal("routerSettings");
          } else {
            activeChatRef.current?.setActiveModel(modelId);
            notifyProviderSwitch(modelId);
            setActiveModelForHeader(modelId);
            saveToScope({ defaultModel: modelId }, modelScope);
            const wasFromWizard = wizardOpenedLlm.current;
            wizardOpenedLlm.current = false;
            useUIStore.getState().closeModal("llmSelector");
            if (wasFromWizard) {
              useUIStore.getState().openModal("firstRunWizard");
            }
          }
        }}
        onClose={closeLlmSelector}
      />

      <FloatingTerminal />

      <GitCommitModal
        visible={modalGitCommit}
        cwd={cwd}
        coAuthor={activeChatRef.current?.coAuthorCommits ?? true}
        onClose={getCloser("gitCommit")}
        onCommitted={(msg) => addSystemMessage(`Committed: ${msg}`)}
        onRefresh={refreshGit}
      />

      <GitMenu
        visible={modalGitMenu}
        cwd={cwd}
        onClose={getCloser("gitMenu")}
        onCommit={onGitMenuCommit}
        onSuspend={handleSuspend}
        onSystemMessage={addSystemMessage}
        onRefresh={refreshGit}
      />

      <SessionPicker
        visible={modalSessionPicker}
        cwd={cwd}
        onClose={getCloser("sessionPicker")}
        onRestore={(sessionId) => {
          const data = sessionManager.loadSession(sessionId);
          if (data) {
            tabMgr.restoreFromMeta(data.meta.tabs, data.meta.activeTabId, data.tabMessages);
            setForgeModeHeader(data.meta.forgeMode);
            setExitSessionId(data.meta.id);
          }
        }}
        onSystemMessage={addSystemMessage}
      />

      <SkillSearch
        visible={modalSkillSearch}
        contextManager={tabMgr.getActiveChat()?.contextManager ?? contextManager}
        onClose={getCloser("skillSearch")}
        onSystemMessage={addSystemMessage}
      />

      <LspInstallSearch
        visible={modalLspInstall}
        cwd={cwd}
        onClose={getCloser("lspInstall")}
        onSystemMessage={addSystemMessage}
        saveToScope={saveToScope}
        detectScope={detectScope}
        disabledServers={effectiveConfig.disabledLspServers ?? []}
      />

      <EditorSettings
        visible={modalEditorSettings}
        settings={effectiveConfig.editorIntegration}
        initialScope={detectScope("editorIntegration")}
        onUpdate={(settings: EditorIntegration, toScope, fromScope) => {
          saveToScope({ editorIntegration: settings }, toScope, fromScope);
        }}
        onClose={getCloser("editorSettings")}
      />

      <ProviderSettings
        visible={modalProviderSettings}
        globalConfig={globalConfig}
        projectConfig={projConfig}
        onUpdate={(patch, toScope, fromScope) => saveToScope(patch, toScope, fromScope)}
        onClose={getCloser("providerSettings")}
      />

      <ToolsPopup
        visible={modalToolsPopup}
        disabledTools={toolsState.disabledTools}
        onToggleTool={toolsState.toggleTool}
        onClose={getCloser("toolsPopup")}
      />

      <RouterSettings
        visible={modalRouterSettings && !routerSlotPicking}
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
          const current = effectiveConfig.taskRouter ?? DEFAULT_TASK_ROUTER;
          const updated = { ...current, [slot]: null };
          saveToScope({ taskRouter: updated }, routerScope);
        }}
        onClose={getCloser("routerSettings")}
      />

      <CommandPalette
        visible={modalCommandPalette}
        onClose={getCloser("commandPalette")}
        onExecute={(cmd) => {
          const chat = activeChatRef.current;
          if (chat) handleTabCommand(cmd, chat);
        }}
      />

      <CommandPicker
        visible={modalCommandPicker}
        config={commandPickerConfig}
        onClose={getCloser("commandPicker")}
      />

      <InfoPopup visible={modalInfoPopup} config={infoPopupConfig} onClose={closeInfoPopup} />

      <StatusDashboard
        visible={modalStatusDashboard}
        initialTab={statusDashboardTab}
        onClose={getCloser("statusDashboard")}
        activeModel={activeModelForHeader}
        contextManager={contextManager}
        tabMgr={tabMgr}
        currentMode={activeChatRef.current?.forgeMode ?? "default"}
        currentModeLabel={getModeLabel(activeChatRef.current?.forgeMode ?? "default")}
      />

      <DiagnosePopup
        visible={modalDiagnose}
        onClose={getCloser("diagnosePopup")}
        runHealthCheck={runIntelligenceHealthCheck}
      />

      <RepoMapStatusPopup
        visible={modalRepoMapStatus}
        onClose={getCloser("repoMapStatus")}
        enabled={effectiveConfig.repoMap !== false}
        currentMode={
          effectiveConfig.semanticSummaries === true
            ? "synthetic"
            : effectiveConfig.semanticSummaries === false
              ? "off"
              : effectiveConfig.semanticSummaries === "on"
                ? "full"
                : (effectiveConfig.semanticSummaries ?? "synthetic")
        }
        currentLimit={effectiveConfig.semanticSummaryLimit ?? 500}
        currentAutoRegen={effectiveConfig.semanticAutoRegen ?? false}
        currentTokenBudget={effectiveConfig.repoMapTokenBudget}
        currentScope={detectScope("semanticSummaries")}
        onToggle={(enabled, scope) => {
          contextManager.setRepoMapEnabled(enabled);
          saveToScope({ repoMap: enabled }, scope);
        }}
        onRefresh={() => contextManager.refreshRepoMap().catch(() => {})}
        onClear={(scope) => {
          if (contextManager.isSemanticEnabled()) {
            contextManager.setSemanticSummaries("off");
            saveToScope({ semanticSummaries: "off" }, scope);
          }
          contextManager.clearRepoMap();
        }}
        onRegenerate={() => {
          contextManager.setActiveModel(activeModelForHeader);
          contextManager.clearFreeSummaries();
          const mode = contextManager.getSemanticMode();
          contextManager
            .setSemanticSummaries(mode === "off" ? "synthetic" : mode)
            .then(() => contextManager.generateSemanticSummaries(activeModelForHeader))
            .catch(() => {});
        }}
        onClearSummaries={() => {
          contextManager.clearFreeSummaries();
        }}
        onLspEnrich={() => {
          contextManager.enrichWithLsp().catch(() => {});
        }}
        onApply={(mode, limit, autoRegen, scope, tokenBudget) => {
          const typedMode = mode as "off" | "ast" | "synthetic" | "llm" | "full";
          contextManager.setActiveModel(activeModelForHeader);
          saveToScope(
            {
              semanticSummaries: typedMode,
              semanticSummaryLimit: limit,
              semanticAutoRegen: autoRegen,
              repoMapTokenBudget: tokenBudget,
            },
            scope,
          );
          contextManager.setSemanticSummaryLimit(limit);
          contextManager.setSemanticAutoRegen(autoRegen);
          contextManager.setRepoMapTokenBudget(tokenBudget);
          contextManager
            .setSemanticSummaries(typedMode)
            .then(() =>
              typedMode === "llm" || typedMode === "full"
                ? contextManager.generateSemanticSummaries(activeModelForHeader)
                : undefined,
            )
            .catch(() => {});
        }}
      />

      <FirstRunWizard
        visible={modalFirstRunWizard}
        hasModel={activeModelForHeader !== "none"}
        activeModel={activeModelForHeader}
        onSelectModel={() => {
          wizardOpenedLlm.current = true;
          useUIStore.getState().closeModal("firstRunWizard");
          useUIStore.getState().openModal("llmSelector");
        }}
        onClose={() => {
          useUIStore.getState().closeModal("firstRunWizard");
          saveToScope({ onboardingComplete: true }, "global");
        }}
      />

      <UpdateModal
        visible={modalUpdateModal}
        onClose={getCloser("updateModal")}
        onRestart={restart}
      />

      <SimpleModalLayer
        messages={activeChatRef.current?.messages ?? []}
        onSystemMessage={addSystemMessage}
      />
    </box>
  );
}
