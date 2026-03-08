import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { isForbidden } from "../security/forbidden.js";
import type { Language, SymbolKind } from "./types.js";

const INDEXABLE_EXTENSIONS: Record<string, Language> = {
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
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  // Config/data files — no AST symbols, but tracked in the map
  ".json": "unknown",
  ".yaml": "unknown",
  ".yml": "unknown",
  ".toml": "unknown",
  ".xml": "unknown",
  ".md": "unknown",
  ".css": "unknown",
  ".scss": "unknown",
  ".html": "unknown",
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

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  "target",
  ".soulforge",
  ".cache",
]);

const MAX_FILE_SIZE = 500_000;
const MAX_DEPTH = 10;
const MAX_REFS_PER_FILE = 500;
const PAGERANK_ITERATIONS = 20;
const PAGERANK_DAMPING = 0.85;
const DEFAULT_TOKEN_BUDGET = 2500;
const MIN_TOKEN_BUDGET = 1500;
const MAX_TOKEN_BUDGET = 4000;
const DIRTY_DEBOUNCE_MS = 500;
const GIT_LOG_COMMITS = 300;
const MAX_COCHANGE_FILES_PER_COMMIT = 20;

const IDENTIFIER_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "export",
  "import",
  "from",
  "return",
  "async",
  "await",
  "new",
  "this",
  "super",
  "extends",
  "implements",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "string",
  "number",
  "boolean",
  "any",
  "never",
  "unknown",
  "for",
  "while",
  "if",
  "else",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "throw",
  "finally",
  "default",
  "static",
  "private",
  "public",
  "protected",
  "readonly",
  "abstract",
  "override",
  "typeof",
  "instanceof",
  "delete",
  "yield",
  "enum",
  "declare",
  "module",
  "namespace",
  "require",
  "def",
  "self",
  "None",
  "True",
  "False",
  "elif",
  "except",
  "raise",
  "pass",
  "with",
  "lambda",
  "func",
  "struct",
  "impl",
  "trait",
  "pub",
  "mod",
  "use",
  "crate",
  "mut",
  "ref",
  "match",
  "where",
  "package",
  "range",
  "defer",
  "chan",
  "select",
  "map",
  "make",
  "append",
  "len",
  "cap",
  "println",
  "fmt",
]);

interface FileRow {
  id: number;
  path: string;
  mtime_ms: number;
  language: string;
  line_count: number;
  symbol_count: number;
  pagerank: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  line: number;
  end_line: number;
  is_exported: number;
  signature: string | null;
}

interface EdgeRow {
  source_file_id: number;
  target_file_id: number;
  weight: number;
}

export interface RepoMapOptions {
  tokenBudget?: number;
  mentionedFiles?: string[];
  editedFiles?: string[];
  editorFile?: string | null;
  conversationTerms?: string[];
  conversationTokens?: number;
}

export interface SymbolForSummary {
  name: string;
  kind: string;
  signature: string | null;
  code: string;
  filePath: string;
}

export type SummaryGenerator = (
  batch: SymbolForSummary[],
) => Promise<Array<{ name: string; summary: string }>>;

