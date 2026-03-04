import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { FileEdit, RefactorResult } from "../intelligence/types.js";

type RefactorAction = "rename" | "extract_function" | "extract_variable";

interface RefactorArgs {
  action: RefactorAction;
  file?: string;
  symbol?: string;
  newName?: string;
  startLine?: number;
  endLine?: number;
  apply?: boolean;
}

function applyEdits(edits: FileEdit[]): void {
  for (const edit of edits) {
    writeFileSync(edit.file, edit.newContent, "utf-8");
  }
}

function formatResult(result: RefactorResult, applied: boolean): string {
  const lines = [result.description];
  if (applied) {
    lines.push(`Applied to ${String(result.edits.length)} file(s):`);
  } else {
    lines.push(`Would modify ${String(result.edits.length)} file(s):`);
  }
  for (const edit of result.edits) {
    lines.push(`  ${edit.file}`);
  }
  if (!applied) {
    lines.push("Pass apply: true to apply changes.");
  }
  return lines.join("\n");
}

export const refactorTool = {
  name: "refactor",
  description:
    "Refactor code: rename symbols across files, extract functions, or extract variables. " +
    "Uses semantic analysis for safe, compiler-guaranteed transformations. " +
    "Set apply: true to write changes to disk.",
  execute: async (args: RefactorArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(process.cwd());
      const file = args.file ? resolve(args.file) : undefined;
      const language = router.detectLanguage(file);
      const shouldApply = args.apply ?? true;

      switch (args.action) {
        case "rename": {
          const symbol = args.symbol;
          const newName = args.newName;
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for rename",
              error: "missing symbol",
            };
          }
          if (!newName) {
            return {
              success: false,
              output: "newName is required for rename",
              error: "missing newName",
            };
          }
          if (!file) {
            return { success: false, output: "file is required for rename", error: "missing file" };
          }

          const result = await router.executeWithFallback(language, "rename", (b) =>
            b.rename ? b.rename(file, symbol, newName) : Promise.resolve(null),
          );

          if (!result) {
            return {
              success: false,
              output: `Cannot rename '${symbol}' — no backend supports rename for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) applyEdits(result.edits);
          return { success: true, output: formatResult(result, shouldApply) };
        }

        case "extract_function": {
          const startLine = args.startLine;
          const endLine = args.endLine;
          const newName = args.newName;
          if (!file) {
            return {
              success: false,
              output: "file is required for extract_function",
              error: "missing file",
            };
          }
          if (!startLine || !endLine) {
            return {
              success: false,
              output: "startLine and endLine are required for extract_function",
              error: "missing range",
            };
          }
          if (!newName) {
            return {
              success: false,
              output: "newName is required for extract_function",
              error: "missing newName",
            };
          }

          const result = await router.executeWithFallback(language, "extractFunction", (b) =>
            b.extractFunction
              ? b.extractFunction(file, startLine, endLine, newName)
              : Promise.resolve(null),
          );

          if (!result) {
            return {
              success: false,
              output: `Cannot extract function — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) applyEdits(result.edits);
          return { success: true, output: formatResult(result, shouldApply) };
        }

        case "extract_variable": {
          const startLine = args.startLine;
          const endLine = args.endLine;
          const newName = args.newName;
          if (!file) {
            return {
              success: false,
              output: "file is required for extract_variable",
              error: "missing file",
            };
          }
          if (!startLine || !endLine) {
            return {
              success: false,
              output: "startLine and endLine are required for extract_variable",
              error: "missing range",
            };
          }
          if (!newName) {
            return {
              success: false,
              output: "newName is required for extract_variable",
              error: "missing newName",
            };
          }

          const result = await router.executeWithFallback(language, "extractVariable", (b) =>
            b.extractVariable
              ? b.extractVariable(file, startLine, endLine, newName)
              : Promise.resolve(null),
          );

          if (!result) {
            return {
              success: false,
              output: `Cannot extract variable — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) applyEdits(result.edits);
          return { success: true, output: formatResult(result, shouldApply) };
        }

        default:
          return {
            success: false,
            output: `Unknown action: ${args.action as string}`,
            error: "invalid action",
          };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
