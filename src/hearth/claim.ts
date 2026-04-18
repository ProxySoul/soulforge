/**
 * Auto-claim daemon-side Hearth workspaces into the TUI.
 *
 * Called once on TUI boot: asks the daemon (via hearth.sock) which chats it's
 * currently driving in this cwd, atomically pulls each one (daemon drops its
 * TabLoop + ChatWorkspace after flushing session metadata), then loads the
 * flushed session off disk and returns it ready for `tabMgr.restoreFromMeta`.
 *
 * The caller (App.tsx) performs the actual tab restoration so the rehydrated
 * TabInstance carries the full message history, checkpoints, and plan state
 * — not just the bridge binding.
 *
 * Bridge bindings are set AFTER restoration so the binding tabId points at a
 * real live tab; until then inbound chat messages queue by label.
 */

import { existsSync } from "node:fs";
import type { ModelMessage } from "ai";
import { SessionManager } from "../core/sessions/manager.js";
import type { SessionMeta } from "../core/sessions/types.js";
import type { ChatMessage } from "../types/index.js";
import { hearthBridge } from "./bridge.js";
import { loadHearthConfig } from "./config.js";
import { socketRequest } from "./protocol.js";
import {
  type ClaimWorkspaceRequest,
  type ClaimWorkspaceResponse,
  HEARTH_PROTOCOL_VERSION,
  type ListWorkspacesRequest,
  type ListWorkspacesResponse,
  type SurfaceId,
} from "./types.js";

export interface ClaimedSession {
  surfaceId: SurfaceId;
  externalId: string;
  sessionId: string;
  meta: SessionMeta;
  tabMessages: Map<string, ChatMessage[]>;
  tabCoreMessages?: Map<string, ModelMessage[]>;
}

export interface AutoClaimResult {
  sessions: ClaimedSession[];
  errors: string[];
}

/** Returns immediately when the daemon isn't running. */
export async function autoClaimDaemonWorkspaces(cwd: string): Promise<AutoClaimResult> {
  const config = loadHearthConfig(cwd);
  const socketPath = config.daemon.socketPath;
  const out: AutoClaimResult = { sessions: [], errors: [] };

  if (!existsSync(socketPath)) return out;

  let list: ListWorkspacesResponse;
  try {
    list = await socketRequest<ListWorkspacesRequest, ListWorkspacesResponse>(
      { op: "list-workspaces", v: HEARTH_PROTOCOL_VERSION, cwd },
      { path: socketPath, timeoutMs: 1500 },
    );
  } catch {
    return out;
  }

  if (!list.ok) return out;

  const sessionManager = new SessionManager(cwd);

  for (const ws of list.workspaces) {
    try {
      const claim = await socketRequest<ClaimWorkspaceRequest, ClaimWorkspaceResponse>(
        {
          op: "claim-workspace",
          v: HEARTH_PROTOCOL_VERSION,
          surfaceId: ws.surfaceId,
          externalId: ws.externalId,
        },
        { path: socketPath, timeoutMs: 3000 },
      );
      if (!claim.ok || !claim.snapshot) {
        out.errors.push(`${ws.surfaceId}/${ws.externalId}: ${claim.error ?? "unknown"}`);
        continue;
      }
      const loaded = sessionManager.loadSession(claim.snapshot.sessionId);
      if (!loaded) {
        out.errors.push(`${ws.surfaceId}/${ws.externalId}: session file missing`);
        continue;
      }
      out.sessions.push({
        surfaceId: ws.surfaceId,
        externalId: ws.externalId,
        sessionId: claim.snapshot.sessionId,
        meta: loaded.meta,
        tabMessages: loaded.tabMessages,
        tabCoreMessages: loaded.tabCoreMessages,
      });
    } catch (err) {
      out.errors.push(
        `${ws.surfaceId}/${ws.externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return out;
}

/**
 * Pre-seed bridge bindings for claimed sessions after tabs have been
 * restored by `tabMgr.restoreFromMeta`. The meta's activeTabId (or first
 * tab) is used as the binding target.
 */
export function bindClaimedSessions(claimed: ClaimedSession[]): void {
  for (const c of claimed) {
    const targetTab =
      c.meta.tabs.find((t) => t.id === c.meta.activeTabId) ?? c.meta.tabs[0] ?? null;
    if (!targetTab) continue;
    hearthBridge.setBinding({
      surfaceId: c.surfaceId,
      externalId: c.externalId,
      tabId: targetTab.id,
      tabLabel: targetTab.label,
    });
  }
}
