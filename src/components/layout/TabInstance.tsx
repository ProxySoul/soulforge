import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ContextManager, type SharedContextResources } from "../../core/context/manager.js";
import { getWorkspaceCoordinator } from "../../core/coordination/WorkspaceCoordinator.js";
import { icon } from "../../core/icons.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import { clearTabSessionPatterns } from "../../core/security/forbidden.js";
import type { SessionManager } from "../../core/sessions/manager.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { clearEditStacks } from "../../core/tools/edit-stack.js";
import { planFileName } from "../../core/tools/index.js";
import { disposeTaskScope, setActiveTaskTab } from "../../core/tools/task-list.js";
import {
  type ChatInstance,
  type TabState,
  useChat,
  type WorkspaceSnapshot,
} from "../../hooks/useChat.js";
import type { TabActivity } from "../../hooks/useTabs.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import type { AppConfig, ChatMessage, EditorIntegration } from "../../types/index.js";
import { InputBox } from "../chat/InputBox.js";
import { CodeExpandedProvider } from "../chat/Markdown.js";
import { RAIL_BORDER, ReasoningExpandedProvider, StaticMessage } from "../chat/MessageList.js";
import { StreamSegmentList } from "../chat/StreamSegmentList.js";
import { PlanProgress } from "../plan/PlanProgress.js";
import { PlanReviewPrompt } from "../plan/PlanReviewPrompt.js";
import { TaskProgress, useTaskList } from "../plan/TaskProgress.js";
import { QuestionPrompt } from "../QuestionPrompt.js";
import { AnimatedBorder } from "./AnimatedBorder.js";
import { ChangedFilesBar, ChangesPanel } from "./ChangedFiles.js";
import { LandingPage } from "./LandingPage.js";
import { LoadingStatus } from "./LoadingStatus.js";
import { SystemBanner } from "./SystemBanner.js";

interface TabInstanceProps {
  tabId: string;
  tabLabel: string;
  visible: boolean;
  effectiveConfig: AppConfig;
  sharedResources: SharedContextResources;
  sessionManager: SessionManager;
  cwd: string;
  openEditorWithFile: (file: string) => void;
  openEditor: () => void;
  onSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  onCommand: (input: string, chat: ChatInstance) => void;
  onExit: () => void;
  registerChat: (id: string, chat: ChatInstance) => void;
  unregisterChat: (id: string) => void;
  setTabActivity: (id: string, activity: Partial<TabActivity>) => void;
  autoLabel: (id: string, firstMessage: string) => void;
  initialState?: TabState;
  editorVisible: boolean;
  focusMode: "chat" | "editor";
  anyModalOpen: boolean;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  getWorkspaceSnapshot: () => WorkspaceSnapshot;
  editorIntegration?: EditorIntegration;
  editorOpen: boolean;
  editorFile: string | null;
  editorModeName: string;
  editorCursorLine: number;
  editorCursorCol: number;
  editorVisualSelection: string | null;
  clearEditorSelection: () => void;
}

const MAX_RENDERED = 60;
const SCROLLBOX_STYLE = { contentOptions: { justifyContent: "flex-end" as const } };
const SCROLLBAR_HIDDEN = { visible: false } as const;
const SCROLLBAR_VISIBLE = {
  visible: true,
  trackOptions: {
    foregroundColor: "#555",
    backgroundColor: "#222",
  },
} as const;

