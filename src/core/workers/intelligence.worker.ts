import type { WorkerHandlerContext } from "./rpc.js";
import { createWorkerHandler } from "./rpc.js";

let repoMap: import("../intelligence/repo-map.js").RepoMap | null = null;
let highlighter: import("shiki").Highlighter | null = null;
let ctx: WorkerHandlerContext;

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  tf: "terraform",
  cs: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  objc: "objective-c",
};

const SHIKI_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "rust",
  "go",
  "bash",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "sql",
  "markdown",
  "ruby",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "php",
  "lua",
  "zig",
  "elixir",
  "haskell",
  "ocaml",
  "scala",
  "dart",
  "dockerfile",
  "graphql",
  "terraform",
  "vim",
  "diff",
  "ini",
  "xml",
] as const;

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase().trim();
  return LANG_ALIASES[lower] ?? lower;
}

async function ensureHighlighter() {
  if (highlighter) return highlighter;
  const { createHighlighter } = await import("shiki");
  highlighter = await createHighlighter({
    themes: ["catppuccin-mocha"],
    langs: [...SHIKI_LANGS],
  });
  return highlighter;
}

function requireRepoMap() {
  if (!repoMap) throw new Error("RepoMap not initialized — send init first");
  return repoMap;
}

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  // ── Core ──
  scan: async () => {
    await requireRepoMap().scan();
  },
  getCwd: () => requireRepoMap().getCwd(),
  close: async () => {
    await requireRepoMap().close();
    repoMap = null;
  },
  clear: () => requireRepoMap().clear(),

  // ── Semantic ──
  setSemanticMode: (mode: unknown) =>
    requireRepoMap().setSemanticMode(mode as "off" | "ast" | "synthetic" | "llm" | "full" | "on"),
  getSemanticMode: () => requireRepoMap().getSemanticMode(),
  isSemanticEnabled: () => requireRepoMap().isSemanticEnabled(),
  detectPersistedSemanticMode: () => requireRepoMap().detectPersistedSemanticMode(),
  generateAstSummaries: () => requireRepoMap().generateAstSummaries(),
  generateSyntheticSummaries: (limit: unknown) =>
    requireRepoMap().generateSyntheticSummaries(limit as number | undefined),
  clearFreeSummaries: () => requireRepoMap().clearFreeSummaries(),
  clearSemanticSummaries: () => requireRepoMap().clearSemanticSummaries(),
  getStaleSummaryCount: () => requireRepoMap().getStaleSummaryCount(),
  getSummaryBreakdown: () => requireRepoMap().getSummaryBreakdown(),

  generateSemanticSummaries: async (maxSymbols: unknown) => {
    const rm = requireRepoMap();
    rm.setSummaryGenerator(async (batch) => {
      return ctx.requestCallback<Array<{ name: string; summary: string }>>(
        "summaryGenerator",
        batch,
      );
    });
    const count = await rm.generateSemanticSummaries(maxSymbols as number | undefined);
    rm.setSummaryGenerator(null);
    return count;
  },

  // ── File Monitoring ──
  onFileChanged: (absPath: unknown) => requireRepoMap().onFileChanged(absPath as string),
  recheckModifiedFiles: () => requireRepoMap().recheckModifiedFiles(),

  // ── Render ──
  render: (opts: unknown) =>
    requireRepoMap().render(opts as import("../intelligence/repo-map.js").RepoMapOptions),

  // ── Symbol Lookup ──
  findSymbols: (name: unknown) => requireRepoMap().findSymbols(name as string),
  findSymbol: (name: unknown) => requireRepoMap().findSymbol(name as string),
  searchSymbolsSubstring: (query: unknown, limit: unknown) =>
    requireRepoMap().searchSymbolsSubstring(query as string, limit as number | undefined),
  getFileSymbols: (relPath: unknown) => requireRepoMap().getFileSymbols(relPath as string),
  getFileSymbolRanges: (relPath: unknown) =>
    requireRepoMap().getFileSymbolRanges(relPath as string),
  getSymbolSignature: (name: unknown) => requireRepoMap().getSymbolSignature(name as string),
  getSymbolsByKind: (kind: unknown, limit: unknown) =>
    requireRepoMap().getSymbolsByKind(kind as string, limit as number | undefined),

  // ── File Analysis ──
  matchFiles: (pattern: unknown, limit: unknown) =>
    requireRepoMap().matchFiles(pattern as string, limit as number | undefined),
  getFileDependents: (relPath: unknown) => requireRepoMap().getFileDependents(relPath as string),
  getFileDependencies: (relPath: unknown) =>
    requireRepoMap().getFileDependencies(relPath as string),
  getFileCoChanges: (relPath: unknown) => requireRepoMap().getFileCoChanges(relPath as string),
  getFileExportCount: (relPath: unknown) => requireRepoMap().getFileExportCount(relPath as string),
  getFileBlastRadius: (relPath: unknown) => requireRepoMap().getFileBlastRadius(relPath as string),
  getFilesByPackage: (pkg: unknown) => requireRepoMap().getFilesByPackage(pkg as string),
  listDirectory: (dirPath: unknown) => requireRepoMap().listDirectory(dirPath as string),

  // ── Code Analysis ──
  getIdentifierFrequency: (limit: unknown) =>
    requireRepoMap().getIdentifierFrequency(limit as number | undefined),
  getUnusedExports: (limit: unknown) =>
    requireRepoMap().getUnusedExports(limit as number | undefined),
  getTestOnlyExports: () => requireRepoMap().getTestOnlyExports(),
  getDeadBarrels: () => requireRepoMap().getDeadBarrels(),
  getRepeatedFragments: (limit: unknown) =>
    requireRepoMap().getRepeatedFragments(limit as number | undefined),
  getDuplicateStructures: (limit: unknown) =>
    requireRepoMap().getDuplicateStructures(limit as number | undefined),
  getNearDuplicates: (threshold: unknown, limit: unknown) =>
    requireRepoMap().getNearDuplicates(
      threshold as number | undefined,
      limit as number | undefined,
    ),
  getFileDuplicates: (relPath: unknown) => requireRepoMap().getFileDuplicates(relPath as string),
  getCallees: (symbolId: unknown) => requireRepoMap().getCallees(symbolId as number),

  // ── Stats ──
  getStats: () => requireRepoMap().getStats(),
  dbSizeBytes: () => requireRepoMap().dbSizeBytes(),
  getTopFiles: (limit: unknown) => requireRepoMap().getTopFiles(limit as number | undefined),
  getExternalPackages: (limit: unknown) =>
    requireRepoMap().getExternalPackages(limit as number | undefined),

  // ── Ready State ──
  getIsReady: () => requireRepoMap().isReady,

  // ── Shiki Highlighting ──
  codeToAnsi: async (code: unknown, lang: unknown) => {
    const hl = await ensureHighlighter();
    const normalized = lang ? normalizeLang(lang as string) : "text";
    const langId = hl.getLoadedLanguages().includes(normalized) ? normalized : "text";
    try {
      const RST = "\x1b[0m";
      const result = hl.codeToTokens(code as string, {
        lang: langId as import("shiki").BundledLanguage,
        theme: "catppuccin-mocha",
      });
      const lines: string[] = [];
      for (const line of result.tokens) {
        let lineStr = "";
        for (const token of line) {
          if (token.color) {
            const h = token.color.startsWith("#") ? token.color.slice(1) : token.color;
            const r = Number.parseInt(h.slice(0, 2), 16);
            const g = Number.parseInt(h.slice(2, 4), 16);
            const b = Number.parseInt(h.slice(4, 6), 16);
            lineStr += `\x1b[38;2;${String(r)};${String(g)};${String(b)}m${token.content}${RST}`;
          } else {
            lineStr += token.content;
          }
        }
        lines.push(lineStr);
      }
      return lines.join("\n");
    } catch {
      return code as string;
    }
  },

  codeToStyledTokens: async (code: unknown, lang: unknown) => {
    const hl = await ensureHighlighter();
    const normalized = lang ? normalizeLang(lang as string) : "text";
    const langId = hl.getLoadedLanguages().includes(normalized) ? normalized : "text";
    try {
      const result = hl.codeToTokens(code as string, {
        lang: langId as import("shiki").BundledLanguage,
        theme: "catppuccin-mocha",
      });
      return result.tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          color: token.color ?? undefined,
        })),
      );
    } catch {
      return (code as string).split("\n").map((line) => [{ content: line }]);
    }
  },

  isShikiLanguage: async (lang: unknown) => {
    const hl = await ensureHighlighter();
    const normalized = normalizeLang(lang as string);
    return hl.getLoadedLanguages().includes(normalized);
  },
};

ctx = createWorkerHandler(
  handlers,
  async (config) => {
    const { RepoMap } = await import("../intelligence/repo-map.js");
    repoMap = new RepoMap(config.cwd as string);

    repoMap.onProgress = (indexed, total) => {
      const rm = repoMap;
      if (!rm) return;
      const stats = rm.getStats();
      const dbSize = rm.dbSizeBytes();
      ctx.emit("progress", { indexed, total, stats, dbSize });
    };
    repoMap.onScanComplete = (success) => {
      const rm = repoMap;
      if (!rm) return;
      const stats = rm.getStats();
      const dbSize = rm.dbSizeBytes();
      ctx.emit("scan-complete", { success, stats, dbSize, isReady: rm.isReady });
    };
    repoMap.onStaleSymbols = (count) => {
      ctx.emit("stale-symbols", { count });
    };
  },
  async () => {
    if (repoMap) {
      await repoMap.close();
      repoMap = null;
    }
  },
);
