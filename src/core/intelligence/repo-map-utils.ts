import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { IGNORED_DIRS } from "../context/file-tree.js";
import { isForbidden } from "../security/forbidden.js";
import type { Language, SymbolKind } from "./types.js";

export const INDEXABLE_EXTENSIONS: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".m": "objc",
  ".el": "elisp",
  ".res": "rescript",
  ".resi": "rescript",
  ".sol": "solidity",
  ".tla": "tlaplus",
  ".vue": "vue",
  // Additional extensions from EXT_TO_LANGUAGE
  ".pyw": "python",
  ".erb": "ruby",
  // Config/data files — no AST symbols, but tracked in the map
  ".json": "unknown",
  ".jsonc": "unknown",
  ".yaml": "unknown",
  ".yml": "unknown",
  ".toml": "unknown",
  ".xml": "unknown",
  ".md": "unknown",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".sql": "unknown",
  ".graphql": "unknown",
  ".gql": "unknown",
  ".proto": "unknown",
  ".env": "unknown",
  ".conf": "unknown",
  ".ini": "unknown",
  ".cfg": "unknown",
  ".dockerfile": "unknown",
};

/** Languages that are tracked in the file list but should not produce identifier-based refs.
 *  They have no meaningful AST symbols and their text content (JSON keys, YAML fields, markdown prose)
 *  would pollute the cross-file reference graph with false edges. */
export const NON_CODE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "unknown",
  "css",
  "html",
  "json",
  "toml",
  "yaml",
  "dockerfile",
]);

/**
 * Languages where we can reliably track cross-file imports via tree-sitter queries.
 * Files in other languages should not be classified as "dead" because we can't
 * determine their usage via import graph analysis alone — they may be loaded
 * via filesystem, process spawn, runtime include, or other non-import mechanisms.
 */
export const IMPORT_TRACKABLE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "dart",
  "ocaml",
  "objc",
  "solidity",
]);

const BARREL_RE = /\/(index\.(ts|js|tsx|mts|mjs)|__init__\.py|mod\.rs)$/;

