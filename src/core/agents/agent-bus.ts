/**
 * AgentBus — Shared coordination layer for parallel subagents.
 *
 * Each bus instance lives for the duration of a single `multi_agent` dispatch.
 * Subagents post findings to the bus, and can query findings from peers.
 * The bus is immutable-append-only (no deletions) to avoid race conditions.
 */

import { logBackgroundError } from "../../stores/errors.js";
import type { TaskTier } from "../../types/index.js";

export function normalizePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) return "";
  let n = p.replace(/\\/g, "/");
  while (n.startsWith("./")) n = n.slice(2);
  return n.replace(/\/+/g, "/");
}

function notifyWaiters<T>(waiters: Array<(v: T) => void>, value: T): void {
  for (const w of waiters) {
    try {
      w(value);
    } catch {}
  }
}

export interface SharedCache {
  files: Map<string, string | null>;
  toolResults: Map<string, { result: string; ts: number; agentId: string }>;
  findings: BusFinding[];
}

export interface BusFinding {
  agentId: string;
  label: string;
  content: string;
  timestamp: number;
}

export type AgentRole = "explore" | "code" | "investigate";

export type ReturnFormat = "summary" | "code" | "files" | "full" | "verdict";

export interface AgentTask {
  agentId: string;
  role: AgentRole;
  task: string;
  returnFormat?: ReturnFormat;
  dependsOn?: string[];
  timeoutMs?: number;
  tier?: TaskTier;
  taskId?: number;
  tabId?: string;
  targetFileCount?: number;
  targetFiles?: string[];
}

export interface AgentResult {
  agentId: string;
  role: AgentRole;
  task: string;
  result: string;
  success: boolean;
  error?: string;
}

export class DependencyFailedError extends Error {
  constructor(
    public readonly depAgentId: string,
    public readonly depResult: AgentResult,
  ) {
    super(`Dependency "${depAgentId}" failed: ${depResult.error ?? depResult.result}`);
    this.name = "DependencyFailedError";
  }
}

interface FileCacheEntry {
  agentId: string;
  state: "reading" | "done" | "failed";
  content: string | null;
  waiters: Array<(content: string | null) => void>;
  gen: number;
  lastAccess: number;
}

type AcquireResult =
  | { cached: true; content: string | null }
  | { cached: false; gen: number }
  | { cached: "waiting"; content: Promise<string | null> };

type CacheEventType = "hit" | "wait" | "store" | "invalidate";
type CacheEventCallback = (
  agentId: string,
  type: CacheEventType,
  path: string,
  sourceAgentId: string,
) => void;

type ToolCacheEventCallback = (
  agentId: string,
  toolName: string,
  key: string,
  type: "hit" | "store",
) => void;

interface CacheMetrics {
  fileHits: number;
  fileMisses: number;
  fileWaits: number;
  toolHits: number;
  toolMisses: number;
  toolWaits: number;
  toolEvictions: number;
  toolInvalidations: number;
  providerFailures: number;
}

export interface FileReadRecord {
  agentId: string;
  path: string;
  tool: string;
  target?: string;
  name?: string;
  startLine?: number;
  endLine?: number;
  cached: boolean;
}

const EDIT_LOCK_TIMEOUT_MS = 180_000;
const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_WINDOW_MS = 30_000;
const FILE_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const TOOL_RESULT_CACHE_MAX_SIZE = 200;
const TOOL_RESULT_TTL_MS = 120_000;
const FINDING_MAX_CONTENT_BYTES = 2048;
const FINDING_MAX_TOTAL_BYTES = 128 * 1024;
const AGENT_WAIT_TIMEOUT_MS = 300_000;

export class AgentBus {
  private findings: BusFinding[] = [];
  private findingKeys = new Map<string, number>();
  private results = new Map<string, AgentResult>();
  private completionCallbacks = new Map<string, Array<() => void>>();

