import { resolve, sep } from "node:path";
import type {
  ClaimResult,
  ConflictInfo,
  CoordinatorEvent,
  CoordinatorListener,
  FileClaim,
} from "./types.js";

/** Advisory idle timeout — claims released after tab finishes a prompt and goes idle */
const IDLE_RELEASE_MS = 60_000;
/** Hard stale timeout — claims released regardless of state */
const STALE_RELEASE_MS = 5 * 60_000;
/** How often to sweep for stale claims */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Normalize path for cross-OS consistency.
 * - Resolves to absolute
 * - Normalizes separators to forward slashes (Windows compat)
 * - Lowercases on case-insensitive filesystems (Windows/macOS)
 */
const IS_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normalizePath(p: string): string {
  let abs = resolve(p);
  if (sep === "\\") abs = abs.replace(/\\/g, "/");
  if (IS_CASE_INSENSITIVE) abs = abs.toLowerCase();
  return abs;
}

export class WorkspaceCoordinator {
  private claims = new Map<string, FileClaim>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<CoordinatorListener>();
  /** Track active agent count per tab — don't idle-release while agents are running */
  private activeAgents = new Map<string, number>();
  /** Debounce event emission — batch rapid claim/release into one event per tick */
  private pendingEvents = new Map<string, { type: CoordinatorEvent; paths: Set<string> }>();
  private flushScheduled = false;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  claimFiles(tabId: string, tabLabel: string, paths: string[]): ClaimResult {
    const granted: string[] = [];
    const contested: ClaimResult["contested"] = [];
    const now = Date.now();

    for (const raw of paths) {
      const p = normalizePath(raw);
      const existing = this.claims.get(p);

      if (existing && existing.tabId !== tabId) {
        contested.push({ path: p, owner: { ...existing } });
        continue;
      }

      if (existing && existing.tabId === tabId) {
        existing.lastEditAt = now;
        existing.editCount++;
        granted.push(p);
        continue;
      }

      this.claims.set(p, {
        tabId,
        tabLabel,
        claimedAt: now,
        lastEditAt: now,
        editCount: 1,
      });
      granted.push(p);
    }

    if (granted.length > 0) this.scheduleEvent(tabId, "claim", granted);
    if (contested.length > 0)
      this.scheduleEvent(
        tabId,
        "conflict",
        contested.map((c) => c.path),
      );

    this.resetIdleTimer(tabId);
    return { granted, contested };
  }

  releaseFiles(tabId: string, paths: string[]): void {
    const released: string[] = [];
    for (const raw of paths) {
      const p = normalizePath(raw);
      const claim = this.claims.get(p);
      if (claim && claim.tabId === tabId) {
        this.claims.delete(p);
        released.push(p);
      }
    }
    if (released.length > 0) this.scheduleEvent(tabId, "release", released);
  }

  releaseAll(tabId: string): void {
    const released: string[] = [];
    for (const [path, claim] of this.claims) {
      if (claim.tabId === tabId) released.push(path);
    }
    for (const p of released) this.claims.delete(p);
    this.clearIdleTimer(tabId);
    if (released.length > 0) this.scheduleEvent(tabId, "release", released);
  }

  forceClaim(tabId: string, tabLabel: string, path: string): FileClaim | null {
    const p = normalizePath(path);
    const existing = this.claims.get(p);
    const previousOwner = existing ? { ...existing } : null;

    const now = Date.now();
    this.claims.set(p, { tabId, tabLabel, claimedAt: now, lastEditAt: now, editCount: 1 });
    this.scheduleEvent(tabId, "claim", [p]);
    return previousOwner;
  }

