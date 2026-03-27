import { stat as statAsync, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { analyzeFile } from "../analysis/complexity.js";
import { markToolWrite, readBufferContent, reloadBuffer } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { buildRichEditError, fuzzyWhitespaceMatch } from "./edit-file.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

interface EditEntry {
  oldString: string;
  newString: string;
  lineStart?: number;
  lineEnd?: number;
}

interface MultiEditArgs {
  path: string;
  edits: EditEntry[];
  tabId?: string;
}

/**
 * Transactional multi-edit: reads file once, validates ALL edits upfront,
 * applies atomically, pushes one undo entry, runs diagnostics once.
 */
export const multiEditTool = {
  name: "multi_edit",
  description: "Apply multiple edits to a single file atomically. All-or-nothing validation.",
  execute: async (args: MultiEditArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      if (!args.edits || args.edits.length === 0) {
        const msg = "No edits provided. Pass an array of {oldString, newString} objects.";
        return { success: false, output: msg, error: msg };
      }

      try {
        await statAsync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === "EACCES" || code === "EPERM"
            ? `Permission denied: ${filePath}`
            : `File not found: ${filePath}`;
        return { success: false, output: msg, error: msg };
      }

      const originalContent = await readBufferContent(filePath);
      let content = originalContent;

      // Phase 1: Validate and apply edits sequentially against evolving content.
      // Each edit sees the result of all prior edits — overlapping edits fail explicitly.
      // lineOffset tracks cumulative line count changes from prior edits so that
      // lineStart values (which reference the ORIGINAL file) stay accurate.
      let lineOffset = 0;

      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];
        if (!edit) continue;
        const label = `Edit ${String(i + 1)}/${String(args.edits.length)}`;
        const adjustedLineStart = edit.lineStart != null ? edit.lineStart + lineOffset : undefined;
        const adjustedLineEnd = edit.lineEnd != null ? edit.lineEnd + lineOffset : undefined;
        const oldLineCount = edit.oldString.split("\n").length;
        const newLineCount = edit.newString.split("\n").length;

        // Helper: apply line-based replacement at a given range
        const applyLineReplace = (start: number, end: number): boolean => {
          const lines = content.split("\n");
          if (start < 0 || end > lines.length || start >= end) return false;
          const before = lines.slice(0, start);
          const after = lines.slice(end);
          content = [...before, ...edit.newString.split("\n"), ...after].join("\n");
          return true;
        };

        // Try exact string match first
        if (content.includes(edit.oldString)) {
          const occurrences = content.split(edit.oldString).length - 1;
          if (occurrences > 1) {
            if (adjustedLineStart != null) {
              const start = adjustedLineStart - 1;
              const end = adjustedLineEnd != null ? adjustedLineEnd : start + oldLineCount;
              if (applyLineReplace(start, end)) {
                lineOffset += newLineCount - oldLineCount;
                continue;
              }
            }
            const msg = `${label}: found ${String(occurrences)} matches. Provide lineStart to disambiguate.`;
            return { success: false, output: msg, error: msg };
          }
          content = content.replace(edit.oldString, edit.newString);
          lineOffset += newLineCount - oldLineCount;
          continue;
        }

        // Fuzzy match (whitespace + escape normalization)
        const fixed = fuzzyWhitespaceMatch(content, edit.oldString, edit.newString);
        if (fixed && content.includes(fixed.oldStr)) {
          const fixedOldLines = fixed.oldStr.split("\n").length;
          const fixedNewLines = fixed.newStr.split("\n").length;
          content = content.replace(fixed.oldStr, fixed.newStr);
          lineOffset += fixedNewLines - fixedOldLines;
          continue;
        }

        // Line-based fallback (when lineStart provided)
        if (adjustedLineStart != null) {
          const start = adjustedLineStart - 1;
          const end = adjustedLineEnd != null ? adjustedLineEnd : start + oldLineCount;
          if (applyLineReplace(start, end)) {
            lineOffset += newLineCount - oldLineCount;
            continue;
          }
        }

        const err = buildRichEditError(content, edit.oldString, adjustedLineStart);
        return {
          success: false,
          output: `${label} failed: ${err.output}`,
          error: `edit ${String(i + 1)} failed`,
        };
      }

      // Phase 2: All edits validated — compute metrics and apply
      const beforeMetrics = analyzeFile(originalContent);
      const afterMetrics = analyzeFile(content);

      // Snapshot diagnostics BEFORE writing
      let beforeDiags: import("../intelligence/types.js").Diagnostic[] = [];
      let router: import("../intelligence/router.js").CodeIntelligenceRouter | null = null;
      let language: import("../intelligence/types.js").Language = "unknown";
      try {
        const intel = await import("../intelligence/index.js");
        router = intel.getIntelligenceRouter(process.cwd());
        language = router.detectLanguage(filePath);
        const diags = await router.executeWithFallback(language, "getDiagnostics", (b) =>
          b.getDiagnostics ? b.getDiagnostics(filePath) : Promise.resolve(null),
        );
        if (diags) beforeDiags = diags;
      } catch {
        // Intelligence not available
      }

      // Push single undo entry for the entire batch
      pushEdit(filePath, originalContent, args.tabId);

      await writeFile(filePath, content, "utf-8");
      markToolWrite(filePath);
      emitFileEdited(filePath, content);

      await reloadBuffer(filePath);

      // Build output
      const lineDelta = afterMetrics.lineCount - beforeMetrics.lineCount;
      const importDelta = afterMetrics.importCount - beforeMetrics.importCount;
      const deltas: string[] = [];
      if (lineDelta !== 0) {
        const sign = lineDelta > 0 ? "+" : "";
        deltas.push(
          `lines: ${String(beforeMetrics.lineCount)}→${String(afterMetrics.lineCount)} (${sign}${String(lineDelta)})`,
        );
      }
      if (importDelta !== 0) {
        const sign = importDelta > 0 ? "+" : "";
        deltas.push(
          `imports: ${String(beforeMetrics.importCount)}→${String(afterMetrics.importCount)} (${sign}${String(importDelta)})`,
        );
      }

      let output = `Applied ${String(args.edits.length)} edits to ${args.path}`;
      if (deltas.length > 0) output += ` (${deltas.join(", ")})`;

      // Single diagnostic pass
      if (router) {
        try {
          const { formatPostEditResult, postEditDiagnostics } = await import(
            "../intelligence/post-edit.js"
          );
          const diffResult = await postEditDiagnostics(router, filePath, language, beforeDiags);
          const diffOutput = formatPostEditResult(diffResult);
          if (diffOutput) output += `\n${diffOutput}`;
        } catch {
          // Post-edit analysis unavailable
        }
      }

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
