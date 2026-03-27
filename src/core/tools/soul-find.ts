import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface SoulFindArgs {
  query: string;
  type?: string;
  limit?: number;
}

export const soulFindTool = {
  name: "soul_find",
  description: "Fuzzy file and symbol search ranked by importance. Supports multi-word queries.",

  createExecute: (repoMap?: IntelligenceClient) => {
    return async (args: SoulFindArgs): Promise<ToolResult> => {
      const { query } = args;
      const limit = args.limit ?? 20;
      const cwd = process.cwd();

      const repoMapResults = repoMap?.isReady
        ? await searchIntelligenceClient(repoMap, query, cwd, limit)
        : null;

      if (repoMapResults && repoMapResults.length > 0) {
        const symbolDetails = await buildSymbolDetails(repoMap, repoMapResults);
        return { success: true, output: symbolDetails };
      }

      const fileResults = await fuzzyFileSearch(query, args.type, limit);
      if (!fileResults.length) {
        return { success: true, output: `No files matching "${query}".` };
      }

      const enriched = repoMap?.isReady
        ? await enrichWithSymbols(repoMap, fileResults, cwd)
        : fileResults.map((f: string) => `  ${relative(cwd, resolve(f))}`).join("\n");

      return {
        success: true,
        output: `${String(fileResults.length)} files matching "${query}":\n\n${enriched}`,
      };
    };
  },
};

interface RankedFile {
  path: string;
  relPath: string;
  score: number;
  matchType: "symbol" | "file" | "both";
  symbols: Array<{ name: string; kind: string }>;
}

async function searchIntelligenceClient(
  repoMap: IntelligenceClient,
  query: string,
  cwd: string,
  limit: number,
): Promise<RankedFile[]> {
  const fileMap = new Map<string, RankedFile>();
  const words = query.split(/\s+/).filter((w: string) => w.length >= 2);
  const primaryWord = words[0] ?? query;

  const exactSymbols = await repoMap.findSymbols(primaryWord);
  for (const sym of exactSymbols) {
    const rel = relative(cwd, sym.path);
    upsertFile(fileMap, rel, sym.path, sym.pagerank + 10, { name: primaryWord, kind: sym.kind });
  }

  const substringSymbols = await repoMap.searchSymbolsSubstring(primaryWord, 30);
  for (const sym of substringSymbols) {
    const rel = relative(cwd, sym.path);
    upsertFile(fileMap, rel, sym.path, sym.pagerank + 3, { name: sym.name, kind: sym.kind });
  }

  for (const word of words.slice(1)) {
    const extra = await repoMap.searchSymbolsSubstring(word, 15);
    for (const sym of extra) {
      const rel = relative(cwd, sym.path);
      const existing = fileMap.get(rel);
      if (existing) {
        existing.score += sym.pagerank + 5;
        if (!existing.symbols.some((s) => s.name === sym.name)) {
          existing.symbols.push({ name: sym.name, kind: sym.kind });
        }
      }
    }
  }

  const safeQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const fileMatches = await repoMap.matchFiles(`%${safeQuery}%`, 30);
  for (const absPath of fileMatches) {
    const rel = relative(cwd, absPath);
    const nameScore = fuzzyScoreMultiWord(words, rel);
    const existing = fileMap.get(rel);
    if (existing) {
      existing.score += nameScore;
      existing.matchType = "both";
    } else {
      fileMap.set(rel, {
        path: absPath,
        relPath: rel,
        score: nameScore,
        matchType: "file",
        symbols: [],
      });
    }
  }

  if (words.length > 1) {
    for (const word of words) {
      const wordSafe = word.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const wordFiles = await repoMap.matchFiles(`%${wordSafe}%`, 15);
      for (const absPath of wordFiles) {
        const rel = relative(cwd, absPath);
        if (!fileMap.has(rel)) {
          fileMap.set(rel, {
            path: absPath,
            relPath: rel,
            score: fuzzyScore(word, rel),
            matchType: "file",
            symbols: [],
          });
        }
      }
    }
  }

  const topFiles = [...fileMap.values()]
    .filter((f: RankedFile) => f.score > 0)
    .sort((a: RankedFile, b: RankedFile) => b.score - a.score)
    .slice(0, 5);

  for (const top of topFiles) {
    const cochanges = await repoMap.getFileCoChanges(top.relPath);
    for (const co of cochanges) {
      if (isForbidden(co.path) !== null) continue;
      const existing = fileMap.get(co.path);
      if (existing) {
        existing.score += Math.min(co.count, 5);
      } else {
        fileMap.set(co.path, {
          path: resolve(cwd, co.path),
          relPath: co.path,
          score: Math.min(co.count, 3),
          matchType: "file",
          symbols: [],
        });
      }
    }
  }

  return [...fileMap.values()]
    .filter((f: RankedFile) => isForbidden(f.relPath) === null && isForbidden(f.path) === null)
    .sort((a: RankedFile, b: RankedFile) => b.score - a.score)
    .slice(0, limit);
}

function upsertFile(
  map: Map<string, RankedFile>,
  rel: string,
  absPath: string,
  scoreDelta: number,
  sym: { name: string; kind: string },
): void {
  const existing = map.get(rel);
  if (existing) {
    existing.score += scoreDelta;
    if (!existing.symbols.some((s) => s.name === sym.name)) {
      existing.symbols.push(sym);
    }
    existing.matchType = "both";
  } else {
    map.set(rel, {
      path: absPath,
      relPath: rel,
      score: scoreDelta,
      matchType: "symbol",
      symbols: [sym],
    });
  }
}

