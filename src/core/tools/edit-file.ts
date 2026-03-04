import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../../types";
import { analyzeFile, checkConstraints } from "../analysis/complexity";
import { getNvimInstance } from "../editor/instance";
import { MemoryManager } from "../memory/manager";
import { isForbidden } from "../security/forbidden.js";

interface EditFileArgs {
  path: string;
  oldString: string;
  newString: string;
}

function formatMetricDelta(label: string, before: number, after: number): string {
  const delta = after - before;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "";
  return `${label}: ${String(before)}→${String(after)} (${sign}${String(delta)})`;
}

export const editFileTool = {
  name: "edit_file",
  description:
    "Edit a file on disk by replacing an exact string match with new content. Also supports creating new files. This is the primary tool for all file modifications.",
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
        writeFileSync(filePath, newStr, "utf-8");
        let openedInEditor = false;
        const nvim = getNvimInstance();
        if (nvim) {
          try {
            await nvim.api.command(`edit ${filePath}`);
            openedInEditor = true;
          } catch {
            // Editor not available
          }
        }
        const metrics = analyzeFile(newStr);
        let out = `Created ${filePath} (lines: ${String(metrics.lineCount)}, imports: ${String(metrics.importCount)})`;
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

      const content = readFileSync(filePath, "utf-8");

      if (!content.includes(oldStr)) {
        const msg = "old_string not found in file. Make sure it matches exactly.";
        return { success: false, output: msg, error: msg };
      }

      const occurrences = content.split(oldStr).length - 1;
      if (occurrences > 1) {
        const msg = `Found ${String(occurrences)} matches. Provide more context to make the match unique.`;
        return { success: false, output: msg, error: msg };
      }

      const beforeMetrics = analyzeFile(content);
      const updated = content.replace(oldStr, newStr);
      const afterMetrics = analyzeFile(updated);

      // Check constraints
      const cwd = process.cwd();
      const memory = new MemoryManager(cwd);
      const constraints = memory.loadConstraints();
      const violations = checkConstraints(afterMetrics, constraints, filePath);

      const blockers = violations.filter((v) => v.constraint.action === "block");
      if (blockers.length > 0) {
        const msgs = blockers.map(
          (v) =>
            `${v.constraint.name}: ${v.constraint.metric} is ${String(v.actual)} (limit: ${String(v.constraint.limit)})`,
        );
        const constraintMsg = `Constraint violation(s): ${msgs.join("; ")}`;
        return { success: false, output: constraintMsg, error: constraintMsg };
      }

      // Calculate edit line before writing
      const editLine = content.slice(0, content.indexOf(oldStr)).split("\n").length;

      writeFileSync(filePath, updated, "utf-8");

      // Open edited file in editor if available
      let openedInEditor = false;
      const nvim = getNvimInstance();
      if (nvim) {
        try {
          await nvim.api.command(`edit ${filePath}`);
          await nvim.api.command(`normal! ${String(editLine)}G`);
          openedInEditor = true;
        } catch {
          // Editor not available
        }
      }

      // Build output with metrics
      const deltas = [
        formatMetricDelta("lines", beforeMetrics.lineCount, afterMetrics.lineCount),
        formatMetricDelta("imports", beforeMetrics.importCount, afterMetrics.importCount),
      ].filter(Boolean);

      let output = `Edited ${filePath}`;
      if (deltas.length > 0) {
        output += ` (${deltas.join(", ")})`;
      }

      // Append warnings
      const warnings = violations.filter((v) => v.constraint.action === "warn");
      if (warnings.length > 0) {
        const warnMsgs = warnings.map(
          (v) =>
            `⚠ ${v.constraint.name}: ${v.constraint.metric} is ${String(v.actual)} (limit: ${String(v.constraint.limit)})`,
        );
        output += `\n${warnMsgs.join("\n")}`;
      }

      if (openedInEditor) output += " → opened in editor";

      // Post-edit diagnostics (soft — fails silently)
      try {
        const { getIntelligenceRouter } = await import("../intelligence/index.js");
        const router = getIntelligenceRouter(cwd);
        const language = router.detectLanguage(filePath);
        const diags = await router.executeWithFallback(language, "getDiagnostics", (b) => {
          if (!b.getDiagnostics) return Promise.resolve(null);
          return b.getDiagnostics(filePath);
        });
        if (diags && diags.length > 0) {
          const errors = diags.filter((d) => d.severity === "error");
          if (errors.length > 0) {
            output += `\n⚠ ${String(errors.length)} error(s) after edit:`;
            for (const e of errors.slice(0, 3)) {
              output += `\n  L${String(e.line)}: ${e.message}`;
            }
            if (errors.length > 3) {
              output += `\n  ...and ${String(errors.length - 3)} more`;
            }
          }
        }
      } catch {
        // Intelligence not available — that's fine
      }

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
