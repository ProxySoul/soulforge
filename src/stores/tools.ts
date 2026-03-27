import { create } from "zustand";

interface ToolsState {
  disabledTools: Set<string>;
  agentManaged: boolean;
  toggleTool: (name: string) => void;
  toggleAgentManaged: () => void;
}

export const useToolsStore = create<ToolsState>()((set) => ({
  disabledTools: new Set<string>(),
  agentManaged: false,
  toggleTool: (name) =>
    set((s) => {
      const next = new Set(s.disabledTools);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { disabledTools: next };
    }),
  toggleAgentManaged: () => set((s) => ({ agentManaged: !s.agentManaged })),
}));
