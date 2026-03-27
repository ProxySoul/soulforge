import { join } from "node:path";
import type { ModelMessage } from "ai";
import { useWorkerStore } from "../../stores/workers.js";
import type { ChatMessage } from "../../types/index.js";
import type { WorkingState } from "../compaction/types.js";
import type { SessionMeta } from "../sessions/types.js";
import { WorkerClient } from "./rpc.js";

interface CompressResult {
  text: string;
  original: string | null;
}

interface GitLogEntry {
  hash: string;
  subject: string;
  date: string;
}

interface LoadSessionResult {
  meta: SessionMeta;
  tabEntries: [string, ChatMessage[]][];
}

let _instance: IOClient | null = null;

export function getIOClient(): IOClient {
  if (!_instance) _instance = new IOClient();
  return _instance;
}

export function disposeIOClient(): void {
  _instance?.dispose();
  _instance = null;
}

export class IOClient extends WorkerClient {
  constructor() {
    const workerPath = join(import.meta.dir, "io.worker.ts");
    super(workerPath, undefined, { smol: true });
    useWorkerStore.getState().markStarted("io");
    this.onStatusChange = (status) => {
      const store = useWorkerStore.getState();
      if (status === "crashed") store.setWorkerError("io", "IO worker crashed");
      else if (status === "restarting") {
        store.incrementRestarts("io");
        store.setWorkerStatus("io", "restarting");
      } else if (status === "starting") store.setWorkerStatus("io", "starting");
      else store.markStarted("io");
    };
    this.onRpcStart = () => {
      useWorkerStore.getState().updateRpcInFlight("io", 1);
    };
    this.onRpcEnd = (error) => {
      const store = useWorkerStore.getState();
      store.updateRpcInFlight("io", -1);
      store.incrementCalls("io");
      if (error) store.incrementErrors("io");
    };
  }

  // ── Shell Compression ────────────────────────────────────────────

  async compressShellOutput(raw: string): Promise<string> {
    return this.call("compressShellOutput", raw);
  }

  async compressShellOutputFull(raw: string): Promise<CompressResult> {
    return this.call("compressShellOutputFull", raw);
  }

  // ── File Tree ────────────────────────────────────────────────────

  async walkDir(dir: string, prefix: string, depth: number): Promise<string[]> {
    return this.call("walkDir", dir, prefix, depth);
  }

  // ── Git Parsing ──────────────────────────────────────────────────

  async parseGitLogLine(line: string): Promise<GitLogEntry> {
    return this.call("parseGitLogLine", line);
  }

  async parseGitLogBatch(lines: string[]): Promise<GitLogEntry[]> {
    return this.call("parseGitLogBatch", lines);
  }

  // ── Compaction Serialization ─────────────────────────────────────

  async serializeWorkingState(state: Readonly<WorkingState>): Promise<string> {
    return this.call("serializeWorkingState", state);
  }

  async buildConvoText(messages: ModelMessage[], charBudget: number): Promise<string> {
    return this.call("buildConvoText", messages, charBudget);
  }

  // ── Session Persistence ──────────────────────────────────────────

  async saveSession(
    sessionDir: string,
    meta: SessionMeta,
    tabEntries: [string, ChatMessage[]][],
  ): Promise<void> {
    return this.call("saveSession", sessionDir, meta, tabEntries);
  }

  async loadSession(sessionDir: string): Promise<LoadSessionResult | null> {
    return this.call("loadSession", sessionDir);
  }
}
