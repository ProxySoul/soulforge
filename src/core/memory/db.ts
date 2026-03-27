import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryCategory, MemoryIndex, MemoryRecord, MemoryScope } from "./types.js";

interface RawRow {
  id: string;
  title: string;
  category: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export class MemoryDB {
  private db: Database;
  readonly scope: MemoryScope;

  constructor(dbPath: string, scope: MemoryScope) {
    this.scope = scope;
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA foreign_keys = ON");
    if (dbPath !== ":memory:") {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {}
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(dbPath + suffix, 0o600);
        } catch {}
      }
    }
    this.init();
  }

  private init(): void {
    const existing = this.db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'",
      )
      .get();

    if (existing) {
      const hasContent = existing.sql.toLowerCase().includes("content text");
      if (hasContent) {
        this.migrateDropContent();
      }
    } else {
      this.db.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('decision','convention','preference','architecture','pattern','fact','checkpoint')),
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
      `);
    }

    this.ensureFts();
  }

  private migrateDropContent(): void {
    this.db.run("DROP TABLE IF EXISTS memories_fts");
    this.db.run("DROP TRIGGER IF EXISTS memories_ai");
    this.db.run("DROP TRIGGER IF EXISTS memories_ad");
    this.db.run("DROP TRIGGER IF EXISTS memories_au");

    this.db.run(`
      CREATE TABLE memories_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('decision','convention','preference','architecture','pattern','fact','checkpoint')),
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      INSERT INTO memories_new (id, title, category, tags, created_at, updated_at)
      SELECT id, title, category, tags, created_at, updated_at FROM memories
    `);

    this.db.run("DROP TABLE memories");
    this.db.run("ALTER TABLE memories_new RENAME TO memories");

    this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)");
  }

  private ensureFts(): void {
    const hasFts = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      )
      .get();

    if (!hasFts) {
      this.db.run(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, tags,
          content='memories', content_rowid='rowid'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, tags)
          VALUES (new.rowid, new.title, new.tags);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, tags)
          VALUES ('delete', old.rowid, old.title, old.tags);
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, tags)
          VALUES ('delete', old.rowid, old.title, old.tags);
          INSERT INTO memories_fts(rowid, title, tags)
          VALUES (new.rowid, new.title, new.tags);
        END;

        INSERT INTO memories_fts(rowid, title, tags)
        SELECT rowid, title, tags FROM memories;
      `);
    }
  }

  write(
    record: Omit<MemoryRecord, "id" | "created_at" | "updated_at"> & { id?: string },
  ): MemoryRecord {
    const id = record.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(record.tags ?? []);

    const row = this.db
      .query<RawRow, [string, string, string, string, string, string]>(
        `INSERT INTO memories (id, title, category, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           category = excluded.category,
           tags = excluded.tags,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(id, record.title, record.category, tags, now, now);

    if (!row) throw new Error(`Failed to write memory ${id}`);
    return toRecord(row);
  }

  read(id: string): MemoryRecord | null {
    const row = this.db.query<RawRow, [string]>("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  list(opts?: { category?: MemoryCategory; tag?: string }): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const conditions: string[] = [];
    const params: string[] = [];

    if (opts?.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts?.tag) {
      const jsonTag = JSON.stringify(opts.tag);
      const escaped = jsonTag.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("tags LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }

    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC";

    const rows = this.db.query<RawRow, string[]>(sql).all(...params);
    return rows.map(toRecord);
  }

  search(query: string, limit = 20): MemoryRecord[] {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.list();

    const ftsQuery = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");

    try {
      const rows = this.db
        .query<RawRow, [string, number]>(
          `SELECT m.*
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit);

      return rows.map(toRecord);
    } catch {
      return this.list();
    }
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  deleteAll(): number {
    const count =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories").get()?.c ?? 0;
    if (count > 0) {
      this.db.run("DELETE FROM memories");
      this.db.run("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    }
    return count;
  }

  deleteByCategory(category: MemoryCategory): number {
    const count =
      this.db
        .query<{ c: number }, [string]>("SELECT COUNT(*) as c FROM memories WHERE category = ?")
        .get(category)?.c ?? 0;
    if (count > 0) this.db.query("DELETE FROM memories WHERE category = ?").run(category);
    return count;
  }

  deleteStaleCheckpoints(maxAgeDays = 7): number {
    const cutoff = `-${String(maxAgeDays)} days`;
    const count =
      this.db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) as c FROM memories WHERE category = 'checkpoint' AND updated_at < datetime('now', ?)",
        )
        .get(cutoff)?.c ?? 0;
    if (count > 0) {
      this.db
        .query(
          "DELETE FROM memories WHERE category = 'checkpoint' AND updated_at < datetime('now', ?)",
        )
        .run(cutoff);
    }
    return count;
  }

  getIndex(): MemoryIndex {
    const total =
      this.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM memories WHERE category != 'checkpoint'",
        )
        .get()?.count ?? 0;

    const cats = this.db
      .query<{ category: string; count: number }, []>(
        "SELECT category, COUNT(*) as count FROM memories WHERE category != 'checkpoint' GROUP BY category",
      )
      .all();

    const byCategory: Record<string, number> = {};
    for (const c of cats) byCategory[c.category] = c.count;

    const recentRows = this.db
      .query<{ title: string }, []>(
        "SELECT title FROM memories WHERE category != 'checkpoint' ORDER BY updated_at DESC LIMIT 5",
      )
      .all();

    return {
      scope: this.scope,
      total,
      byCategory,
      recent: recentRows.map((r) => r.title),
    };
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: RawRow): MemoryRecord {
  return {
    ...row,
    category: row.category as MemoryCategory,
    tags: JSON.parse(row.tags) as string[],
  };
}
