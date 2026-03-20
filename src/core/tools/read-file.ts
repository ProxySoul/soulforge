import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { readBufferContent } from "../editor/instance";
import type { SymbolKind } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { emitFileRead } from "./file-events.js";

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".lua",
  ".ex",
  ".exs",
  ".dart",
  ".zig",
]);

type ReadTarget = "function" | "class" | "type" | "interface" | "variable" | "enum" | "scope";

interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  target?: ReadTarget;
  name?: string;
}

const OUTLINE_THRESHOLD = 300;

export const readFileTool = {
  name: "read_file",
  description:
    "Read file contents, or read a specific symbol (function/class/type) by name. " +
    "Pass target + name for symbol extraction (AST-based). " +
    "Large files (300+ lines) return an outline first — use startLine=1 to read the full file.",
  execute: async (args: ReadFileArgs): Promise<ToolResult> => {
    try {
      const filePath = resolve(args.path);

      if (args.target) {
        return readSymbolFromFile(filePath, args);
      }

      const blocked = isForbidden(filePath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}". This file is blocked for security.`;
        return { success: false, output: msg, error: msg };
      }

      if (!existsSync(filePath)) {
        return {
          success: false,
          output: `File not found: ${filePath}`,
          error: `File not found: ${filePath}`,
        };
      }

      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return {
          success: false,
          output: `Path is a directory: ${filePath}`,
          error: `Path is a directory: ${filePath}`,
        };
      }

      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

      if (stat.size > MAX_FILE_SIZE && args.startLine == null && args.endLine == null) {
        const sizeStr = `${String(Math.round(stat.size / (1024 * 1024)))}MB`;
        const preview = Bun.file(filePath).stream();
        const decoder = new TextDecoder();
        const previewLines: string[] = [];
        let leftover = "";
        for await (const chunk of preview) {
          leftover += decoder.decode(chunk, { stream: true });
          const parts = leftover.split("\n");
          leftover = parts.pop() ?? "";
          for (const line of parts) {
            previewLines.push(line);
            if (previewLines.length >= 500) break;
          }
          if (previewLines.length >= 500) break;
        }
        const numbered = previewLines
          .map((line: string, i: number) => `${String(i + 1).padStart(4)}  ${line}`)
          .join("\n");

        emitFileRead(filePath);
        return {
          success: true,
          output: `${numbered}\n\n[Truncated — file is ${sizeStr}, showing first ${String(previewLines.length)} lines. Use startLine/endLine to read specific sections.]`,
        };
      }

      const content = await readBufferContent(filePath);
      const lines = content.split("\n");
      const isFullRead = args.startLine == null && args.endLine == null;

      if (
        isFullRead &&
        lines.length > OUTLINE_THRESHOLD &&
        CODE_EXTENSIONS.has(extname(filePath))
      ) {
        const outline = await getCompactOutline(filePath);
        if (outline) {
          const sizeKB = Math.round(stat.size / 1024);
          emitFileRead(filePath);
          return {
            success: true,
            output:
              `${outline}\n` +
              `[${String(lines.length)} lines, ${String(sizeKB)}KB — ` +
              `use target + name to read a symbol, startLine/endLine for a range, or startLine=1 for the full file]`,
            outlineOnly: true,
          };
        }
      }

      const start = (args.startLine ?? 1) - 1;
      const end = args.endLine ?? lines.length;
      const slice = lines.slice(start, end);

      const numbered = slice
        .map((line: string, i: number) => `${String(start + i + 1).padStart(4)}  ${line}`)
        .join("\n");

      emitFileRead(filePath);

      if (isFullRead && lines.length > 100 && CODE_EXTENSIONS.has(extname(filePath))) {
        const outline = await getCompactOutline(filePath);
        if (outline) return { success: true, output: `${outline}\n${numbered}` };
      }

      return { success: true, output: numbered };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

const TOP_LEVEL_KINDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "constant",
  "method",
  "property",
]);

