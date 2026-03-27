import { execFile } from "node:child_process";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CompactionStrategy } from "../core/compaction/types.js";
import { getNvimPid } from "../core/editor/instance.js";
import { getIntelligenceChildPids } from "../core/intelligence/index.js";
import { getProxyPid } from "../core/proxy/lifecycle.js";

export interface PerModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  modelBreakdown: Record<string, PerModelUsage>;
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

/** Compute total cost from per-model breakdown. More accurate than computeCost when router mixes models. */
export function computeTotalCostFromBreakdown(breakdown: Record<string, PerModelUsage>): number {
  let total = 0;
  for (const [modelId, usage] of Object.entries(breakdown)) {
    const p = matchPricing(modelId);
    total +=
      (usage.input / 1e6) * p.input +
      (usage.cacheWrite / 1e6) * p.cacheWrite +
      (usage.cacheRead / 1e6) * p.cacheRead +
      (usage.output / 1e6) * p.output;
  }
  return total;
}

/** Compute cost for a single model from the breakdown. */
export function computeModelCost(modelId: string, usage: PerModelUsage): number {
  const p = matchPricing(modelId);
  return (
    (usage.input / 1e6) * p.input +
    (usage.cacheWrite / 1e6) * p.cacheWrite +
    (usage.cacheRead / 1e6) * p.cacheRead +
    (usage.output / 1e6) * p.output
  );
}

/** Accumulate tokens for a specific model in the breakdown. Returns a new breakdown object. */
export function accumulateModelUsage(
  breakdown: Record<string, PerModelUsage>,
  modelId: string,
  delta: Partial<PerModelUsage>,
): Record<string, PerModelUsage> {
  const prev = breakdown[modelId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    ...breakdown,
    [modelId]: {
      input: prev.input + (delta.input ?? 0),
      output: prev.output + (delta.output ?? 0),
      cacheRead: prev.cacheRead + (delta.cacheRead ?? 0),
      cacheWrite: prev.cacheWrite + (delta.cacheWrite ?? 0),
    },
  };
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
  modelBreakdown: {},
};

export interface ProcessRss {
  mainMB: number;
  nvimMB: number;
  proxyMB: number;
  lspMB: number;
}

const ZERO_PROCESS_RSS: ProcessRss = { mainMB: 0, nvimMB: 0, proxyMB: 0, lspMB: 0 };

interface StatusBarState {
  tokenUsage: TokenUsage;
  activeModel: string;
  contextTokens: number;
  contextWindow: number;
  chatChars: number;
  chatCharsAtSnapshot: number;
  subagentChars: number;
  rssMB: number;
  processRss: ProcessRss;
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
  setProcessRss: (rss: ProcessRss) => void;
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
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,

    setTokenUsage: (usage, modelId) =>
      set({ tokenUsage: usage, ...(modelId ? { activeModel: modelId } : {}) }),
    resetTokenUsage: () => set({ tokenUsage: { ...ZERO_USAGE } }),
    setContext: (contextTokens, chatChars) =>
      set({
        contextTokens,
        chatChars,
        chatCharsAtSnapshot: contextTokens > 0 ? chatChars : 0,
        subagentChars: 0,
      }),
    setContextWindow: (tokens) => set({ contextWindow: tokens }),
    setSubagentChars: (chars) => set({ subagentChars: chars }),
    setRssMB: (mb) => set({ rssMB: mb }),
    setProcessRss: (rss) =>
      set({
        processRss: rss,
        rssMB: Math.round(rss.mainMB + rss.nvimMB + rss.proxyMB + rss.lspMB),
      }),
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
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
  });
}

interface PidGroup {
  nvim: number | null;
  proxy: number | null;
  lsp: number[];
}

function collectPidGroups(): PidGroup {
  return {
    nvim: getNvimPid(),
    proxy: getProxyPid(),
    lsp: getIntelligenceChildPids(),
  };
}

function getPerPidRssKB(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (pids.length === 0) return Promise.resolve(result);
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        [
          "process",
          "where",
          `(${pids.map((p) => `ProcessId=${String(p)}`).join(" or ")})`,
          "get",
          "ProcessId,WorkingSetSize",
          "/format:csv",
        ],
        (err, stdout) => {
          if (err) {
            resolve(result);
            return;
          }
          for (const line of stdout.split("\n")) {
            const parts = line.trim().split(",");
            const pidStr = parts[1];
            const bytesStr = parts[2];
            if (pidStr && bytesStr) {
              const pid = Number.parseInt(pidStr, 10);
              const bytes = Number.parseInt(bytesStr, 10);
              if (!Number.isNaN(pid) && !Number.isNaN(bytes)) {
                result.set(pid, bytes / 1024);
              }
            }
          }
          resolve(result);
        },
      );
    });
  }
  return new Promise((resolve) => {
    execFile("ps", ["-p", pids.join(","), "-o", "pid=,rss="], (err, stdout) => {
      if (err) {
        resolve(result);
        return;
      }
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pidStr = parts[0];
        const kbStr = parts[1];
        if (pidStr && kbStr) {
          const pid = Number.parseInt(pidStr, 10);
          const kb = Number.parseInt(kbStr, 10);
          if (!Number.isNaN(pid) && !Number.isNaN(kb)) {
            result.set(pid, kb);
          }
        }
      }
      resolve(result);
    });
  });
}

let memPollStarted = false;
let memPollTimer: ReturnType<typeof setInterval> | null = null;
export function startMemoryPoll(intervalMs = 2000) {
  if (memPollStarted) return;
  memPollStarted = true;
  memPollTimer = setInterval(() => {
    const mainMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const groups = collectPidGroups();
    const allPids: number[] = [];
    if (groups.nvim != null) allPids.push(groups.nvim);
    if (groups.proxy != null) allPids.push(groups.proxy);
    allPids.push(...groups.lsp);

    if (allPids.length === 0) {
      useStatusBarStore.getState().setProcessRss({ mainMB, nvimMB: 0, proxyMB: 0, lspMB: 0 });
      return;
    }
    getPerPidRssKB(allPids).then((rssMap) => {
      const kbToMB = (pid: number | null) =>
        pid != null ? Math.round((rssMap.get(pid) ?? 0) / 1024) : 0;
      let lspMB = 0;
      for (const pid of groups.lsp) {
        lspMB += Math.round((rssMap.get(pid) ?? 0) / 1024);
      }
      useStatusBarStore.getState().setProcessRss({
        mainMB,
        nvimMB: kbToMB(groups.nvim),
        proxyMB: kbToMB(groups.proxy),
        lspMB,
      });
    });
  }, intervalMs);
}
