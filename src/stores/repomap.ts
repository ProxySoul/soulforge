import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export type RepoMapStatus = "off" | "scanning" | "ready" | "error";
export type SemanticStatus = "off" | "generating" | "ready" | "error";

interface RepoMapState {
  status: RepoMapStatus;
  files: number;
  symbols: number;
  edges: number;
  dbSizeBytes: number;
  scanProgress: string;
  scanError: string;
  semanticStatus: SemanticStatus;
  semanticCount: number;
  semanticProgress: string;
  semanticModel: string;
  semanticTokensIn: number;
  semanticTokensOut: number;

  setStatus: (status: RepoMapStatus) => void;
  setStats: (files: number, symbols: number, edges: number, dbSizeBytes: number) => void;
  setScanProgress: (msg: string) => void;
  setScanError: (msg: string) => void;
  setSemanticStatus: (status: SemanticStatus) => void;
  setSemanticCount: (count: number) => void;
  setSemanticProgress: (msg: string) => void;
  setSemanticModel: (model: string) => void;
  addSemanticTokens: (input: number, output: number) => void;
  resetSemanticTokens: () => void;
}

let _pendingScanProgress = "";
let _pendingStats: { files: number; symbols: number; edges: number; dbSizeBytes: number } | null =
  null;
let _scanThrottleTimer: ReturnType<typeof setTimeout> | null = null;

function flushScanThrottle(set: (partial: Partial<RepoMapState>) => void) {
  _scanThrottleTimer = null;
  const patch: Partial<RepoMapState> = { scanProgress: _pendingScanProgress };
  if (_pendingStats) {
    Object.assign(patch, _pendingStats);
    _pendingStats = null;
  }
  set(patch);
}

export const useRepoMapStore = create<RepoMapState>()(
  subscribeWithSelector((set) => ({
    status: "off",
    files: 0,
    symbols: 0,
    edges: 0,
    dbSizeBytes: 0,
    scanProgress: "",
    scanError: "",
    semanticStatus: "off",
    semanticCount: 0,
    semanticProgress: "",
    semanticModel: "",
    semanticTokensIn: 0,
    semanticTokensOut: 0,

    setStatus: (status) => {
      if (_scanThrottleTimer) {
        clearTimeout(_scanThrottleTimer);
        flushScanThrottle(set);
      }
      set({ status });
    },
    setStats: (files, symbols, edges, dbSizeBytes) => {
      _pendingStats = { files, symbols, edges, dbSizeBytes };
      if (!_scanThrottleTimer) {
        _scanThrottleTimer = setTimeout(() => flushScanThrottle(set), 200);
      }
    },
    setScanProgress: (scanProgress) => {
      _pendingScanProgress = scanProgress;
      if (!_scanThrottleTimer) {
        _scanThrottleTimer = setTimeout(() => flushScanThrottle(set), 200);
      }
    },
    setScanError: (scanError) => set({ scanError }),
    setSemanticStatus: (semanticStatus) => set({ semanticStatus }),
    setSemanticCount: (semanticCount) => set({ semanticCount }),
    setSemanticProgress: (semanticProgress) => set({ semanticProgress }),
    setSemanticModel: (semanticModel) => set({ semanticModel }),
    addSemanticTokens: (input, output) =>
      set((s) => ({
        semanticTokensIn: s.semanticTokensIn + input,
        semanticTokensOut: s.semanticTokensOut + output,
      })),
    resetSemanticTokens: () => set({ semanticTokensIn: 0, semanticTokensOut: 0 }),
  })),
);