async function getCompactOutline(filePath: string): Promise<string | null> {
  try {
    const { getIntelligenceRouter } = await import("../intelligence/index.js");
    const router = getIntelligenceRouter(process.cwd());
    const language = router.detectLanguage(filePath);
    const outline = await router.executeWithFallback(language, "getFileOutline", (b) =>
      b.getFileOutline ? b.getFileOutline(filePath) : Promise.resolve(null),
    );
    if (!outline || outline.symbols.length === 0) return null;

    // Only include meaningful symbols — skip callbacks, locals, JSX noise.
    // Works across all languages: TS/JS, Python, Go, Rust, Java, C#, etc.
    const meaningful = outline.symbols.filter((s) => {
      if (!TOP_LEVEL_KINDS.has(s.kind)) return false;
      if (s.name.length <= 1) return false;
      // Skip string/char literals in any language
      if (/^["'`]/.test(s.name)) return false;
      // Skip anonymous/unnamed symbols
      if (s.name === "<unknown>" || s.name === "<function>") return false;
      // Skip callback/closure patterns (JS/TS specific but harmless elsewhere)
      if (s.name.includes("callback") || s.name.includes("() ")) return false;
      // Skip likely local variables — short names that are constants/variables
      // (keeps short class/function/type names like Go's `DB` or Rust's `Ok`)
      if ((s.kind === "constant" || s.kind === "variable") && s.name.length <= 3) return false;
      return true;
    });
    if (meaningful.length === 0) return null;

    // Sort by line number (top-level declarations first), cap at 25
    meaningful.sort((a, b) => a.location.line - b.location.line);
    const capped = meaningful.slice(0, 25);
    const symbolLines = capped.map((s) => {
      const end = s.location.endLine ? `-${String(s.location.endLine)}` : "";
      return `  ${s.kind} ${s.name} — ${String(s.location.line)}${end}`;
    });
    const more = meaningful.length > 30 ? `\n  ... +${String(meaningful.length - 30)} more` : "";

    return `[Outline: ${String(meaningful.length)} symbols — use target + name for targeted reading]\n${symbolLines.join("\n")}${more}\n`;
  } catch {
    return null;
  }
}

async function readSymbolFromFile(filePath: string, args: ReadFileArgs): Promise<ToolResult> {
  const blocked = isForbidden(filePath);
  if (blocked) {
    return {
      success: false,
      output: `Access denied: "${filePath}" matches forbidden pattern "${blocked}"`,
      error: "forbidden",
    };
  }

  const { getIntelligenceRouter } = await import("../intelligence/index.js");
  const router = getIntelligenceRouter(process.cwd());
  const language = router.detectLanguage(filePath);

  if (args.target === "scope") {
    const scopeStart = args.startLine;
    if (!scopeStart) {
      return {
        success: false,
        output: "startLine is required for scope",
        error: "missing startLine",
      };
    }
    const tracked = await router.executeWithFallbackTracked(language, "readScope", (b) =>
      b.readScope ? b.readScope(filePath, scopeStart, args.endLine) : Promise.resolve(null),
    );
    if (!tracked) {
      return { success: false, output: "Could not read scope", error: "failed" };
    }
    const block = tracked.value;
    const range = block.location.endLine
      ? `${String(block.location.line)}-${String(block.location.endLine)}`
      : String(block.location.line);
    emitFileRead(filePath);
    return {
      success: true,
      output: `${filePath}:${range}\n\n${block.content}`,
      backend: tracked.backend,
    };
  }

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
    variable: "variable",
    enum: "enum",
  };

  const targetKind = kindMap[args.target as string];
  let tracked = await router.executeWithFallbackTracked(language, "readSymbol", (b) =>
    b.readSymbol ? b.readSymbol(filePath, name, targetKind) : Promise.resolve(null),
  );

  if (!tracked) {
    tracked = await router.executeWithFallbackTracked(language, "readSymbol", (b) =>
      b.readSymbol ? b.readSymbol(filePath, name) : Promise.resolve(null),
    );
  }

  if (!tracked) {
    return { success: false, output: `'${name}' not found in ${filePath}`, error: "not found" };
  }

  const block = tracked.value;
  const range = block.location.endLine
    ? `${String(block.location.line)}-${String(block.location.endLine)}`
    : String(block.location.line);
  const header = block.symbolKind ? `${block.symbolKind} ${block.symbolName ?? name}` : name;
  emitFileRead(filePath);
  return {
    success: true,
    output: `${header} — ${filePath}:${range}\n\n${block.content}`,
    backend: tracked.backend,
  };
}