  tasks: AgentTask[] = [];
  onCacheEvent: CacheEventCallback | null = null;
  onToolCacheEvent: ToolCacheEventCallback | null = null;
  private fileCache = new Map<string, FileCacheEntry>();
  private _filesRead = new Map<string, Set<string>>();
  private _fileReadRecords: FileReadRecord[] = [];
  private _filesEdited = new Map<string, Set<string>>();
  private fileCacheBytes = 0;
  private readonly fileCacheMaxBytes = FILE_CACHE_MAX_BYTES;
  private toolResultCache = new Map<string, { result: string; ts: number; agentId: string }>();
  private toolResultWaiters = new Map<string, Array<(result: string | null) => void>>();
  private readonly toolResultCacheMaxSize = TOOL_RESULT_CACHE_MAX_SIZE;
  private readonly toolResultTTL = TOOL_RESULT_TTL_MS;
  private _lastSeenFindingIdx = new Map<string, number>();
  private _editLockQueues = new Map<string, Array<() => void>>();
  private _editLockHeld = new Set<string>();
  private _fileOwners = new Map<string, string>();
  private _metrics: CacheMetrics = {
    fileHits: 0,
    fileMisses: 0,
    fileWaits: 0,
    toolHits: 0,
    toolMisses: 0,
    toolWaits: 0,
    toolEvictions: 0,
    toolInvalidations: 0,
    providerFailures: 0,
  };

  private _abortController = new AbortController();

  private _providerFailures: number[] = [];

  constructor(shared?: SharedCache) {
    if (shared) {
      // NOTE: shared.files is intentionally NOT seeded into fileCache.
      // File content must always be read from disk to avoid stale reads.
      // Only tool results and findings are carried across dispatches.
      for (const [key, result] of shared.toolResults) {
        this.toolResultCache.set(key, result);
      }
      for (const finding of shared.findings) {
        this.postFinding(finding);
      }
    }
  }

  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  abort(reason?: string): void {
    this._abortController.abort(reason ?? "dispatch cancelled by peer agent");
    this.drainAllWaiters();
  }

  dispose(): void {
    this.drainAllWaiters();
  }

  private drainAllWaiters(): void {
    for (const [, entry] of this.fileCache) {
      if (entry.state === "reading") {
        notifyWaiters(entry.waiters, null);
        entry.waiters = [];
        entry.state = "failed";
      }
    }
    for (const [key, waiters] of this.toolResultWaiters) {
      notifyWaiters(waiters, null);
      this.toolResultWaiters.delete(key);
    }
    for (const [path, queue] of this._editLockQueues) {
      this._editLockQueues.delete(path);
      this._editLockHeld.delete(path);
      for (const grant of queue) grant();
    }
    for (const [_agentId, cbs] of this.completionCallbacks) {
      this.completionCallbacks.delete(_agentId);
      for (const cb of cbs) cb();
    }
  }

  registerTasks(tasks: AgentTask[]): void {
    this.tasks = tasks;
  }

  getPeerObjectives(excludeAgentId: string): string {
    const peers = this.tasks.filter((t) => t.agentId !== excludeAgentId);
    if (peers.length === 0) return "";
    return peers.map((t) => `[${t.agentId}] (${t.role}): ${t.task}`).join("\n");
  }

  acquireFileRead(agentId: string, path: string): AcquireResult {
    const key = normalizePath(path);
    const entry = this.fileCache.get(key);
    if (entry) {
      if (entry.state === "done") {
        entry.lastAccess = Date.now();
        this._metrics.fileHits++;
        try {
          this.onCacheEvent?.(agentId, "hit", key, entry.agentId);
        } catch {}
        return { cached: true, content: entry.content };
      }
      if (entry.state === "reading") {
        if (entry.agentId === agentId) {
          return { cached: false, gen: -1 };
        }
        this._metrics.fileWaits++;
        try {
          this.onCacheEvent?.(agentId, "wait", key, entry.agentId);
        } catch {}
        const promise = new Promise<string | null>((resolve) => {
          entry.waiters.push(resolve);
          // Timeout: don't let waiters hang forever if the reading agent crashes
          setTimeout(() => resolve(null), 300_000);
        });
        return { cached: "waiting", content: promise };
      }
    }
    this._metrics.fileMisses++;
    const now = Date.now();
    const gen = entry?.gen ?? 0;
    this.fileCache.set(key, {
      agentId,
      state: "reading",
      content: null,
      waiters: [],
      gen,
      lastAccess: now,
    });
    return { cached: false, gen };
  }

