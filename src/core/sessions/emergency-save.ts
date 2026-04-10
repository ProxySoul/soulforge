/**
 * Emergency session persistence — synchronous crash-safe save.
 *
 * Normal saves go through the IO worker (async, unref'd — dies on crash).
 * This module keeps the last known good snapshot in memory and flushes it
 * synchronously when the process receives a fatal signal or uncaught exception.
 *
 * Usage:
 *   - Call `updateEmergencySnapshot` after every saveSession() call so the
 *     in-memory snapshot stays current.
 *   - Signal handlers call `flushEmergencySession` before process.exit().
 */

import type { ModelMessage } from "ai";
import type { ChatMessage } from "../../types/index.js";
import type { SessionManager } from "./manager.js";
import type { SessionMeta } from "./types.js";

interface EmergencySnapshot {
  manager: SessionManager;
  meta: SessionMeta;
  tabMessages: Map<string, ChatMessage[]>;
  tabCoreMessages?: Map<string, ModelMessage[]>;
}

let _snapshot: EmergencySnapshot | null = null;

/** Keep the in-memory snapshot current. Call after every saveSession(). */
export function updateEmergencySnapshot(
  manager: SessionManager,
  meta: SessionMeta,
  tabMessages: Map<string, ChatMessage[]>,
  tabCoreMessages?: Map<string, ModelMessage[]>,
): void {
  // Deep-copy messages so mutations during streaming don't corrupt the snapshot
  const frozen = new Map<string, ChatMessage[]>();
  for (const [id, msgs] of tabMessages) {
    frozen.set(
      id,
      msgs.map((m) => ({ ...m })),
    );
  }
  _snapshot = { manager, meta: { ...meta }, tabMessages: frozen, tabCoreMessages };
}

/**
 * Synchronously flush the last known snapshot to disk.
 * Safe to call from signal handlers — uses only sync fs APIs, no IO worker.
 * Returns true if a save was attempted.
 */
export function flushEmergencySession(): boolean {
  if (!_snapshot) return false;
  try {
    _snapshot.manager.saveSessionSync(
      _snapshot.meta,
      _snapshot.tabMessages,
      _snapshot.tabCoreMessages,
    );
    return true;
  } catch {
    // Best-effort — never throw from a signal handler
    return false;
  }
}