  getConflicts(tabId: string, paths: string[]): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];
    for (const raw of paths) {
      const p = normalizePath(raw);
      const claim = this.claims.get(p);
      if (claim && claim.tabId !== tabId) {
        conflicts.push({
          path: p,
          ownerTabId: claim.tabId,
          ownerTabLabel: claim.tabLabel,
          ownedSince: claim.claimedAt,
          editCount: claim.editCount,
          lastEditAt: claim.lastEditAt,
        });
      }
    }
    return conflicts;
  }

  getClaimsForTab(tabId: string): Map<string, FileClaim> {
    const result = new Map<string, FileClaim>();
    for (const [path, claim] of this.claims) {
      if (claim.tabId === tabId) result.set(path, { ...claim });
    }
    return result;
  }

  getActiveEditors(): Map<string, FileClaim[]> {
    const result = new Map<string, FileClaim[]>();
    for (const [, claim] of this.claims) {
      const list = result.get(claim.tabId) ?? [];
      list.push({ ...claim });
      result.set(claim.tabId, list);
    }
    return result;
  }

  getClaimCount(tabId: string): number {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.tabId === tabId) count++;
    }
    return count;
  }

  getAllClaims(): Map<string, FileClaim> {
    return new Map(this.claims);
  }

  /**
   * Signal that a tab has become idle (prompt finished).
   * Only starts idle timer if no agents are running for this tab.
   */
  markIdle(tabId: string): void {
    const active = this.activeAgents.get(tabId) ?? 0;
    if (active > 0) return;
    this.startIdleTimer(tabId);
  }

  /** Signal that a tab is active (new prompt, dispatch started) */
  markActive(tabId: string): void {
    this.clearIdleTimer(tabId);
  }

  /** Increment active agent count — prevents idle release while agents run */
  agentStarted(tabId: string): void {
    this.activeAgents.set(tabId, (this.activeAgents.get(tabId) ?? 0) + 1);
    this.clearIdleTimer(tabId);
  }

  /** Decrement active agent count — triggers idle when all agents done */
  agentFinished(tabId: string): void {
    const count = (this.activeAgents.get(tabId) ?? 1) - 1;
    if (count <= 0) {
      this.activeAgents.delete(tabId);
    } else {
      this.activeAgents.set(tabId, count);
    }
  }

  private startIdleTimer(tabId: string): void {
    this.clearIdleTimer(tabId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(tabId);
      // Double-check no agents started during the timeout
      if ((this.activeAgents.get(tabId) ?? 0) > 0) return;
      this.releaseAll(tabId);
    }, IDLE_RELEASE_MS);
    this.idleTimers.set(tabId, timer);
  }

  private resetIdleTimer(tabId: string): void {
    if (this.idleTimers.has(tabId)) this.clearIdleTimer(tabId);
  }

  private clearIdleTimer(tabId: string): void {
    const timer = this.idleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(tabId);
    }
  }

  private sweepStale(): void {
    const now = Date.now();
    const stale: Array<{ path: string; tabId: string }> = [];

    for (const [path, claim] of this.claims) {
      if (now - claim.lastEditAt > STALE_RELEASE_MS) {
        stale.push({ path, tabId: claim.tabId });
      }
    }

    const byTab = new Map<string, string[]>();
    for (const { path, tabId } of stale) {
      this.claims.delete(path);
      const list = byTab.get(tabId) ?? [];
      list.push(path);
      byTab.set(tabId, list);
    }

    for (const [tabId, paths] of byTab) {
      this.scheduleEvent(tabId, "release", paths);
    }
  }

  // ── Batched Events ──────────────────────────────────────────────────

  private scheduleEvent(tabId: string, type: CoordinatorEvent, paths: string[]): void {
    const key = `${tabId}:${type}`;
    let pending = this.pendingEvents.get(key);
    if (!pending) {
      pending = { type, paths: new Set() };
      this.pendingEvents.set(key, pending);
    }
    for (const p of paths) pending.paths.add(p);

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushEvents());
    }
  }

  private flushEvents(): void {
    this.flushScheduled = false;
    for (const [key, { type, paths }] of this.pendingEvents) {
      const tabId = key.slice(0, key.lastIndexOf(":"));
      for (const listener of this.listeners) {
        try {
          listener(type, tabId, [...paths]);
        } catch {}
      }
    }
    this.pendingEvents.clear();
  }

  on(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  releaseAllGlobal(): void {
    const tabIds = new Set<string>();
    for (const claim of this.claims.values()) tabIds.add(claim.tabId);
    this.claims.clear();
    for (const tabId of tabIds) this.clearIdleTimer(tabId);
    this.activeAgents.clear();
  }

  dispose(): void {
    this.flushEvents();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.claims.clear();
    this.listeners.clear();
    this.activeAgents.clear();
    this.pendingEvents.clear();
  }
}

let _instance: WorkspaceCoordinator | null = null;

export function getWorkspaceCoordinator(): WorkspaceCoordinator {
  if (!_instance) _instance = new WorkspaceCoordinator();
  return _instance;
}

export function resetWorkspaceCoordinator(): void {
  _instance?.dispose();
  _instance = null;
}
