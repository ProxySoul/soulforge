import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDB } from "./db.js";
import { migrateOldMemory } from "./migrate.js";
import type { MemoryCategory, MemoryRecord, MemoryScope, MemoryScopeConfig } from "./types.js";

type SettingsScope = "project" | "global";

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
    this.cleanupStaleCheckpoints();
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
      } catch {}
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

  private cleanupStaleCheckpoints(): void {
    this.projectDb.deleteStaleCheckpoints();
    this.globalDb.deleteStaleCheckpoints();
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

  list(
    scope: MemoryScope | "both" | "all",
    opts?: { category?: MemoryCategory; tag?: string },
  ): (MemoryRecord & { scope: MemoryScope })[] {
    const results: (MemoryRecord & { scope: MemoryScope })[] = [];
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
  ): (MemoryRecord & { scope: MemoryScope })[] {
    const results: (MemoryRecord & { scope: MemoryScope })[] = [];
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
      cleared += db.deleteAll();
    }
    return cleared;
  }

  listByScope(scope: MemoryScope): (MemoryRecord & { scope: MemoryScope })[] {
    const db = this.getDb(scope);
    return db.list().map((m) => ({ ...m, scope }));
  }

  buildMemoryIndex(): string | null {
    const projectIdx = this.projectDb.getIndex();
    const globalIdx = this.globalDb.getIndex();

    if (projectIdx.total === 0 && globalIdx.total === 0) return null;

    const parts = [
      "You have persistent memory. Use memory(action: search) to recall. Only write when the USER explicitly asks you to remember something.",
      `Write scope: ${this._scopeConfig.writeScope} | Read scope: ${this._scopeConfig.readScope}`,
      "",
    ];

    let totalChars = parts.reduce((s, p) => s + p.length, 0);
    const addIndex = (label: string, idx: typeof projectIdx) => {
      if (idx.total === 0) return;
      const cats = Object.entries(idx.byCategory)
        .map(([k, v]) => `${k}(${String(v)})`)
        .join(" ");
      parts.push(`${label} (${String(idx.total)}): ${cats}`);
      totalChars += parts[parts.length - 1]?.length ?? 0;
      if (idx.recent.length > 0) {
        for (const title of idx.recent) {
          const line = `  - ${title.length > 80 ? `${title.slice(0, 77)}...` : title}`;
          if (totalChars + line.length > 800) {
            parts.push(`  ... +${String(idx.total - idx.recent.indexOf(title))} more`);
            break;
          }
          parts.push(line);
          totalChars += line.length;
        }
        if (idx.total > idx.recent.length && !parts[parts.length - 1]?.startsWith("  ...")) {
          parts.push(`  ... +${String(idx.total - idx.recent.length)} more`);
        }
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
