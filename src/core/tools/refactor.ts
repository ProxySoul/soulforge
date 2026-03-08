import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { FileEdit, FormatEdit, RefactorResult } from "../intelligence/types.js";

type RefactorAction =
  | "extract_function"
  | "extract_variable"
  | "format"
  | "format_range"
  | "organize_imports";

interface RefactorArgs {
  action: RefactorAction;
  file?: string;
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

async function applyAndDiagnose(
  edits: FileEdit[],
  router: ReturnType<typeof getIntelligenceRouter>,
): Promise<string | null> {
  // Snapshot before-diagnostics for each file
  const beforeMap = new Map<string, import("../intelligence/types.js").Diagnostic[]>();
  for (const edit of edits) {
    const lang = router.detectLanguage(edit.file);
    const diags = await router.executeWithFallback(lang, "getDiagnostics", (b) =>
      b.getDiagnostics ? b.getDiagnostics(edit.file) : Promise.resolve(null),
    );
    if (diags) beforeMap.set(edit.file, diags);
  }

  applyEdits(edits);

  // Run diagnostic diff on each file
  try {
    const { formatPostEditResult, postEditDiagnostics } = await import(
      "../intelligence/post-edit.js"
    );
    const parts: string[] = [];
    for (const edit of edits) {
      const lang = router.detectLanguage(edit.file);
      const before = beforeMap.get(edit.file) ?? [];
      const diffResult = await postEditDiagnostics(router, edit.file, lang, before);
      const diffOutput = formatPostEditResult(diffResult);
      if (diffOutput) parts.push(diffOutput);
    }
    return parts.length > 0 ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

function formatResult(result: RefactorResult, applied: boolean): string {
  const lines = [result.description];
  if (applied) {
    lines.push(
      `Applied to ${String(result.edits.length)} file(s) — ALL references updated atomically:`,
    );
  } else {
    lines.push(`Would modify ${String(result.edits.length)} file(s):`);
  }
  for (const edit of result.edits) {
    lines.push(`  ${edit.file}`);
  }
  if (applied) {
    lines.push("All references updated. No errors.");
  } else {
    lines.push("Pass apply: true to apply changes.");
  }
  return lines.join("\n");
}

export const refactorTool = {
  name: "refactor",
  description:
    "Extract functions/variables, format code, and organize imports. Compiler-guaranteed safety.",
  execute: async (args: RefactorArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(process.cwd());
      const file = args.file ? resolve(args.file) : undefined;
      const language = router.detectLanguage(file);
      const shouldApply = args.apply ?? true;

      switch (args.action) {
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

          const tracked = await router.executeWithFallbackTracked(
            language,
            "extractFunction",
            (b) =>
              b.extractFunction
                ? b.extractFunction(file, startLine, endLine, newName)
                : Promise.resolve(null),
          );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot extract function — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
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

          const tracked = await router.executeWithFallbackTracked(
            language,
            "extractVariable",
            (b) =>
              b.extractVariable
                ? b.extractVariable(file, startLine, endLine, newName)
                : Promise.resolve(null),
          );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot extract variable — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
        }

        case "format": {
          if (!file) {
            return {
              success: false,
              output: "file is required for format",
              error: "missing file",
            };
          }

          const tracked = await router.executeWithFallbackTracked(
            language,
            "formatDocument",
            (b) => (b.formatDocument ? b.formatDocument(file) : Promise.resolve(null)),
          );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot format — no backend supports formatting for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) applyFormatEdits(tracked.value);
          return {
            success: true,
            output: `Formatted ${file} (${String(tracked.value.edits.length)} edit(s))${shouldApply ? " — applied" : " — pass apply: true to apply"}`,
            backend: tracked.backend,
          };
        }

        case "format_range": {
          if (!file) {
            return {
              success: false,
              output: "file is required for format_range",
              error: "missing file",
            };
          }
          const startLine = args.startLine;
          const endLine = args.endLine;
          if (!startLine || !endLine) {
            return {
              success: false,
              output: "startLine and endLine are required for format_range",
              error: "missing range",
            };
          }

          const tracked = await router.executeWithFallbackTracked(language, "formatRange", (b) =>
            b.formatRange ? b.formatRange(file, startLine, endLine) : Promise.resolve(null),
          );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot format range — no backend supports range formatting for ${language}`,
              error: "unsupported",
            };
          }

          if (shouldApply) applyFormatEdits(tracked.value);
          return {
            success: true,
            output: `Formatted ${file} lines ${String(startLine)}-${String(endLine)} (${String(tracked.value.edits.length)} edit(s))${shouldApply ? " — applied" : ""}`,
            backend: tracked.backend,
          };
        }

        case "organize_imports": {
          if (!file) {
            return {
              success: false,
              output: "file is required for organize_imports",
              error: "missing file",
            };
          }

          const tracked = await router.executeWithFallbackTracked(
            language,
            "organizeImports",
            (b) => (b.organizeImports ? b.organizeImports(file) : Promise.resolve(null)),
          );

          if (!tracked) {
            return {
              success: false,
              output: `Cannot organize imports — no backend supports this for ${language}`,
              error: "unsupported",
            };
          }

          let diagOutput: string | null = null;
          if (shouldApply) {
            diagOutput = await applyAndDiagnose(tracked.value.edits, router);
          }
          let output = formatResult(tracked.value, shouldApply);
          if (diagOutput) output += `\n${diagOutput}`;
          return { success: true, output, backend: tracked.backend };
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

function applyFormatEdits(formatEdit: FormatEdit): void {
  const content = readFileSync(formatEdit.file, "utf-8");
  const lines = content.split("\n");

  // Apply edits in reverse order to preserve offsets
  const sorted = [...formatEdit.edits].sort((a, b) => {
    if (a.startLine !== b.startLine) return b.startLine - a.startLine;
    return b.startCol - a.startCol;
  });

  let result = content;
  for (const edit of sorted) {
    let startOffset = 0;
    for (let i = 0; i < edit.startLine - 1 && i < lines.length; i++) {
      startOffset += (lines[i]?.length ?? 0) + 1;
    }
    startOffset += edit.startCol - 1;

    let endOffset = 0;
    for (let i = 0; i < edit.endLine - 1 && i < lines.length; i++) {
      endOffset += (lines[i]?.length ?? 0) + 1;
    }
    endOffset += edit.endCol - 1;

    result = result.slice(0, startOffset) + edit.newText + result.slice(endOffset);
  }

  writeFileSync(formatEdit.file, result, "utf-8");
}