  releaseFileRead(path: string, content: string | null, readGen: number): void {
    const key = normalizePath(path);
    const entry = this.fileCache.get(key);
    if (!entry) return;
    if (entry.gen !== readGen) return;
    entry.state = "done";
    entry.lastAccess = Date.now();
    const oldSize = entry.content?.length ?? 0;
    entry.content = content;
    this.fileCacheBytes += (content?.length ?? 0) - oldSize;
    notifyWaiters(entry.waiters, content);
    entry.waiters = [];
    this.evictFileCacheIfNeeded(key);
  }

  failFileRead(path: string, readGen: number): void {
    const key = normalizePath(path);
    const entry = this.fileCache.get(key);
    if (!entry) return;
    if (entry.gen !== readGen) return;
    this.fileCacheBytes -= entry.content?.length ?? 0;
    const { waiters } = entry;
    this.fileCache.delete(key);
    notifyWaiters(waiters, null);
  }

  invalidateFile(path: string, agentId = "_edit"): void {
    const key = normalizePath(path);
    const entry = this.fileCache.get(key);
    if (entry) {
      this.fileCacheBytes -= entry.content?.length ?? 0;
      entry.gen++;
      entry.state = "failed";
      entry.content = null;
      notifyWaiters(entry.waiters, null);
      entry.waiters = [];
    }
    this.fileCache.delete(key);
    const invalidated = this.invalidateToolResultsForFile(key, agentId);
    if (invalidated > 0) {
      try {
        this.onCacheEvent?.(agentId, "invalidate", key, agentId);
      } catch {}
    }
  }

  updateFile(path: string, content: string, agentId = "_edit"): void {
    const key = normalizePath(path);
    const now = Date.now();
    const entry = this.fileCache.get(key);
    if (entry) {
      const oldSize = entry.content?.length ?? 0;
      entry.gen++;
      entry.content = content;
      entry.state = "done";
      entry.agentId = agentId;
      entry.lastAccess = now;
      this.fileCacheBytes += content.length - oldSize;
      for (const waiter of entry.waiters) waiter(content);
      entry.waiters = [];
    } else {
      this.fileCache.set(key, {
        agentId,
        state: "done",
        content,
        waiters: [],
        gen: 1,
        lastAccess: now,
      });
      this.fileCacheBytes += content.length;
    }
    this.evictFileCacheIfNeeded(key);
    const invalidated = this.invalidateToolResultsForFile(key, agentId);
    if (invalidated > 0) {
      this.onCacheEvent?.(agentId, "invalidate", key, agentId);
    }
  }

  private evictFileCacheIfNeeded(protectKey: string): void {
    if (this.fileCacheBytes <= this.fileCacheMaxBytes) return;

    const candidates: [string, FileCacheEntry][] = [];
    for (const [key, entry] of this.fileCache) {
      if (key === protectKey) continue;
      if (entry.state !== "done") continue;
      candidates.push([key, entry]);
    }
    candidates.sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    for (const [key, entry] of candidates) {
      this.fileCacheBytes -= entry.content?.length ?? 0;
      this.fileCache.delete(key);
      if (this.fileCacheBytes <= this.fileCacheMaxBytes * 0.8) break;
    }
  }

  private invalidateToolResult(key: string): void {
    this.toolResultCache.delete(key);
    const waiters = this.toolResultWaiters.get(key);
    if (waiters) {
      this.toolResultWaiters.delete(key);
      for (const w of waiters) w(null);
    }
    this._metrics.toolInvalidations++;
  }

  private keyMatchesFile(parts: string[], filePath: string): boolean {
    const tool = parts[0];
    if (tool === "analyze") {
      return parts[1] === filePath;
    }
    if (tool === "navigate") {
      return parts[2] === filePath || parts[2] === "";
    }
    if (tool === "grep" || tool === "glob") {
      const scopePath = parts[2] ?? "";
      return (
        scopePath === "" ||
        scopePath === "." ||
        filePath.startsWith(`${scopePath}/`) ||
        filePath === scopePath
      );
    }
    return false;
  }

