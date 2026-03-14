import { execFile } from "node:child_process";
import { create } from "zustand";
import { getIntelligenceChildPids } from "../core/intelligence/index.js";
import { getProxyPid } from "../core/proxy/lifecycle.js";

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  subagentInput: number;
  subagentOutput: number;
}

export const ZERO_USAGE: TokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
  cacheRead: 0,
  subagentInput: 0,
  subagentOutput: 0,
};

interface StatusBarState {
  tokenUsage: TokenUsage;
  contextTokens: number;
  contextWindow: number;
  chatChars: number;
  subagentChars: number;
  rssMB: number;
  compacting: boolean;
  compactionStrategy: "v1" | "v2";
  v2Slots: number;

  setTokenUsage: (usage: TokenUsage) => void;
  resetTokenUsage: () => void;
  setContext: (contextTokens: number, chatChars: number) => void;
  setContextWindow: (tokens: number) => void;
  setSubagentChars: (chars: number) => void;
  setRssMB: (mb: number) => void;
  setCompacting: (v: boolean) => void;
  setCompactionStrategy: (s: "v1" | "v2") => void;
  setV2Slots: (n: number) => void;
}

export const useStatusBarStore = create<StatusBarState>()((set) => ({
  tokenUsage: { ...ZERO_USAGE },
  contextTokens: 0,
  contextWindow: 200_000,
  chatChars: 0,
  subagentChars: 0,
  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  compacting: false,
  compactionStrategy: "v1",
  v2Slots: 0,

  setTokenUsage: (usage) => set({ tokenUsage: usage }),
  resetTokenUsage: () => set({ tokenUsage: { ...ZERO_USAGE } }),
  setContext: (contextTokens, chatChars) => set({ contextTokens, chatChars, subagentChars: 0 }),
  setContextWindow: (tokens) => set({ contextWindow: tokens }),
  setSubagentChars: (chars) => set({ subagentChars: chars }),
  setRssMB: (mb) => set({ rssMB: mb }),
  setCompacting: (v) => set({ compacting: v }),
  setCompactionStrategy: (s) => set({ compactionStrategy: s }),
  setV2Slots: (n) => set({ v2Slots: n }),
}));

export function resetStatusBarStore(): void {
  useStatusBarStore.setState({
    tokenUsage: { ...ZERO_USAGE },
    contextTokens: 0,
    chatChars: 0,
    subagentChars: 0,
    compacting: false,
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
export function startMemoryPoll(intervalMs = 2000) {
  if (memPollStarted) return;
  memPollStarted = true;
  setInterval(() => {
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