export class RepoMap {
  private db: Database;
  private cwd: string;
  private scanPromise: Promise<void> | null = null;
  private treeSitter:
    | typeof import("./backends/tree-sitter.js").TreeSitterBackend.prototype
    | null = null;
  private ready = false;
  private dirty = false;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private hasGit: boolean | null = null;
  private seenPaths = new Set<string>();
  private entryPointsCache: string[] | null = null;
  private semanticMode: "off" | "ast" | "llm" = "off";
  private summaryGenerator: SummaryGenerator | null = null;
  onProgress: ((indexed: number, total: number) => void) | null = null;
  onScanComplete: ((success: boolean) => void) | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    const dbDir = join(cwd, ".soulforge");
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    const dbPath = join(dbDir, "repomap.db");
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(dbPath + suffix, 0o600);
      } catch {}
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        line_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        pagerank REAL NOT NULL DEFAULT 0.0
      );
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_pagerank ON files(pagerank DESC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        is_exported INTEGER NOT NULL DEFAULT 0,
        signature TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    `);

    // Migration: add signature column if missing
    try {
      this.db.run("ALTER TABLE symbols ADD COLUMN signature TEXT");
    } catch {
      // Column already exists
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS edges (
        source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (source_file_id, target_file_id)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS refs (
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
      CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cochanges (
        file_id_a INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        file_id_b INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (file_id_a, file_id_b)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS external_imports (
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        package TEXT NOT NULL,
        specifiers TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (file_id, package)
      );
      CREATE INDEX IF NOT EXISTS idx_ext_imports_pkg ON external_imports(package);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS semantic_summaries (
        symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'llm',
        summary TEXT NOT NULL,
        file_mtime REAL NOT NULL,
        PRIMARY KEY (symbol_id, source)
      );
    `);
    this.migrateSemanticSource();

    this.rebuildFts();
  }

  private migrateSemanticSource(): void {
    try {
      const cols = this.db
        .query<{ name: string }, []>("PRAGMA table_info(semantic_summaries)")
        .all();
      if (cols.length > 0 && !cols.some((c) => c.name === "source")) {
        this.db.run("DROP TABLE semantic_summaries");
        this.db.run(`
          CREATE TABLE semantic_summaries (
            symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
            source TEXT NOT NULL DEFAULT 'llm',
            summary TEXT NOT NULL,
            file_mtime REAL NOT NULL,
            PRIMARY KEY (symbol_id, source)
          );
        `);
      }
    } catch {
      // fresh db or already migrated
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  async scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.doScan();
    return this.scanPromise;
  }

  private async doScan(): Promise<void> {
    try {
      const files = collectFiles(this.cwd);

      const existingFiles = new Map<string, { id: number; mtime_ms: number }>();
      for (const row of this.db
        .query<{ id: number; path: string; mtime_ms: number }, []>(
          "SELECT id, path, mtime_ms FROM files",
        )
        .all()) {
        existingFiles.set(row.path, { id: row.id, mtime_ms: row.mtime_ms });
      }

      const currentPaths = new Set<string>();
      const toIndex: { absPath: string; relPath: string; mtime: number; language: Language }[] = [];

      for (const file of files) {
        const relPath = relative(this.cwd, file.path);
        currentPaths.add(relPath);

        const existing = existingFiles.get(relPath);
        if (existing && existing.mtime_ms === file.mtimeMs) continue;
        const ext = extname(file.path).toLowerCase();
        const language = INDEXABLE_EXTENSIONS[ext] ?? "unknown";
        toIndex.push({ absPath: file.path, relPath, mtime: file.mtimeMs, language });
      }

      const stale = [...existingFiles.keys()].filter((p) => !currentPaths.has(p));
      if (stale.length > 0) {
        const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
        const tx = this.db.transaction(() => {
          for (const p of stale) deleteFile.run(p);
        });
        tx();
      }

      if (toIndex.length > 0) {
        await this.ensureTreeSitter();
        for (let i = 0; i < toIndex.length; i++) {
          const file = toIndex[i];
          if (file) {
            try {
              await this.indexFile(file.absPath, file.relPath, file.mtime, file.language);
            } catch {
              // skip files that fail to index
            }
          }
          if (this.onProgress && i % 10 === 0) this.onProgress(i + 1, toIndex.length);
        }
        this.onProgress?.(toIndex.length, toIndex.length);
      }

      if (toIndex.length > 0 || stale.length > 0) {
        this.buildEdges();
        this.computePageRank();
      }

      this.buildCoChanges();

      this.compactIfNeeded();
      this.ready = true;
      this.onScanComplete?.(true);
    } catch (err) {
      this.onScanComplete?.(false);
      throw err;
    } finally {
      this.scanPromise = null;
    }
  }

  private async ensureTreeSitter(): Promise<void> {
    if (this.treeSitter) return;
    try {
      const { TreeSitterBackend } = await import("./backends/tree-sitter.js");
      const backend = new TreeSitterBackend();
      await Promise.race([
        backend.initialize(this.cwd),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("tree-sitter init timeout")), 15_000),
        ),
      ]);
      this.treeSitter = backend;
    } catch {
      // tree-sitter unavailable — files will be indexed without AST symbols
    }
  }

  private async indexFile(
    absPath: string,
    relPath: string,
    mtime: number,
    language: Language,
  ): Promise<void> {
    const existing = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);

    if (existing) {
      this.db.query("DELETE FROM symbols WHERE file_id = ?").run(existing.id);
      this.db.query("DELETE FROM refs WHERE file_id = ?").run(existing.id);
      this.db.query("DELETE FROM external_imports WHERE file_id = ?").run(existing.id);
      this.db
        .query("DELETE FROM edges WHERE source_file_id = ? OR target_file_id = ?")
        .run(existing.id, existing.id);
    }

    let lineCount = 0;
    let content: string;
    try {
      content = require("node:fs").readFileSync(absPath, "utf-8");
      lineCount = content.split("\n").length;
    } catch {
      return;
    }

    let outline: import("./types.js").FileOutline | null = null;
    if (this.treeSitter) {
      try {
        outline =
          (await Promise.race([
            this.treeSitter.getFileOutline(absPath),
            new Promise<null>((r) => setTimeout(r, 5_000, null)),
          ])) ?? null;
      } catch {
        // skip file on parse error
      }
    }
    const symbolCount = outline?.symbols.length ?? 0;

    if (existing) {
      this.db
        .query(
          "UPDATE files SET mtime_ms = ?, language = ?, line_count = ?, symbol_count = ? WHERE id = ?",
        )
        .run(mtime, language, lineCount, symbolCount, existing.id);
    } else {
      this.db
        .query(
          "INSERT INTO files (path, mtime_ms, language, line_count, symbol_count) VALUES (?, ?, ?, ?, ?)",
        )
        .run(relPath, mtime, language, lineCount, symbolCount);
    }

    const fileId =
      existing?.id ??
      (this.db.query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?").get(relPath)
        ?.id as number);

    if (outline) {
      const insertSym = this.db.prepare(
        "INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const exportedNames = new Set(outline.exports.map((e) => e.name));
      const seen = new Set<string>();
      const lines = content.split("\n");

      const tx = this.db.transaction(() => {
        for (const sym of outline.symbols) {
          const key = `${sym.name}:${String(sym.location.line)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sig = extractSignature(lines, sym.location.line - 1, sym.kind);
          insertSym.run(
            fileId,
            sym.name,
            sym.kind,
            sym.location.line,
            sym.location.endLine ?? sym.location.line,
            exportedNames.has(sym.name) ? 1 : 0,
            sig,
          );
        }
      });
      tx();

      if (this.semanticMode === "ast") {
        this.extractAstSummaries(fileId, outline.symbols, exportedNames, lines, mtime);
      }
    }

    const identifiers = this.extractIdentifiers(content, language);
    if (identifiers.size > 0) {
      const insertRef = this.db.prepare("INSERT INTO refs (file_id, name) VALUES (?, ?)");
      const refs = [...identifiers].slice(0, MAX_REFS_PER_FILE);
      const tx = this.db.transaction(() => {
        for (const name of refs) {
          insertRef.run(fileId, name);
        }
      });
      tx();
    }

    if (outline && outline.imports.length > 0) {
      const extImports = new Map<string, Set<string>>();
      for (const imp of outline.imports) {
        if (
          imp.source.startsWith(".") ||
          imp.source.startsWith("/") ||
          imp.source.startsWith("node:") ||
          imp.source.startsWith("bun:")
        )
          continue;
        const pkg = imp.source.startsWith("@")
          ? imp.source.split("/").slice(0, 2).join("/")
          : (imp.source.split("/")[0] ?? imp.source);
        let specs = extImports.get(pkg);
        if (!specs) {
          specs = new Set();
          extImports.set(pkg, specs);
        }
        for (const s of imp.specifiers) specs.add(s);
      }
      if (extImports.size > 0) {
        const insertExt = this.db.prepare(
          "INSERT OR REPLACE INTO external_imports (file_id, package, specifiers) VALUES (?, ?, ?)",
        );
        const tx = this.db.transaction(() => {
          for (const [pkg, specs] of extImports) {
            insertExt.run(fileId, pkg, [...specs].join(","));
          }
        });
        tx();
      }
    }
  }

  private extractIdentifiers(content: string, language: Language): Set<string> {
    const ids = new Set<string>();
    const patterns: RegExp[] = [];

    if (
      language === "typescript" ||
      language === "javascript" ||
      language === "go" ||
      language === "rust"
    ) {
      patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
      patterns.push(/\b([a-z][a-zA-Z0-9_]{2,})\b/g);
    } else if (language === "python") {
      patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
      patterns.push(/\b([a-z][a-z0-9_]{2,})\b/g);
    }

    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const id = match[1];
        if (id && id.length > 2 && id.length < 60 && !IDENTIFIER_KEYWORDS.has(id)) {
          ids.add(id);
        }
      }
    }

    return ids;
  }

  private buildEdges(): void {
    this.db.run("DELETE FROM edges");

    const rows = this.db
      .query<
        {
          source_file_id: number;
          target_file_id: number;
          name: string;
          ref_count: number;
          def_count: number;
        },
        []
      >(
        `SELECT r.file_id AS source_file_id, s.file_id AS target_file_id,
                r.name, COUNT(*) AS ref_count,
                (SELECT COUNT(*) FROM symbols s2 WHERE s2.name = r.name AND s2.is_exported = 1) AS def_count
         FROM refs r
         JOIN symbols s ON r.name = s.name
         WHERE r.file_id != s.file_id
           AND s.is_exported = 1
         GROUP BY r.file_id, s.file_id, r.name`,
      )
      .all();

    const totalFiles =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files").get()?.c ?? 1;

    const edgeWeights = new Map<string, number>();
    for (const row of rows) {
      const name = row.name;
      // IDF: symbols defined in many files are generic (low specificity)
      const idf = Math.log(totalFiles / Math.max(1, row.def_count));
      let mul = Math.max(0.5, idf / Math.log(totalFiles));
      const isCamelOrSnake = /[a-z][A-Z]/.test(name) || name.includes("_");
      if (isCamelOrSnake && name.length >= 8) mul *= 3;
      if (name.startsWith("_")) mul *= 0.1;
      const w = Math.sqrt(row.ref_count) * mul;

      const key = `${String(row.source_file_id)}:${String(row.target_file_id)}`;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + w);
    }

    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO edges (source_file_id, target_file_id, weight) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const [key, weight] of edgeWeights) {
        const [src, tgt] = key.split(":");
        insert.run(Number(src), Number(tgt), weight);
      }
    });
    tx();
  }

  private computePageRank(personalization?: Map<number, number>): void {
    const files = this.db.query<{ id: number }, []>("SELECT id FROM files").all();
    if (files.length === 0) return;

    const n = files.length;
    const idToIdx = new Map<number, number>();
    const ids: number[] = [];
    for (const file of files) {
      idToIdx.set(file.id, ids.length);
      ids.push(file.id);
    }

    const outWeight: number[] = new Array(n).fill(0);
    const adj: Array<{ from: number; to: number; weight: number }> = [];

    const edges = this.db
      .query<EdgeRow, []>("SELECT source_file_id, target_file_id, weight FROM edges")
      .all();

    for (const edge of edges) {
      const src = idToIdx.get(edge.source_file_id);
      const tgt = idToIdx.get(edge.target_file_id);
      if (src !== undefined && tgt !== undefined) {
        const w = edge.weight || 1;
        adj.push({ from: src, to: tgt, weight: w });
        outWeight[src] = (outWeight[src] ?? 0) + w;
      }
    }

    // Build personalization vector (teleport distribution)
    // Blend: 70% uniform baseline + 30% context boost for balanced ranking
    const pv = new Float64Array(n);
    const uniform = 1 / n;
    if (personalization && personalization.size > 0) {
      let boostSum = 0;
      for (const [fileId, boost] of personalization) {
        const idx = idToIdx.get(fileId);
        if (idx !== undefined) {
          pv[idx] = boost;
          boostSum += boost;
        }
      }
      if (boostSum > 0) {
        for (let i = 0; i < n; i++) {
          pv[i] = 0.7 * uniform + 0.3 * ((pv[i] ?? 0) / boostSum);
        }
      } else {
        pv.fill(uniform);
      }
    } else {
      pv.fill(uniform);
    }

    let rank = new Float64Array(n).fill(1 / n);
    let next = new Float64Array(n);

    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      // Teleport to personalization distribution instead of uniform
      for (let j = 0; j < n; j++) next[j] = (1 - PAGERANK_DAMPING) * (pv[j] ?? 0);

      let danglingSum = 0;
      for (let i = 0; i < n; i++) {
        if ((outWeight[i] ?? 0) === 0) danglingSum += rank[i] ?? 0;
      }
      // Dangling nodes distribute to personalization vector
      for (let j = 0; j < n; j++) {
        next[j] = (next[j] ?? 0) + PAGERANK_DAMPING * danglingSum * (pv[j] ?? 0);
      }

      for (const { from, to, weight } of adj) {
        const contribution =
          (PAGERANK_DAMPING * (rank[from] ?? 0) * weight) / (outWeight[from] ?? 1);
        next[to] = (next[to] ?? 0) + contribution;
      }
      [rank, next] = [next, rank];
    }

    const update = this.db.prepare("UPDATE files SET pagerank = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        update.run(rank[i] ?? 0, ids[i] ?? 0);
      }
    });
    tx();
  }

  private detectGit(): boolean {
    if (this.hasGit !== null) return this.hasGit;
    try {
      execSync("git rev-parse --git-dir", { cwd: this.cwd, stdio: "pipe", timeout: 3000 });
      this.hasGit = true;
    } catch {
      this.hasGit = false;
    }
    return this.hasGit;
  }

  private buildCoChanges(): void {
    if (!this.detectGit()) return;

    this.db.run("DELETE FROM cochanges");

    let logOutput: string;
    try {
      logOutput = execSync(
        `git log --format="---COMMIT---" --name-only -n ${String(GIT_LOG_COMMITS)}`,
        { cwd: this.cwd, stdio: "pipe", timeout: 10_000, maxBuffer: 5_000_000 },
      ).toString();
    } catch {
      return;
    }

    const pathToId = new Map<string, number>();
    for (const row of this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all()) {
      pathToId.set(row.path, row.id);
    }

    const pairCounts = new Map<string, number>();
    const commits = logOutput.split("---COMMIT---").filter((s) => s.trim());

    for (const commit of commits) {
      const files = commit
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && pathToId.has(l));

      if (files.length < 2 || files.length > MAX_COCHANGE_FILES_PER_COMMIT) continue;

      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const a = files[i] as string;
          const b = files[j] as string;
          const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }

    if (pairCounts.size === 0) return;

    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const [key, count] of pairCounts) {
        if (count < 2) continue;
        const [a, b] = key.split("\0") as [string, string];
        const idA = pathToId.get(a);
        const idB = pathToId.get(b);
        if (idA !== undefined && idB !== undefined) {
          insert.run(idA, idB, count);
        }
      }
    });
    tx();
  }

  private getCoChangePartners(fileIds: Set<number>): Map<number, number> {
    if (fileIds.size === 0) return new Map();

    const partners = new Map<number, number>();
    const arr = [...fileIds];
    const placeholders = arr.map(() => "?").join(",");

    const rows = this.db
      .query<{ partner_id: number; total: number }, number[]>(
        `SELECT file_id_b AS partner_id, SUM(count) AS total FROM cochanges
         WHERE file_id_a IN (${placeholders})
         GROUP BY file_id_b
         UNION ALL
         SELECT file_id_a AS partner_id, SUM(count) AS total FROM cochanges
         WHERE file_id_b IN (${placeholders})
         GROUP BY file_id_a`,
      )
      .all(...arr, ...arr);

    for (const row of rows) {
      if (!fileIds.has(row.partner_id)) {
        partners.set(row.partner_id, (partners.get(row.partner_id) ?? 0) + row.total);
      }
    }
    return partners;
  }

  private getBlastRadius(fileIds: number[]): Map<number, number> {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ target_file_id: number; dependents: number }, number[]>(
        `SELECT target_file_id, COUNT(DISTINCT source_file_id) AS dependents
         FROM edges WHERE target_file_id IN (${placeholders})
         GROUP BY target_file_id`,
      )
      .all(...fileIds);

    const result = new Map<number, number>();
    for (const row of rows) result.set(row.target_file_id, row.dependents);
    return result;
  }

  private getEntryPoints(): string[] {
    if (this.entryPointsCache !== null) return this.entryPointsCache;
    this.entryPointsCache = [];
    try {
      const pkgPath = join(this.cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      for (const field of ["module", "main", "source"]) {
        if (typeof pkg[field] === "string") {
          this.entryPointsCache.push(pkg[field].replace(/^\.\//, ""));
        }
      }
      if (typeof pkg.bin === "string") {
        this.entryPointsCache.push(pkg.bin.replace(/^\.\//, ""));
      } else if (pkg.bin && typeof pkg.bin === "object") {
        for (const v of Object.values(pkg.bin)) {
          if (typeof v === "string") this.entryPointsCache.push(v.replace(/^\.\//, ""));
        }
      }
    } catch {}
    for (const p of ["src/main.rs", "src/lib.rs", "main.go"]) {
      if (existsSync(join(this.cwd, p))) this.entryPointsCache.push(p);
    }
    return this.entryPointsCache;
  }

  private getExternalDepsSummary(): string | null {
    const deps = this.db
      .query<{ package: string; file_count: number; all_specs: string | null }, []>(
        `SELECT package, COUNT(DISTINCT file_id) AS file_count,
                GROUP_CONCAT(specifiers) AS all_specs
         FROM external_imports
         GROUP BY package
         HAVING file_count >= 3
         ORDER BY file_count DESC
         LIMIT 8`,
      )
      .all();
    if (deps.length === 0) return null;

    const depLines: string[] = ["Key dependencies:"];
    for (const dep of deps) {
      const allSpecs = new Set<string>();
      if (dep.all_specs) {
        for (const s of dep.all_specs.split(",")) {
          if (s.trim()) allSpecs.add(s.trim());
        }
      }
      const topSpecs = [...allSpecs].slice(0, 5);
      const specStr =
        topSpecs.length > 0 ? ` (${topSpecs.join(", ")}${allSpecs.size > 5 ? ", …" : ""})` : "";
      depLines.push(`  ${dep.package}: ${String(dep.file_count)} files${specStr}`);
    }
    return depLines.join("\n");
  }

  setSemanticMode(mode: "off" | "ast" | "llm"): void {
    this.semanticMode = mode;
  }

  getSemanticMode(): "off" | "ast" | "llm" {
    return this.semanticMode;
  }

  isSemanticEnabled(): boolean {
    return this.semanticMode !== "off";
  }

  detectPersistedSemanticMode(): "off" | "ast" | "llm" {
    const llm =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'llm'",
        )
        .get()?.c ?? 0;
    if (llm > 0) return "llm";
    const ast =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'ast'",
        )
        .get()?.c ?? 0;
    if (ast > 0) return "ast";
    return "off";
  }

  setSummaryGenerator(generator: SummaryGenerator | null): void {
    this.summaryGenerator = generator;
  }

  generateAstSummaries(): number {
    if (!this.ready) return 0;
    const rows = this.db
      .query<
        {
          id: number;
          file_id: number;
          name: string;
          kind: string;
          line: number;
          path: string;
          mtime_ms: number;
        },
        []
      >(
        `SELECT s.id, s.file_id, s.name, s.kind, s.line, f.path, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.kind IN ('function','method','class','interface','type')
         ORDER BY f.pagerank DESC LIMIT 500`,
      )
      .all();

    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime) VALUES (?, 'ast', ?, ?)`,
    );
    let count = 0;
    const fileCache = new Map<string, string[]>();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let lines = fileCache.get(row.path);
        if (!lines) {
          try {
            const content = readFileSync(join(this.cwd, row.path), "utf-8");
            lines = content.split("\n");
            fileCache.set(row.path, lines);
          } catch {
            continue;
          }
        }
        const doc = extractDocComment(lines, row.line - 1);
        if (doc) {
          upsert.run(row.id, doc, row.mtime_ms);
          count++;
        }
      }
    });
    tx();
    return count;
  }

  clearSemanticSummaries(): void {
    this.db.run("DELETE FROM semantic_summaries");
  }

  async generateSemanticSummaries(maxSymbols = 100): Promise<number> {
    if (!this.summaryGenerator || !this.ready) return 0;

    const topSymbols = this.db
      .query<
        {
          sym_id: number;
          name: string;
          kind: string;
          signature: string | null;
          line: number;
          end_line: number;
          file_path: string;
          file_mtime: number;
        },
        [number]
      >(
        `SELECT s.id AS sym_id, s.name, s.kind, s.signature, s.line, s.end_line,
                f.path AS file_path, f.mtime_ms AS file_mtime
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.kind IN ('function', 'method', 'class', 'interface', 'type')
         ORDER BY f.pagerank DESC, s.line ASC
         LIMIT ?`,
      )
      .all(maxSymbols);

    // Filter to symbols that need (re)generation — only check LLM source
    const existing = new Map<number, number>();
    for (const row of this.db
      .query<{ symbol_id: number; file_mtime: number }, []>(
        "SELECT symbol_id, file_mtime FROM semantic_summaries WHERE source = 'llm'",
      )
      .all()) {
      existing.set(row.symbol_id, row.file_mtime);
    }

    const needed: Array<{
      symId: number;
      name: string;
      kind: string;
      signature: string | null;
      code: string;
      filePath: string;
      fileMtime: number;
    }> = [];

    for (const sym of topSymbols) {
      const cachedMtime = existing.get(sym.sym_id);
      if (cachedMtime === sym.file_mtime) continue;

      const absPath = join(this.cwd, sym.file_path);
      let code = "";
      try {
        const content = require("node:fs").readFileSync(absPath, "utf-8") as string;
        const lines = content.split("\n");
        const startLine = Math.max(0, sym.line - 1);
        // end_line often equals line (name node only) — expand to capture the body
        let endLine = sym.end_line;
        if (endLine <= sym.line) {
          // Scan forward for closing brace/dedent (heuristic: up to 60 lines)
          const limit = Math.min(startLine + 60, lines.length);
          let depth = 0;
          for (let k = startLine; k < limit; k++) {
            const l = lines[k] ?? "";
            for (const ch of l) {
              if (ch === "{" || ch === "(") depth++;
              else if (ch === "}" || ch === ")") depth--;
            }
            if (depth <= 0 && k > startLine) {
              endLine = k + 1;
              break;
            }
          }
          if (endLine <= sym.line) endLine = Math.min(startLine + 15, lines.length);
        }
        endLine = Math.min(lines.length, endLine);
        const snippet = lines.slice(startLine, endLine).join("\n");
        code = snippet.length > 1500 ? `${snippet.slice(0, 1500)}...` : snippet;
      } catch {
        continue;
      }

      needed.push({
        symId: sym.sym_id,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        code,
        filePath: sym.file_path,
        fileMtime: sym.file_mtime,
      });
    }

    if (needed.length === 0) return 0;

    // Batch generate summaries
    const batch: SymbolForSummary[] = needed.map((s) => ({
      name: s.name,
      kind: s.kind,
      signature: s.signature,
      code: s.code,
      filePath: s.filePath,
    }));

    const results = await this.summaryGenerator(batch);

    const summaryMap = new Map<string, string>();
    for (const r of results) summaryMap.set(r.name, r.summary);

    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime)
       VALUES (?, 'llm', ?, ?)`,
    );
    const symExists = this.db.prepare("SELECT 1 FROM symbols WHERE id = ?");
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const sym of needed) {
        const summary = summaryMap.get(sym.name);
        if (summary && symExists.get(sym.symId)) {
          upsert.run(sym.symId, summary, sym.fileMtime);
          count++;
        }
      }
    });
    tx();
    return count;
  }

  private extractAstSummaries(
    fileId: number,
    symbols: import("./types.js").SymbolInfo[],
    exportedNames: Set<string>,
    lines: string[],
    mtime: number,
  ): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime) VALUES (?, 'ast', ?, ?)`,
    );
    const symLookup = this.db.prepare<{ id: number }, [number, string, number]>(
      "SELECT id FROM symbols WHERE file_id = ? AND name = ? AND line = ?",
    );

    const summaryKinds = new Set(["function", "method", "class", "interface", "type"]);
    const tx = this.db.transaction(() => {
      for (const sym of symbols) {
        if (!exportedNames.has(sym.name)) continue;
        if (!summaryKinds.has(sym.kind)) continue;

        const doc = extractDocComment(lines, sym.location.line - 1);
        if (!doc) continue;

        const row = symLookup.get(fileId, sym.name, sym.location.line);
        if (row) upsert.run(row.id, doc, mtime);
      }
    });
    tx();
  }

  private getSemanticSummaries(symbolIds: number[]): Map<number, string> {
    if (!this.isSemanticEnabled() || symbolIds.length === 0) return new Map();
    const placeholders = symbolIds.map(() => "?").join(",");
    const source = this.semanticMode;
    const rows = this.db
      .query<{ symbol_id: number; summary: string }, [...number[], string]>(
        `SELECT symbol_id, summary FROM semantic_summaries WHERE symbol_id IN (${placeholders}) AND source = ?`,
      )
      .all(...symbolIds, source);
    const result = new Map<number, string>();
    for (const row of rows) result.set(row.symbol_id, row.summary);
    return result;
  }

  onFileChanged(absPath: string): void {
    const relPath = relative(this.cwd, absPath);

    if (relPath === "package.json" || relPath === "Cargo.toml" || relPath === "go.mod") {
      this.entryPointsCache = null;
    }

    const ext = extname(absPath).toLowerCase();
    const language = INDEXABLE_EXTENSIONS[ext];
    if (!language) return;

    try {
      const stat = statSync(absPath);
      this.ensureTreeSitter()
        .then(() => this.indexFile(absPath, relPath, stat.mtimeMs, language))
        .catch(() => {});
      this.markDirty();
    } catch {}
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
    }, DIRTY_DEBOUNCE_MS);
  }

  private flushIfDirty(): void {
    if (!this.dirty || this.dirtyTimer) return;
    this.dirty = false;
    this.buildEdges();
    this.computePageRank();
  }

  render(opts: RepoMapOptions = {}): string {
    this.flushIfDirty();

    // Recompute PageRank with personalization when we have conversation context
    const pv = this.buildPersonalization(opts);
    if (pv.size > 0) this.computePageRank(pv);

    const budget = this.computeBudget(opts.conversationTokens);
    const ranked = this.rankFiles(opts);
    if (ranked.length === 0) return "";

    const candidateIds = ranked.slice(0, 100).map((f) => f.id);
    const placeholders = candidateIds.map(() => "?").join(",");
    const allSymbols = this.db
      .query<SymbolRow, number[]>(
        `SELECT id, file_id, name, kind, line, end_line, is_exported, signature FROM symbols WHERE file_id IN (${placeholders}) AND kind != 'variable' AND kind != 'constant' ORDER BY file_id, line`,
      )
      .all(...candidateIds);

    const symbolsByFile = new Map<number, SymbolRow[]>();
    for (const sym of allSymbols) {
      let arr = symbolsByFile.get(sym.file_id);
      if (!arr) {
        arr = [];
        symbolsByFile.set(sym.file_id, arr);
      }
      arr.push(sym);
    }

    // Blast radius: how many files depend on each candidate
    const blastRadius = this.getBlastRadius(candidateIds);

    // Semantic summaries: load cached summaries for all candidate symbols
    const semanticMap = this.getSemanticSummaries(allSymbols.map((s) => s.id));

    // Diff-aware: [NEW] marks files the agent has never seen in any render
    const prevPathSet = this.seenPaths;

    // Pre-compute all file blocks for binary search
    const blocks: Array<{ path: string; fileLine: string; symbolLines: string; tokens: number }> =
      [];
    for (const file of ranked) {
      const radius = blastRadius.get(file.id);
      const radiusTag = radius && radius >= 2 ? ` (→${String(radius)})` : "";
      const newTag = prevPathSet.size > 0 && !prevPathSet.has(file.path) ? " [NEW]" : "";
      const fileLine = `${file.path}:${radiusTag}${newTag}`;
      const symbols = symbolsByFile.get(file.id) ?? [];
      let symbolLines = "";
      for (const sym of symbols) {
        const exported = sym.is_exported ? "+" : " ";
        const semantic = semanticMap.get(sym.id);
        const display = semantic
          ? `${sym.name} — ${semantic}`
          : (sym.signature ?? `${kindTag(sym.kind as SymbolKind)}${sym.name}`);
        symbolLines += `  ${exported}${display}\n`;
      }
      const blockTokens = estimateTokens(fileLine) + estimateTokens(symbolLines);
      blocks.push({ path: file.path, fileLine, symbolLines, tokens: blockTokens });
    }

    // Binary search: find the max number of blocks that fit within budget
    let lo = 1;
    let hi = Math.min(blocks.length, Math.ceil(budget / 5));
    let bestCount = 1;
    let bestTokens = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      let total = 0;
      for (let i = 0; i < mid; i++) total += blocks[i]?.tokens ?? 0;
      if (total <= budget) {
        bestCount = mid;
        bestTokens = total;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Try to squeeze in one more block if we have remaining budget
    if (bestCount < blocks.length) {
      const nextBlock = blocks[bestCount];
      if (nextBlock && bestTokens + nextBlock.tokens <= budget * 1.05) {
        bestCount++;
      }
    }

    // Directory coverage: ensure major directories aren't invisible
    const coverageBlocks: typeof blocks = [];
    {
      const representedDirs = new Set<string>();
      for (let i = 0; i < bestCount; i++) {
        const dir = getDirGroup(blocks[i]?.path ?? "");
        if (dir) representedDirs.add(dir);
      }
      const dirCounts = new Map<string, number>();
      for (const b of blocks) {
        const dir = getDirGroup(b.path);
        if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
      let usedTokens = 0;
      for (let i = 0; i < bestCount; i++) usedTokens += blocks[i]?.tokens ?? 0;
      const reserve = budget * 0.1;
      for (let i = bestCount; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b) continue;
        const dir = getDirGroup(b.path);
        if (!dir || representedDirs.has(dir) || (dirCounts.get(dir) ?? 0) < 3) continue;
        if (usedTokens + b.tokens > budget + reserve) continue;
        coverageBlocks.push(b);
        usedTokens += b.tokens;
        representedDirs.add(dir);
      }
    }

    const lines: string[] = [];
    const depsSummary = this.getExternalDepsSummary();
    if (depsSummary) lines.push(depsSummary, "");
    if (semanticMap.size > 0) {
      const tag = this.semanticMode === "ast" ? "[AST]" : "[LLM]";
      lines.push(`Summaries: ${tag} ${String(semanticMap.size)} symbols`, "");
    }

    const currentPaths: string[] = [];
    for (let i = 0; i < bestCount; i++) {
      const block = blocks[i];
      if (!block) break;
      lines.push(block.fileLine);
      if (block.symbolLines) lines.push(block.symbolLines.trimEnd());
      currentPaths.push(block.path);
    }
    for (const block of coverageBlocks) {
      lines.push(block.fileLine);
      if (block.symbolLines) lines.push(block.symbolLines.trimEnd());
      currentPaths.push(block.path);
    }

    for (const p of currentPaths) this.seenPaths.add(p);
    return lines.join("\n");
  }

  private buildPersonalization(opts: RepoMapOptions): Map<number, number> {
    const pv = new Map<number, number>();
    const mentionedSet = new Set((opts.mentionedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editedSet = new Set((opts.editedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editorRel = opts.editorFile ? relative(this.cwd, opts.editorFile) : null;
    const entryPoints = new Set(this.getEntryPoints());

    if (mentionedSet.size === 0 && editedSet.size === 0 && !editorRel && entryPoints.size === 0)
      return pv;

    const allFiles = this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all();

    const contextFileIds = new Set<number>();
    const base = 100 / Math.max(allFiles.length, 1);
    for (const f of allFiles) {
      let boost = base;
      if (editedSet.has(f.path)) {
        boost += base * 5;
        contextFileIds.add(f.id);
      }
      if (mentionedSet.has(f.path)) {
        boost += base * 3;
        contextFileIds.add(f.id);
      }
      if (f.path === editorRel) {
        boost += base * 2;
        contextFileIds.add(f.id);
      }
      if (entryPoints.has(f.path)) {
        boost += base * 4;
        contextFileIds.add(f.id);
      }
      if (boost > base) pv.set(f.id, boost);
    }

    // Co-change partners get a lighter boost in personalization
    const coPartners = this.getCoChangePartners(contextFileIds);
    for (const [fileId, count] of coPartners) {
      if (!pv.has(fileId)) {
        pv.set(fileId, base + base * Math.min(count / 3, 2));
      }
    }

    return pv;
  }

  private computeBudget(conversationTokens?: number): number {
    if (!conversationTokens || conversationTokens < 1000) return DEFAULT_TOKEN_BUDGET;
    // Gentle decay — keeps 80% of budget even at 100k tokens.
    // Deep conversations need MORE context, not less.
    const scale = Math.max(0.6, 1 - (conversationTokens / 100_000) * 0.4);
    return Math.round(MIN_TOKEN_BUDGET + (MAX_TOKEN_BUDGET - MIN_TOKEN_BUDGET) * scale);
  }

  private rankFiles(opts: RepoMapOptions): FileRow[] {
    const allFiles = this.db
      .query<FileRow, []>(
        "SELECT id, path, mtime_ms, language, line_count, symbol_count, pagerank FROM files ORDER BY pagerank DESC",
      )
      .all();

    // FTS matching on conversation terms (not captured by PageRank personalization)
    let ftsMatches = new Set<number>();
    if (opts.conversationTerms && opts.conversationTerms.length > 0) {
      const ftsQuery = opts.conversationTerms
        .slice(0, 10)
        .map((t) => `"${t.replace(/"/g, "")}"`)
        .join(" OR ");
      try {
        const rows = this.db
          .query<{ id: number }, [string]>(
            `SELECT DISTINCT s.file_id AS id FROM symbols_fts f
             JOIN symbols s ON s.id = f.rowid
             WHERE symbols_fts MATCH ?`,
          )
          .all(ftsQuery);
        ftsMatches = new Set(rows.map((r) => r.id));
      } catch {}
    }

    // Neighbor boosting (files connected to context files via edges)
    const mentionedSet = new Set((opts.mentionedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editedSet = new Set((opts.editedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editorRel = opts.editorFile ? relative(this.cwd, opts.editorFile) : null;

    const neighborFiles = new Set<number>();
    const boostFileIds = new Set<number>();
    for (const f of allFiles) {
      if (mentionedSet.has(f.path) || editedSet.has(f.path) || f.path === editorRel) {
        boostFileIds.add(f.id);
      }
    }
    if (boostFileIds.size > 0) {
      const boostArr = [...boostFileIds];
      const placeholders = boostArr.map(() => "?").join(",");
      const params = [...boostArr, ...boostArr];
      const neighbors = this.db
        .query<{ target_file_id: number }, number[]>(
          `SELECT DISTINCT target_file_id FROM edges WHERE source_file_id IN (${placeholders})
           UNION
           SELECT DISTINCT source_file_id FROM edges WHERE target_file_id IN (${placeholders})`,
        )
        .all(...params);
      for (const row of neighbors) neighborFiles.add(row.target_file_id);
    }

    // Co-change partners: files that historically change together with context files
    const coChangePartners = this.getCoChangePartners(boostFileIds);

    // PageRank already incorporates mentioned/edited/editor boosts via personalization.
    // Post-hoc: add FTS, neighbor, and co-change signals that PageRank can't capture.
    const contextFileIds = new Set([...boostFileIds, ...neighborFiles]);
    const scored = allFiles
      .filter((f) => {
        // Skip config/data files with no symbols unless they're in the conversation context
        if (f.symbol_count === 0 && !contextFileIds.has(f.id)) return false;
        return true;
      })
      .map((f) => {
        let score = f.pagerank * 1000;
        if (ftsMatches.has(f.id)) score += 0.5;
        if (neighborFiles.has(f.id)) score += 1;
        const cochangeCount = coChangePartners.get(f.id);
        if (cochangeCount) score += Math.min(cochangeCount / 5, 3);
        return { ...f, score };
      });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Find symbol matches by name (case-insensitive). Returns ranked results with mtime validation. */
  findSymbols(
    name: string,
  ): Array<{ path: string; kind: string; isExported: boolean; pagerank: number }> {
    const rows = this.db
      .query<
        { path: string; kind: string; is_exported: number; pagerank: number; mtime_ms: number },
        [string, string]
      >(
        `SELECT f.path, s.kind, s.is_exported, f.pagerank, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name = ? OR LOWER(s.name) = LOWER(?))
           AND s.kind IN ('interface','type','class','function','enum','variable','method')
         ORDER BY s.is_exported DESC, f.pagerank DESC
         LIMIT 10`,
      )
      .all(name, name);

    const results: Array<{ path: string; kind: string; isExported: boolean; pagerank: number }> =
      [];
    const seenPaths = new Set<string>();
    for (const row of rows) {
      const absPath = join(this.cwd, row.path);

      // Deduplicate by path
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);

      // Mtime check — skip stale entries
      try {
        const stat = statSync(absPath);
        if (Math.abs(stat.mtimeMs - row.mtime_ms) > 1000) continue;
      } catch {
        continue; // file no longer exists
      }

      results.push({
        path: absPath,
        kind: row.kind,
        isExported: row.is_exported === 1,
        pagerank: row.pagerank,
      });
    }

    // Deprioritize .d.ts files when non-.d.ts matches exist
    const hasSource = results.some((r) => !r.path.endsWith(".d.ts"));
    if (hasSource) {
      return results.filter((r) => !r.path.endsWith(".d.ts"));
    }
    return results;
  }

  /** Legacy single-result lookup. Returns the best match absolute path or null. */
  findSymbol(name: string): string | null {
    const matches = this.findSymbols(name);
    return matches.length > 0 ? (matches[0] as { path: string }).path : null;
  }

  getStats(): { files: number; symbols: number; edges: number; summaries: number } {
    const files = this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
    const symbols =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM symbols").get()?.c ?? 0;
    const edges = this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM edges").get()?.c ?? 0;
    const source = this.semanticMode === "off" ? "llm" : this.semanticMode;
    const summaries =
      this.db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = ?",
        )
        .get(source)?.c ?? 0;
    return { files, symbols, edges, summaries };
  }

  clear(): void {
    this.db.run("DROP TRIGGER IF EXISTS symbols_ai");
    this.db.run("DROP TRIGGER IF EXISTS symbols_ad");
    this.db.run("DELETE FROM semantic_summaries");
    this.db.run("DELETE FROM external_imports");
    this.db.run("DELETE FROM cochanges");
    this.db.run("DELETE FROM edges");
    this.db.run("DELETE FROM refs");
    this.db.run("DELETE FROM symbols");
    this.db.run("DELETE FROM files");
    this.rebuildFts();
    this.ready = false;
    this.scanPromise = null;
    this.seenPaths.clear();
  }

  private rebuildFts(): void {
    this.db.run("DROP TRIGGER IF EXISTS symbols_ai");
    this.db.run("DROP TRIGGER IF EXISTS symbols_ad");
    this.db.run("DROP TABLE IF EXISTS symbols_fts");
    this.db.run(`
      CREATE VIRTUAL TABLE symbols_fts USING fts5(name, kind);
      CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, kind) VALUES (new.id, new.name, new.kind);
      END;
      CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
        DELETE FROM symbols_fts WHERE rowid = old.id;
      END;
    `);
    this.db.run("INSERT INTO symbols_fts(rowid, name, kind) SELECT id, name, kind FROM symbols");
  }

  private compactIfNeeded(): void {
    const bytes = this.dbSizeBytes();
    if (bytes > 50 * 1024 * 1024) {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        this.db.run("VACUUM");
      } catch {
        // compaction is best-effort
      }
    }
  }

  dbSizeBytes(): number {
    try {
      const row = this.db
        .query<{ s: number }, []>(
          "SELECT page_count * page_size AS s FROM pragma_page_count(), pragma_page_size()",
        )
        .get();
      return row?.s ?? 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    this.db.close();
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function extractSignature(lines: string[], lineIdx: number, kind: string): string | null {
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

function kindTag(kind: SymbolKind): string {
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
function extractDocComment(lines: string[], symbolLineIdx: number): string | null {
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

interface CollectedFile {
  path: string;
  mtimeMs: number;
}

function getDirGroup(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length < 2) return null;
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null);
}

function collectFiles(dir: string, depth = 0): CollectedFile[] {
  if (depth > MAX_DEPTH) return [];
  const files: CollectedFile[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          files.push(...collectFiles(fullPath, depth + 1));
        }
      } else if (entry.isFile()) {
        if (isForbidden(fullPath)) continue;
        const ext = extname(entry.name).toLowerCase();
        if (ext in INDEXABLE_EXTENSIONS) {
          try {
            const stat = statSync(fullPath);
            if (stat.size < MAX_FILE_SIZE) files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
          } catch {}
        }
      }
    }
  } catch {}
  return files;
}
