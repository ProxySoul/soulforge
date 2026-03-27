import { existsSync } from "node:fs";
import { access, stat as statAsync } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { isBinaryFile } from "isbinaryfile";
import type { ToolResult } from "../../types";
import { readBufferContent } from "../editor/instance";
import type { SymbolKind } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { binaryHint } from "./binary-detect.js";
import { emitFileRead } from "./file-events.js";

type ReadTarget = string;

interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  target?: ReadTarget;
  name?: string;
}

const MAX_READ_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_SIZE = 250 * 1024;

export const readFileTool = {
  name: "read_file",
  description:
    "[TIER-1] Read file contents with line numbers. Use Soul Map :line numbers to jump directly to symbols. " +
    "Supports startLine/endLine ranges, or target + name for AST-based symbol extraction. " +
    "TIPS: Read ALL needed files in a single parallel call. NEVER re-read a file you already have.",
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

      let fileStat: Awaited<ReturnType<typeof statAsync>>;
      try {
        fileStat = await statAsync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const msg =
          code === "EACCES" || code === "EPERM"
            ? `Permission denied: ${filePath}`
            : `File not found: ${filePath}`;
        return { success: false, output: msg, error: msg };
      }

      if (fileStat.isDirectory()) {
        return {
          success: false,
          output: `Path is a directory: ${filePath}`,
          error: `Path is a directory: ${filePath}`,
        };
      }

      if (await isBinaryFile(filePath)) {
        const ext = extname(filePath).toLowerCase();
        const sizeStr =
          fileStat.size > 1024 * 1024
            ? `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${(fileStat.size / 1024).toFixed(0)}KB`;
        const hint = binaryHint(ext);
        return {
          success: false,
          output: `Cannot read binary file: "${args.path}" (${ext || "no extension"}, ${sizeStr}).${hint}`,
          error: "binary",
        };
      }

      if (fileStat.size > MAX_READ_SIZE) {
        const sizeStr =
          fileStat.size > 1024 * 1024
            ? `${(fileStat.size / (1024 * 1024)).toFixed(1)}MB`
            : `${String(Math.round(fileStat.size / 1024))}KB`;
        return {
          success: false,
          output: `File too large (${sizeStr}). Maximum is ${String(MAX_READ_SIZE / 1024)}KB. Use startLine/endLine to read a specific range.`,
          error: "file too large",
        };
      }

      const content = await readBufferContent(filePath);
      const lines = content.split("\n");

      const start = (args.startLine ?? 1) - 1;
      const end = args.endLine ?? lines.length;
      let slice = lines.slice(start, end);

      const totalLines = lines.length;
      const truncated = slice.length > MAX_READ_LINES;
      if (truncated) slice = slice.slice(0, MAX_READ_LINES);

      const numbered = slice
        .map((line: string, i: number) => {
          const l = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
          return `${String(start + i + 1).padStart(4)}  ${l}`;
        })
        .join("\n");

      emitFileRead(filePath);

      let output = numbered;
      if (truncated) {
        output += `\n\n(File has ${String(totalLines)} lines. Showing first ${String(MAX_READ_LINES)}. Use startLine/endLine to read beyond line ${String(start + MAX_READ_LINES)})`;
      }

      return { success: true, output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

async function readSymbolFromFile(filePath: string, args: ReadFileArgs): Promise<ToolResult> {
  const blocked = isForbidden(filePath);
  if (blocked) {
    return {
      success: false,
      output: `Access denied: "${filePath}" matches forbidden pattern "${blocked}"`,
      error: "forbidden",
    };
  }

  if (!existsSync(filePath)) {
    return {
      success: false,
      output: `File not found: ${filePath}`,
      error: "not_found",
    };
  }

  try {
    await access(filePath);
  } catch {
    return {
      success: false,
      output: `File not found: ${filePath}`,
      error: `File not found: ${filePath}`,
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
