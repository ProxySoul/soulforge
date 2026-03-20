import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

type CompactionEventKind = "compact" | "strategy-change" | "auto-trigger" | "error";

interface CompactionLogEntry {
  id: string;
  kind: CompactionEventKind;
  message: string;
  timestamp: number;
  model?: string;
  strategy?: string;
  slotsBefore?: number;
  contextBefore?: string;
  contextAfter?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  summarySnippet?: string;
  summaryLength?: number;
}

type LogExtra = Omit<CompactionLogEntry, "id" | "kind" | "message" | "timestamp">;

const MAX_ENTRIES = 200;

type CompactionLogState = {
  entries: CompactionLogEntry[];
  push: (kind: CompactionEventKind, message: string, extra?: LogExtra) => void;
  clear: () => void;
};

export const useCompactionLogStore = create<CompactionLogState>()(
  subscribeWithSelector((set) => ({
    entries: [],
    push: (kind, message, extra) =>
      set((s) => {
        const entry = {
          id: crypto.randomUUID(),
          kind,
          message,
          timestamp: Date.now(),
          ...extra,
        };
        const entries =
          s.entries.length >= MAX_ENTRIES
            ? [...s.entries.slice(-(MAX_ENTRIES - 1)), entry]
            : [...s.entries, entry];
        return { entries };
      }),
    clear: () => set({ entries: [] }),
  })),
);

export function logCompaction(kind: CompactionEventKind, message: string, extra?: LogExtra): void {
  useCompactionLogStore.getState().push(kind, message, extra);
}
