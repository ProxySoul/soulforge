import { mkdir, stat as statAsync, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { analyzeFile } from "../analysis/complexity";
import { markToolWrite, readBufferContent, reloadBuffer } from "../editor/instance";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

interface EditFileArgs {
  path: string;
  oldString: string;
  newString: string;
  lineStart?: number;
  lineEnd?: number;
  tabId?: string;
}

export function formatMetricDelta(label: string, before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "";
  return `${label}: ${String(before)}→${String(after)} (${sign}${String(delta)})`;
}

/**
 * When exact match fails, try normalizing leading whitespace (tabs↔spaces).
 * Returns the corrected oldStr/newStr with the file's actual indentation,
 * or null if no match is possible.
 */
export function buildRichEditError(
  content: string,
  oldStr: string,
  lineHint?: number,
): { output: string } {
  const lines = content.split("\n");
  const center = lineHint ? Math.min(lineHint - 1, lines.length - 1) : Math.floor(lines.length / 2);
  const start = Math.max(0, center - 5);
  const end = Math.min(lines.length, center + 6);
  const snippet = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(4)} │ ${l}`)
    .join("\n");
  // Detect escape-heavy content — likely JSON escaping corruption
  const backslashDensity = (oldStr.match(/\\/g) || []).length / Math.max(oldStr.length, 1);
  const escapeHint =
    backslashDensity > 0.05
      ? "\n[Escape-heavy content detected — use lineStart + lineEnd for line-range replacement, or use editor(action: edit, startLine, endLine, replacement)]"
      : "";
  return {
    output: `old_string not found in file (re-read performed — content below is current):\n${snippet}${escapeHint}`,
  };
}

export function fuzzyWhitespaceMatch(
  content: string,
  oldStr: string,
  newStr: string,
): { oldStr: string; newStr: string } | null {
  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  if (oldLines.length === 0) return null;

  // Try progressively looser normalization: whitespace-only, then escape-aware
  for (const normalize of [
    // Level 1: whitespace normalization only
    (line: string) => line.replace(/^[\t ]+/, "").trimEnd(),
    // Level 2: also normalize escape sequences (handles JSON escape corruption)
    (line: string) =>
      line
        .replace(/^[\t ]+/, "")
        .trimEnd()
        .replace(/\\{2,}/g, "\\") // collapse multiple backslashes
        .replace(/\\([[\](){}|.*+?^$])/g, "$1"), // unescape regex metacharacters
  ]) {
    const normalizedOld = oldLines.map(normalize);

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (normalize(contentLines[i + j] as string) !== normalizedOld[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const actualOld = contentLines.slice(i, i + oldLines.length).join("\n");
        if (content.split(actualOld).length - 1 !== 1) continue;

        const correctedNew = correctIndentation(oldLines, contentLines, i, newStr);
        return { oldStr: actualOld, newStr: correctedNew };
      }
    }
  }
  return null;
}

function correctIndentation(
  oldLines: string[],
  contentLines: string[],
  matchStart: number,
  newStr: string,
): string {
  const newLines = newStr.split("\n");
  return newLines
    .map((newLine, idx) => {
      const oldLine = oldLines[idx];
      if (!oldLine) return newLine;
      const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
      const actualLine = contentLines[matchStart + idx] as string;
      const actualIndent = actualLine.match(/^[\t ]*/)?.[0] ?? "";
      if (oldIndent === actualIndent) return newLine;
      const newIndent = newLine.match(/^[\t ]*/)?.[0] ?? "";
      if (newIndent === oldIndent) {
        return actualIndent + newLine.slice(oldIndent.length);
      }
      return newLine;
    })
    .join("\n");
}

async function applyEdit(
  filePath: string,
  content: string,
  updated: string,
  editLine: number,
  label: string,
  tabId?: string,
): Promise<ToolResult> {
  const beforeMetrics = analyzeFile(content);
  const afterMetrics = analyzeFile(updated);

  // Kick off pre-edit diagnostics in parallel — don't block the file write
  const diagsPromise = import("../intelligence/index.js")
    .then(async (intel) => {
      const router = intel.getIntelligenceRouter(process.cwd());
      const language = router.detectLanguage(filePath);
      const diags = await router.executeWithFallback(language, "getDiagnostics", (b) =>
        b.getDiagnostics ? b.getDiagnostics(filePath) : Promise.resolve(null),
      );
      return { beforeDiags: diags ?? [], router, language } as {
        beforeDiags: import("../intelligence/types.js").Diagnostic[];
        router: import("../intelligence/router.js").CodeIntelligenceRouter;
        language: import("../intelligence/types.js").Language;
      };
    })
    .catch((): null => null);

  // Write file immediately — don't wait for diagnostics
  pushEdit(filePath, content, tabId);
  await writeFile(filePath, updated, "utf-8");
  markToolWrite(filePath);
  emitFileEdited(filePath, updated);

  // Fire-and-forget: reload the nvim buffer (don't block tool result)
  reloadBuffer(filePath, editLine).catch(() => {});

  const deltas = [
    formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
    formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
  ].filter(Boolean);

  let output = `Edited ${filePath}${label}`;
  if (deltas.length > 0) output += ` (${deltas.join(", ")})`;

  // Post-edit diagnostics: await with a tight timeout so we don't freeze the UI
  try {
    const diagCtx = await Promise.race([
      diagsPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 500)),
    ]);
    if (diagCtx) {
      const { formatPostEditResult, postEditDiagnostics } = await import(
        "../intelligence/post-edit.js"
      );
      const diffResult = await Promise.race([
        postEditDiagnostics(diagCtx.router, filePath, diagCtx.language, diagCtx.beforeDiags),
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      if (diffResult) {
        const diffOutput = formatPostEditResult(diffResult);
        if (diffOutput) output += `\n${diffOutput}`;
      }
    }
  } catch {}

  return { success: true, output };
}

function resolveLineRange(
  content: string,
  oldStr: string,
  lineStart: number,
  lineEnd?: number,
): { start: number; end: number } | null {
  const lines = content.split("\n");
  const oldLineCount = oldStr.split("\n").length;
  const start = lineStart - 1;
  const end = lineEnd != null ? lineEnd : start + oldLineCount;
  if (start < 0 || start >= lines.length || end > lines.length || start >= end) return null;
  return { start, end };
}

export const editFileTool = {
  name: "edit_file",
  description:
    "[TIER-1] Edit a file by replacing content. Read first, then provide path, oldString, newString. " +
    "ALWAYS provide lineStart (1-indexed from read_file output) — makes edits escape-proof. " +
    "Empty oldString creates a new file. Use multi_edit for multiple changes to the same file. " +
    "Edits are applied immediately.",
  execute: async (args: EditFileArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}". This file is blocked for security.`;
        return { success: false, output: msg, error: msg };
      }

      const oldStr = args.oldString;
      const newStr = args.newString;

      // Create new file
      if (oldStr === "") {
        const dir = dirname(filePath);
        let dirCreated = false;
        try {
          await statAsync(dir);
        } catch {
          dirCreated = true;
        }
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, newStr, "utf-8");
        markToolWrite(filePath);
        emitFileEdited(filePath, newStr);
        const openedInEditor = await reloadBuffer(filePath);
        const metrics = analyzeFile(newStr);
        let out = `Created ${filePath} (lines: ${String(metrics.lineCount)}, imports: ${String(metrics.importCount)})`;
        if (dirCreated) out += ` [directory created: ${dir}]`;
        if (openedInEditor) out += " → opened in editor";
        return { success: true, output: out };
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

      const content = await readBufferContent(filePath);
      const lines = content.split("\n");

      // ═══════════════════════════════════════════════════════════════
      // PRIMARY PATH: line-based editing (when lineStart is provided)
      // No string matching — uses line numbers from the agent's last read.
      // oldString serves as verification hint, not match key.
      // ═══════════════════════════════════════════════════════════════
      if (args.lineStart != null) {
        // First try exact string match at the hinted region for safety verification
        if (content.includes(oldStr)) {
          const matchIdx = content.indexOf(oldStr);
          const matchLine = content.slice(0, matchIdx).split("\n").length;
          const updated = content.replace(oldStr, newStr);
          return applyEdit(filePath, content, updated, matchLine, "", args.tabId);
        }

        // Fuzzy match (whitespace/escape normalization)
        const fixed = fuzzyWhitespaceMatch(content, oldStr, newStr);
        if (fixed && content.includes(fixed.oldStr)) {
          const matchIdx = content.indexOf(fixed.oldStr);
          const matchLine = content.slice(0, matchIdx).split("\n").length;
          const updated = content.replace(fixed.oldStr, fixed.newStr);
          return applyEdit(filePath, content, updated, matchLine, "", args.tabId);
        }

        // String matching failed — fall back to pure line-based replacement.
        // This is the escape-proof path: no string matching at all.
        const range = resolveLineRange(content, oldStr, args.lineStart, args.lineEnd);
        if (!range) {
          return {
            success: false,
            output: `Invalid line range: ${String(args.lineStart)} (file has ${String(lines.length)} lines)`,
            error: "invalid line range",
          };
        }

        const replacedLines = lines.slice(range.start, range.end);
        const newLines = newStr.split("\n");

        // Safety: don't delete large blocks with empty replacement
        if (replacedLines.length > 10 && newLines.length === 0) {
          return {
            success: false,
            output: `Refusing to delete ${String(replacedLines.length)} lines with empty replacement.`,
            error: "safety: empty replacement for large range",
          };
        }

        const before = lines.slice(0, range.start);
        const after = lines.slice(range.end);
        const updated = [...before, ...newLines, ...after].join("\n");
        const label = ` (lines ${String(args.lineStart)}-${String(range.end)})`;
        return applyEdit(filePath, content, updated, args.lineStart, label, args.tabId);
      }

      // ═══════════════════════════════════════════════════════════════
      // FALLBACK PATH: string-based editing (no lineStart provided)
      // Uses exact match → fuzzy whitespace → fuzzy escape → error
      // ═══════════════════════════════════════════════════════════════
      let resolvedOld = oldStr;
      let resolvedNew = newStr;

      if (!content.includes(oldStr)) {
        const fixed = fuzzyWhitespaceMatch(content, oldStr, newStr);
        if (fixed) {
          resolvedOld = fixed.oldStr;
          resolvedNew = fixed.newStr;
        } else {
          const rich = buildRichEditError(content, oldStr, args.lineStart);
          return { success: false, output: rich.output, error: "old_string not found" };
        }
      }

      const occurrences = content.split(resolvedOld).length - 1;
      if (occurrences > 1) {
        const msg = `Found ${String(occurrences)} matches. Provide more context or use lineStart to disambiguate.`;
        return { success: false, output: msg, error: msg };
      }

      const matchIdx = content.indexOf(resolvedOld);
      const editLine = matchIdx >= 0 ? content.slice(0, matchIdx).split("\n").length : 1;
      const updated = content.replace(resolvedOld, resolvedNew);
      const result = await applyEdit(filePath, content, updated, editLine, "", args.tabId);
      if (result.success) {
        result.output +=
          "\n⚠ lineStart not provided — pass lineStart from read_file output to make edits escape-proof.";
      }
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