export function barrelToDir(barrelPath: string): string {
  return barrelPath.replace(BARREL_RE, "");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function extractSignature(lines: string[], lineIdx: number, kind: string): string | null {
  const line = lines[lineIdx];
  if (!line) return null;

  let sig = line.trimStart();

  // For functions/methods, capture up to the opening brace or end of params
  if (kind === "function" || kind === "method") {
    // If the signature spans multiple lines (params not closed), grab up to 2 more
    if (!sig.includes(")") && !sig.includes("{") && !sig.includes("=>")) {
      for (let i = 1; i <= 2; i++) {
        const next = lines[lineIdx + i];
        if (!next) break;
        sig += ` ${next.trim()}`;
        if (next.includes(")") || next.includes("{")) break;
      }
    }
  }

  // Strip body: remove everything after opening brace
  const braceIdx = sig.indexOf("{");
  if (braceIdx > 0) sig = sig.slice(0, braceIdx).trimEnd();

  // Strip trailing body markers
  sig = sig.replace(/\s*[{:]\s*$/, "").trimEnd();

  // Cap length for token budget
  if (sig.length > 120) sig = `${sig.slice(0, 117)}...`;

  return sig || null;
}

export function kindTag(kind: SymbolKind): string {
  switch (kind) {
    case "function":
    case "method":
      return "f:";
    case "class":
      return "c:";
    case "interface":
      return "i:";
    case "type":
      return "t:";
    case "variable":
    case "constant":
      return "v:";
    case "enum":
      return "e:";
    default:
      return "";
  }
}

/**
 * Extract a doc comment immediately above the symbol line and return
 * a one-line summary (max 80 chars). Handles:
 * - JSDoc/Javadoc: /** ... * /
 * - Rust/Go/C#: /// or // comment block
 * - Python: docstring (first """...""" or '''...''' inside function body)
 * - Hash comments: # comment block (Ruby, Python standalone)
 */
export function extractDocComment(lines: string[], symbolLineIdx: number): string | null {
  // --- Python docstring: first line inside the body ---
  const symbolLine = lines[symbolLineIdx];
  if (symbolLine && /^\s*(def |class |async def )/.test(symbolLine)) {
    for (let k = symbolLineIdx + 1; k < Math.min(symbolLineIdx + 3, lines.length); k++) {
      const trimmed = lines[k]?.trim() ?? "";
      const tripleMatch = /^("""|''')(.*)/.exec(trimmed);
      if (tripleMatch) {
        const quote = tripleMatch[1] as string;
        const rest = tripleMatch[2] ?? "";
        if (rest.includes(quote)) {
          return trimDocLine(rest.slice(0, rest.indexOf(quote)));
        }
        const docLines = [rest];
        for (let j = k + 1; j < Math.min(k + 10, lines.length); j++) {
          const dl = lines[j]?.trim() ?? "";
          if (dl.includes(quote)) {
            docLines.push(dl.slice(0, dl.indexOf(quote)));
            break;
          }
          docLines.push(dl);
        }
        return trimDocLine(docLines.filter(Boolean).join(" "));
      }
      if (trimmed) break;
    }
  }

  // --- JSDoc / Javadoc: /** ... */ above symbol ---
  for (let k = symbolLineIdx - 1; k >= Math.max(0, symbolLineIdx - 2); k--) {
    const trimmed = lines[k]?.trim() ?? "";
    if (trimmed === "" || trimmed === "*/" || trimmed.startsWith("*/")) continue;
    if (trimmed.startsWith("*/")) continue;
    if (trimmed.endsWith("*/")) {
      // Single-line /** summary */
      const m = /^\/\*\*?\s*(.*?)\s*\*\/$/.exec(trimmed);
      if (m?.[1]) return trimDocLine(m[1]);
    }
    if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      // Find closing */
      const collected: string[] = [];
      const firstContent = trimmed
        .replace(/^\/\*\*?\s*/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (firstContent) collected.push(firstContent);
      for (let j = k + 1; j < symbolLineIdx; j++) {
        const cl = (lines[j]?.trim() ?? "")
          .replace(/^\*\s?/, "")
          .replace(/\*\/\s*$/, "")
          .trim();
        if (cl.startsWith("@")) break;
        if (cl) collected.push(cl);
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }
    break;
  }

  // --- /// doc comments (Rust) or // comment block (Go, TS) ---
  let commentEnd = symbolLineIdx - 1;
  if (commentEnd >= 0 && (lines[commentEnd]?.trim() ?? "") === "") commentEnd--;
  if (commentEnd >= 0) {
    const first = lines[commentEnd]?.trim() ?? "";
    if (first.startsWith("///") || first.startsWith("//")) {
      const isTriple = first.startsWith("///");
      const prefix = isTriple ? "///" : "//";
      const collected: string[] = [];
      let k = commentEnd;
      while (k >= 0 && (lines[k]?.trim() ?? "").startsWith(prefix)) {
        collected.unshift((lines[k]?.trim() ?? "").slice(prefix.length).trim());
        k--;
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }

    // --- # comment block (Ruby, Python) ---
    if (first.startsWith("#") && !first.startsWith("#!")) {
      const collected: string[] = [];
      let k = commentEnd;
      while (k >= 0 && (lines[k]?.trim() ?? "").startsWith("#")) {
        collected.unshift((lines[k]?.trim() ?? "").slice(1).trim());
        k--;
      }
      if (collected.length > 0) return trimDocLine(collected.join(" "));
    }
  }

  return null;
}

function trimDocLine(text: string): string | null {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s || s.length < 5) return null;
  if (s.length > 80) s = `${s.slice(0, 77)}...`;
  return s;
}

function splitIdentifier(name: string): string[] {
  if (name.includes("_"))
    return name
      .split("_")
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .map((w) => w.toLowerCase());
}

export function generateSyntheticSummary(name: string, kind: string, filePath: string): string {
  const words = splitIdentifier(name);
  const parts = filePath.split("/");
  const dir = parts.length >= 2 ? parts[parts.length - 2] : "";
  const kindLabel = kind === "function" || kind === "method" ? kind : kind;
  const summary = `${dir ? `[${dir}] ` : ""}${kindLabel}: ${words.join(" ")}`;
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
}

export function getDirGroup(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length < 2) return null;
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null);
}

export async function collectFiles(dir: string, depth = 0): Promise<CollectedFile[]> {
  if (depth > MAX_DEPTH) return [];
  const files: CollectedFile[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          files.push(...(await collectFiles(fullPath, depth + 1)));
        }
      } else if (entry.isFile()) {
        if (isForbidden(fullPath)) continue;
        const ext = extname(entry.name).toLowerCase();
        if (ext in INDEXABLE_EXTENSIONS) {
          try {
            const s = await stat(fullPath);
            if (s.size < MAX_FILE_SIZE) files.push({ path: fullPath, mtimeMs: s.mtimeMs });
          } catch {}
        }
      }
      if (files.length % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } catch {}
  return files;
}

interface CollectedFile {
  path: string;
  mtimeMs: number;
}

export const MAX_FILE_SIZE = 500_000;

const MAX_DEPTH = 10;

export const MAX_REFS_PER_FILE = 5000;

export const PAGERANK_ITERATIONS = 20;

export const PAGERANK_DAMPING = 0.85;

export const DEFAULT_TOKEN_BUDGET = 2500;

export const MIN_TOKEN_BUDGET = 1500;

export const MAX_TOKEN_BUDGET = 4000;

export const DIRTY_DEBOUNCE_MS = 500;

export const GIT_LOG_COMMITS = 300;

export const MAX_COCHANGE_FILES_PER_COMMIT = 20;

export const MAX_INDEXED_FILES = 10_000;