export const TabInstance = memo(function TabInstance({
  tabId,
  tabLabel,
  visible,
  effectiveConfig,
  sharedResources,
  sessionManager,
  cwd,
  openEditorWithFile,
  openEditor,
  onSuspend,
  onCommand,
  onExit,
  registerChat,
  unregisterChat,
  setTabActivity,
  autoLabel,
  initialState,
  editorVisible,
  focusMode,
  anyModalOpen,
  bootProviders,
  bootPrereqs,
  getWorkspaceSnapshot,
  editorIntegration,
  editorOpen,
  editorFile,
  editorModeName,
  editorCursorLine,
  editorCursorCol,
  editorVisualSelection,
  clearEditorSelection,
}: TabInstanceProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Per-tab ContextManager sharing expensive resources
  const contextManager = useMemo(
    () => new ContextManager(cwd, sharedResources),
    [cwd, sharedResources],
  );

  // Register tabId with contextManager for cross-tab awareness
  useEffect(() => {
    contextManager.setTabId(tabId);
    contextManager.setTabLabel(tabLabel);
  }, [tabId, tabLabel, contextManager]);

  // Set active task tab when this tab becomes visible
  useEffect(() => {
    if (visible) setActiveTaskTab(tabId);
  }, [tabId, visible]);

  // Dispose task scope only on unmount (tab close), not on hide
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup-only on unmount
  useEffect(() => () => disposeTaskScope(tabId), []);

  useEffect(() => {
    if (editorIntegration) contextManager.setEditorIntegration(editorIntegration);
  }, [editorIntegration, contextManager]);

  useEffect(() => {
    contextManager.setEditorState(
      editorOpen,
      editorFile,
      editorModeName,
      editorCursorLine,
      editorCursorCol,
      editorVisualSelection,
    );
  }, [
    editorOpen,
    editorFile,
    editorModeName,
    editorCursorLine,
    editorCursorCol,
    editorVisualSelection,
    contextManager,
  ]);

  useEffect(() => {
    contextManager.setRepoMapEnabled(effectiveConfig.repoMap !== false);
  }, [effectiveConfig.repoMap, contextManager]);

  useEffect(() => {
    contextManager.setTaskRouter(effectiveConfig.taskRouter);
  }, [effectiveConfig.taskRouter, contextManager]);

  useEffect(() => {
    if (effectiveConfig.semanticSummaries !== undefined)
      contextManager.setSemanticSummaries(effectiveConfig.semanticSummaries);
    contextManager.setSemanticSummaryLimit(effectiveConfig.semanticSummaryLimit);
    contextManager.setSemanticAutoRegen(effectiveConfig.semanticAutoRegen);
    contextManager.setRepoMapTokenBudget(effectiveConfig.repoMapTokenBudget);
  }, [
    effectiveConfig.semanticSummaries,
    effectiveConfig.semanticSummaryLimit,
    effectiveConfig.semanticAutoRegen,
    effectiveConfig.repoMapTokenBudget,
    contextManager,
  ]);

  // Per-tab useChat instance
  const chat = useChat({
    effectiveConfig,
    contextManager,
    sessionManager,
    cwd,
    tabId,
    openEditorWithFile,
    openEditor,
    onSuspend,
    initialState,
    getWorkspaceSnapshot,
    visible,
  });

  // Sync coAuthorCommits from config
  useEffect(() => {
    if (effectiveConfig.coAuthorCommits !== undefined)
      chat.setCoAuthorCommits(effectiveConfig.coAuthorCommits);
  }, [effectiveConfig.coAuthorCommits, chat.setCoAuthorCommits]);

  // Seed active model for semantic summary generation
  useEffect(() => {
    contextManager.setActiveModel(chat.activeModel);
  }, [chat.activeModel, contextManager]);

  // Register/unregister chat instance with tab manager
  useEffect(() => {
    registerChat(tabId, chat);
    return () => unregisterChat(tabId);
  }, [tabId, chat, registerChat, unregisterChat]);

  // Sync status bar when this tab is active
  useEffect(() => {
    if (visible) {
      useStatusBarStore.getState().setTokenUsage(chat.tokenUsage, chat.activeModel);
    }
  }, [visible, chat.tokenUsage, chat.activeModel]);

  // Report loading state to tab manager, sync coordinator idle/active, update claim count
  const prevLoading = useRef(chat.isLoading);
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    setTabActivity(tabId, { isLoading: chat.isLoading });
    // Mark unread if loading finished while tab is in background
    if (prevLoading.current && !chat.isLoading && !visible) {
      setTabActivity(tabId, { hasUnread: true });
    }
    // Signal coordinator idle/active state
    if (!chat.isLoading && prevLoading.current) {
      coordinator.markIdle(tabId);
    } else if (chat.isLoading && !prevLoading.current) {
      coordinator.markActive(tabId);
    }
    prevLoading.current = chat.isLoading;
  }, [chat.isLoading, tabId, setTabActivity, visible]);

  // Signal attention when tab is waiting for user input (plan review or question)
  useEffect(() => {
    const needs = !!(chat.pendingPlanReview || chat.pendingQuestion);
    setTabActivity(tabId, { needsAttention: needs });
  }, [chat.pendingPlanReview, chat.pendingQuestion, tabId, setTabActivity]);

  // Sync claim count to tab activity for tab bar indicator
  useEffect(() => {
    const coordinator = getWorkspaceCoordinator();
    let lastCount = coordinator.getClaimCount(tabId);
    const unsub = coordinator.on((event, eventTabId) => {
      if (eventTabId === tabId || event === "release") {
        const newCount = coordinator.getClaimCount(tabId);
        if (newCount !== lastCount) {
          lastCount = newCount;
          setTabActivity(tabId, { editedFileCount: newCount });
        }
      }
    });
    return unsub;
  }, [tabId, setTabActivity]);

  // Auto-label tab from first user message
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger
  useEffect(() => {
    const firstUser = chat.messages.find((m) => m.role === "user");
    if (firstUser) autoLabel(tabId, firstUser.content);
  }, [chat.messages.length]);

  // Cleanup / dispose on unmount
  useEffect(() => {
    return () => {
      contextManager.dispose();
      clearTabSessionPatterns(tabId);
      clearEditStacks(tabId);
      // Close tab in coordinator — releases claims, clears agents, blocks ghost claims
      getWorkspaceCoordinator().closeTab(tabId);
      // Clean up any pending plan file on disk
      try {
        const p = join(cwd, ".soulforge", "plans", planFileName(chat.sessionId));
        if (existsSync(p)) unlinkSync(p);
      } catch {}
    };
  }, [contextManager, tabId, cwd, chat.sessionId]);

  // Derived state
  const isStreaming = chat.streamSegments.length > 0 || chat.liveToolCalls.length > 0;

  const nonSystemCount = useMemo(() => {
    let count = 0;
    for (const m of chat.messages) {
      if (m.role !== "system" || m.showInChat) count++;
    }
    return count;
  }, [chat.messages]);

  const hasContent = nonSystemCount > 0 || isStreaming;

  // Show scrollbar as soon as we have content. The stickyScroll + stickyStart="bottom"
  // combo handles initial positioning correctly.
  const scrollbarReady = hasContent;

  const {
    codeExpandedMap,
    changesExpanded,
    chatStyle,
    editorSplit,
    showReasoning,
    reasoningExpandedMap,
  } = useUIStore(
    useShallow((s) => ({
      codeExpandedMap: s.codeExpanded,
      changesExpanded: s.changesExpanded,
      chatStyle: s.chatStyle,
      editorSplit: s.editorSplit,
      showReasoning: s.showReasoning,
      reasoningExpandedMap: s.reasoningExpanded,
    })),
  );
  const codeExpanded = !!codeExpandedMap[tabId];
  const reasoningExpanded = !!reasoningExpandedMap[tabId];

  const showPlanProgress = !!chat.activePlan;
  const tasks = useTaskList(tabId);

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

  const visibleMessages = useMemo(() => {
    const msgs = chat.messages;
    const keep = (m: ChatMessage) => m.role !== "system" || m.showInChat;
    if (nonSystemCount <= MAX_RENDERED) return msgs.filter(keep);
    const result: typeof msgs = [];
    for (let i = msgs.length - 1; i >= 0 && result.length < MAX_RENDERED; i--) {
      if (keep(msgs[i] as ChatMessage)) result.push(msgs[i] as (typeof msgs)[0]);
    }
    result.reverse();
    return result;
  }, [chat.messages, nonSystemCount]);
  const hiddenCount = nonSystemCount - visibleMessages.length;

  // Trim old tool results
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrow trigger
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

  const cleanupPlanFile = useCallback(() => {
    try {
      const p = join(cwd, ".soulforge", "plans", planFileName(chat.sessionId));
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }, [cwd, chat.sessionId]);

  const onAcceptPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onClearAndImplementPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("clear_execute");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const onRevisePlan = useCallback(
    (feedback: string) => {
      chat.pendingPlanReview?.resolve(feedback);
    },
    [chat.pendingPlanReview],
  );

  const onCancelPlan = useCallback(() => {
    chat.pendingPlanReview?.resolve("cancel");
    cleanupPlanFile();
  }, [chat.pendingPlanReview, cleanupPlanFile]);

  const handleInputSubmit = useCallback(
    async (input: string) => {
      if (input.startsWith("/")) {
        onCommand(input, chat);
        return;
      }
      chat.handleSubmit(input);
      clearEditorSelection();
      // Re-engage sticky scroll so new messages are visible
      const sb = scrollRef.current;
      if (sb) {
        sb.scrollTo(sb.scrollHeight);
      }
    },
    [chat, onCommand, clearEditorSelection],
  );

  const isFocused = visible && focusMode === "chat" && !anyModalOpen;

  return (
    <box
      visible={visible}
      flexDirection="column"
      flexGrow={editorVisible ? 0 : 1}
      flexShrink={editorVisible ? 1 : 0}
      width={editorVisible ? (`${String(100 - editorSplit)}%` as `${number}%`) : "100%"}
    >
      <SystemBanner messages={chat.messages} expanded={codeExpanded} />

      {!hasContent ? (
        <LandingPage bootProviders={bootProviders} bootPrereqs={bootPrereqs} />
      ) : (
        <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
          <AnimatedBorder active={chat.isLoading || chat.isCompacting}>
            <scrollbox
              ref={scrollRef}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              style={SCROLLBOX_STYLE}
              verticalScrollbarOptions={scrollbarReady ? SCROLLBAR_VISIBLE : SCROLLBAR_HIDDEN}
              horizontalScrollbarOptions={SCROLLBAR_HIDDEN}
            >
              <CodeExpandedProvider value={codeExpanded}>
                <ReasoningExpandedProvider value={reasoningExpanded}>
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
                </ReasoningExpandedProvider>
              </CodeExpandedProvider>
              <LoadingStatus
                isLoading={chat.isLoading}
                isCompacting={chat.isCompacting}
                queueCount={chat.messageQueue.length}
              />
            </scrollbox>
          </AnimatedBorder>
          {changesExpanded && <ChangesPanel messages={chat.messages} cwd={cwd} />}
        </box>
      )}

      {chat.pendingPlanReview ? (
        <box flexShrink={0} paddingX={1}>
          <PlanReviewPrompt
            isActive={isFocused}
            plan={chat.pendingPlanReview.plan}
            planFile={chat.pendingPlanReview.planFile}
            onAccept={onAcceptPlan}
            onClearAndImplement={onClearAndImplementPlan}
            onRevise={onRevisePlan}
            onCancel={onCancelPlan}
          />
        </box>
      ) : chat.pendingQuestion ? (
        <>
          <box flexShrink={0} paddingX={1}>
            <QuestionPrompt question={chat.pendingQuestion} isActive={isFocused} />
          </box>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {hasChangedFiles && (
            <box flexShrink={0} paddingX={1}>
              <ChangedFilesBar messages={chat.messages} />
            </box>
          )}
        </>
      ) : (
        <>
          {showPlanProgress && chat.activePlan && (
            <box flexShrink={0} paddingX={1}>
              <PlanProgress plan={chat.activePlan} tasks={tasks} />
            </box>
          )}
          {!showPlanProgress && tasks.length > 0 && (
            <box flexShrink={0} paddingX={1}>
              <TaskProgress tabId={tabId} />
            </box>
          )}
          {(hasChangedFiles || chat.messageQueue.length > 0) && (
            <box flexShrink={0} paddingX={1} flexDirection="row" gap={1} height={1}>
              {hasChangedFiles && <ChangedFilesBar messages={chat.messages} />}
              {chat.messageQueue.length > 0 &&
                (() => {
                  const latest = chat.messageQueue[chat.messageQueue.length - 1]?.content ?? "";
                  const firstLine = latest.split("\n")[0] ?? "";
                  const extraLines = latest.split("\n").length - 1;
                  const prevCount = chat.messageQueue.length - 1;
                  return (
                    <text fg="#FF8C00" truncate>
                      │ Steering: {firstLine}
                      {extraLines > 0 && <span fg="#666"> (+{String(extraLines)} lines)</span>}
                      {prevCount > 0 && <span fg="#666"> (+{String(prevCount)} queued)</span>}
                    </text>
                  );
                })()}
            </box>
          )}
          <box flexShrink={0} zIndex={10}>
            <InputBox
              onSubmit={handleInputSubmit}
              isLoading={chat.isLoading}
              isCompacting={chat.isCompacting}
              isFocused={isFocused}
              cwd={cwd}
              onExit={onExit}
              onQueue={(msg) =>
                chat.setMessageQueue((prev) =>
                  prev.length >= 5 ? prev : [...prev, { content: msg, queuedAt: Date.now() }],
                )
              }
              queueCount={chat.messageQueue.length}
            />
          </box>
        </>
      )}
    </box>
  );
});
