import { resolve } from "node:path";
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

function normalizePath(p: string): string {
  // Resolve to absolute, then make consistent
  return resolve(p);
}

export class WorkspaceCoordinator {
  private claims = new Map<string, FileClaim>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>(); // tabId → idle timer
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<CoordinatorListener>();

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  // ── Claim Lifecycle ──────────────────────────────────────────────────

  /**
   * Claim files for a tab. First-come-first-served — contested files
   * are reported but not blocked.
   */
  claimFiles(tabId: string, tabLabel: string, paths: string[]): ClaimResult {
    const granted: string[] = [];
    const contested: ClaimResult["contested"] = [];
    const now = Date.now();

    for (const raw of paths) {
      const p = normalizePath(raw);
      const existing = this.claims.get(p);

      if (existing && existing.tabId !== tabId) {
        // Contested — another tab owns it
        contested.push({ path: p, owner: { ...existing } });
        // Still update: both tabs now have a relationship with this file
        // but we don't transfer ownership
        continue;
      }

      if (existing && existing.tabId === tabId) {
        // Already owned — refresh
        existing.lastEditAt = now;
        existing.editCount++;
        granted.push(p);
        continue;
      }

      // New claim
      this.claims.set(p, {
        tabId,
        tabLabel,
        claimedAt: now,
        lastEditAt: now,
        editCount: 1,
      });
      granted.push(p);
    }

    if (granted.length > 0) {
      this.emit("claim", tabId, granted);
    }
    if (contested.length > 0) {
      this.emit(
        "conflict",
        tabId,
        contested.map((c) => c.path),
      );
    }

    // Reset idle timer for this tab
    this.resetIdleTimer(tabId);

    return { granted, contested };
  }

  /** Release specific files for a tab */
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
    if (released.length > 0) {
      this.emit("release", tabId, released);
    }
  }

  /** Release all claims for a tab (tab close, session end) */
  releaseAll(tabId: string): void {
    const released: string[] = [];
    for (const [path, claim] of this.claims) {
      if (claim.tabId === tabId) {
        released.push(path);
      }
    }
    for (const p of released) {
      this.claims.delete(p);
    }
    this.clearIdleTimer(tabId);
    if (released.length > 0) {
      this.emit("release", tabId, released);
    }
  }

  /** Force-claim a file from another tab (user override) */
  forceClaim(tabId: string, tabLabel: string, path: string): FileClaim | null {
    const p = normalizePath(path);
    const existing = this.claims.get(p);
    const previousOwner = existing ? { ...existing } : null;

    const now = Date.now();
    this.claims.set(p, {
      tabId,
      tabLabel,
      claimedAt: now,
      lastEditAt: now,
      editCount: 1,
    });
    this.emit("claim", tabId, [p]);

    return previousOwner;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  /** Get conflicts for a set of files from a tab's perspective */
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

  /** Get all claims for a specific tab */
  getClaimsForTab(tabId: string): Map<string, FileClaim> {
    const result = new Map<string, FileClaim>();
    for (const [path, claim] of this.claims) {
      if (claim.tabId === tabId) {
        result.set(path, { ...claim });
      }
    }
    return result;
  }

  /** Get all active editors grouped by tabId */
  getActiveEditors(): Map<string, FileClaim[]> {
    const result = new Map<string, FileClaim[]>();
    for (const [, claim] of this.claims) {
      const list = result.get(claim.tabId) ?? [];
      list.push({ ...claim });
      result.set(claim.tabId, list);
    }
    return result;
  }

  /** Get total claim count for a tab */
  getClaimCount(tabId: string): number {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.tabId === tabId) count++;
    }
    return count;
  }

  /** Get all claims (for /claims command display) */
  getAllClaims(): Map<string, FileClaim> {
    return new Map(this.claims);
  }

  // ── Idle & Auto-Release ───────────────────────────────────────────────

  /** Signal that a tab has become idle (prompt finished, no pending dispatch) */
  markIdle(tabId: string): void {
    this.startIdleTimer(tabId);
  }

  /** Signal that a tab is active (new prompt, dispatch started) */
  markActive(tabId: string): void {
    this.clearIdleTimer(tabId);
  }

  private startIdleTimer(tabId: string): void {
    this.clearIdleTimer(tabId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(tabId);
      this.releaseAll(tabId);
    }, IDLE_RELEASE_MS);
    this.idleTimers.set(tabId, timer);
  }

  private resetIdleTimer(tabId: string): void {
    // If there's an existing idle timer, it means the tab was idle.
    // Claiming files means it's active again — clear the timer.
    if (this.idleTimers.has(tabId)) {
      this.clearIdleTimer(tabId);
    }
  }

  private clearIdleTimer(tabId: string): void {
    const timer = this.idleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(tabId);
    }
  }

  /** Sweep claims that have exceeded the stale timeout */
  private sweepStale(): void {
    const now = Date.now();
    const stale: Array<{ path: string; tabId: string }> = [];

    for (const [path, claim] of this.claims) {
      if (now - claim.lastEditAt > STALE_RELEASE_MS) {
        stale.push({ path, tabId: claim.tabId });
      }
    }

    // Group by tabId for event emission
    const byTab = new Map<string, string[]>();
    for (const { path, tabId } of stale) {
      this.claims.delete(path);
      const list = byTab.get(tabId) ?? [];
      list.push(path);
      byTab.set(tabId, list);
    }

    for (const [tabId, paths] of byTab) {
      this.emit("release", tabId, paths);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  on(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: CoordinatorEvent, tabId: string, paths: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(event, tabId, paths);
      } catch {
        // listener errors should not break the coordinator
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /** Release all claims globally (session end) */
  releaseAllGlobal(): void {
    const tabIds = new Set<string>();
    for (const claim of this.claims.values()) {
      tabIds.add(claim.tabId);
    }
    this.claims.clear();
    for (const tabId of tabIds) {
      this.clearIdleTimer(tabId);
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    this.claims.clear();
    this.listeners.clear();
  }
}

/** Module-level singleton */
let _instance: WorkspaceCoordinator | null = null;

export function getWorkspaceCoordinator(): WorkspaceCoordinator {
  if (!_instance) {
    _instance = new WorkspaceCoordinator();
  }
  return _instance;
}

/** For testing — reset the singleton */
export function resetWorkspaceCoordinator(): void {
  _instance?.dispose();
  _instance = null;
}