  private invalidateToolResultsForFile(filePath: string, editingAgentId: string): number {
    let count = 0;
    for (const [k, entry] of this.toolResultCache) {
      try {
        const parts = JSON.parse(k) as string[];
        if (!this.keyMatchesFile(parts, filePath)) continue;
        if (
          parts[0] === "read" &&
          entry.agentId === editingAgentId &&
          parts[1] === filePath &&
          parts[3]
        ) {
          continue;
        }
        this.invalidateToolResult(k);
        count++;
      } catch {
        if (k.includes(`"${filePath}"`) || k.includes(`:${filePath}:`)) {
          this.invalidateToolResult(k);
          count++;
        }
      }
    }
    return count;
  }

  recordFileRead(
    agentId: string,
    path: string,
    detail?: {
      tool?: string;
      target?: string;
      name?: string;
      startLine?: number;
      endLine?: number;
      cached?: boolean;
    },
  ): void {
    let set = this._filesRead.get(agentId);
    if (!set) {
      set = new Set();
      this._filesRead.set(agentId, set);
    }
    set.add(path);

    this._fileReadRecords.push({
      agentId,
      path,
      tool: detail?.tool ?? "read",
      target: detail?.target,
      name: detail?.name,
      startLine: detail?.startLine,
      endLine: detail?.endLine,
      cached: detail?.cached ?? false,
    });
  }

  getFilesRead(peerId?: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (peerId) {
      const set = this._filesRead.get(peerId);
      if (set) result.set(peerId, [...set]);
    } else {
      for (const [id, set] of this._filesRead) {
        result.set(id, [...set]);
      }
    }
    return result;
  }

  getFileReadRecords(agentId?: string): FileReadRecord[] {
    if (agentId) return this._fileReadRecords.filter((r) => r.agentId === agentId);
    return [...this._fileReadRecords];
  }

  recordFileEdit(agentId: string, path: string): void {
    let editors = this._filesEdited.get(path);
    if (!editors) {
      editors = new Set();
      this._filesEdited.set(path, editors);
    }
    editors.add(agentId);
  }

  checkEditConflict(agentId: string, path: string): string | null {
    const editors = this._filesEdited.get(path);
    if (!editors) return null;
    for (const editor of editors) {
      if (editor !== agentId) return editor;
    }
    return null;
  }

  acquireEditLock(
    agentId: string,
    path: string,
  ): Promise<{ release: () => void; owner: string | null }> {
    const existingOwner = this._fileOwners.get(path) ?? null;

    const grant = (): { release: () => void; owner: string | null } => {
      this._editLockHeld.add(path);
      if (!this._fileOwners.has(path)) {
        this._fileOwners.set(path, agentId);
      }
      let released = false;
      const timer = setTimeout(() => {
        if (!released) {
          released = true;
          logBackgroundError(
            "edit-lock-timeout",
            `Edit lock for "${path}" held by "${agentId}" force-released after ${String(EDIT_LOCK_TIMEOUT_MS / 1000)}s`,
          );
          this.releaseEditLock(path);
        }
      }, EDIT_LOCK_TIMEOUT_MS);
      return {
        release: () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          this.releaseEditLock(path);
        },
        owner: existingOwner,
      };
    };

    if (!this._editLockHeld.has(path)) {
      return Promise.resolve(grant());
    }

