import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ToolResult } from "../../types";
import type { FileOutline, SymbolInfo } from "../intelligence/types.js";
import { isForbidden } from "../security/forbidden.js";
import { getVendoredPath } from "../setup/install.js";

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  maxCount?: number;
}

const ENRICHMENT_TIMEOUT_MS = 2000;
const MAX_SEARCH_OUTPUT_BYTES = 32_000;

export const grepTool = {
  name: "grep",
  description: "Search file contents with ripgrep regex patterns.",
  execute: async (args: GrepArgs): Promise<ToolResult> => {
    const pattern = args.pattern;
    const searchPath = args.path ?? ".";
    const glob = args.glob;

    const rgArgs = [
      "--line-number",
      "--color=never",
      "--max-filesize=256K",
      "--max-columns=1000",
      "--glob=!*.js.map",
      "--glob=!*.css.map",
      `--max-count=${String(args.maxCount ?? 50)}`,
      ...(glob ? ["--glob", glob] : []),
      pattern,
      searchPath,
    ];

    const rawOutput = await new Promise<string>((res) => {
      const rgBin = getVendoredPath("rg") ?? "rg";
      const proc = spawn(rgBin, rgArgs, {
        cwd: process.cwd(),
        timeout: 10_000,
      });

      const chunks: string[] = [];
      let totalBytes = 0;
      proc.stdout.on("data", (data: Buffer) => {
        totalBytes += data.length;
        if (totalBytes <= MAX_SEARCH_OUTPUT_BYTES) {
          chunks.push(data.toString());
        }
      });

      proc.on("close", (code: number | null) => {
        let output = chunks.join("");
        if (totalBytes > MAX_SEARCH_OUTPUT_BYTES) {
          output = output.slice(0, MAX_SEARCH_OUTPUT_BYTES);
          const lastNl = output.lastIndexOf("\n");
          if (lastNl > 0) output = output.slice(0, lastNl);
          output += `\n[truncated — ${String(Math.round((totalBytes - MAX_SEARCH_OUTPUT_BYTES) / 1024))}KB omitted. Use glob or path to narrow.]`;
        }
        if (code === 0 || code === 1) {
          res(output || "No matches found.");
        } else {
          const fallbackArgs = ["-rn", pattern, searchPath];
          if (glob) fallbackArgs.push("--include", glob);

          const grepProc = spawn("grep", fallbackArgs, {
            cwd: process.cwd(),
            timeout: 10_000,
          });

          const grepChunks: string[] = [];
          grepProc.stdout.on("data", (data: Buffer) => grepChunks.push(data.toString()));
          grepProc.on("close", () => {
            res(grepChunks.join("") || "No matches found.");
          });
        }
      });
    });

    const filtered =
      rawOutput === "No matches found."
        ? rawOutput
        : rawOutput
            .split("\n")
            .filter((line) => {
              const m = line.match(/^(.+?):\d+:/);
              return !m?.[1] || isForbidden(m[1]) === null;
            })
            .join("\n") || "No matches found.";

    const enriched = await Promise.race([
      enrichWithSymbolContext(filtered).catch(() => filtered),
      new Promise<string>((res) => setTimeout(() => res(filtered), ENRICHMENT_TIMEOUT_MS)),
    ]);

    // Hint: if pattern is a single identifier, navigate(references) is more precise
    const isIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pattern);
    const hint =
      isIdentifier && !glob
        ? `\n\n[Hint: for symbol references, navigate(action: references, symbol: "${pattern}") gives exact call sites without false positives.]`
        : "";

    return { success: true, output: enriched + hint };
  },
};

export async function enrichWithSymbolContext(output: string): Promise<string> {
  if (output === "No matches found.") return output;

  const { getIntelligenceRouter } = await import("../intelligence/index.js");
  const router = getIntelligenceRouter(process.cwd());

  const hitsByFile = new Map<string, number[]>();
  for (const line of output.split("\n")) {
    const m = line.match(/^(.+?):(\d+):/);
    if (m?.[1] && m[2]) {
      const hits = hitsByFile.get(m[1]);
      if (hits) hits.push(parseInt(m[2], 10));
      else hitsByFile.set(m[1], [parseInt(m[2], 10)]);
    }
  }

  if (hitsByFile.size === 0 || hitsByFile.size > 10) return output;

  const outlines = new Map<string, FileOutline>();
  await Promise.all(
    [...hitsByFile.keys()].map(async (file) => {
      try {
        const abs = resolve(file);
        const lang = router.detectLanguage(abs);
        const ol = await router.executeWithFallback(lang, "getFileOutline", (b) =>
          b.getFileOutline ? b.getFileOutline(abs) : Promise.resolve(null),
        );
        if (ol) outlines.set(file, ol);
      } catch {}
    }),
  );

  if (outlines.size === 0) return output;

  const sections: string[] = [];
  for (const [file, lines] of hitsByFile) {
    const outline = outlines.get(file);
    if (!outline || outline.symbols.length === 0) continue;

    const symbolHits = new Map<string, { sym: SymbolInfo; count: number }>();
    for (const lineNum of lines) {
      const enclosing = findEnclosingSymbol(outline.symbols, lineNum);
      if (enclosing) {
        const key = `${enclosing.name}:${String(enclosing.location.line)}`;
        const existing = symbolHits.get(key);
        if (existing) existing.count++;
        else symbolHits.set(key, { sym: enclosing, count: 1 });
      }
    }

    if (symbolHits.size === 0) continue;
    sections.push(`${file}:`);
    for (const { sym, count } of symbolHits.values()) {
      const end = sym.location.endLine ? `-${String(sym.location.endLine)}` : "";
      const hits = count > 1 ? ` (${String(count)} hits)` : "";
      sections.push(`  ${sym.kind} ${sym.name} — ${String(sym.location.line)}${end}${hits}`);
    }
  }

  if (sections.length === 0) return output;
  return `${output}\n\n[Symbol context — use read_file(path, target, name) for precise reading]\n${sections.join("\n")}`;
}

function findEnclosingSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | null {
  let best: SymbolInfo | null = null;
  for (const sym of symbols) {
    const end = sym.location.endLine ?? sym.location.line;
    if (sym.location.line <= line && end >= line) {
      if (!best || sym.location.line > best.location.line) best = sym;
    }
  }
  return best;
}
