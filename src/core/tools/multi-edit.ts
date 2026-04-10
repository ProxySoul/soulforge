import { readFile, stat as statAsync, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { analyzeFile } from "../analysis/complexity.js";
import { markToolWrite, readBufferContent, reloadBuffer } from "../editor/instance.js";
import { isForbidden } from "../security/forbidden.js";
import { autoFormatAfterEdit } from "./auto-format.js";
import { buildRichEditError, fuzzyWhitespaceMatch } from "./edit-file.js";
import { pushEdit, updateLastAfterHash } from "./edit-stack.js";
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
  description:
    "Apply multiple edits to a single file atomically. All-or-nothing: if any edit fails, ZERO edits are applied. " +
    "lineStart values reference the ORIGINAL file (pre-edit) — the tool tracks cumulative line offsets internally. " +
    "Provide lineStart (1-indexed) for reliable line-anchored matching. Without it, falls back to string matching against evolved content. " +
    "The range is derived from oldString line count.",
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

      const originalContent = await readFile(filePath, "utf-8");
      let content = originalContent;

      // Phase 1: Validate and apply edits sequentially against evolving content.
      // Each edit sees the result of all prior edits — overlapping edits fail explicitly.
      // lineOffset tracks cumulative line count changes from prior edits so that
      // lineStart values (which reference the ORIGINAL file) stay accurate.
      // Sort edits top-to-bottom by lineStart so the cumulative offset is correct —
      // each edit only shifts lines below it. Edits without lineStart go last (string-match fallback).
      const sortedEdits = [...args.edits].sort((a, b) => {
        if (a.lineStart == null && b.lineStart == null) return 0;
        if (a.lineStart == null) return 1;
        if (b.lineStart == null) return -1;
        return a.lineStart - b.lineStart;
      });
      let lineOffset = 0;

      for (let i = 0; i < sortedEdits.length; i++) {
        const edit = sortedEdits[i];
        if (!edit) continue;
        const label = `Edit ${String(i + 1)}/${String(args.edits.length)}`;
        const adjustedLineStart = edit.lineStart != null ? edit.lineStart + lineOffset : undefined;
        const oldLineCount = edit.oldString.split("\n").length;
        const newLineCount = edit.newString.split("\n").length;

        // Helper: apply line-based replacement at a given range
        const applyLineReplace = (start: number, end: number, replacement?: string): boolean => {
          const lines = content.split("\n");
          if (start < 0 || end > lines.length || start >= end) return false;
          const before = lines.slice(0, start);
          const after = lines.slice(end);
          content = [...before, ...(replacement ?? edit.newString).split("\n"), ...after].join(
            "\n",
          );
          return true;
        };

        // ── PRIMARY: line-based editing (when lineStart is provided) ──
        // Line numbers are AUTHORITATIVE — oldString is verification only.
        if (adjustedLineStart != null) {
          const start = adjustedLineStart - 1;
          const end = start + oldLineCount;
          const lines = content.split("\n");

          if (start >= 0 && end <= lines.length && start < end) {
            const rangeContent = lines.slice(start, end).join("\n");

            // Exact match at range — high confidence
            if (rangeContent === edit.oldString) {
              applyLineReplace(start, end);
              lineOffset += newLineCount - oldLineCount;
              continue;
            }

            // Fuzzy match at range (whitespace/escape normalization)
            const rangeFixed = fuzzyWhitespaceMatch(rangeContent, edit.oldString, edit.newString);
            if (rangeFixed) {
              applyLineReplace(start, end, rangeFixed.newStr);
              lineOffset += rangeFixed.newStr.split("\n").length - (end - start);
              continue;
            }

            // oldString doesn't match at the adjusted line range.
            // Fall through to string-based matching — the content may still
            // exist elsewhere in the evolved file (e.g. adjacent edits shifted it).
          }
          // Line range invalid — fall through to string-based matching
        }

        // ── FALLBACK: string-based editing (no lineStart or invalid range) ──
        if (content.includes(edit.oldString)) {
          const occurrences = content.split(edit.oldString).length - 1;
          if (occurrences > 1) {
            const msg = `${label}: found ${String(occurrences)} matches. Provide lineStart to disambiguate. NO edits were applied (atomic rollback).`;
            return {
              success: false,
              output: msg,
              error: `${label}: ambiguous match (0 edits applied)`,
            };
          }
          // Single occurrence — safe to replace
          const idx = content.indexOf(edit.oldString);
          content =
            content.slice(0, idx) + edit.newString + content.slice(idx + edit.oldString.length);
          lineOffset += newLineCount - oldLineCount;
          continue;
        }

        // Fuzzy match (whitespace + escape normalization)
        const fixed = fuzzyWhitespaceMatch(content, edit.oldString, edit.newString);
        if (fixed && content.includes(fixed.oldStr)) {
          const fixedOccurrences = content.split(fixed.oldStr).length - 1;
          if (fixedOccurrences === 1) {
            const fixedOldLines = fixed.oldStr.split("\n").length;
            const fixedNewLines = fixed.newStr.split("\n").length;
            const idx = content.indexOf(fixed.oldStr);
            content =
              content.slice(0, idx) + fixed.newStr + content.slice(idx + fixed.oldStr.length);
            lineOffset += fixedNewLines - fixedOldLines;
            continue;
          }
        }

        const err = buildRichEditError(content, edit.oldString, adjustedLineStart);
        return {
          success: false,
          output: `${label} failed: ${err.output}\nNO edits were applied (atomic rollback). Re-read the file and retry ALL edits.`,
          error: `edit ${String(i + 1)} failed (0 edits applied)`,
        };
      }

      // Phase 2: All edits validated — compute metrics and apply
      const beforeMetrics = analyzeFile(originalContent);
      const afterMetrics = analyzeFile(content);

      // Kick off pre-edit diagnostics in parallel — don't block the file write.
      // Skip if intelligence hasn't been initialized (avoids cold-starting LSP/tree-sitter from edit tools).
      const diagsPromise = import("../intelligence/index.js")
        .then(async (intel) => {
          if (!intel.isIntelligenceReady()) return null;
          const client = intel.getIntelligenceClient();
          const r = intel.getIntelligenceRouter(process.cwd());
          const lang = client
            ? await client.routerDetectLanguage(filePath)
            : r.detectLanguage(filePath);
          let diags: import("../intelligence/types.js").Diagnostic[] | null = null;
          if (client) {
            const tracked = await client.routerGetDiagnostics(filePath);
            diags = tracked?.value ?? null;
          } else {
            diags = await r.executeWithFallback(lang, "getDiagnostics", (b) =>
              b.getDiagnostics ? b.getDiagnostics(filePath) : Promise.resolve(null),
            );
          }
          return {
            beforeDiags: diags ?? [],
            router: r,
            language: lang,
          } as {
            beforeDiags: import("../intelligence/types.js").Diagnostic[];
            router: import("../intelligence/router.js").CodeIntelligenceRouter;
            language: import("../intelligence/types.js").Language;
          };
        })
        .catch((): null => null);

      // CAS: verify file hasn't been modified since we read it
      const currentOnDisk = await readFile(filePath, "utf-8");
      if (currentOnDisk !== originalContent) {
        const msg =
          "File was modified concurrently since last read. NO edits were applied (atomic rollback). Re-read and retry ALL edits.";
        return { success: false, output: msg, error: "concurrent modification (0 edits applied)" };
      }

      // Push single undo entry for the entire batch — write immediately
      pushEdit(filePath, originalContent, content, args.tabId);

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

      // Auto-format after edit (cached command, 5s timeout)
      const formatted = await autoFormatAfterEdit(filePath);
      if (formatted) {
        const postFormatContent = await readBufferContent(filePath);
        updateLastAfterHash(filePath, postFormatContent, args.tabId);
        const postLines = postFormatContent.split("\n").length;
        const preLines = content.split("\n").length;
        if (postLines !== preLines) {
          output += ` (formatted, line count changed ${String(preLines)}→${String(postLines)} — re-read affected range before next edit)`;
        } else {
          output += " (formatted)";
        }
      }

      // Post-edit diagnostics: same-file only (skip expensive cross-file findImporters)
      try {
        const diagCtx = await Promise.race([
          diagsPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 500)),
        ]);
        if (diagCtx) {
          const { formatPostEditResult, sameFileDiagnostics } = await import(
            "../intelligence/post-edit.js"
          );
          const diffResult = await Promise.race([
            sameFileDiagnostics(diagCtx.router, filePath, diagCtx.language, diagCtx.beforeDiags),
            new Promise<null>((r) => setTimeout(() => r(null), 800)),
          ]);
          if (diffResult) {
            const diffOutput = formatPostEditResult(diffResult);
            if (diffOutput) output += `\n${diffOutput}`;
          }
        }
      } catch {}

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