    return new Promise((resolve) => {
      let queue = this._editLockQueues.get(path);
      if (!queue) {
        queue = [];
        this._editLockQueues.set(path, queue);
      }
      queue.push(() => resolve(grant()));
    });
  }

  private releaseEditLock(path: string): void {
    this._editLockHeld.delete(path);
    const queue = this._editLockQueues.get(path);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) this._editLockQueues.delete(path);
      try {
        next?.();
      } catch {
        this._editLockQueues.delete(path);
        this._editLockHeld.delete(path);
      }
    }
  }

  getFileOwner(path: string): string | null {
    return this._fileOwners.get(path) ?? null;
  }

  claimFile(agentId: string, path: string): boolean {
    const normalized = normalizePath(path);
    const owner = this._fileOwners.get(normalized);
    if (owner && owner !== agentId) return false;
    this._fileOwners.set(normalized, agentId);
    return true;
  }

  getEditedFiles(agentId?: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [path, editors] of this._filesEdited) {
      if (agentId) {
        if (editors.has(agentId)) result.set(path, [...editors]);
      } else {
        result.set(path, [...editors]);
      }
    }
    return result;
  }

  acquireToolResult(
    agentId: string,
    key: string,
  ):
    | { hit: true; result: string }
    | { hit: false }
    | { hit: "waiting"; result: Promise<string | null> } {
    const entry = this.toolResultCache.get(key);
    if (entry !== undefined) {
      if (Date.now() - entry.ts > this.toolResultTTL) {
        this.toolResultCache.delete(key);
      } else {
        this._metrics.toolHits++;
        this.toolResultCache.delete(key);
        this.toolResultCache.set(key, entry);
        try {
          this.onToolCacheEvent?.(agentId, this.toolNameFromKey(key), key, "hit");
        } catch {}
        return { hit: true, result: entry.result };
      }
    }
    const waiters = this.toolResultWaiters.get(key);
    if (waiters) {
      this._metrics.toolWaits++;
      const promise = new Promise<string | null>((resolve) => {
        waiters.push((r) => resolve(r));
        setTimeout(() => resolve(null), 300_000);
      });
      return { hit: "waiting", result: promise };
    }
    this.toolResultWaiters.set(key, []);
    this._metrics.toolMisses++;
    return { hit: false };
  }

  cacheToolResult(agentId: string, key: string, result: string): void {
    const waiters = this.toolResultWaiters.get(key);
    this.toolResultWaiters.delete(key);
    if (waiters) {
      notifyWaiters(waiters, result);
    }
    this.toolResultCache.delete(key);
    if (this.toolResultCache.size >= this.toolResultCacheMaxSize) {
      this._metrics.toolEvictions++;
      const firstKey = this.toolResultCache.keys().next().value;
      if (firstKey) this.toolResultCache.delete(firstKey);
    }
    this.toolResultCache.set(key, { result, ts: Date.now(), agentId });
    try {
      this.onToolCacheEvent?.(agentId, this.toolNameFromKey(key), key, "store");
    } catch {}
  }

  private toolNameFromKey(key: string): string {
    try {
      const parts = JSON.parse(key) as string[];
      return parts[0] ?? key;
    } catch {
      const colonIdx = key.indexOf(":");
      return colonIdx >= 0 ? key.slice(0, colonIdx) : key;
    }
  }

  private findingBytes = 0;
  private readonly findingMaxContentBytes = FINDING_MAX_CONTENT_BYTES;
  private readonly findingMaxTotalBytes = FINDING_MAX_TOTAL_BYTES;

  postFinding(finding: BusFinding): void {
    if (this.findings.length >= 30 && !this.findingKeys.has(`${finding.agentId}:${finding.label}`))
      return;
    if (this.findingBytes >= this.findingMaxTotalBytes) return;
    const key = `${finding.agentId}:${finding.label}`;
    const content =
      finding.content.length > this.findingMaxContentBytes
        ? `${finding.content.slice(0, this.findingMaxContentBytes)}…`
        : finding.content;
    const capped = { ...finding, content };

    const existingIdx = this.findingKeys.get(key);
    if (existingIdx !== undefined) {
      const old = this.findings[existingIdx];
      if (old) {
        this.findingBytes -= old.content.length;
        this.findings[existingIdx] = capped;
        this.findingBytes += content.length;
      }
      return;
    }

    this.findingKeys.set(key, this.findings.length);
    this.findingBytes += content.length;
    this.findings.push(capped);
  }

  getFindings(excludeAgentId?: string): BusFinding[] {
    if (!excludeAgentId) return [...this.findings];
    return this.findings.filter((f) => f.agentId !== excludeAgentId);
  }

  getPeerFindings(peerId: string): BusFinding[] {
    return this.findings.filter((f) => f.agentId === peerId);
  }

  setResult(result: AgentResult): void {
    this.results.set(result.agentId, result);
    const cbs = this.completionCallbacks.get(result.agentId);
    if (cbs) {
      for (const cb of cbs) cb();
      this.completionCallbacks.delete(result.agentId);
    }
  }

  getResult(agentId: string): AgentResult | undefined {
    return this.results.get(agentId);
  }

  getAllResults(): AgentResult[] {
    return [...this.results.values()];
  }

  waitForAgent(agentId: string, timeoutMs = AGENT_WAIT_TIMEOUT_MS): Promise<AgentResult> {
    const existing = this.results.get(agentId);
    if (existing) {
      if (!existing.success) {
        return Promise.reject(new DependencyFailedError(agentId, existing));
      }
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`Timed out waiting for agent "${agentId}" (${String(timeoutMs / 1000)}s)`),
        );
      }, timeoutMs);
      const cbs = this.completionCallbacks.get(agentId) ?? [];
      cbs.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = this.results.get(agentId);
        if (result) {
          if (!result.success) {
            reject(new DependencyFailedError(agentId, result));
          } else {
            resolve(result);
          }
        } else {
          reject(new Error(`Agent bus disposed while waiting for "${agentId}"`));
        }
      });
      this.completionCallbacks.set(agentId, cbs);
    });
  }

  recordProviderFailure(): boolean {
    const now = Date.now();
    this._providerFailures.push(now);
    this._metrics.providerFailures++;

    const cutoff = now - CIRCUIT_BREAKER_WINDOW_MS;
    this._providerFailures = this._providerFailures.filter((t) => t > cutoff);

    if (this._providerFailures.length >= CIRCUIT_BREAKER_THRESHOLD) {
      this.abort("circuit breaker tripped — multiple provider failures within window");
      return true;
    }
    return false;
  }

  summarizeFindings(excludeAgentId?: string): string {
    const findings = this.getFindings(excludeAgentId);
    if (findings.length === 0) return "No findings from peer agents yet.";
    return findings.map((f) => `[${f.agentId}] ${f.label}:\n${f.content}`).join("\n\n---\n\n");
  }

  drainUnseenFindings(agentId: string): string | null {
    const lastSeen = this._lastSeenFindingIdx.get(agentId) ?? 0;
    this._lastSeenFindingIdx.set(agentId, this.findings.length);
    if (lastSeen >= this.findings.length) return null;
    const parts: string[] = [];
    for (let i = lastSeen; i < this.findings.length; i++) {
      const f = this.findings[i];
      if (f && f.agentId !== agentId) {
        parts.push(`[${f.agentId}] ${f.label}: ${f.content}`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }

  get completedAgentIds(): string[] {
    return [...this.results.keys()];
  }

  get findingCount(): number {
    return this.findings.length;
  }

  getFileContent(path: string): string | null {
    const entry = this.fileCache.get(normalizePath(path));
    if (entry?.state === "done") return entry.content;
    return null;
  }

  getToolResultSummary(): string[] {
    const summaries: string[] = [];
    for (const [key] of this.toolResultCache) {
      try {
        const parts = JSON.parse(key) as string[];
        const [tool, ...rest] = parts;
        switch (tool) {
          case "read":
            summaries.push(`read ${rest.join(" ")}`);
            break;
          case "navigate":
            summaries.push(`navigate ${rest.join(" ")}`);
            break;
          case "analyze":
            summaries.push(`analyze ${rest.join(" ")}`);
            break;
          case "grep":
            summaries.push(`grep ${rest[0] ?? ""}`);
            break;
          case "glob":
            summaries.push(`glob ${rest[0] ?? ""}`);
            break;
          case "web_search":
            summaries.push(`web_search "${rest[0] ?? ""}"`);
            break;
          case "fetch_page":
            summaries.push(`fetch_page ${rest[0] ?? ""}`);
            break;
        }
      } catch {
        summaries.push(key);
      }
    }
    return summaries;
  }

  get metrics(): Readonly<CacheMetrics> {
    return this._metrics;
  }

  exportCaches(): SharedCache {
    // NOTE: file content is intentionally NOT exported.
    // File content must always be read from disk to avoid stale reads
    // across dispatches. Only tool results and findings are shared.
    const now = Date.now();
    const toolResults = new Map<string, { result: string; ts: number; agentId: string }>();
    for (const [key, entry] of this.toolResultCache) {
      if (now - entry.ts <= this.toolResultTTL) {
        toolResults.set(key, entry);
      }
    }
    return {
      files: new Map(),
      toolResults,
      findings: [...this.findings],
    };
  }
}
