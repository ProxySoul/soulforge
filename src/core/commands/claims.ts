import { relative } from "node:path";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function displayPath(absPath: string): string {
  const cwd = process.cwd();
  return absPath.startsWith(cwd) ? relative(cwd, absPath) : absPath;
}

function handleClaims(_input: string, ctx: CommandContext): void {
  const coordinator = getWorkspaceCoordinator();
  const allClaims = coordinator.getAllClaims();

  if (allClaims.size === 0) {
    sysMsg(ctx, "No active file claims across tabs.");
    return;
  }

  // Group by tab
  const byTab = new Map<string, Array<{ path: string; editCount: number; lastEditAt: number }>>();
  for (const [path, claim] of allClaims) {
    const key = `${claim.tabLabel} (${claim.tabId.slice(0, 8)})`;
    const list = byTab.get(key) ?? [];
    list.push({ path, editCount: claim.editCount, lastEditAt: claim.lastEditAt });
    byTab.set(key, list);
  }

  const lines: string[] = ["📋 Active file claims:"];
  for (const [tabKey, files] of byTab) {
    lines.push(`\n  Tab "${tabKey}"`);
    for (const f of files) {
      const ago = formatTimeAgo(f.lastEditAt);
      lines.push(`    🔒 ${displayPath(f.path)} (${String(f.editCount)} edits, last ${ago})`);
    }
  }
  lines.push(`\nTotal: ${String(allClaims.size)} file(s) claimed.`);

  sysMsg(ctx, lines.join("\n"));
}

function handleUnclaim(input: string, ctx: CommandContext): void {
  const parts = input.trim().split(/\s+/);
  const path = parts[1];
  if (!path) {
    sysMsg(ctx, "Usage: /unclaim <file-path>");
    return;
  }

  const tabId = ctx.tabMgr.activeTabId;
  const coordinator = getWorkspaceCoordinator();
  const claims = coordinator.getClaimsForTab(tabId);

  // Find the claim by matching the end of the path
  let matchedPath: string | null = null;
  for (const [claimPath] of claims) {
    if (claimPath.endsWith(path) || displayPath(claimPath) === path) {
      matchedPath = claimPath;
      break;
    }
  }

  if (!matchedPath) {
    sysMsg(ctx, `No claim found for "${path}" in current tab.`);
    return;
  }

  coordinator.releaseFiles(tabId, [matchedPath]);
  sysMsg(ctx, `Released claim on ${displayPath(matchedPath)}.`);
}

function handleUnclaimAll(_input: string, ctx: CommandContext): void {
  const tabId = ctx.tabMgr.activeTabId;
  const coordinator = getWorkspaceCoordinator();
  const claims = coordinator.getClaimsForTab(tabId);
  const count = claims.size;

  if (count === 0) {
    sysMsg(ctx, "No active claims in current tab.");
    return;
  }

  coordinator.releaseAll(tabId);
  sysMsg(ctx, `Released ${String(count)} file claim(s) from current tab.`);
}

function handleForceClaim(input: string, ctx: CommandContext): void {
  const parts = input.trim().split(/\s+/);
  const path = parts.slice(1).join(" ");
  if (!path) {
    sysMsg(ctx, "Usage: /force-claim <file-path>");
    return;
  }

  const tabId = ctx.tabMgr.activeTabId;
  const tabLabel = ctx.tabMgr.activeTab.label;
  const coordinator = getWorkspaceCoordinator();

  const previousOwner = coordinator.forceClaim(tabId, tabLabel, path);
  if (previousOwner && previousOwner.tabId !== tabId) {
    sysMsg(ctx, `Force-claimed ${displayPath(path)} from Tab "${previousOwner.tabLabel}".`);
  } else {
    sysMsg(ctx, `Claimed ${displayPath(path)}.`);
  }
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ago`;
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("claims", handleClaims);
  map.set("unclaim-all", handleUnclaimAll);
  map.set("force-claim", handleForceClaim);
}

export function matchClaimsPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("unclaim ") || cmd === "unclaim") return handleUnclaim;
  if (cmd.startsWith("force-claim ") || cmd === "force-claim") return handleForceClaim;
  return null;
}
