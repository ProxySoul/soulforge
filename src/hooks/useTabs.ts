import type { ModelMessage } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { rebuildCoreMessages } from "../core/sessions/rebuild.js";
import type { TabMeta } from "../core/sessions/types.js";
import type { ChatMessage } from "../types/index.js";
import type { ChatInstance, TabState } from "./useChat.js";

const MAX_TABS = 5;

export interface Tab {
  id: string;
  label: string;
}

export interface TabActivity {
  isLoading: boolean;
  isCompacting: boolean;
  hasUnread: boolean;
  hasError: boolean;
  needsAttention: boolean;
  editedFileCount: number;
}

export interface UseTabsReturn {
  tabs: Tab[];
  activeTabId: string;
  activeTab: Tab;
  tabCount: number;
  activeTabIndex: number;
  createTab: () => void;
  closeTab: (id: string) => boolean;
  isTabLoading: (id: string) => boolean;
  switchTab: (id: string) => void;
  switchToIndex: (index: number) => void;
  nextTab: () => void;
  prevTab: () => void;
  renameTab: (id: string, label: string) => void;
  moveTab: (id: string, direction: "left" | "right") => void;
  resetTabLabel: (id: string) => void;
  autoLabel: (id: string, firstMessage: string) => void;
  setTabActivity: (id: string, activity: Partial<TabActivity>) => void;
  getTabActivity: (id: string) => TabActivity;
  registerChat: (id: string, chat: ChatInstance) => void;
  unregisterChat: (id: string) => void;
  getActiveChat: () => ChatInstance | null;
  getChat: (id: string) => ChatInstance | null;
  getAllTabStates: () => TabState[];
  initialStates: React.RefObject<Map<string, TabState>>;
  restoreFromMeta: (
    tabMetas: TabMeta[],
    activeId: string,
    tabMessages: Map<string, ChatMessage[]>,
    tabCoreMessages?: Map<string, ModelMessage[]>,
  ) => void;
}

const DEFAULT_ACTIVITY: TabActivity = {
  isLoading: false,
  isCompacting: false,
  hasUnread: false,
  hasError: false,
  needsAttention: false,
  editedFileCount: 0,
};

