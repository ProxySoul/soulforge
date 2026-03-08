import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  MemoryCategory,
  MemoryIndex,
  MemoryRecord,
  MemoryScope,
  MemorySummary,
} from "./types.js";

interface RawRow {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface RawSummaryRow {
  id: string;
  title: string;
  category: string;
  tags: string;
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
    this.db.run("PRAGMA foreign_keys = ON");
    if (dbPath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(dbPath + suffix, 0o600);
        } catch {}
      }
    }
    this.init();
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('decision','convention','preference','architecture','pattern','fact')),
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    `);

    const hasFts = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      )
      .get();

    if (!hasFts) {
      this.db.run(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, content, tags,
          content='memories', content_rowid='rowid'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
          INSERT INTO memories_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        INSERT INTO memories_fts(rowid, title, content, tags)
        SELECT rowid, title, content, tags FROM memories;
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
      .query<RawRow, [string, string, string, string, string, string, string]>(
        `INSERT INTO memories (id, title, content, category, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           category = excluded.category,
           tags = excluded.tags,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(id, record.title, record.content, record.category, tags, now, now);

    if (!row) throw new Error(`Failed to write memory ${id}`);
    return toRecord(row);
  }

  read(id: string): MemoryRecord | null {
    const row = this.db.query<RawRow, [string]>("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  list(opts?: { category?: MemoryCategory; tag?: string }): MemorySummary[] {
    let sql = "SELECT id, title, category, tags, updated_at FROM memories";
    const conditions: string[] = [];
    const params: string[] = [];

    if (opts?.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts?.tag) {
      conditions.push("tags LIKE ?");
      params.push(`%"${opts.tag}"%`);
    }

    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC";

    const rows = this.db.query<RawSummaryRow, string[]>(sql).all(...params);
    return rows.map(toSummary);
  }

  search(query: string, limit = 20): MemorySummary[] {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.list();

    const ftsQuery = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");

    try {
      const rows = this.db
        .query<RawSummaryRow, [string, number]>(
          `SELECT m.id, m.title, m.category, m.tags, m.updated_at
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit);

      return rows.map(toSummary);
    } catch {
      return this.list();
    }
  }

  searchFull(query: string, limit = 5): MemoryRecord[] {
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

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
      return [];
    }
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM memories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getIndex(): MemoryIndex {
    const total =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories").get()?.count ??
      0;

    const cats = this.db
      .query<{ category: string; count: number }, []>(
        "SELECT category, COUNT(*) as count FROM memories GROUP BY category",
      )
      .all();

    const byCategory: Record<string, number> = {};
    for (const c of cats) byCategory[c.category] = c.count;

    const recentRows = this.db
      .query<{ title: string }, []>("SELECT title FROM memories ORDER BY updated_at DESC LIMIT 5")
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

function toSummary(row: RawSummaryRow): MemorySummary {
  return {
    ...row,
    category: row.category as MemoryCategory,
    tags: JSON.parse(row.tags) as string[],
  };
}
