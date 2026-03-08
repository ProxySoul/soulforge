import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";

type AnalyzeAction =
  | "diagnostics"
  | "type_info"
  | "outline"
  | "code_actions"
  | "unused"
  | "symbol_diff";

interface AnalyzeArgs {
  action: AnalyzeAction;
  file?: string;
  symbol?: string;
  line?: number;
  column?: number;
  startLine?: number;
  endLine?: number;
  oldContent?: string;
}

export const analyzeTool = {
  name: "analyze",
  description:
    "Check for type errors, get type info for a symbol, list unused exports, or diff symbols before/after an edit. " +
    "Use INSTEAD of 'shell tsc' for diagnostics. Works without neovim — uses static analysis.",
  execute: async (args: AnalyzeArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(process.cwd());
      const file = args.file ? resolve(args.file) : undefined;
      const language = router.detectLanguage(file);

      switch (args.action) {
        case "diagnostics": {
          if (!file) {
            return {
              success: false,
              output: "file is required for diagnostics",
              error: "missing file",
            };
          }

          const tracked = await router.executeWithFallbackTracked(
            language,
            "getDiagnostics",
            (b) => (b.getDiagnostics ? b.getDiagnostics(file) : Promise.resolve(null)),
          );

          if (!tracked) {
            return {
              success: false,
              output: `No diagnostics backend available for ${language}`,
              error: "unsupported",
            };
          }

          const diags = tracked.value;
          if (diags.length === 0) {
            return {
              success: true,
              output: "No diagnostics — file is clean",
              backend: tracked.backend,
            };
          }

          const errors = diags.filter((d) => d.severity === "error").length;
          const warnings = diags.filter((d) => d.severity === "warning").length;
          const header = `${String(diags.length)} diagnostic(s): ${String(errors)} error(s), ${String(warnings)} warning(s)`;

          const lines = diags.map((d) => {
            const code = d.code ? ` [${String(d.code)}]` : "";
            return `${d.severity} ${d.file}:${String(d.line)}:${String(d.column)}${code} — ${d.message}`;
          });

          return {
            success: true,
            output: `${header}\n${lines.join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "type_info": {
          if (!file) {
            return {
              success: false,
              output: "file is required for type_info",
              error: "missing file",
            };
          }
          const symbol = args.symbol;
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for type_info",
              error: "missing symbol",
            };
          }

          const tracked = await router.executeWithFallbackTracked(language, "getTypeInfo", (b) =>
            b.getTypeInfo
              ? b.getTypeInfo(file, symbol, args.line, args.column)
              : Promise.resolve(null),
          );

          if (!tracked) {
            return {
              success: false,
              output: `No type info available for '${symbol}'`,
              error: "not found",
            };
          }

          const info = tracked.value;
          const parts = [`${info.symbol}: ${info.type}`];
          if (info.documentation) {
            parts.push("", info.documentation);
          }
          return { success: true, output: parts.join("\n"), backend: tracked.backend };
        }

        case "outline": {
          if (!file) {
            return {
              success: false,
              output: "file is required for outline",
              error: "missing file",
            };
          }

          const tracked = await router.executeWithFallbackTracked(
            language,
            "getFileOutline",
            (b) => (b.getFileOutline ? b.getFileOutline(file) : Promise.resolve(null)),
          );

          if (!tracked) {
            return { success: false, output: "Could not generate outline", error: "failed" };
          }

          const outline = tracked.value;
          const parts: string[] = [`Outline of ${outline.file} (${outline.language})`];

          if (outline.imports.length > 0) {
            parts.push(`\nImports (${String(outline.imports.length)}):`);
            for (const imp of outline.imports) {
              const specs = imp.specifiers.length > 0 ? ` { ${imp.specifiers.join(", ")} }` : "";
              parts.push(`  ${imp.source}${specs}`);
            }
          }

          if (outline.symbols.length > 0) {
            parts.push(`\nSymbols (${String(outline.symbols.length)}):`);
            for (const sym of outline.symbols) {
              const end = sym.location.endLine ? `-${String(sym.location.endLine)}` : "";
              parts.push(`  ${sym.kind} ${sym.name} — line ${String(sym.location.line)}${end}`);
            }
          }

          if (outline.exports.length > 0) {
            parts.push(`\nExports (${String(outline.exports.length)}):`);
            for (const exp of outline.exports) {
              const def = exp.isDefault ? " (default)" : "";
              parts.push(`  ${exp.kind} ${exp.name}${def}`);
            }
          }

          return { success: true, output: parts.join("\n"), backend: tracked.backend };
        }

        case "code_actions": {
          if (!file) {
            return {
              success: false,
              output: "file is required for code_actions",
              error: "missing file",
            };
          }
          const startLine = args.startLine ?? 1;
          const endLine = args.endLine ?? startLine;

          const tracked = await router.executeWithFallbackTracked(
            language,
            "getCodeActions",
            (b) =>
              b.getCodeActions ? b.getCodeActions(file, startLine, endLine) : Promise.resolve(null),
          );

          if (!tracked || tracked.value.length === 0) {
            return { success: true, output: "No code actions available" };
          }

          const actionLines = tracked.value.map((a) => {
            const kind = a.kind ? ` [${a.kind}]` : "";
            const preferred = a.isPreferred ? " ★" : "";
            return `${a.title}${kind}${preferred}`;
          });

          return {
            success: true,
            output: `Code actions (${String(tracked.value.length)}):\n${actionLines.join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "unused": {
          if (!file) {
            return {
              success: false,
              output: "file is required for unused detection",
              error: "missing file",
            };
          }

          const tracked = await router.executeWithFallbackTracked(language, "findUnused", (b) =>
            b.findUnused ? b.findUnused(file) : Promise.resolve(null),
          );

          if (!tracked || tracked.value.length === 0) {
            return {
              success: true,
              output: "No unused imports or exports detected",
              backend: tracked?.backend,
            };
          }

          const unusedLines = tracked.value.map(
            (u) => `${u.kind} ${u.name} — ${u.file}:${String(u.line)}`,
          );

          return {
            success: true,
            output: `Unused items (${String(tracked.value.length)}):\n${unusedLines.join("\n")}`,
            backend: tracked.backend,
          };
        }

        case "symbol_diff": {
          if (!file) {
            return {
              success: false,
              output: "file is required for symbol_diff",
              error: "missing file",
            };
          }

          // Get old content from args or git
          let oldContent = args.oldContent;
          if (!oldContent) {
            try {
              const gitResult = spawnSync("git", ["show", `HEAD:${file}`], {
                encoding: "utf-8",
                cwd: process.cwd(),
              });
              if (gitResult.status !== 0) throw new Error(gitResult.stderr);
              oldContent = gitResult.stdout;
            } catch {
              return {
                success: false,
                output: "Could not get old version — provide oldContent or ensure file is in git",
                error: "no old content",
              };
            }
          }

          let newContent: string;
          try {
            newContent = readFileSync(resolve(file), "utf-8");
          } catch {
            return {
              success: false,
              output: `Could not read current file: ${file}`,
              error: "read error",
            };
          }

          // Get outlines of both versions using simple parsing
          const oldOutline = await router.executeWithFallback(language, "getFileOutline", (b) => {
            if (!b.getFileOutline) return Promise.resolve(null);
            // Write old content to a temp analysis — use the file outline on current
            return b.getFileOutline(file);
          });

          // Parse symbols from both versions via simple heuristic
          const oldSymbols = extractSymbolNames(oldContent);
          const newSymbols = extractSymbolNames(newContent);

          const added = newSymbols.filter((s) => !oldSymbols.includes(s));
          const removed = oldSymbols.filter((s) => !newSymbols.includes(s));
          const kept = newSymbols.filter((s) => oldSymbols.includes(s));

          const parts: string[] = [`Symbol diff of ${file}:`];
          if (added.length > 0) {
            parts.push(`\nAdded (${String(added.length)}):`);
            parts.push(...added.map((s) => `  + ${s}`));
          }
          if (removed.length > 0) {
            parts.push(`\nRemoved (${String(removed.length)}):`);
            parts.push(...removed.map((s) => `  - ${s}`));
          }
          parts.push(`\nUnchanged: ${String(kept.length)} symbol(s)`);

          if (oldOutline) {
            parts.push(
              `\nCurrent outline: ${String(oldOutline.symbols.length)} symbols, ${String(oldOutline.imports.length)} imports, ${String(oldOutline.exports.length)} exports`,
            );
          }

          return { success: true, output: parts.join("\n") };
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

/** Extract symbol names from source code using regex heuristics */
function extractSymbolNames(content: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:export\s+)?class\s+(\w+)/g,
    /(?:export\s+)?interface\s+(\w+)/g,
    /(?:export\s+)?type\s+(\w+)/g,
    /(?:export\s+)?enum\s+(\w+)/g,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.push(match[1]);
    }
  }
  return symbols;
}
