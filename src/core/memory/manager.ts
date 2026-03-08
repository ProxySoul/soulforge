import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDB } from "./db.js";
import { migrateOldMemory } from "./migrate.js";
import type {
  MemoryCategory,
  MemoryRecord,
  MemoryScope,
  MemoryScopeConfig,
  MemorySummary,
} from "./types.js";

export type SettingsScope = "project" | "global";

const CONFIG_FILE = "memory-config.json";
const DEFAULT_CONFIG: MemoryScopeConfig = { writeScope: "global", readScope: "all" };

export class MemoryManager {
  private globalDb: MemoryDB;
  private projectDb: MemoryDB;
  private cwd: string;
  private _scopeConfig: MemoryScopeConfig = { ...DEFAULT_CONFIG };
  private _settingsScope: SettingsScope = "project";

  get scopeConfig(): MemoryScopeConfig {
    return this._scopeConfig;
  }

  set scopeConfig(config: MemoryScopeConfig) {
    this._scopeConfig = config;
    this.saveConfig(this._settingsScope);
  }

  get settingsScope(): SettingsScope {
    return this._settingsScope;
  }

  constructor(cwd: string) {
    this.cwd = cwd;

    const globalPath = join(homedir(), ".soulforge", "memory.db");
    const projectPath = join(cwd, ".soulforge", "memory.db");

    this.globalDb = new MemoryDB(globalPath, "global");
    this.projectDb = new MemoryDB(projectPath, "project");

    this.loadConfig();
    this.tryMigrate();
  }

  private configPath(scope: "project" | "global"): string {
    return scope === "global"
      ? join(homedir(), ".soulforge", CONFIG_FILE)
      : join(this.cwd, ".soulforge", CONFIG_FILE);
  }