async function buildSymbolDetails(
  repoMap: IntelligenceClient | undefined,
  results: RankedFile[],
): Promise<string> {
  const lines: string[] = [`${String(results.length)} results:\n`];

  for (const r of results) {
    lines.push(`  ${r.relPath}`);

    if (repoMap) {
      const matchedNames = new Set(r.symbols.map((s: { name: string; kind: string }) => s.name));
      for (const sym of r.symbols.slice(0, 4)) {
        const sigs = await repoMap.getSymbolSignature(sym.name);
        const sig = sigs.find(
          (s: { path: string; signature: string | null }) =>
            s.path === r.relPath || s.path.endsWith(`/${r.relPath}`),
        );
        lines.push(`    ${sig?.signature ?? `${sym.kind} ${sym.name}`}`);
      }
      const allFileSymbols = await repoMap.getFileSymbols(r.relPath);
      const extra = allFileSymbols
        .filter((fs: { name: string }) => !matchedNames.has(fs.name))
        .slice(0, 3);
      if (extra.length > 0) {
        lines.push(`    also: ${extra.map((s: { name: string }) => s.name).join(", ")}`);
      }
    } else {
      for (const sym of r.symbols.slice(0, 4)) {
        lines.push(`    ${sym.kind} ${sym.name}`);
      }
    }
  }

  lines.push("\nUse read_file(path, target, name) for precise symbol reading.");
  return lines.join("\n");
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === lastMatch + 1) {
        consecutive++;
        score += consecutive;
      } else {
        consecutive = 0;
      }
      const prev = t[ti - 1];
      if (ti === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ".") {
        score += 5;
      }
      lastMatch = ti;
      qi++;
    }
  }

  return qi === q.length ? score : 0;
}

function fuzzyScoreMultiWord(words: string[], target: string): number {
  if (words.length <= 1) return fuzzyScore(words[0] ?? "", target);
  let total = 0;
  let matchedAll = true;
  for (const word of words) {
    const s = fuzzyScore(word, target);
    if (s === 0) matchedAll = false;
    total += s;
  }
  if (matchedAll) total *= 1.5;
  return total;
}

const TYPE_GLOBS: Record<string, string[]> = {
  test: ["*.test.*", "*.spec.*", "*_test.*", "*_spec.*", "*_tests.*"],
  component: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"],
  config: ["*.config.*", "*.json", "*.yaml", "*.yml", "*.toml", "*.ini", "*.env*"],
  types: ["*.d.ts", "types.*", "types/*", "*.pyi", "*.rbi"],
  style: ["*.css", "*.scss", "*.less", "*.sass", "*.styled.*"],
};

const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "target",
  "vendor",
  ".turbo",
  "coverage",
];

async function fuzzyFileSearch(
  query: string,
  typeFilter: string | undefined,
  limit: number,
): Promise<string[]> {
  const files = await listFiles(typeFilter);
  if (files.length === 0) return [];

  const words = query.split(/\s+/).filter((w) => w.length >= 2);
  const scored = files
    .filter((f) => isForbidden(f) === null)
    .map((f) => ({ file: f, score: fuzzyScoreMultiWord(words, f) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => s.file);
}

function listFiles(typeFilter: string | undefined): Promise<string[]> {
  return new Promise((res) => {
    const args = ["--type", "f", "--max-depth", "8"];

    if (typeFilter && TYPE_GLOBS[typeFilter]) {
      for (const g of TYPE_GLOBS[typeFilter]) {
        args.push("--glob", g);
      }
    }

    args.push("--max-results", "500");
    args.push(".");

    const proc = spawn("fd", args, { cwd: process.cwd(), timeout: 10_000 });
    const chunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        res(chunks.join("").split("\n").filter(Boolean));
      } else {
        fallbackFind(typeFilter).then(res);
      }
    });

    proc.on("error", () => {
      fallbackFind(typeFilter).then(res);
    });
  });
}

function fallbackFind(typeFilter: string | undefined): Promise<string[]> {
  return new Promise((res) => {
    const excludes = EXCLUDED_DIRS.flatMap((d) => ["-not", "-path", `*/${d}/*`]);
    const args = [".", "-type", "f", "-maxdepth", "5", ...excludes];

    if (typeFilter && TYPE_GLOBS[typeFilter]) {
      const globs = TYPE_GLOBS[typeFilter];
      const nameArgs = globs.flatMap((g, i) => (i === 0 ? ["-name", g] : ["-o", "-name", g]));
      args.push("(", ...nameArgs, ")");
    }

    const proc = spawn("find", args, { cwd: process.cwd(), timeout: 10_000 });
    const chunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));

    proc.on("close", () => {
      res(chunks.join("").split("\n").filter(Boolean).slice(0, 500));
    });

    proc.on("error", () => res([]));
  });
}

async function enrichWithSymbols(
  repoMap: IntelligenceClient,
  files: string[],
  cwd: string,
): Promise<string> {
  const results: string[] = [];
  for (const f of files) {
    const rel = relative(cwd, resolve(f));
    const syms = await repoMap.getFileSymbols(rel);
    const symStr =
      syms.length > 0
        ? `\n    ${syms
            .slice(0, 5)
            .map((s: { kind: string; name: string }) => `${s.kind} ${s.name}`)
            .join(", ")}`
        : "";
    results.push(`  ${rel}${symStr}`);
  }
  return results.join("\n");
}