export function useTabs(): UseTabsReturn {
  const initialId = useRef(crypto.randomUUID()).current;
  const [tabs, setTabs] = useState<Tab[]>([{ id: initialId, label: "Tab 1" }]);
  const [activeTabId, setActiveTabId] = useState<string>(initialId);
  const autoLabeled = useRef(new Set<string>());
  const chatRegistry = useRef(new Map<string, ChatInstance>());
  const [activityMap, setActivityMap] = useState<Map<string, TabActivity>>(() => new Map());
  const activityMapRef = useRef(activityMap);
  activityMapRef.current = activityMap;
  const initialStates = useRef(new Map<string, TabState>());

  // Stable refs so callbacks don't depend on tabs/activeTabId arrays
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const activeTab = useMemo(
    () => (tabs.find((t) => t.id === activeTabId) ?? tabs[0]) as (typeof tabs)[number],
    [tabs, activeTabId],
  );
  const activeTabIndex = useMemo(
    () => tabs.findIndex((t) => t.id === activeTabId),
    [tabs, activeTabId],
  );

  const switchTab = useCallback((targetId: string) => {
    if (targetId === activeTabIdRef.current) return;
    if (!tabsRef.current.some((t) => t.id === targetId)) return;
    const activity = activityMapRef.current.get(targetId);
    if (activity && (activity.hasUnread || activity.hasError)) {
      setActivityMap((prev) => {
        const next = new Map(prev);
        next.set(targetId, { ...activity, hasUnread: false, hasError: false });
        return next;
      });
    }
    setActiveTabId(targetId);
  }, []);

  const createTab = useCallback(() => {
    if (tabsRef.current.length >= MAX_TABS) return;
    const newId = crypto.randomUUID();
    setTabs((prev) => {
      const newLabel = `Tab ${String(prev.length + 1)}`;
      return [...prev, { id: newId, label: newLabel }];
    });
    setActiveTabId(newId);
  }, []);

  const closeTab = useCallback((targetId: string): boolean => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length <= 1) return false;
    const idx = currentTabs.findIndex((t) => t.id === targetId);
    if (idx === -1) return false;

    const chat = chatRegistry.current.get(targetId);
    if (chat) chat.abort();

    chatRegistry.current.delete(targetId);
    autoLabeled.current.delete(targetId);
    setActivityMap((prev) => {
      const next = new Map(prev);
      next.delete(targetId);
      return next;
    });
    initialStates.current.delete(targetId);

    const newTabs = currentTabs.filter((t) => t.id !== targetId);
    setTabs(newTabs);

    if (targetId === activeTabIdRef.current) {
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActiveId = newTabs[newIdx]?.id ?? newTabs[0]?.id ?? "";
      setActiveTabId(newActiveId);
    }

    return true;
  }, []);

  const switchToIndex = useCallback(
    (index: number) => {
      const tab = tabsRef.current[index];
      if (tab) switchTab(tab.id);
    },
    [switchTab],
  );

  const nextTab = useCallback(() => {
    const currentTabs = tabsRef.current;
    const idx = currentTabs.findIndex((t) => t.id === activeTabIdRef.current);
    const nextIdx = (idx + 1) % currentTabs.length;
    const tab = currentTabs[nextIdx];
    if (tab) switchTab(tab.id);
  }, [switchTab]);

  const prevTab = useCallback(() => {
    const currentTabs = tabsRef.current;
    const idx = currentTabs.findIndex((t) => t.id === activeTabIdRef.current);
    const prevIdx = (idx - 1 + currentTabs.length) % currentTabs.length;
    const tab = currentTabs[prevIdx];
    if (tab) switchTab(tab.id);
  }, [switchTab]);

  const renameTab = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
    autoLabeled.current.add(id);
  }, []);

  const moveTab = useCallback((id: string, direction: "left" | "right") => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const newIdx = direction === "left" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      const a = next[idx];
      const b = next[newIdx];
      if (a && b) {
        next[idx] = b;
        next[newIdx] = a;
      }
      return next;
    });
  }, []);

  const resetTabLabel = useCallback((id: string) => {
    autoLabeled.current.delete(id);
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const label = `Tab ${String(idx + 1)}`;
      return prev.map((t) => (t.id === id ? { ...t, label } : t));
    });
  }, []);

  const autoLabel = useCallback((id: string, firstMessage: string) => {
    if (autoLabeled.current.has(id)) return;
    autoLabeled.current.add(id);
    const label = firstMessage.trim().slice(0, 20) || "Tab";
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
  }, []);

  const setTabActivity = useCallback((id: string, activity: Partial<TabActivity>) => {
    setActivityMap((prev) => {
      const current = prev.get(id) ?? { ...DEFAULT_ACTIVITY };
      const updated = { ...current, ...activity };
      if (activity.hasUnread && id === activeTabIdRef.current) {
        updated.hasUnread = false;
      }
      const next = new Map(prev);
      next.set(id, updated);
      return next;
    });
  }, []);

  const getTabActivity = useCallback(
    (id: string): TabActivity => {
      return activityMap.get(id) ?? { ...DEFAULT_ACTIVITY };
    },
    [activityMap],
  );

  const isTabLoading = useCallback(
    (id: string): boolean => {
      return activityMap.get(id)?.isLoading === true;
    },
    [activityMap],
  );

  const registerChat = useCallback((id: string, chat: ChatInstance) => {
    chatRegistry.current.set(id, chat);
    initialStates.current.delete(id);
  }, []);

  const unregisterChat = useCallback((id: string) => {
    chatRegistry.current.delete(id);
  }, []);

  const getActiveChat = useCallback((): ChatInstance | null => {
    return chatRegistry.current.get(activeTabIdRef.current) ?? null;
  }, []);

  const getChat = useCallback((id: string): ChatInstance | null => {
    return chatRegistry.current.get(id) ?? null;
  }, []);

  const getAllTabStates = useCallback((): TabState[] => {
    const states: TabState[] = [];
    for (const tab of tabsRef.current) {
      const chat = chatRegistry.current.get(tab.id);
      if (chat) {
        states.push(chat.snapshot(tab.label));
      }
    }
    return states;
  }, []);

  const restoreFromMeta = useCallback(
    (
      tabMetas: TabMeta[],
      activeId: string,
      tabMessages: Map<string, ChatMessage[]>,
      tabCoreMessages?: Map<string, ModelMessage[]>,
    ) => {
      if (tabMetas.length === 0) return;

      // Abort any in-flight chats before replacing tabs
      for (const chat of chatRegistry.current.values()) {
        chat.abort();
      }
      chatRegistry.current.clear();

      const restoredTabs: Tab[] = tabMetas.map((tm) => ({
        id: tm.id,
        label: tm.label,
      }));
      setTabs(restoredTabs);

      // Reset activity + auto-label tracking for clean state
      setActivityMap(new Map());
      autoLabeled.current.clear();
      for (const tm of tabMetas) {
        autoLabeled.current.add(tm.id);
      }

      const resolvedActiveId = tabMetas.some((tm) => tm.id === activeId)
        ? activeId
        : (tabMetas[0] as (typeof tabMetas)[number]).id;

      initialStates.current.clear();
      for (const tm of tabMetas) {
        const msgs = tabMessages.get(tm.id) ?? [];
        const state: TabState = {
          id: tm.id,
          label: tm.label,
          messages: msgs,
          coreMessages: tabCoreMessages?.get(tm.id) ?? rebuildCoreMessages(msgs),
          activeModel: tm.activeModel,
          activePlan: null,
          sidebarPlan: null,
          tokenUsage: {
            cacheRead: 0,
            cacheWrite: 0,
            subagentInput: 0,
            subagentOutput: 0,
            lastStepInput: 0,
            lastStepOutput: 0,
            lastStepCacheRead: 0,
            modelBreakdown: {},
            ...tm.tokenUsage,
          },
          coAuthorCommits: tm.coAuthorCommits,
          sessionId: tm.sessionId,
          planMode: tm.planMode,
          planRequest: tm.planRequest,
          forgeMode: tm.forgeMode ?? "default",
        };
        initialStates.current.set(tm.id, state);
      }

      setActiveTabId(resolvedActiveId);
    },
    [],
  );

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount: tabs.length,
    activeTabIndex,
    createTab,
    closeTab,
    isTabLoading,
    switchTab,
    switchToIndex,
    nextTab,
    prevTab,
    renameTab,
    moveTab,
    resetTabLabel,
    autoLabel,
    setTabActivity,
    getTabActivity,
    registerChat,
    unregisterChat,
    getActiveChat,
    getChat,
    getAllTabStates,
    initialStates,
    restoreFromMeta,
  };
}
