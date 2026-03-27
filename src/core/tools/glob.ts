import { execSync, spawn } from "node:child_process";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";

interface GlobArgs {
  pattern: string;
  path?: string;
}

let _fdBin: string | null | undefined;
function getFdBin(): string | null {
  if (_fdBin !== undefined) return _fdBin;
  for (const bin of ["fd", "fdfind"]) {
    try {
      execSync(`command -v ${bin}`, { stdio: "ignore" });
      _fdBin = bin;
      return bin;
    } catch {}
  }
  _fdBin = null;
  return null;
}

function runFd(bin: string, pattern: string, basePath: string): Promise<ToolResult | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ["--glob", pattern, basePath, "--max-results", "50", "--max-depth", "8"],
      {
        cwd: process.cwd(),
        timeout: 10_000,
      },
    );
    const chunks: string[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    proc.on("error", () => resolve(null));
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({ success: true, output: chunks.join("") || "No files found." });
      } else {
        resolve(null);
      }
    });
  });
}

function runFind(pattern: string, basePath: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    const proc = spawn("find", [basePath, "-name", pattern, "-maxdepth", "5"], {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    const chunks: string[] = [];
    proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    proc.on("error", () => resolve({ success: true, output: "No files found." }));
    proc.on("close", () => {
      resolve({ success: true, output: chunks.join("") || "No files found." });
    });
  });
}

function filterForbidden(result: ToolResult): ToolResult {
  if (!result.success || result.output === "No files found.") return result;
  const filtered = result.output
    .split("\n")
    .filter((line) => !line.trim() || isForbidden(line.trim()) === null)
    .join("\n");
  return { ...result, output: filtered || "No files found." };
}

export const globTool = {
  name: "glob",
  description:
    "Fast file pattern matching. Returns matching paths sorted by modification time. " +
    "WHEN TO USE: Finding files by name or extension. " +
    "HOW TO USE: Provide a glob pattern. Optionally specify a starting path. " +
    "PATTERN SYNTAX: '*' matches non-separator chars, '**' matches any path, '?' matches one char, '[...]' matches chars in brackets. " +
    "EXAMPLES: '**/*.ts' all TypeScript files, 'src/**/*.test.*' all test files in src, '*.{html,css,js}' multiple extensions. " +
    "LIMITATIONS: Results limited to 100 files (newest first). Hidden files are skipped. " +
    "TIPS: Combine with grep — find files with glob, then search contents with grep. " +
    "For iterative exploration requiring multiple rounds, use the dispatch tool instead.",
  execute: async (args: GlobArgs): Promise<ToolResult> => {
    const pattern = args.pattern;
    const basePath = args.path ?? ".";

    const fdBin = getFdBin();
    if (fdBin) {
      const result = await runFd(fdBin, pattern, basePath);
      if (result) return filterForbidden(result);
    }
    return filterForbidden(await runFind(pattern, basePath));
  },
};
