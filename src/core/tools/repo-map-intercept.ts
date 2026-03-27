import { relative } from "node:path";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface InterceptResult {
  intercepted: true;
  success: true;
  output: string;
  /** Signals the UI to show this as a repo-map interception */
  repoMapHit: true;
}

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
}

interface NavigateArgs {
  action: string;
  symbol?: string;
  query?: string;
  file?: string;
  scope?: string;
}

const INTERCEPTABLE_NAVIGATE_ACTIONS = new Set(["workspace_symbols", "search_symbols"]);
const MIN_SYMBOL_LEN = 3;
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const READ_CODE_TARGETS = new Set(["function", "class", "type", "interface", "variable", "enum"]);

/** Map repo-map kind to read_file target. Returns null if no direct mapping. */
function kindToTarget(kind: string): string | null {
  if (READ_CODE_TARGETS.has(kind)) return kind;
  if (kind === "method") return "function";
  return null;
}

/** Escape SQL LIKE special characters in user input */
function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function isCleanIdentifier(pattern: string): string | null {
  const cleaned = pattern.replace(/[\\^$.*+?()[\]{}|]/g, "");
  if (cleaned.length < MIN_SYMBOL_LEN) return null;
  if (!IDENTIFIER_RE.test(cleaned)) return null;
  return cleaned;
}

function formatMatches(
  matches: Array<{ path: string; kind: string; isExported: boolean; pagerank: number }>,
  cwd: string,
): string {
  return matches
    .map((m) => {
      const rel = relative(cwd, m.path);
      const exp = m.isExported ? "+" : " ";
      return `  ${exp} ${rel} (${m.kind})`;
    })
    .join("\n");
}

interface GlobArgs {
  pattern: string;
  path?: string;
}

/**
 * Convert a glob pattern to a SQL LIKE pattern for repo map file matching.
 * Handles: ** → %, * → %, exact segments.
 */
