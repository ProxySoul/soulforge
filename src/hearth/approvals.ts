/**
 * Approval registry — tracks pending permission requests keyed by approvalId
 * so a surface (or CLI) can resolve the decision asynchronously.
 */

import { randomUUID } from "node:crypto";
import type { PendingApproval, PermissionResponse } from "./types.js";
import { HEARTH_PROTOCOL_VERSION } from "./types.js";

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private defaultTimeoutMs: number) {
    this.sweepTimer = setInterval(() => this.sweepExpired(), 30_000);
  }

  register(
    opts: Omit<PendingApproval, "id" | "createdAt" | "expiresAt" | "resolve">,
    resolve: (res: PermissionResponse) => void,
    timeoutMs?: number,
  ): PendingApproval {
    const id = randomUUID();
    const now = Date.now();
    const ttl = timeoutMs ?? this.defaultTimeoutMs;
    let settled = false;
    const once = (res: PermissionResponse): void => {
      if (settled) return;
      settled = true;
      try {
        resolve(res);
      } catch {}
    };
    const entry: PendingApproval = {
      ...opts,
      id,
      createdAt: now,
      expiresAt: now + ttl,
      resolve: once,
    };
    this.pending.set(id, entry);
    return entry;
  }

  /** Resolve a pending approval. Returns true if one was waiting. */
  resolve(id: string, response: PermissionResponse): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    try {
      entry.resolve(response);
    } catch {
      // never propagate resolve errors
    }
    return true;
  }

  /** Reject all pending approvals for a sessionId — used when a tab is closed. */
  cancelForSession(sessionId: string, reason = "session ended"): number {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(id);
      try {
        entry.resolve({ v: HEARTH_PROTOCOL_VERSION, decision: "deny", reason });
      } catch {}
      n++;
    }
    return n;
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id);
  }

  list(): PendingApproval[] {
    return [...this.pending.values()];
  }

  count(): number {
    return this.pending.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt > now) continue;
      this.pending.delete(id);
      try {
        entry.resolve({
          v: HEARTH_PROTOCOL_VERSION,
          decision: "deny",
          reason: "approval timed out",
        });
      } catch {}
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const entry of this.pending.values()) {
      try {
        entry.resolve({
          v: HEARTH_PROTOCOL_VERSION,
          decision: "deny",
          reason: "daemon shutting down",
        });
      } catch {}
    }
    this.pending.clear();
  }
}
