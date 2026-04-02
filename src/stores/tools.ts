import { create } from "zustand";

const DEFAULT_DISABLED = ["request_tools", "release_tools", "skills", "editor", "test_scaffold"];

interface ToolsState {
  disabledTools: Set<string>;
  toggleTool: (name: string) => void;
  initFromConfig: (disabled?: string[]) => void;
}

export const useToolsStore = create<ToolsState>()((set) => ({
  disabledTools: new Set<string>(DEFAULT_DISABLED),
  toggleTool: (name) =>
    set((s) => {
      const next = new Set(s.disabledTools);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { disabledTools: next };
    }),
  initFromConfig: (disabled) => set({ disabledTools: new Set(disabled ?? DEFAULT_DISABLED) }),
}));