function globToLike(pattern: string): string | null {
  // Bail on brace expansion — too complex for LIKE translation
  if (pattern.includes("{")) return null;

  const normalized = pattern.replace(/\\/g, "/");

  // Escape SQL LIKE special chars in the literal portions before converting glob wildcards
  const escaped = normalized.replace(/%/g, "\\%").replace(/_/g, "\\_");

  // Replace glob wildcards with SQL LIKE wildcards
  let like = escaped
    .replace(/\*\*\//g, "%") // **/ → %
    .replace(/\/\*\*/g, "/%") // /** → /%
    .replace(/\*\*/g, "%") // remaining ** → %
    .replace(/\*/g, "%"); // * → %

  // Collapse multiple % into one
  like = like.replace(/%+/g, "%");

  // Must have at least one non-wildcard segment to be useful
  const meaningful = like.replace(/%/g, "").replace(/\./g, "");
  if (meaningful.length < 2) return null;

  // Ensure leading % for patterns that start with wildcards
  if (!like.startsWith("%") && !like.startsWith("/")) {
    like = `%${like}`;
  }

  return like;
}

export async function tryInterceptGlob(
  args: GlobArgs,
  repoMap: IntelligenceClient | undefined,
  cwd: string,
): Promise<InterceptResult | null> {
  if (!repoMap || !repoMap.isReady) return null;

  const like = globToLike(args.pattern);
  if (!like) return null;

  const matches = await repoMap.matchFiles(like);
  if (matches.length === 0) return null;

  const fileList = matches.map((p: string) => `  ${relative(cwd, p)}`).join("\n");
  const output =
    `SOUL MAP — ${String(matches.length)} indexed file${matches.length === 1 ? "" : "s"} match "${args.pattern}":\n${fileList}\n` +
    `Use read_file on these paths directly — dispatch is not needed. Glob was skipped.`;

  return { intercepted: true, success: true, output, repoMapHit: true };
}

function formatSubstringMatches(
  matches: Array<{ name: string; path: string; kind: string; isExported: boolean }>,
  cwd: string,
): string {
  return matches
    .map((m) => {
      const rel = relative(cwd, m.path);
      const exp = m.isExported ? "+" : " ";
      return `  ${exp} ${m.name} → ${rel} (${m.kind})`;
    })
    .join("\n");
}

export async function tryInterceptDiscoverPattern(
  args: { query: string; file?: string },
  repoMap: IntelligenceClient | undefined,
  cwd: string,
): Promise<InterceptResult | null> {
  if (!repoMap || !repoMap.isReady) return null;
  if (args.file) return null;

  const query = args.query.toLowerCase();
  const safeQuery = escapeLike(query);

  // Exact symbol match first
  const exactMatches = await repoMap.findSymbols(query);

  // Substring symbol match (e.g. "provider" → "createOpenAIProvider", "ProviderConfig")
  const substringMatches =
    exactMatches.length === 0 ? await repoMap.searchSymbolsSubstring(query) : [];

  // File path match
  const fileMatches = await repoMap.matchFiles(`%${safeQuery}%`, 10);

  if (exactMatches.length === 0 && substringMatches.length === 0 && fileMatches.length === 0)
    return null;

  const parts: string[] = [`SOUL MAP — discover "${args.query}":`];

  if (exactMatches.length > 0) {
    parts.push(`\nExact symbols (${String(exactMatches.length)}):`);
    parts.push(formatMatches(exactMatches, cwd));
  }

  if (substringMatches.length > 0) {
    parts.push(`\nSymbols containing "${query}" (${String(substringMatches.length)}):`);
    parts.push(formatSubstringMatches(substringMatches, cwd));
  }

  if (fileMatches.length > 0) {
    parts.push(`\nFiles matching "${query}" (${String(fileMatches.length)}):`);
    parts.push(fileMatches.map((p: string) => `  ${relative(cwd, p)}`).join("\n"));
  }

  parts.push(
    "\nUse read_file on these paths directly — dispatch is not needed for reading indexed files.",
  );

  return {
    intercepted: true,
    success: true,
    output: parts.join("\n"),
    repoMapHit: true,
  };
}

export async function tryInterceptGrep(
  args: GrepArgs,
  repoMap: IntelligenceClient | undefined,
  cwd: string,
): Promise<InterceptResult | null> {
  if (!repoMap || !repoMap.isReady) return null;

  // Skip when scoped searches — those are legitimate usage lookups
  if (args.glob || args.path) return null;

  // Handle compound patterns: "Foo|Bar" — check each part
  const parts = args.pattern.split("|");
  if (parts.length > 1) {
    // For compound patterns, add hints but don't block
    return null;
  }

  const symbolName = isCleanIdentifier(args.pattern);
  if (!symbolName) return null;

  // Try exact match first
  const exactMatches = await repoMap.findSymbols(symbolName);
  if (exactMatches.length > 0) {
    const matchList = formatMatches(exactMatches, cwd);
    const bestMatch = exactMatches[0] as { path: string; kind: string };
    const bestRel = relative(cwd, bestMatch.path);

    const bestTarget = kindToTarget(bestMatch.kind);
    const readHint = bestTarget
      ? `read_file(${bestTarget}, "${symbolName}", "${bestRel}")`
      : `read_file("${bestRel}")`;

    const output =
      exactMatches.length === 1
        ? `SOUL MAP — "${symbolName}" is indexed at ${bestRel} (${bestMatch.kind}). ` +
          `Use ${readHint} to read it directly. ` +
          `Grep was skipped — the soul map already knows this symbol's location.`
        : `SOUL MAP — "${symbolName}" found in ${String(exactMatches.length)} files:\n${matchList}\n` +
          `Use read_file with the correct file path. Grep was skipped.`;

    return { intercepted: true, success: true, output, repoMapHit: true };
  }

  // Fall back to substring match — "provider" finds "createOpenAIProvider", "ProviderConfig", etc.
  const substringMatches = await repoMap.searchSymbolsSubstring(symbolName);
  if (substringMatches.length > 0) {
    const matchList = formatSubstringMatches(substringMatches, cwd);
    const output =
      `SOUL MAP — no exact symbol "${symbolName}", but ${String(substringMatches.length)} symbol${substringMatches.length === 1 ? "" : "s"} contain it:\n${matchList}\n` +
      `Use read_file with the correct symbol name and file path. Grep was skipped.`;

    return { intercepted: true, success: true, output, repoMapHit: true };
  }

  return null;
}

export async function tryInterceptNavigate(
  args: NavigateArgs,
  repoMap: IntelligenceClient | undefined,
  cwd: string,
): Promise<InterceptResult | null> {
  if (!repoMap || !repoMap.isReady) return null;

  if (!INTERCEPTABLE_NAVIGATE_ACTIONS.has(args.action)) return null;

  const query = args.query ?? args.symbol;
  if (!query) return null;

  const symbolName = isCleanIdentifier(query);
  if (!symbolName) return null;

  // Exact match
  const exactMatches = await repoMap.findSymbols(symbolName);
  if (exactMatches.length > 0) {
    const matchList = formatMatches(exactMatches, cwd);
    const bestMatch = exactMatches[0] as { path: string; kind: string };
    const bestRel = relative(cwd, bestMatch.path);
    const bestTarget = kindToTarget(bestMatch.kind);
    const readHint = bestTarget
      ? `read_file(${bestTarget}, "${symbolName}", "${bestRel}")`
      : `read_file("${bestRel}")`;

    const output =
      exactMatches.length === 1
        ? `SOUL MAP — "${symbolName}" is indexed at ${bestRel} (${bestMatch.kind}). ` +
          `Use ${readHint} directly. ` +
          `${args.action} was skipped.`
        : `SOUL MAP — "${symbolName}" found in ${String(exactMatches.length)} files:\n${matchList}\n` +
          `Use read_file with the correct file. ${args.action} was skipped.`;

    return { intercepted: true, success: true, output, repoMapHit: true };
  }

  // Substring match
  const substringMatches = await repoMap.searchSymbolsSubstring(symbolName);
  if (substringMatches.length > 0) {
    const matchList = formatSubstringMatches(substringMatches, cwd);
    const output =
      `SOUL MAP — no exact symbol "${symbolName}", but ${String(substringMatches.length)} symbol${substringMatches.length === 1 ? "" : "s"} contain it:\n${matchList}\n` +
      `Use read_file with the correct symbol name and file path. ${args.action} was skipped.`;

    return { intercepted: true, success: true, output, repoMapHit: true };
  }

  return null;
}
