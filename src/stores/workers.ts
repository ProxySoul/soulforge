import { create } from "zustand";

export type WorkerStatus = "idle" | "starting" | "ready" | "busy" | "crashed" | "restarting";

interface WorkerInfo {
  status: WorkerStatus;
  restarts: number;
  lastError: string | null;
  rpcInFlight: number;
  totalCalls: number;
  totalErrors: number;
  uptimeMs: number;
  startedAt: number;
}

const EMPTY_WORKER: WorkerInfo = {
  status: "idle",
  restarts: 0,
  lastError: null,
  rpcInFlight: 0,
  totalCalls: 0,
  totalErrors: 0,
  uptimeMs: 0,
  startedAt: 0,
};

interface WorkerStoreState {
  intelligence: WorkerInfo;
  io: WorkerInfo;

  setWorkerStatus: (worker: "intelligence" | "io", status: WorkerStatus) => void;
  setWorkerError: (worker: "intelligence" | "io", error: string) => void;
  incrementRestarts: (worker: "intelligence" | "io") => void;
  updateRpcInFlight: (worker: "intelligence" | "io", delta: number) => void;
  incrementCalls: (worker: "intelligence" | "io") => void;
  incrementErrors: (worker: "intelligence" | "io") => void;
  markStarted: (worker: "intelligence" | "io") => void;
}

export const useWorkerStore = create<WorkerStoreState>()((set) => ({
  intelligence: { ...EMPTY_WORKER },
  io: { ...EMPTY_WORKER },

  setWorkerStatus: (worker, status) =>
    set((state) => ({
      [worker]: { ...state[worker], status },
    })),

  setWorkerError: (worker, error) =>
    set((state) => ({
      [worker]: { ...state[worker], lastError: error, status: "crashed" as const },
    })),

  incrementRestarts: (worker) =>
    set((state) => ({
      [worker]: { ...state[worker], restarts: state[worker].restarts + 1 },
    })),

  updateRpcInFlight: (worker, delta) =>
    set((state) => ({
      [worker]: {
        ...state[worker],
        rpcInFlight: Math.max(0, state[worker].rpcInFlight + delta),
        status:
          state[worker].status === "ready" && delta > 0
            ? ("busy" as const)
            : state[worker].status === "busy" && state[worker].rpcInFlight + delta <= 0
              ? ("ready" as const)
              : state[worker].status,
      },
    })),

  incrementCalls: (worker) =>
    set((state) => ({
      [worker]: { ...state[worker], totalCalls: state[worker].totalCalls + 1 },
    })),

  incrementErrors: (worker) =>
    set((state) => ({
      [worker]: { ...state[worker], totalErrors: state[worker].totalErrors + 1 },
    })),

  markStarted: (worker) =>
    set((state) => ({
      [worker]: {
        ...state[worker],
        status: "ready" as const,
        startedAt: Date.now(),
        uptimeMs: 0,
      },
    })),
}));
