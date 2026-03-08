import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ScrollBoxRenderable, type Selection, TextAttributes } from "@opentui/core";
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
import { initForbidden } from "../core/security/forbidden.js";
import { SessionManager } from "../core/sessions/manager.js";
import { getMissingRequired } from "../core/setup/prerequisites.js";
import { suspendAndRun } from "../core/terminal/suspend.js";
import { useChat, type WorkspaceSnapshot } from "../hooks/useChat.js";
import { useEditorFocus } from "../hooks/useEditorFocus.js";
import { useEditorInput } from "../hooks/useEditorInput.js";
import { useForgeMode } from "../hooks/useForgeMode.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useLspStatus } from "../hooks/useLspStatus.js";
import { useNeovim } from "../hooks/useNeovim.js";
import { buildSessionMeta } from "../hooks/useSessionBuilder.js";
import { useTabs } from "../hooks/useTabs.js";
import { cleanupAndExit, setExitSessionId } from "../index.js";
import { logBackgroundError } from "../stores/errors.js";
import { startMemoryPoll } from "../stores/statusbar.js";
import { type ModalName, selectIsAnyModalOpen, useUIStore } from "../stores/ui.js";
import type { AppConfig, ChatMessage, EditorIntegration } from "../types/index.js";
import { BrandTag } from "./BrandTag.js";
import { ChangedFiles } from "./ChangedFiles.js";
import { CommandPicker } from "./CommandPicker.js";
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
import { InputBox } from "./InputBox.js";
import { LandingPage } from "./LandingPage.js";
import { LlmSelector } from "./LlmSelector.js";
import { CodeExpandedProvider } from "./Markdown.js";
import { MemoryIndicator } from "./MemoryIndicator.js";
import { RAIL_BORDER, StaticMessage } from "./MessageList.js";
import { PlanProgress } from "./PlanProgress.js";
import { PlanReviewPrompt } from "./PlanReviewPrompt.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { RepoMapIndicator } from "./RepoMapIndicator.js";
import { RepoMapStatusPopup } from "./RepoMapStatusPopup.js";
import { RouterSettings } from "./RouterSettings.js";
import { SessionPicker } from "./SessionPicker.js";
import { SetupGuide } from "./SetupGuide.js";
import { SkillSearch } from "./SkillSearch.js";
import { StreamSegmentList } from "./StreamSegmentList.js";
import { SystemBanner } from "./SystemBanner.js";
import type { ConfigScope } from "./shared.js";
import { BRAND_SEGMENTS, BRAND_TEXT, garble, WORDMARK as SHUTDOWN_WORDMARK } from "./splash.js";
import { TabBar } from "./TabBar.js";
import { TokenDisplay } from "./TokenDisplay.js";
import { WebSearchSettings } from "./WebSearchSettings.js";

startMemoryPoll();

const LSP_SHORT_NAMES: Record<string, string> = {
  "typescript-language-server": "tsserver",
  "pyright-langserver": "pyright",
  pylsp: "pylsp",
  gopls: "gopls",
  "rust-analyzer": "rust-analyzer",
};

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

const ABORT_ON_LOADING = new Set(["/clear", "/compact", "/plan"]);

const SHUTDOWN_STEPS = [
  "Quenching active flames…",
  "Forging session to disk…",
  "Sealing the vault…",
  "Until next time, forgemaster.",
];

