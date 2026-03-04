import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";

type AnalyzeAction = "diagnostics" | "type_info" | "outline";

interface AnalyzeArgs {
  action: AnalyzeAction;
  file?: string;
  symbol?: string;
  line?: number;
  column?: number;
}

export const analyzeTool = {
  name: "analyze",
  description:
    "Analyze code: get diagnostics (errors/warnings), type information, or file outlines. " +
    "Works without neovim — uses static analysis of the codebase.",
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

          const diags = await router.executeWithFallback(language, "getDiagnostics", (b) =>
            b.getDiagnostics ? b.getDiagnostics(file) : Promise.resolve(null),
          );

          if (!diags) {
            return {
              success: false,
              output: `No diagnostics backend available for ${language}`,
              error: "unsupported",
            };
          }

          if (diags.length === 0) {
            return { success: true, output: "No diagnostics — file is clean" };
          }

          const errors = diags.filter((d) => d.severity === "error").length;
          const warnings = diags.filter((d) => d.severity === "warning").length;
          const header = `${String(diags.length)} diagnostic(s): ${String(errors)} error(s), ${String(warnings)} warning(s)`;

          const lines = diags.map((d) => {
            const code = d.code ? ` [${String(d.code)}]` : "";
            return `${d.severity} ${d.file}:${String(d.line)}:${String(d.column)}${code} — ${d.message}`;
          });

          return { success: true, output: `${header}\n${lines.join("\n")}` };
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

          const info = await router.executeWithFallback(language, "getTypeInfo", (b) =>
            b.getTypeInfo
              ? b.getTypeInfo(file, symbol, args.line, args.column)
              : Promise.resolve(null),
          );

          if (!info) {
            return {
              success: false,
              output: `No type info available for '${symbol}'`,
              error: "not found",
            };
          }

          const parts = [`${info.symbol}: ${info.type}`];
          if (info.documentation) {
            parts.push("", info.documentation);
          }
          return { success: true, output: parts.join("\n") };
        }

        case "outline": {
          if (!file) {
            return {
              success: false,
              output: "file is required for outline",
              error: "missing file",
            };
          }

          const outline = await router.executeWithFallback(language, "getFileOutline", (b) =>
            b.getFileOutline ? b.getFileOutline(file) : Promise.resolve(null),
          );

          if (!outline) {
            return { success: false, output: "Could not generate outline", error: "failed" };
          }

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
