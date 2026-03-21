import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { reloadBuffer } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { emitFileEdited } from "./file-events.js";

interface EditEntry {
  content: string;
  timestamp: number;
  tabId?: string;
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
    const filtered = stack.filter((e) => e.tabId && e.tabId !== tabId);
    if (filtered.length === 0) {
      stacks.delete(key);
    } else {
      stacks.set(key, filtered);
    }
  }
}

export function pushEdit(absPath: string, previousContent: string, tabId?: string): void {
  const key = absPath;
  let stack = stacks.get(key);
  if (!stack) {
    stack = [];
    stacks.set(key, stack);
  }
  stack.push({ content: previousContent, timestamp: Date.now(), tabId });
  if (stack.length > MAX_STACK_SIZE) {
    stack.shift();
  }
  evictOldest();
}

function popEdit(absPath: string, tabId?: string): string | null {
  const stack = stacks.get(absPath);
  if (!stack || stack.length === 0) return null;
  if (tabId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const item = stack[i];
      if (item && (!item.tabId || item.tabId === tabId)) {
        stack.splice(i, 1);
        return item.content;
      }
    }
    return null;
  }
  const entry = stack.pop();
  return entry ? entry.content : null;
}

function getEditCount(absPath: string, tabId?: string): number {
  const stack = stacks.get(absPath);
  if (!stack) return 0;
  if (!tabId) return stack.length;
  return stack.filter((e) => !e.tabId || e.tabId === tabId).length;
}

export const undoEditTool = {
  name: "undo_edit",
  description: "Undo the last edit_file change to a file.",
  execute: async (args: { path: string; steps?: number; tabId?: string }): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      if (!existsSync(filePath)) {
        return {
          success: false,
          output: `File not found: ${filePath}`,
          error: `File not found: ${filePath}`,
        };
      }

      const steps = Math.max(1, Math.min(args.steps ?? 1, 10));
      let restored: string | null = null;
      let actualSteps = 0;

      for (let i = 0; i < steps; i++) {
        const prev = popEdit(filePath, args.tabId);
        if (!prev) break;
        restored = prev;
        actualSteps++;
      }

      if (!restored) {
        const msg = `No edit history for ${args.path}. Undo is only available for edits made this session via edit_file.`;
        return { success: false, output: msg, error: msg };
      }

      await writeFile(filePath, restored, "utf-8");
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
