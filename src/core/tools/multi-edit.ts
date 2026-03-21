import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { analyzeFile } from "../analysis/complexity.js";
import { readBufferContent, reloadBuffer } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { buildRichEditError, fuzzyWhitespaceMatch } from "./edit-file.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

interface EditEntry {
  oldString: string;
  newString: string;
  lineStart?: number;
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

      if (!existsSync(filePath)) {
        const msg = `File not found: ${filePath}`;
        return { success: false, output: msg, error: msg };
      }

      const originalContent = await readBufferContent(filePath);
      let content = originalContent;

      // Phase 1: Validate and apply edits sequentially against evolving content.
      // Each edit sees the result of all prior edits — overlapping edits fail explicitly.

      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];
        if (!edit) continue;
        let resolvedOld = edit.oldString;
        let resolvedNew = edit.newString;

        if (!content.includes(resolvedOld)) {
          const fixed = fuzzyWhitespaceMatch(content, resolvedOld, resolvedNew);
          if (fixed) {
            resolvedOld = fixed.oldStr;
            resolvedNew = fixed.newStr;
          } else {
            const err = buildRichEditError(content, resolvedOld, edit.lineStart);
            return {
              success: false,
              output: `Edit ${String(i + 1)}/${String(args.edits.length)} failed: ${err.output}`,
              error: `edit ${String(i + 1)} failed`,
            };
          }
        }

        const occurrences = content.split(resolvedOld).length - 1;
        if (occurrences > 1) {
          const msg = `Edit ${String(i + 1)}/${String(args.edits.length)}: found ${String(occurrences)} matches for oldString. Provide more context to make it unique.`;
          return { success: false, output: msg, error: msg };
        }

        // Apply this edit so subsequent edits validate against the updated state
        content = content.replace(resolvedOld, resolvedNew);
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
