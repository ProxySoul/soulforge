import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { analyzeFile } from "../analysis/complexity";
import { readBufferContent, reloadBuffer } from "../editor/instance";
import { isForbidden } from "../security/forbidden.js";
import { pushEdit } from "./edit-stack.js";
import { emitFileEdited } from "./file-events.js";

interface EditFileArgs {
  path: string;
  oldString: string;
  newString: string;
  lineStart?: number;
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
  _oldStr: string,
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
  const readHint = `read_file(path, startLine: ${String(start + 1)}, endLine: ${String(Math.min(end + 20, lines.length))})`;
  return {
    output: `old_string not found in file (re-read performed — content below is current):\n${snippet}\n[Hint: ${readHint} to see more context]`,
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

  const normalize = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
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

      const newLines = newStr.split("\n");
      const correctedNew = newLines
        .map((newLine, idx) => {
          const oldLine = oldLines[idx];
          if (!oldLine) return newLine;
          const oldIndent = oldLine.match(/^[\t ]*/)?.[0] ?? "";
          const actualLine = contentLines[i + idx] as string;
          const actualIndent = actualLine.match(/^[\t ]*/)?.[0] ?? "";
          if (oldIndent === actualIndent) return newLine;
          const newIndent = newLine.match(/^[\t ]*/)?.[0] ?? "";
          if (newIndent === oldIndent) {
            return actualIndent + newLine.slice(oldIndent.length);
          }
          return newLine;
        })
        .join("\n");

      return { oldStr: actualOld, newStr: correctedNew };
    }
  }
  return null;
}

export const editFileTool = {
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string match with new content. Also creates new files when oldString is empty.",
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
        const dirCreated = !existsSync(dir);
        mkdirSync(dir, { recursive: true });
        await writeFile(filePath, newStr, "utf-8");
        emitFileEdited(filePath, newStr);
        const openedInEditor = await reloadBuffer(filePath);
        const metrics = analyzeFile(newStr);
        let out = `Created ${filePath} (lines: ${String(metrics.lineCount)}, imports: ${String(metrics.importCount)})`;
        if (dirCreated) out += ` [directory created: ${dir}]`;
        if (openedInEditor) out += " → opened in editor";
        return { success: true, output: out };
      }

      if (!existsSync(filePath)) {
        return {
          success: false,
          output: `File not found: ${filePath}`,
          error: `File not found: ${filePath}`,
        };
      }

      const content = await readBufferContent(filePath);

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
        const msg = `Found ${String(occurrences)} matches. Provide more context to make the match unique.`;
        return { success: false, output: msg, error: msg };
      }

      const beforeMetrics = analyzeFile(content);
      const updated = content.replace(resolvedOld, resolvedNew);
      const afterMetrics = analyzeFile(updated);

      // Calculate edit line before writing
      const editLine = content.slice(0, content.indexOf(oldStr)).split("\n").length;

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

      pushEdit(filePath, content, args.tabId);
      await writeFile(filePath, updated, "utf-8");
      emitFileEdited(filePath, updated);

      const openedInEditor = await reloadBuffer(filePath, editLine);

      // Build output with metrics
      const deltas = [
        formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
        formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
      ].filter(Boolean);

      let output = `Edited ${filePath}`;
      if (deltas.length > 0) {
        output += ` (${deltas.join(", ")})`;
      }

      if (openedInEditor) output += " → opened in editor";

      // Diagnostic diff — only show NEW errors introduced by this edit
      if (router) {
        try {
          const { formatPostEditResult, postEditDiagnostics } = await import(
            "../intelligence/post-edit.js"
          );
          const diffResult = await postEditDiagnostics(router, filePath, language, beforeDiags);
          const diffOutput = formatPostEditResult(diffResult);
          if (diffOutput) {
            output += `\n${diffOutput}`;
          }
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
