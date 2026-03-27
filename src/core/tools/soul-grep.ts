import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";
import { getVendoredPath } from "../setup/install.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { enrichWithSymbolContext } from "./grep.js";

const ENRICHMENT_TIMEOUT_MS = 2000;
const MAX_SEARCH_OUTPUT_BYTES = 32_000;

const DEP_DIRS = [
  "node_modules",
  "vendor",
  ".venv/lib",
  "venv/lib",
  "__pypackages__",
  "site-packages",
  ".cargo/registry",
  "Packages",
  "pkg/mod",
  "bower_components",
];

function resolveDepPath(dep: string, explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (typeof dep === "string" && dep.length > 0 && dep !== "true") {
    for (const dir of DEP_DIRS) {
      const candidate = `${dir}/${dep}`;
      if (existsSync(candidate)) return candidate;
    }
    return `node_modules/${dep}`;
  }
  return ".";
}

interface SoulGrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  count?: boolean;
  wordBoundary?: boolean;
  maxCount?: number;
  dep?: string;
}

export const soulGrepTool = {
  name: "soul_grep",
  description:
    "Token-efficient search with count mode and word-boundary matching. Count mode returns per-file counts. Non-count mode includes symbol context.",
  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulGrepArgs): Promise<ToolResult> => {
      const { pattern, count, wordBoundary, dep } = args;
      const searchPath = dep ? resolveDepPath(dep, args.path) : (args.path ?? ".");

      if (!dep && count && wordBoundary && repoMap?.isReady && !args.path && !args.glob) {
        const intercept = await tryIntelligenceClientCount(repoMap, pattern);
        if (intercept) return intercept;
      }

      const rgBin = getVendoredPath("rg") ?? "rg";
      const rgArgs: string[] = [
        "--color=never",
        "--max-filesize=256K",
        "--max-columns=1000",
        "--glob=!*.js.map",
        "--glob=!*.css.map",
      ];

      if (dep) rgArgs.push("--no-ignore");
      if (wordBoundary) rgArgs.push("--word-regexp");

      if (count) {
        rgArgs.push("--count", "--with-filename");
        if (args.glob) rgArgs.push("--glob", args.glob);
        rgArgs.push(pattern, searchPath);
        return runCount(rgBin, rgArgs);
      }

      rgArgs.push("--line-number", "--with-filename");
      rgArgs.push(`--max-count=${String(args.maxCount ?? 50)}`);
      if (args.glob) rgArgs.push("--glob", args.glob);
      rgArgs.push(pattern, searchPath);
      return runSearch(rgBin, rgArgs);
    };
  },
};

async function tryIntelligenceClientCount(
  repoMap: IntelligenceClient,
  pattern: string,
): Promise<ToolResult | null> {
  if (/[^a-zA-Z0-9_$]/.test(pattern)) return null;

  const freq = await repoMap.getIdentifierFrequency(500);
  const match = freq.find((f: { name: string; fileCount: number }) => f.name === pattern);
  if (!match) return null;

  const symbols = await repoMap.findSymbols(pattern);
  const lines = [
    `${pattern}: referenced in ${String(match.fileCount)} files (from soul map index)`,
  ];

  if (symbols.length > 0) {
    lines.push("");
    lines.push(`Defined in ${String(symbols.length)} location(s):`);
    for (const sym of symbols.slice(0, 10)) {
      if (isForbidden(sym.path) !== null) continue;
      lines.push(`  ${sym.path} (${sym.kind}, pagerank: ${sym.pagerank.toFixed(3)})`);
    }
  }

  const nearby = freq
    .filter((f: { name: string; fileCount: number }) => f.name !== pattern)
    .slice(0, 5);
  if (nearby.length > 0) {
    lines.push("");
    lines.push("Top identifiers for comparison:");
    for (const n of nearby) {
      lines.push(`  ${n.name} — ${String(n.fileCount)} files`);
    }
  }

  return { success: true, output: lines.join("\n") };
}

function isFileForbidden(filePath: string): boolean {
  return isForbidden(filePath) !== null;
}

function filterForbiddenLines(output: string): string {
  if (output === "No matches found.") return output;
  const lines = output.split("\n");
  const filtered = lines.filter((line) => {
    const fileMatch = line.match(/^(.+?):\d+:/);
    if (!fileMatch?.[1]) return true;
    return !isFileForbidden(fileMatch[1]);
  });
  return filtered.length > 0 ? filtered.join("\n") : "No matches found.";
}

function runCount(bin: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: process.cwd(), timeout: 15_000 });
    const chunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));

    proc.on("close", (code: number | null) => {
      if (code !== 0 && code !== 1) {
        resolve({ success: false, output: "ripgrep failed", error: `exit ${String(code)}` });
        return;
      }

      const raw = chunks.join("");
      if (!raw.trim()) {
        resolve({ success: true, output: "0 matches." });
        return;
      }

      const entries: Array<{ file: string; count: number }> = [];
      let total = 0;
      for (const line of raw.split("\n")) {
        const m = line.match(/^(.+):(\d+)$/);
        if (m?.[1] && m[2]) {
          if (isFileForbidden(m[1])) continue;
          const c = parseInt(m[2], 10);
          entries.push({ file: m[1], count: c });
          total += c;
        }
      }

      entries.sort((a, b) => b.count - a.count);

      const top = entries.slice(0, 25);
      const lines = [
        `${String(total)} matches across ${String(entries.length)} files`,
        "",
        ...top.map((e) => `  ${String(e.count).padStart(5)}  ${e.file}`),
      ];
      if (entries.length > 25) {
        lines.push(`  ... and ${String(entries.length - 25)} more files`);
      }

      resolve({ success: true, output: lines.join("\n") });
    });

    proc.on("error", (err: Error) => {
      resolve({ success: false, output: err.message, error: err.message });
    });
  });
}

async function runSearch(bin: string, args: string[]): Promise<ToolResult> {
  const rawOutput = await new Promise<string>((resolve) => {
    const proc = spawn(bin, args, { cwd: process.cwd(), timeout: 10_000 });
    const chunks: string[] = [];
    let totalBytes = 0;
    proc.stdout.on("data", (d: Buffer) => {
      totalBytes += d.length;
      if (totalBytes <= MAX_SEARCH_OUTPUT_BYTES) {
        chunks.push(d.toString());
      }
    });

    proc.on("close", (code: number | null) => {
      let output = chunks.join("");
      if (totalBytes > MAX_SEARCH_OUTPUT_BYTES) {
        output = output.slice(0, MAX_SEARCH_OUTPUT_BYTES);
        const lastNl = output.lastIndexOf("\n");
        if (lastNl > 0) output = output.slice(0, lastNl);
        output += `\n[output capped — narrow with glob or path params]`;
      }
      if (code === 0 || code === 1) {
        resolve(output || "No matches found.");
      } else {
        resolve(output || "No matches found.");
      }
    });

    proc.on("error", () => {
      resolve("No matches found.");
    });
  });

  const sanitized = filterForbiddenLines(rawOutput);

  const enriched = await Promise.race([
    enrichWithSymbolContext(sanitized).catch(() => sanitized),
    new Promise<string>((r) => setTimeout(() => r(sanitized), ENRICHMENT_TIMEOUT_MS)),
  ]);

  return { success: true, output: enriched };
}
