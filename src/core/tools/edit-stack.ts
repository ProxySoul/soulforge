import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getNvimInstance } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { emitFileEdited } from "./file-events.js";

interface EditEntry {
  content: string;
  timestamp: number;
}

const MAX_STACK_SIZE = 20;
const stacks = new Map<string, EditEntry[]>();

export function pushEdit(absPath: string, previousContent: string): void {
  const key = absPath;
  let stack = stacks.get(key);
  if (!stack) {
    stack = [];
    stacks.set(key, stack);
  }
  stack.push({ content: previousContent, timestamp: Date.now() });
  if (stack.length > MAX_STACK_SIZE) {
    stack.shift();
  }
}

function popEdit(absPath: string): string | null {
  const stack = stacks.get(absPath);
  if (!stack || stack.length === 0) return null;
  const entry = stack.pop();
  return entry ? entry.content : null;
}

function getEditCount(absPath: string): number {
  return stacks.get(absPath)?.length ?? 0;
}

export const undoEditTool = {
  name: "undo_edit",
  description: "Undo the last edit_file change to a file.",
  execute: async (args: { path: string; steps?: number }): Promise<ToolResult> => {
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
        const prev = popEdit(filePath);
        if (!prev) break;
        restored = prev;
        actualSteps++;
      }

      if (!restored) {
        const msg = `No edit history for ${args.path}. Undo is only available for edits made this session via edit_file.`;
        return { success: false, output: msg, error: msg };
      }

      writeFileSync(filePath, restored, "utf-8");
      emitFileEdited(filePath, restored);

      // Reload in editor
      const nvim = getNvimInstance();
      if (nvim) {
        try {
          await nvim.api.executeLua("vim.cmd.edit({args={vim.fn.fnameescape(...)}, bang=true})", [
            filePath,
          ]);
        } catch {
          // Editor not available
        }
      }

      const remaining = getEditCount(filePath);
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
