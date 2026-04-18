import { stat as statAsync, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { markToolWrite, readBufferContent, reloadBuffer } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { emitFileEdited } from "./file-events.js";

interface EditEntry {
  /** File content BEFORE this edit was applied */
  content: string;
  /** Hash of file content AFTER this edit was applied — used to detect stale undos */
  afterHash: number;
  timestamp: number;
  tabId?: string;
}

/** Fast content hash using Bun's native hasher (FNV-like, non-crypto) */
function contentHash(s: string): number {
  // Bun.hash returns a bigint; coerce to number (safe for equality checks)
  return Number(Bun.hash(s));
}

const MAX_STACK_SIZE = 20;
/** Cap total unique files tracked to prevent unbounded Map growth in long sessions */
const MAX_FILES_TRACKED = 200;
const stacks = new Map<string, EditEntry[]>();

/** Remove the oldest file entry (by most recent edit timestamp) when map exceeds cap */
function evictOldest(): void {
  if (stacks.size <= MAX_FILES_TRACKED) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, stack] of stacks) {
    const last = stack[stack.length - 1];
    if (last && last.timestamp < oldestTime) {
      oldestTime = last.timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey) stacks.delete(oldestKey);
}

/** Clear all undo history for a specific tab, or all tabs if no tabId given */
export function clearEditStacks(tabId?: string): void {
  if (!tabId) {
    stacks.clear();
    return;
  }
  for (const [key, stack] of stacks) {
    const filtered = stack.filter((e) => !e.tabId || e.tabId !== tabId);
    if (filtered.length === 0) {
      stacks.delete(key);
    } else {
      stacks.set(key, filtered);
    }
  }
}

/**
 * Push an undo entry. Call BEFORE writing the new content to disk.
 * @param absPath - absolute file path
 * @param previousContent - file content before the edit
 * @param newContent - file content after the edit (used for stale detection)
 * @param tabId - owning tab (for cross-tab isolation)
 */
export function pushEdit(
  absPath: string,
  previousContent: string,
  newContent: string,
  tabId?: string,
): void {
  const key = absPath;
  let stack = stacks.get(key);
  if (!stack) {
    stack = [];
    stacks.set(key, stack);
  }
  stack.push({
    content: previousContent,
    afterHash: contentHash(newContent),
    timestamp: Date.now(),
    tabId,
  });
  if (stack.length > MAX_STACK_SIZE) {
    stack.shift();
  }
  evictOldest();
}

/**
 * Update the afterHash of the most recent edit entry for a file.
 * Call after auto-formatting rewrites the file so undo doesn't flag it as stale.
 */
export function updateLastAfterHash(
  absPath: string,
  postFormatContent: string,
  tabId?: string,
): void {
  const stack = stacks.get(absPath);
  if (!stack || stack.length === 0) return;
  if (tabId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i];
      if (item && (!item.tabId || item.tabId === tabId)) {
        item.afterHash = contentHash(postFormatContent);
        return;
      }
    }
  } else {
    const last = stack[stack.length - 1];
    if (last) last.afterHash = contentHash(postFormatContent);
  }
}

interface PopResult {
  content: string;
  stale: boolean;
}

/**
 * Pop the most recent undo entry, verifying it's not stale.
 * @param currentFileHash - hash of the file's current content on disk
 * @returns the previous content + stale flag, or null if no entry
 */
function popEdit(
  absPath: string,
  currentFileHash: number,
  tabId?: string,
  skipStale?: boolean,
): PopResult | null {
  const stack = stacks.get(absPath);
  if (!stack || stack.length === 0) return null;
  if (tabId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i];
      if (item && (!item.tabId || item.tabId === tabId)) {
        // Tab-scoped undo skips stale detection — the whole point is to
        // undo YOUR edits regardless of what other tabs did to the file.
        const stale = skipStale ? false : item.afterHash !== currentFileHash;
        stack.splice(i, 1);
        return { content: item.content, stale };
      }
    }
    return null;
  }
  const entry = stack.pop();
  if (!entry) return null;
  return { content: entry.content, stale: skipStale ? false : entry.afterHash !== currentFileHash };
}

function getEditCount(absPath: string, tabId?: string): number {
  const stack = stacks.get(absPath);
  if (!stack) return 0;
  if (!tabId) return stack.length;
  return stack.filter((e) => !e.tabId || e.tabId === tabId).length;
}

export const undoEditTool = {
  name: "undo_edit",
  description:
    "Undo the last edit_file change to a file. Refuses if the file was modified since the edit — read the file and use edit_file to surgically revert instead.",
  execute: async (args: { path: string; steps?: number; tabId?: string }): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      try {
        await statAsync(filePath);
      } catch {
        return {
          success: false,
          output: `File not found: ${filePath}`,
          error: `File not found: ${filePath}`,
        };
      }

      const steps = Math.max(1, Math.min(args.steps ?? 1, MAX_STACK_SIZE));
      const currentContent = await readBufferContent(filePath);
      let currentHash = contentHash(currentContent);
      let restored: string | null = null;
      let actualSteps = 0;

      for (let i = 0; i < steps; i++) {
        // Only check staleness on the first pop against the actual file on disk.
        // Subsequent pops in a multi-step undo are against content we just restored,
        // so the hash chain is broken by design (we skip other tabs' intermediate entries).
        const skipStale = i > 0;
        const result = popEdit(filePath, currentHash, args.tabId, skipStale);
        if (!result) break;
        if (result.stale) {
          return {
            success: false,
            output: `File was modified by another agent or externally since this edit (step ${String(i + 1)}). Read the file and use edit_file to surgically revert your specific changes — undo would overwrite other modifications.`,
            error: "stale_undo",
          };
        }
        restored = result.content;
        // Update hash for next iteration — the "current" content is now what we're about to restore
        currentHash = contentHash(restored);
        actualSteps++;
      }

      if (!restored) {
        const msg = `No edit history for ${args.path}. Undo is only available for edits made this session via edit_file.`;
        return { success: false, output: msg, error: msg };
      }

      await writeFile(filePath, restored, "utf-8");
      markToolWrite(filePath);
      emitFileEdited(filePath, restored);

      await reloadBuffer(filePath);

      const remaining = getEditCount(filePath, args.tabId);
      const lineCount = restored.split("\n").length;
      let output = `Undid ${String(actualSteps)} edit${actualSteps > 1 ? "s" : ""} to ${args.path} (restored ${String(lineCount)} lines)`;
      if (remaining > 0) {
        output += ` — ${String(remaining)} more undo${remaining > 1 ? "s" : ""} available`;
      }

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
/** Files this tab has edited in the current session — used by remote /diff and /files. */
export function getEditedFilesForTab(
  tabId: string,
): Array<{ path: string; edits: number; lastTs: number }> {
  const out: Array<{ path: string; edits: number; lastTs: number }> = [];
  for (const [path, stack] of stacks) {
    const tabEdits = stack.filter((e) => !e.tabId || e.tabId === tabId);
    if (tabEdits.length === 0) continue;
    const last = tabEdits[tabEdits.length - 1];
    if (!last) continue;
    out.push({ path, edits: tabEdits.length, lastTs: last.timestamp });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return out;
}