  private loadConfig(): void {
    for (const scope of ["project", "global"] as const) {
      const path = this.configPath(scope);
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, "utf-8")) as MemoryScopeConfig;
        if (data.writeScope && data.readScope) {
          this._scopeConfig = data;
          this._settingsScope = scope;
          return;
        }
      } catch {
        // ignore corrupt config
      }
    }
  }

  saveConfig(to: "project" | "global"): void {
    const path = this.configPath(to);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(this._scopeConfig, null, 2), "utf-8");
    this._settingsScope = to;
  }

  deleteConfig(from: "project" | "global"): void {
    const path = this.configPath(from);
    if (existsSync(path)) rmSync(path);
    if (from === this._settingsScope) {
      this._settingsScope = "project";
    }
  }

  setSettingsScope(scope: SettingsScope): void {
    if (this._settingsScope !== scope) {
      this.deleteConfig(this._settingsScope);
    }
    this.saveConfig(scope);
  }

  private tryMigrate(): void {
    const oldDir = join(this.cwd, ".soulforge", "memory");
    if (!existsSync(oldDir)) return;

    const hasData = this.projectDb.list().length > 0;
    if (hasData) return;

    migrateOldMemory(oldDir, this.projectDb);
  }

  private getDb(scope: MemoryScope): MemoryDB {
    return scope === "global" ? this.globalDb : this.projectDb;
  }

  private getReadDbs(scope: MemoryScope | "both" | "all" | "none"): MemoryDB[] {
    if (scope === "none") return [];
    if (scope === "project") return [this.projectDb];
    if (scope === "global") return [this.globalDb];
    return [this.projectDb, this.globalDb];
  }

  write(
    scope: MemoryScope,
    record: Omit<MemoryRecord, "id" | "created_at" | "updated_at"> & { id?: string },
  ): MemoryRecord {
    return this.getDb(scope).write(record);
  }

  read(scope: MemoryScope, id: string): MemoryRecord | null {
    return this.getDb(scope).read(id);
  }

  list(
    scope: MemoryScope | "both" | "all",
    opts?: { category?: MemoryCategory; tag?: string },
  ): (MemorySummary & { scope: MemoryScope })[] {
    const results: (MemorySummary & { scope: MemoryScope })[] = [];
    for (const db of this.getReadDbs(scope)) {
      for (const m of db.list(opts)) {
        results.push({ ...m, scope: db.scope });
      }
    }
    return results;
  }

  search(
    query: string,
    scope: MemoryScope | "both" | "all",
    limit?: number,
  ): (MemorySummary & { scope: MemoryScope })[] {
    const results: (MemorySummary & { scope: MemoryScope })[] = [];
    for (const db of this.getReadDbs(scope)) {
      for (const m of db.search(query, limit)) {
        results.push({ ...m, scope: db.scope });
      }
    }
    return results;
  }

  delete(scope: MemoryScope, id: string): boolean {
    return this.getDb(scope).delete(id);
  }

  clearScope(scope: MemoryScope | "all"): number {
    let cleared = 0;
    const dbs = scope === "all" ? [this.projectDb, this.globalDb] : [this.getDb(scope)];
    for (const db of dbs) {
      const items = db.list();
      for (const item of items) {
        if (db.delete(item.id)) cleared++;
      }
    }
    return cleared;
  }

  listByScope(scope: MemoryScope): (MemorySummary & { scope: MemoryScope })[] {
    const db = this.getDb(scope);
    return db.list().map((m) => ({ ...m, scope }));
  }

  autoRecall(userMessage: string): string | null {
    const readScope = this._scopeConfig.readScope;
    if (readScope === "none") return null;

    const keywords = extractKeywords(userMessage);
    if (keywords.length === 0) return null;

    const query = keywords.join(" ");
    const seen = new Set<string>();
    const hits: import("./types.js").MemoryRecord[] = [];

    const dbs =
      readScope === "all" || (readScope as string) === "both"
        ? [this.projectDb, this.globalDb]
        : readScope === "project"
          ? [this.projectDb]
          : [this.globalDb];

    for (const db of dbs) {
      for (const record of db.searchFull(query, 3)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        hits.push(record);
      }
    }

    if (hits.length === 0) return null;

    const parts = hits.map((m) => `**${m.title}** (${m.category})\n${m.content}`);
    return parts.join("\n\n");
  }

  buildMemoryIndex(): string | null {
    const projectIdx = this.projectDb.getIndex();
    const globalIdx = this.globalDb.getIndex();

    if (projectIdx.total === 0 && globalIdx.total === 0) return null;

    const parts = [
      "You have persistent memory. Use memory_search/memory_read to fetch details on demand.",
      `Write scope: ${this._scopeConfig.writeScope} | Read scope: ${this._scopeConfig.readScope}`,
      "",
    ];

    const addIndex = (label: string, idx: typeof projectIdx) => {
      if (idx.total === 0) return;
      const cats = Object.entries(idx.byCategory)
        .map(([k, v]) => `${k}(${String(v)})`)
        .join(" ");
      parts.push(`${label} (${String(idx.total)}): ${cats}`);
      if (idx.recent.length > 0) {
        parts.push(`Recent: ${idx.recent.map((t) => `"${t}"`).join(", ")}`);
      }
    };

    addIndex("Project", projectIdx);
    addIndex("Global", globalIdx);

    return parts.join("\n");
  }

  close(): void {
    this.globalDb.close();
    this.projectDb.close();
  }
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "when",
  "where",
  "why",
  "and",
  "or",
  "but",
  "not",
  "no",
  "so",
  "if",
  "then",
  "else",
  "for",
  "of",
  "in",
  "on",
  "at",
  "to",
  "from",
  "by",
  "with",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "just",
  "also",
  "too",
  "very",
  "really",
  "quite",
  "some",
  "any",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "than",
  "get",
  "got",
  "make",
  "made",
  "let",
  "use",
  "using",
  "used",
  "want",
  "like",
  "know",
  "think",
  "see",
  "look",
  "find",
  "give",
  "tell",
  "try",
  "take",
  "come",
  "go",
  "put",
  "run",
  "say",
  "said",
  "here",
  "there",
  "now",
  "still",
  "already",
  "yet",
  "file",
  "files",
  "code",
  "please",
  "thanks",
  "help",
  "ok",
  "sure",
  "hey",
  "hi",
  "hello",
  "yeah",
  "yes",
  "no",
  "right",
  "well",
]);

function extractKeywords(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const unique = [...new Set(words)];
  return unique.slice(0, 8);
}
