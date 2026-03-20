import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

interface BackgroundError {
  id: string;
  source: string;
  message: string;
  timestamp: number;
}

const MAX_ERRORS = 500;

interface ErrorStoreState {
  errors: BackgroundError[];
  push: (source: string, message: string) => void;
  clear: () => void;
}

export const useErrorStore = create<ErrorStoreState>()(
  subscribeWithSelector((set) => ({
    errors: [],
    push: (source, message) =>
      set((s) => {
        const entry = { id: crypto.randomUUID(), source, message, timestamp: Date.now() };
        const errors =
          s.errors.length >= MAX_ERRORS
            ? [...s.errors.slice(-(MAX_ERRORS - 1)), entry]
            : [...s.errors, entry];
        return { errors };
      }),
    clear: () => set({ errors: [] }),
  })),
);

export function logBackgroundError(source: string, message: string): void {
  useErrorStore.getState().push(source, message);
}
