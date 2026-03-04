import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { SourceLocation, SymbolInfo } from "../intelligence/types.js";

type NavigateAction = "definition" | "references" | "symbols" | "imports" | "exports";

interface NavigateArgs {
  action: NavigateAction;
  symbol?: string;
  file?: string;
  scope?: string;
}

function formatLocation(loc: SourceLocation): string {
  const end = loc.endLine ? `-${String(loc.endLine)}` : "";
  return `${loc.file}:${String(loc.line)}${end}`;
}

function formatSymbol(s: SymbolInfo): string {
  const loc = `${s.location.file}:${String(s.location.line)}`;
  const container = s.containerName ? ` (in ${s.containerName})` : "";
  return `${s.kind} ${s.name}${container} — ${loc}`;
}

export const navigateTool = {
  name: "navigate",
  description:
    "Navigate code: find definitions, references, symbols, imports, and exports. " +
    "Works without neovim — uses static analysis of the codebase.",
  execute: async (args: NavigateArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(process.cwd());
      const file = args.file ? resolve(args.file) : undefined;
      const language = router.detectLanguage(file);
      const symbol = args.symbol;

      switch (args.action) {
        case "definition": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for definition lookup",
              error: "missing symbol",
            };
          }
          if (!file) {
            return {
              success: false,
              output: "file is required for definition lookup",
              error: "missing file",
            };
          }

          const locations = await router.executeWithFallback(language, "findDefinition", (b) =>
            b.findDefinition ? b.findDefinition(file, symbol) : Promise.resolve(null),
          );

          if (!locations || locations.length === 0) {
            return {
              success: false,
              output: `No definition found for '${symbol}'`,
              error: "not found",
            };
          }

          return {
            success: true,
            output: `Definition of '${symbol}':\n${locations.map(formatLocation).join("\n")}`,
          };
        }

        case "references": {
          if (!symbol) {
            return {
              success: false,
              output: "symbol is required for references lookup",
              error: "missing symbol",
            };
          }
          if (!file) {
            return {
              success: false,
              output: "file is required for references lookup",
              error: "missing file",
            };
          }

          const refs = await router.executeWithFallback(language, "findReferences", (b) =>
            b.findReferences ? b.findReferences(file, symbol) : Promise.resolve(null),
          );

          if (!refs || refs.length === 0) {
            return {
              success: false,
              output: `No references found for '${symbol}'`,
              error: "not found",
            };
          }

          return {
            success: true,
            output: `References to '${symbol}' (${String(refs.length)}):\n${refs.map(formatLocation).join("\n")}`,
          };
        }

        case "symbols": {
          if (!file) {
            return {
              success: false,
              output: "file is required for symbol listing",
              error: "missing file",
            };
          }

          const symbols = await router.executeWithFallback(language, "findSymbols", (b) =>
            b.findSymbols ? b.findSymbols(file, args.scope) : Promise.resolve(null),
          );

          if (!symbols || symbols.length === 0) {
            return { success: true, output: "No symbols found" };
          }

          return {
            success: true,
            output: `Symbols in ${file} (${String(symbols.length)}):\n${symbols.map(formatSymbol).join("\n")}`,
          };
        }

        case "imports": {
          if (!file) {
            return {
              success: false,
              output: "file is required for import listing",
              error: "missing file",
            };
          }

          const imports = await router.executeWithFallback(language, "findImports", (b) =>
            b.findImports ? b.findImports(file) : Promise.resolve(null),
          );

          if (!imports || imports.length === 0) {
            return { success: true, output: "No imports found" };
          }

          const lines = imports.map((imp) => {
            const specs = imp.specifiers.length > 0 ? ` { ${imp.specifiers.join(", ")} }` : "";
            return `${imp.source}${specs} — line ${String(imp.location.line)}`;
          });
          return {
            success: true,
            output: `Imports in ${file} (${String(imports.length)}):\n${lines.join("\n")}`,
          };
        }

        case "exports": {
          if (!file) {
            return {
              success: false,
              output: "file is required for export listing",
              error: "missing file",
            };
          }

          const exports = await router.executeWithFallback(language, "findExports", (b) =>
            b.findExports ? b.findExports(file) : Promise.resolve(null),
          );

          if (!exports || exports.length === 0) {
            return { success: true, output: "No exports found" };
          }

          const lines = exports.map((exp) => {
            const def = exp.isDefault ? " (default)" : "";
            return `${exp.kind} ${exp.name}${def} — line ${String(exp.location.line)}`;
          });
          return {
            success: true,
            output: `Exports from ${file} (${String(exports.length)}):\n${lines.join("\n")}`,
          };
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
