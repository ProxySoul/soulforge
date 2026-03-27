import { execFile } from "node:child_process";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CompactionStrategy } from "../core/compaction/types.js";
import { getIntelligenceChildPids } from "../core/intelligence/index.js";
import { getProxyPid } from "../core/proxy/lifecycle.js";

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  subagentInput: number;
  subagentOutput: number;
  lastStepInput: number;
  lastStepOutput: number;
  lastStepCacheRead: number;
}

interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-1": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4": { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.7-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-3.5-sonnet": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  "claude-3.5-haiku": { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4 },
  "claude-3-haiku": { input: 0.25, cacheWrite: 0.3, cacheRead: 0.03, output: 1.25 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };

function matchPricing(modelId: string): ModelPricing {
  const id = modelId.toLowerCase();
  // Match most specific first (longer keys first via sorted entries)
  const entries = Object.entries(MODEL_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, pricing] of entries) {
    if (id.includes(key)) return pricing;
  }
  if (id.includes("opus")) return MODEL_PRICING["claude-opus-4-6"] ?? DEFAULT_PRICING;
  if (id.includes("sonnet")) return DEFAULT_PRICING;
  if (id.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5"] ?? DEFAULT_PRICING;
  return DEFAULT_PRICING;
}

/** Compute session cost in USD.
 *  prompt = uncached input only (noCache tokens).
 *  cacheWrite and cacheRead tracked separately with their own rates. */
export function computeCost(usage: TokenUsage, modelId: string): number {
  const p = matchPricing(modelId);
  const uncached = usage.prompt + usage.subagentInput;
  const totalOutput = usage.completion + usage.subagentOutput;
  return (
    (uncached / 1e6) * p.input +
    (usage.cacheWrite / 1e6) * p.cacheWrite +
    (usage.cacheRead / 1e6) * p.cacheRead +
    (totalOutput / 1e6) * p.output
  );
}

const ZERO_USAGE: TokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
  cacheRead: 0,
  cacheWrite: 0,
  subagentInput: 0,
  subagentOutput: 0,
  lastStepInput: 0,
  lastStepOutput: 0,
  lastStepCacheRead: 0,
};

interface StatusBarState {
  tokenUsage: TokenUsage;
  activeModel: string;
  contextTokens: number;
  contextWindow: number;
  chatChars: number;
  subagentChars: number;
  rssMB: number;
  compacting: boolean;
  compactElapsed: number;
  compactionStrategy: CompactionStrategy;
  v2Slots: number;

  setTokenUsage: (usage: TokenUsage, modelId?: string) => void;
  resetTokenUsage: () => void;
  setContext: (contextTokens: number, chatChars: number) => void;
  setContextWindow: (tokens: number) => void;
  setSubagentChars: (chars: number) => void;
  setRssMB: (mb: number) => void;
  setCompacting: (v: boolean) => void;
  setCompactElapsed: (s: number) => void;
  setCompactionStrategy: (s: CompactionStrategy) => void;
  setV2Slots: (n: number) => void;
}

export const useStatusBarStore = create<StatusBarState>()(
  subscribeWithSelector((set) => ({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 200_000,
    chatChars: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,

    setTokenUsage: (usage, modelId) =>
      set({ tokenUsage: usage, ...(modelId ? { activeModel: modelId } : {}) }),
    resetTokenUsage: () => set({ tokenUsage: { ...ZERO_USAGE } }),
    setContext: (contextTokens, chatChars) => set({ contextTokens, chatChars, subagentChars: 0 }),
    setContextWindow: (tokens) => set({ contextWindow: tokens }),
    setSubagentChars: (chars) => set({ subagentChars: chars }),
    setRssMB: (mb) => set({ rssMB: mb }),
    setCompacting: (v) => set({ compacting: v, compactElapsed: 0 }),
    setCompactElapsed: (s) => set({ compactElapsed: s }),
    setCompactionStrategy: (s) => set({ compactionStrategy: s }),
    setV2Slots: (n) => set({ v2Slots: n }),
  })),
);

export function resetStatusBarStore(): void {
  if (memPollTimer) {
    clearInterval(memPollTimer);
    memPollTimer = null;
    memPollStarted = false;
  }
  useStatusBarStore.setState({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 200_000,
    chatChars: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
  });
}

function collectChildPids(): number[] {
  const pids: number[] = [];
  const proxyPid = getProxyPid();
  if (proxyPid != null) pids.push(proxyPid);
  pids.push(...getIntelligenceChildPids());
  return pids;
}

function getChildRssKB(pids: number[]): Promise<number> {
  if (pids.length === 0) return Promise.resolve(0);
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        [
          "process",
          "where",
          `(${pids.map((p) => `ProcessId=${String(p)}`).join(" or ")})`,
          "get",
          "WorkingSetSize",
        ],
        (err, stdout) => {
          if (err) {
            resolve(0);
            return;
          }
          let total = 0;
          for (const line of stdout.split("\n")) {
            const bytes = Number.parseInt(line.trim(), 10);
            if (!Number.isNaN(bytes)) total += bytes / 1024;
          }
          resolve(total);
        },
      );
    });
  }
  return new Promise((resolve) => {
    execFile("ps", ["-p", pids.join(","), "-o", "rss="], (err, stdout) => {
      if (err) {
        resolve(0);
        return;
      }
      let total = 0;
      for (const line of stdout.split("\n")) {
        const kb = Number.parseInt(line.trim(), 10);
        if (!Number.isNaN(kb)) total += kb;
      }
      resolve(total);
    });
  });
}

let memPollStarted = false;
let memPollTimer: ReturnType<typeof setInterval> | null = null;
export function startMemoryPoll(intervalMs = 2000) {
  if (memPollStarted) return;
  memPollStarted = true;
  memPollTimer = setInterval(() => {
    const mainMB = process.memoryUsage().rss / 1024 / 1024;
    const childPids = collectChildPids();
    if (childPids.length === 0) {
      useStatusBarStore.getState().setRssMB(Math.round(mainMB));
      return;
    }
    getChildRssKB(childPids).then((childKB) => {
      const totalMB = mainMB + childKB / 1024;
      useStatusBarStore.getState().setRssMB(Math.round(totalMB));
    });
  }, intervalMs);
}
