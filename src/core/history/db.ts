import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 5000;
const PRUNE_INTERVAL = 50;

export class HistoryDB {
  private db: Database;
  private writesSincePrune = 0;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.init();
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry TEXT NOT NULL UNIQUE,
        project TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
    `);

    const hasFts = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='history_fts'",
      )
      .get();

    if (!hasFts) {
      this.db.run(`
        CREATE VIRTUAL TABLE history_fts USING fts5(
          entry,
          content='history', content_rowid='rowid'
        );

        CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
          INSERT INTO history_fts(rowid, entry) VALUES (new.rowid, new.entry);
        END;

        CREATE TRIGGER history_ad AFTER DELETE ON history BEGIN
          INSERT INTO history_fts(history_fts, rowid, entry) VALUES ('delete', old.rowid, old.entry);
        END;

        CREATE TRIGGER history_au AFTER UPDATE ON history BEGIN
          INSERT INTO history_fts(history_fts, rowid, entry) VALUES ('delete', old.rowid, old.entry);
          INSERT INTO history_fts(rowid, entry) VALUES (new.rowid, new.entry);
        END;

        INSERT INTO history_fts(rowid, entry)
        SELECT rowid, entry FROM history;
      `);
    }
  }

  push(entry: string, project?: string): void {
    this.db
      .query(
        `INSERT INTO history (entry, project, created_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(entry) DO UPDATE SET
           project = excluded.project,
           created_at = datetime('now')`,
      )
      .run(entry, project ?? null);

    this.writesSincePrune++;
    if (this.writesSincePrune >= PRUNE_INTERVAL) {
      this.prune();
      this.writesSincePrune = 0;
    }
  }

  recent(limit = 100): string[] {
    const rows = this.db
      .query<{ entry: string }, [number]>(
        "SELECT entry FROM history ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((r) => r.entry);
  }

  search(query: string, limit = 50): string[] {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.recent(limit);

    const ftsQuery = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");

    try {
      const rows = this.db
        .query<{ entry: string }, [string, number]>(
          `SELECT h.entry
           FROM history_fts f
           JOIN history h ON h.rowid = f.rowid
           WHERE history_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit);
      return rows.map((r) => r.entry);
    } catch {
      return this.recent(limit);
    }
  }

  private prune(): void {
    this.db
      .query(
        `DELETE FROM history WHERE id NOT IN (
          SELECT id FROM history ORDER BY created_at DESC LIMIT ?
        )`,
      )
      .run(MAX_ENTRIES);
  }

  close(): void {
    this.db.close();
  }
}
