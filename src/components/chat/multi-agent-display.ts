import type { MultiAgentEvent } from "../../core/agents/subagent-events.js";

export interface AgentInfo {
  role: string;
  task: string;
  state: "pending" | "running" | "done" | "error";
  toolUses?: number;
  tokenUsage?: { input: number; output: number; total: number };
  cacheHits?: number;
  modelId?: string;
  tier?: string;
  dependsOn?: string[];
  succeeded?: boolean;
}

export interface MultiAgentState {
  totalAgents: number;
  agents: Map<string, AgentInfo>;
  findingCount: number;
}

export function shortModelId(modelId: string): string {
  const parts = modelId.split("/");
  const name = parts[parts.length - 1] ?? modelId;
  if (name.includes("haiku")) return "haiku";
  if (name.includes("sonnet")) return "sonnet";
  if (name.includes("opus")) return "opus";
  if (name.includes("flash")) return "flash";
  if (name.includes("pro")) return "pro";
  if (name.includes("gpt-4o-mini")) return "4o-mini";
  if (name.includes("gpt-4o")) return "4o";
  return name.length > 15 ? `${name.slice(0, 12)}...` : name;
}

export function applyMultiAgentEvent(
  prev: MultiAgentState | null,
  event: MultiAgentEvent,
  fallbackTotal: number,
): MultiAgentState {
  const s: MultiAgentState = prev ?? {
    totalAgents: event.totalAgents ?? fallbackTotal,
    agents: new Map(),
    findingCount: 0,
  };
  const total = event.totalAgents ?? s.totalAgents;

  if (event.type === "dispatch-start") {
    const newTotal = event.totalAgents ?? fallbackTotal;
    // Clear stale seeds — dispatch may have merged tasks (7 raw → 5 actual)
    if (newTotal < s.agents.size) {
      for (const [key, info] of s.agents) {
        if (info.state === "pending") s.agents.delete(key);
      }
    }
    return {
      ...s,
      totalAgents: newTotal,
    };
  }
  if (event.type === "agent-start" && event.agentId) {
    // Remove seed entry if it exists (seed IDs may differ from runtime IDs)
    const existing = s.agents.get(event.agentId);
    if (!existing) {
      // Try to find and replace a pending seed by matching agentId pattern
      for (const [key, info] of s.agents) {
        if (info.state === "pending" && !s.agents.has(event.agentId)) {
          // Match seed to real agent: same task prefix or same position
          const seedTask = info.task.slice(0, 30);
          const eventTask = (event.task ?? "").slice(0, 30);
          if (seedTask && eventTask && seedTask === eventTask) {
            s.agents.delete(key);
            break;
          }
        }
      }
    }
    const prev_info = existing ?? {};
    s.agents.set(event.agentId, {
      ...prev_info,
      role: event.role ?? "explore",
      task: event.task ?? "",
      state: "running",
      modelId: event.modelId,
      tier: event.tier,
    });
    return { ...s, totalAgents: total };
  }
  if (event.type === "agent-done" && event.agentId) {
    const existing = s.agents.get(event.agentId);
    const stats = {
      toolUses: event.toolUses,
      tokenUsage: event.tokenUsage,
      cacheHits: event.cacheHits,
      succeeded: event.succeeded,
    };
    if (existing) {
      s.agents.set(event.agentId, { ...existing, state: "done", ...stats });
    } else {
      s.agents.set(event.agentId, {
        role: event.role ?? "explore",
        task: event.task ?? "",
        state: "done",
        ...stats,
      });
    }
    return {
      ...s,
      totalAgents: total,
      findingCount: event.findingCount ?? s.findingCount,
    };
  }
  if (event.type === "agent-error" && event.agentId) {
    const existing = s.agents.get(event.agentId);
    if (existing) {
      s.agents.set(event.agentId, { ...existing, state: "error" });
    } else {
      s.agents.set(event.agentId, {
        role: event.role ?? "explore",
        task: event.task ?? "",
        state: "error",
      });
    }
    return { ...s, totalAgents: total };
  }
  return s;
}

export const CACHE_ICONS: Record<string, string> = {
  hit: "\uF0E7",
  wait: "\uF017",
  store: "\uF0C7",
  invalidate: "\uF071",
};

export function humanizeTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
