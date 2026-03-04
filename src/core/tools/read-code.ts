import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { SymbolKind } from "../intelligence/types.js";

type ReadTarget = "function" | "class" | "type" | "interface" | "scope";

interface ReadCodeArgs {
  target: ReadTarget;
  name?: string;
  file: string;
  startLine?: number;
  endLine?: number;
}

export const readCodeTool = {
  name: "read_code",
  description:
    "Read a specific code block (function, class, type, interface, or scope) from a file. " +
    "Returns just the targeted code, not the entire file. More precise and token-efficient " +
    "than read_file for understanding specific symbols.",
  execute: async (args: ReadCodeArgs): Promise<ToolResult> => {
    try {
      const router = getIntelligenceRouter(process.cwd());
      const file = resolve(args.file);
      const language = router.detectLanguage(file);

      if (args.target === "scope") {
        const startLine = args.startLine;
        if (!startLine) {
          return {
            success: false,
            output: "startLine is required for scope",
            error: "missing startLine",
          };
        }

        const block = await router.executeWithFallback(language, "readScope", (b) =>
          b.readScope ? b.readScope(file, startLine, args.endLine) : Promise.resolve(null),
        );

        if (!block) {
          return { success: false, output: "Could not read scope", error: "failed" };
        }

        const range = block.location.endLine
          ? `${String(block.location.line)}-${String(block.location.endLine)}`
          : String(block.location.line);
        return { success: true, output: `${file}:${range}\n\n${block.content}` };
      }

      // Symbol-based targets
      const name = args.name;
      if (!name) {
        return {
          success: false,
          output: `name is required for target '${args.target}'`,
          error: "missing name",
        };
      }

      const kindMap: Record<string, SymbolKind> = {
        function: "function",
        class: "class",
        type: "type",
        interface: "interface",
      };

      // Try with the requested kind first
      let block = await router.executeWithFallback(language, "readSymbol", (b) =>
        b.readSymbol ? b.readSymbol(file, name, kindMap[args.target]) : Promise.resolve(null),
      );

      // If not found with the specific kind, retry without kind filter.
      // e.g. user asks for "type HelpPopup" but it's actually a function component
      if (!block) {
        block = await router.executeWithFallback(language, "readSymbol", (b) =>
          b.readSymbol ? b.readSymbol(file, name) : Promise.resolve(null),
        );
      }

      if (!block) {
        return {
          success: false,
          output: `'${name}' not found in ${file}`,
          error: "not found",
        };
      }

      const range = block.location.endLine
        ? `${String(block.location.line)}-${String(block.location.endLine)}`
        : String(block.location.line);
      const header = block.symbolKind ? `${block.symbolKind} ${block.symbolName ?? name}` : name;
      return { success: true, output: `${header} — ${file}:${range}\n\n${block.content}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