function ShutdownSplash({
  phase,
  ghostTick,
  sessionId,
  height,
}: {
  phase: number;
  ghostTick: number;
  sessionId: string | null;
  height: number;
}) {
  const shortId = sessionId?.slice(0, 8);
  const [revealLine, setRevealLine] = useState(-1);
  const [glitchLines, setGlitchLines] = useState<string[]>(() =>
    SHUTDOWN_WORDMARK.map((l) => garble(l)),
  );
  const [showBrand, setShowBrand] = useState(false);
  const [brandReveal, setBrandReveal] = useState(0);
  const brandText = BRAND_TEXT;

  useEffect(() => {
    let frame = 0;
    const timer = setInterval(() => {
      frame++;
      if (frame <= 3) {
        setGlitchLines(SHUTDOWN_WORDMARK.map((l) => garble(l)));
      }
      if (frame === 2) setRevealLine(0);
      if (frame === 4) setRevealLine(1);
      if (frame === 6) setRevealLine(2);
      if (frame === 8) {
        setShowBrand(true);
      }
      if (frame > 8 && frame <= 8 + brandText.length) {
        setBrandReveal(frame - 8);
      }
      if (frame > 8 + brandText.length) {
        clearInterval(timer);
      }
    }, 60);
    return () => clearInterval(timer);
  }, []);

  return (
    <box flexDirection="column" height={height} justifyContent="center" alignItems="center">
      <text fg="#9B30FF" attributes={TextAttributes.BOLD}>
        {ghostTick % 4 === 3 ? " " : icon("ghost")}
      </text>
      <text fg="#4a1a6b" attributes={TextAttributes.DIM}>
        ∿~∿
      </text>
      <box height={1} />
      {SHUTDOWN_WORDMARK.map((line, i) => (
        <text
          key={line}
          fg={i === revealLine ? "#FF0040" : "#9B30FF"}
          attributes={TextAttributes.BOLD}
        >
          {i <= revealLine ? line : (glitchLines[i] ?? garble(line))}
        </text>
      ))}
      {showBrand && (
        <text>
          {BRAND_SEGMENTS.map((s) => (
            <span key={s.text} fg={s.color}>
              {s.text}
            </span>
          ))}
          {brandReveal < brandText.length && <span fg="#FF0040">█</span>}
        </text>
      )}
      <box height={1} />
      <box flexDirection="column" gap={0} alignItems="center" height={SHUTDOWN_STEPS.length + 2}>
        {SHUTDOWN_STEPS.map((label, i) => {
          if (i > phase) return null;
          const done = i < phase;
          return (
            <box key={label} gap={1} flexDirection="row">
              <text fg={done ? "#2d5" : "#8B5CF6"}>{done ? "✓" : "◌"}</text>
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

export function App({ config, projectConfig, resumeSessionId, bootProviders, bootPrereqs }: Props) {
  const renderer = useRenderer();
  const { height: termHeight } = useTerminalDimensions();
  const [shutdownPhase, setShutdownPhase] = useState(-1);
  const savedSessionIdRef = useRef<string | null>(null);
  const [shutdownGhostTick, setShutdownGhostTick] = useState(0);
  useEffect(() => {
    if (shutdownPhase < 0) return;
    const timer = setInterval(() => setShutdownGhostTick((t) => t + 1), 400);
    return () => clearInterval(timer);
  }, [shutdownPhase]);

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
  const [routerScope, setRouterScope] = useState<ConfigScope>("project");
  const effectiveConfig = useMemo(
    () => mergeConfigs(globalConfig, projConfig),
    [globalConfig, projConfig],
  );

  // Editor state
  const { focusMode, editorOpen, toggleEditor, openEditor, closeEditor, focusChat, focusEditor } =
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
    sendMouse,
    error: nvimError,
  } = useNeovim(editorOpen, effectiveConfig.nvimPath, effectiveConfig.nvimConfig, closeEditor);

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
  });

  const {
    modals,
    routerSlotPicking,
    commandPickerConfig,
    infoPopupConfig,
    codeExpanded,
    changesExpanded,
    suspended,
  } = useUIStore(
    useShallow((s) => ({
      modals: s.modals,
      routerSlotPicking: s.routerSlotPicking,
      commandPickerConfig: s.commandPickerConfig,
      infoPopupConfig: s.infoPopupConfig,
      codeExpanded: s.codeExpanded,
      changesExpanded: s.changesExpanded,
      suspended: s.suspended,
    })),
  );
  const chatStyle = useUIStore((s) => s.chatStyle);
  const showReasoning = useUIStore((s) => s.showReasoning);
  const reasoningExpanded = useUIStore((s) => s.reasoningExpanded);
  const isModalOpen = useUIStore(selectIsAnyModalOpen);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

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

  const contextManager = useMemo(() => new ContextManager(cwd), [cwd]);
  const sessionManager = useMemo(() => new SessionManager(cwd), [cwd]);

  const restoreSessionMemory = useCallback((_sessionId: string) => {
    // Session-scoped memory was removed — memories are now always persisted to project/global
  }, []);
  const git = useGitStatus(cwd);
  const lspServers = useLspStatus();
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: contextManager is stable (useMemo on cwd)
  useEffect(() => {
    contextManager.refreshGitContext();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chat.setMessages is a stable useState setter
  const handleSuspend = useCallback(
    async (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => {
      useUIStore.getState().setSuspended(true);
      await new Promise((r) => setTimeout(r, 50));
      const result = await suspendAndRun({ ...opts, cwd });
      useUIStore.getState().setSuspended(false);
      if (result.exitCode === null) {
        chat.setMessages((prev) => [
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

  const workspaceSnapshotRef = useRef<(() => WorkspaceSnapshot) | null>(null);

  const chat = useChat({
    effectiveConfig,
    contextManager,
    sessionManager,
    cwd,
    openEditorWithFile,
    openEditor,
    onSuspend: handleSuspend,
    getWorkspaceSnapshot: () =>
      workspaceSnapshotRef.current?.() ?? {
        forgeMode,
        tabStates: [],
        activeTabId: "",
      },
  });

  useEffect(() => {
    if (effectiveConfig.coAuthorCommits !== undefined)
      chat.setCoAuthorCommits(effectiveConfig.coAuthorCommits);
  }, [effectiveConfig.coAuthorCommits, chat.setCoAuthorCommits]);

  const isStreaming = chat.streamSegments.length > 0 || chat.liveToolCalls.length > 0;

  const nonSystemCount = useMemo(() => {
    let count = 0;
    for (const m of chat.messages) {
      if (m.role !== "system" || m.showInChat) count++;
    }
    return count;
  }, [chat.messages]);

  // Stable shared callbacks — used by multiple modals
  const setMessagesRef = useRef(chat.setMessages);
  setMessagesRef.current = chat.setMessages;
  const addSystemMessage = useCallback((msg: string) => {
    setMessagesRef.current((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system", content: msg, timestamp: Date.now() },
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
      chat.abort();
      setShutdownPhase(1);

      setTimeout(() => {
        try {
          const hasUserMessages = chat.messages.some(
            (m) => m.role === "user" || m.role === "assistant",
          );
          const snapshot = workspaceSnapshotRef.current?.();
          if (snapshot && hasUserMessages) {
            const { meta, tabMessages } = buildSessionMeta({
              sessionId: chat.sessionId,
              title: SessionManager.deriveTitle(chat.messages),
              cwd,
              snapshot,
              currentTabMessages: chat.messages.filter((m) => m.role !== "system" || m.showInChat),
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
  }, [shutdownPhase, chat, cwd, sessionManager, contextManager, renderer]);

  // ─── Tab management ───
  const tabMgr = useTabs({ chat, defaultModel: effectiveConfig.defaultModel });

  workspaceSnapshotRef.current = () => ({
    forgeMode,
    tabStates: tabMgr.getAllTabStates(),
    activeTabId: tabMgr.activeTabId,
  });

  // ─── Session restore on mount ───
  const hasRestoredRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time restore on mount
  useEffect(() => {
    if (hasRestoredRef.current || !resumeSessionId) return;
    hasRestoredRef.current = true;

    const fullId = sessionManager.findByPrefix(resumeSessionId);
    if (!fullId) {
      chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Session not found: ${resumeSessionId}`,
          timestamp: Date.now(),
        },
      ]);
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

  useEffect(() => {
    const hasContent = chat.messages.some((m) => m.role === "user" || m.role === "assistant");
    setExitSessionId(hasContent ? chat.sessionId : null);
  }, [chat.sessionId, chat.messages]);

  const cleanupPlanFile = useCallback(() => {
    try {
      const p = join(cwd, ".soulforge", "plans", chat.planFile);
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }, [cwd, chat.planFile]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run when message count changes
  useEffect(() => {
    const firstUser = chat.messages.find((m) => m.role === "user");
    if (firstUser) {
      tabMgr.autoLabel(tabMgr.activeTabId, firstUser.content);
    }
  }, [chat.messages.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run on tab count/active changes
  useEffect(() => {
    if (tabMgr.tabCount <= 1) return;
    try {
      const dir = join(cwd, ".soulforge");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const layout = tabMgr.tabs.map((t) => ({
        id: t.id,
        label: t.label,
        activeModel: t.id === tabMgr.activeTabId ? chat.activeModel : undefined,
      }));
      writeFileSync(join(dir, "tabs.json"), JSON.stringify(layout, null, 2));
    } catch {
      // Ignore write failures
    }
  }, [tabMgr.tabCount, tabMgr.activeTabId]);

  const { displayProvider, displayModel, isGateway, isProxy } = useMemo(() => {
    const isGw = chat.activeModel.startsWith("gateway/");
    const isPrx = chat.activeModel.startsWith("proxy/");
    if (isGw || isPrx) {
      const prefix = isGw ? "gateway/" : "proxy/";
      const rest = chat.activeModel.slice(prefix.length);
      const idx = rest.indexOf("/");
      return {
        displayProvider: idx >= 0 ? rest.slice(0, idx) : rest,
        displayModel: idx >= 0 ? rest.slice(idx + 1) : rest,
        isGateway: isGw,
        isProxy: isPrx,
      };
    }
    const idx = chat.activeModel.indexOf("/");
    return {
      displayProvider: idx >= 0 ? chat.activeModel.slice(0, idx) : "unknown",
      displayModel: idx >= 0 ? chat.activeModel.slice(idx + 1) : chat.activeModel,
      isGateway: false,
      isProxy: false,
    };
  }, [chat.activeModel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run when message count changes
  useEffect(() => {
    const TRIM_THRESHOLD = 50;
    const KEEP_RECENT = 30;
    if (chat.messages.length < TRIM_THRESHOLD) return;
    const trimCount = chat.messages.length - KEEP_RECENT;
    let changed = false;
    const updated = chat.messages.map((msg, i) => {
      if (i >= trimCount || !msg.toolCalls) return msg;
      let tcChanged = false;
      const newToolCalls = msg.toolCalls.map((tc) => {
        if (tc.result && tc.result.output.length > 200) {
          tcChanged = true;
          return {
            ...tc,
            result: { ...tc.result, output: `${tc.result.output.slice(0, 100)}…[trimmed]` },
          };
        }
        return tc;
      });
      if (!tcChanged) return msg;
      changed = true;
      return { ...msg, toolCalls: newToolCalls };
    });
    if (changed) chat.setMessages(updated);
  }, [chat.messages.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger — only re-run when nvimError changes
  useEffect(() => {
    if (nvimError) {
      chat.setMessages((prev) => [
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

  const handleInputSubmit = useCallback(
    async (input: string) => {
      // Snap to bottom & re-enable sticky scroll when user sends anything
      scrollRef.current?.scrollTo(Infinity);
      if (!input.startsWith("/")) {
        useUIStore.getState().setChangesExpanded(false);
      }
      if (input.startsWith("/")) {
        const cmd = input.trim().toLowerCase().split(/\s+/)[0] ?? "";
        if (chat.isLoading && ABORT_ON_LOADING.has(cmd)) {
          chat.abort();
          chat.setMessageQueue([]);
        }

        if (cmd === "/continue") {
          handleInputSubmit("Continue from where you left off. Complete any remaining work.");
          return;
        }
        if (cmd === "/plan" || input.trim().toLowerCase().startsWith("/plan ")) {
          const desc = input.trim().slice(5).trim();
          if (chat.planMode) {
            chat.setPlanMode(false);
            chat.setPlanRequest(null);
            setForgeMode("default");
            chat.setPendingPlanReview(null);
            chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: "Plan mode OFF",
                timestamp: Date.now(),
              },
            ]);
          } else {
            chat.setPlanMode(true);
            chat.setPlanRequest(desc || null);
            setForgeMode("plan");
            contextManager.setForgeMode("plan");
            chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
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
          openRouterSettings: () => uiState.openModal("routerSettings"),
          openProviderSettings: () => uiState.openModal("providerSettings"),
          openWebSearchSettings: () => uiState.openModal("webSearchSettings"),
          openCommandPicker: (pickerConfig) => uiState.openCommandPicker(pickerConfig),
          openInfoPopup: (popupConfig) => uiState.openInfoPopup(popupConfig),
          toggleChanges: () => uiState.toggleChangesExpanded(),
          saveToScope,
          detectScope,
        });
        return;
      }

      chat.handleSubmit(input);
    },
    [
      chat,
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
    ],
  );

  const anyModalOpen = shutdownPhase >= 0 || isModalOpen;

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
      // Editor is focused — let useEditorInput handle all keys for Neovim.
      // Only Ctrl+E (toggle) gets through (handled above).
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
      chat.abort();
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
    if (evt.meta && evt.name >= "1" && evt.name <= "9") {
      tabMgr.switchToIndex(Number(evt.name) - 1);
    }
    if (evt.meta && evt.name === "[") {
      tabMgr.prevTab();
    }
    if (evt.meta && evt.name === "]") {
      tabMgr.nextTab();
    }
    if (evt.name === "pageup") {
      scrollRef.current?.scrollBy(-(termHeight - 5));
    }
    if (evt.name === "pagedown") {
      scrollRef.current?.scrollBy(termHeight - 5);
    }
  });

  const showPlanProgress = !!chat.activePlan;

  const hasChangedFiles = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg?.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.name === "edit_file" && tc.result?.success) return true;
      }
    }
    return false;
  }, [chat.messages]);

  const MAX_RENDERED = 60;
  const visibleMessages = useMemo(() => {
    const msgs = chat.messages;
    const keep = (m: ChatMessage) => m.role !== "system" || m.showInChat;
    if (nonSystemCount <= MAX_RENDERED) {
      return msgs.filter(keep);
    }
    const result: typeof msgs = [];
    for (let i = msgs.length - 1; i >= 0 && result.length < MAX_RENDERED; i--) {
      if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
    }
    result.reverse();
    return result;
  }, [chat.messages, nonSystemCount]);
  const hiddenCount = nonSystemCount - visibleMessages.length;

  if (suspended) {
    return <box height={termHeight} />;
  }

  if (shutdownPhase >= 0) {
    return (
      <ShutdownSplash
        phase={shutdownPhase}
        ghostTick={shutdownGhostTick}
        sessionId={savedSessionIdRef.current}
        height={termHeight}
      />
    );
  }

  const hasContent = nonSystemCount > 0 || isStreaming;

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
        <box gap={1} flexShrink={1} flexDirection="row" justifyContent="center">
          <ContextBar contextManager={contextManager} modelId={chat.activeModel} />
          <text fg="#333">│</text>
          <TokenDisplay />
          <text fg="#333">│</text>
          <MemoryIndicator />
          <text fg="#333">│</text>
          <RepoMapIndicator />
          <text fg="#333">│</text>
          {git.isRepo ? (
            <text fg={git.isDirty ? "#FF8C00" : "#2d5"} truncate>
              {UI_ICONS.git} {truncate(git.branch ?? "HEAD", 30)}
              {git.isDirty ? "*" : ""}
            </text>
          ) : (
            <text fg="#333">{UI_ICONS.git} no repo</text>
          )}
          {lspServers.length > 0 && (
            <>
              <text fg="#333">│</text>
              <text fg="#2d5" truncate>
                {icon("brain")}{" "}
                {lspServers
                  .map((s) => LSP_SHORT_NAMES[s.command.split("/").pop() ?? ""] ?? s.language)
                  .join(" ")}
              </text>
            </>
          )}
          <text fg="#333">│</text>
          <text truncate>
            {isProxy && (
              <span fg="#8B5CF6">
                {icon("proxy")} proxy<span fg="#444">›</span>
              </span>
            )}
            {isGateway && (
              <span fg="#555">
                {icon("gateway")} gateway<span fg="#444">›</span>
              </span>
            )}
            <span fg="#666">{providerIcon(displayProvider)} </span>
            <span fg="#888">{truncate(displayModel, isProxy || isGateway ? 24 : 32)}</span>
          </text>
          {forgeMode !== "default" && (
            <>
              <text fg="#333">│</text>
              <text fg={modeColor} attributes={TextAttributes.BOLD}>
                [{modeLabel}]
              </text>
            </>
          )}
          {tabMgr.tabCount > 1 && (
            <>
              <text fg="#333">│</text>
              <text fg="#8B5CF6">
                Tab {String(tabMgr.activeTabIndex + 1)}/{String(tabMgr.tabCount)}
              </text>
            </>
          )}
        </box>
        <BrandTag />
      </box>

      <TabBar tabs={tabMgr.tabs} activeTabId={tabMgr.activeTabId} onSwitch={tabMgr.switchTab} />

      <SystemBanner messages={chat.messages} expanded={codeExpanded} />

      {!editorVisible && <box height={1} flexShrink={0} />}

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
        />

        <box
          flexDirection="column"
          width={editorVisible ? "40%" : "100%"}
          flexGrow={editorVisible ? 0 : 1}
          flexShrink={editorVisible ? 1 : 0}
        >
          {!hasContent ? (
            <LandingPage bootProviders={bootProviders} bootPrereqs={bootPrereqs} />
          ) : (
            <box flexGrow={1} flexShrink={1} minHeight={0}>
              <scrollbox
                ref={scrollRef}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                flexShrink={1}
                minHeight={0}
                style={{ contentOptions: { justifyContent: "flex-end" } }}
              >
                <CodeExpandedProvider value={codeExpanded}>
                  {hiddenCount > 0 && (
                    <box paddingX={1} marginBottom={1}>
                      <text fg="#444">
                        ── {String(hiddenCount)} earlier message{hiddenCount > 1 ? "s" : ""} ──
                      </text>
                    </box>
                  )}
                  {visibleMessages.map((msg) => (
                    <StaticMessage
                      key={msg.id}
                      msg={msg}
                      chatStyle={chatStyle}
                      diffStyle={effectiveConfig.diffStyle}
                      showReasoning={showReasoning}
                      reasoningExpanded={reasoningExpanded}
                      animate={false}
                    />
                  ))}
                  {isStreaming && (
                    <box paddingX={1} flexShrink={0} marginBottom={1}>
                      <box
                        flexDirection="column"
                        border={["left"]}
                        borderColor="#9B30FF"
                        customBorderChars={RAIL_BORDER}
                        paddingLeft={2}
                      >
                        <box>
                          <text fg="#9B30FF">{icon("ai")} Forge</text>
                        </box>
                        <StreamSegmentList
                          segments={chat.streamSegments}
                          toolCalls={chat.liveToolCalls}
                          streaming={chat.isLoading}
                          verbose={effectiveConfig.verbose === true}
                          diffStyle={effectiveConfig.diffStyle}
                          showReasoning={showReasoning}
                          reasoningExpanded={reasoningExpanded}
                        />
                      </box>
                    </box>
                  )}
                </CodeExpandedProvider>
              </scrollbox>
            </box>
          )}

          {chat.pendingPlanReview ? (
            <box flexShrink={0} paddingX={1}>
              <PlanReviewPrompt
                isActive={focusMode === "chat" && !anyModalOpen}
                plan={chat.pendingPlanReview.plan}
                planFile={chat.pendingPlanReview.planFile}
                onAccept={() => {
                  chat.pendingPlanReview?.resolve("execute");
                  cleanupPlanFile();
                }}
                onClearAndImplement={() => {
                  chat.pendingPlanReview?.resolve("clear_execute");
                  cleanupPlanFile();
                }}
                onRevise={(feedback) => {
                  chat.pendingPlanReview?.resolve(feedback);
                }}
                onCancel={() => {
                  chat.pendingPlanReview?.resolve("cancel");
                  cleanupPlanFile();
                }}
              />
            </box>
          ) : chat.pendingQuestion ? (
            <>
              <box flexShrink={0} paddingX={1}>
                <QuestionPrompt
                  question={chat.pendingQuestion}
                  isActive={focusMode === "chat" && !anyModalOpen}
                />
              </box>
              {showPlanProgress && chat.activePlan && (
                <box flexShrink={0} paddingX={1}>
                  <PlanProgress plan={chat.activePlan} />
                </box>
              )}
              {hasChangedFiles && (
                <box flexShrink={0} paddingX={1}>
                  <ChangedFiles messages={chat.messages} cwd={cwd} expanded={changesExpanded} />
                </box>
              )}
            </>
          ) : (
            <>
              {showPlanProgress && chat.activePlan && (
                <box flexShrink={0} paddingX={1}>
                  <PlanProgress plan={chat.activePlan} />
                </box>
              )}
              {hasChangedFiles && (
                <box flexShrink={0} paddingX={1}>
                  <ChangedFiles messages={chat.messages} cwd={cwd} expanded={changesExpanded} />
                </box>
              )}
              <InputBox
                onSubmit={handleInputSubmit}
                isLoading={chat.isLoading}
                isCompacting={chat.isCompacting}
                isFocused={focusMode === "chat" && !anyModalOpen}
                cwd={cwd}
                onExit={handleExit}
                onQueue={(msg) =>
                  chat.setMessageQueue((prev) =>
                    prev.length >= 5 ? prev : [...prev, { content: msg, queuedAt: Date.now() }],
                  )
                }
                queueCount={chat.messageQueue.length}
              />
            </>
          )}
        </box>

        <LlmSelector
          visible={modals.llmSelector}
          activeModel={chat.activeModel}
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
                default: null,
              };
              const updated = { ...current, [slot]: modelId };
              saveToScope({ taskRouter: updated }, routerScope);
              useUIStore.getState().setRouterSlotPicking(null);
            } else {
              chat.setActiveModel(modelId);
            }
          }}
          onClose={closeLlmSelector}
        />

        <GitCommitModal
          visible={modals.gitCommit}
          cwd={cwd}
          coAuthor={chat.coAuthorCommits}
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
          activeModel={chat.activeModel}
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
          messages={chat.messages}
          onClose={getCloser("errorLog")}
        />

        <CommandPicker
          visible={modals.commandPicker}
          config={commandPickerConfig}
          onClose={getCloser("commandPicker")}
        />

        <InfoPopup visible={modals.infoPopup} config={infoPopupConfig} onClose={closeInfoPopup} />

        <RepoMapStatusPopup visible={modals.repoMapStatus} onClose={getCloser("repoMapStatus")} />
      </box>

      <box flexShrink={0} width="100%">
        <Footer />
      </box>
    </box>
  );
}
