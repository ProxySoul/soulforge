import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryDB } from "../src/core/memory/db.js";

let db: MemoryDB;

beforeEach(() => {
  db = new MemoryDB(":memory:", "project");
});

afterEach(() => {
  db.close();
});

describe("MemoryDB — write & read", () => {
  it("writes and reads back a record", () => {
    const record = db.write({
      title: "Test memory",
      category: "fact",
      tags: ["test"],
    });
    expect(record.id).toBeTruthy();
    expect(record.title).toBe("Test memory");
    expect(record.tags).toEqual(["test"]);

    const read = db.read(record.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Test memory");
  });

  it("upserts on duplicate id", () => {
    const r1 = db.write({
      id: "fixed-id",
      title: "Version 1",
      category: "fact",
      tags: [],
    });
    const r2 = db.write({
      id: "fixed-id",
      title: "Version 2",
      category: "fact",
      tags: [],
    });
    expect(r1.id).toBe("fixed-id");
    expect(r2.id).toBe("fixed-id");

    const read = db.read("fixed-id");
    expect(read!.title).toBe("Version 2");
  });

  it("returns null for nonexistent id", () => {
    expect(db.read("does-not-exist")).toBeNull();
  });

  it("handles all valid categories", () => {
    const categories = [
      "decision", "convention", "preference", "architecture", "pattern", "fact", "checkpoint",
    ] as const;
    for (const cat of categories) {
      const r = db.write({ title: cat, category: cat, tags: [] });
      expect(r.category).toBe(cat);
    }
  });

  it("rejects invalid category", () => {
    expect(() =>
      db.write({ title: "Bad", category: "invalid" as "fact", tags: [] }),
    ).toThrow();
  });

  it("handles empty tags", () => {
    const r = db.write({ title: "No tags", category: "fact", tags: [] });
    expect(r.tags).toEqual([]);
  });

  it("handles multiple tags", () => {
    const r = db.write({
      title: "Tagged",
      category: "fact",
      tags: ["a", "b", "c"],
    });
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  it("handles unicode title", () => {
    const r = db.write({
      title: "日本語テスト 🎉 résumé",
      category: "fact",
      tags: ["émoji"],
    });
    const read = db.read(r.id);
    expect(read!.title).toBe("日本語テスト 🎉 résumé");
  });

  it("handles title with SQL injection attempt", () => {
    const r = db.write({
      title: "'; DROP TABLE memories; --",
      category: "fact",
      tags: ["'; DROP TABLE"],
    });
    const read = db.read(r.id);
    expect(read!.title).toBe("'; DROP TABLE memories; --");
    const list = db.list();
    expect(list.length).toBeGreaterThan(0);
  });
});

describe("MemoryDB — delete", () => {
  it("deletes existing record", () => {
    const r = db.write({ title: "To delete", category: "fact", tags: [] });
    expect(db.delete(r.id)).toBe(true);
    expect(db.read(r.id)).toBeNull();
  });

  it("returns false for nonexistent id", () => {
    expect(db.delete("nope")).toBe(false);
  });

  it("removes from FTS index after delete", () => {
    const r = db.write({
      title: "Searchable unique_keyword_xyz",
      category: "fact",
      tags: [],
    });
    db.delete(r.id);
    const results = db.search("unique_keyword_xyz");
    expect(results.length).toBe(0);
  });
});

describe("MemoryDB — list", () => {
  it("lists all records", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    db.write({ title: "B", category: "decision", tags: [] });
    const list = db.list();
    expect(list.length).toBe(2);
  });

  it("filters by category", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    db.write({ title: "B", category: "decision", tags: [] });
    const facts = db.list({ category: "fact" });
    expect(facts.length).toBe(1);
    expect(facts[0]!.title).toBe("A");
  });

  it("filters by tag", () => {
    db.write({ title: "A", category: "fact", tags: ["important"] });
    db.write({ title: "B", category: "fact", tags: ["trivial"] });
    const important = db.list({ tag: "important" });
    expect(important.length).toBe(1);
    expect(important[0]!.title).toBe("A");
  });

  it("filters by both category and tag", () => {
    db.write({ title: "A", category: "fact", tags: ["important"] });
    db.write({ title: "B", category: "decision", tags: ["important"] });
    db.write({ title: "C", category: "fact", tags: ["trivial"] });
    const result = db.list({ category: "fact", tag: "important" });
    expect(result.length).toBe(1);
    expect(result[0]!.title).toBe("A");
  });

  it("returns empty for no matches", () => {
    expect(db.list({ category: "architecture" })).toEqual([]);
  });

  it("orders by updated_at DESC", () => {
    db.write({ id: "old", title: "Old", category: "fact", tags: [] });
    db.write({ id: "new", title: "New", category: "fact", tags: [] });
    const list = db.list();
    expect(list[0]!.title).toBe("New");
  });
});

describe("MemoryDB — search (FTS)", () => {
  it("finds by title keyword", () => {
    db.write({ title: "TypeScript conventions", category: "convention", tags: [] });
    db.write({ title: "Python patterns", category: "pattern", tags: [] });
    const results = db.search("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("TypeScript");
  });

  it("finds by tag keyword", () => {
    db.write({ title: "A", category: "fact", tags: ["performance"] });
    const results = db.search("performance");
    expect(results.length).toBe(1);
  });

  it("handles multi-word query (OR)", () => {
    db.write({ title: "TypeScript guide", category: "fact", tags: [] });
    db.write({ title: "Python guide", category: "fact", tags: [] });
    db.write({ title: "Unrelated", category: "fact", tags: [] });
    const results = db.search("TypeScript Python");
    expect(results.length).toBe(2);
  });

  it("returns empty for no matches", () => {
    db.write({ title: "Something", category: "fact", tags: [] });
    const results = db.search("xyznonexistent");
    expect(results.length).toBe(0);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.write({ title: `Item keyword ${i}`, category: "fact", tags: [] });
    }
    const results = db.search("keyword", 3);
    expect(results.length).toBe(3);
  });

  it("falls back to list() on empty query", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    const results = db.search("");
    expect(results.length).toBe(1);
  });

  it("handles quotes in search safely", () => {
    db.write({ title: 'Say "hello"', category: "fact", tags: [] });
    expect(() => db.search('"hello"')).not.toThrow();
  });
});

describe("MemoryDB — getIndex", () => {
  it("returns correct totals", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    db.write({ title: "B", category: "decision", tags: [] });
    db.write({ title: "C", category: "fact", tags: [] });
    const idx = db.getIndex();
    expect(idx.total).toBe(3);
    expect(idx.byCategory.fact).toBe(2);
    expect(idx.byCategory.decision).toBe(1);
    expect(idx.scope).toBe("project");
  });

  it("returns recent titles (up to 5)", () => {
    for (let i = 0; i < 7; i++) {
      db.write({ title: `Item ${i}`, category: "fact", tags: [] });
    }
    const idx = db.getIndex();
    expect(idx.recent.length).toBe(5);
  });

  it("handles empty database", () => {
    const idx = db.getIndex();
    expect(idx.total).toBe(0);
    expect(idx.recent).toEqual([]);
    expect(idx.byCategory).toEqual({});
  });
});

describe("MemoryDB — bulk delete", () => {
  it("deleteAll removes all records", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    db.write({ title: "B", category: "decision", tags: [] });
    db.write({ title: "C", category: "convention", tags: [] });
    const cleared = db.deleteAll();
    expect(cleared).toBe(3);
    expect(db.list().length).toBe(0);
  });

  it("deleteAll clears FTS index", () => {
    db.write({ title: "Unique searchterm", category: "fact", tags: [] });
    db.deleteAll();
    const results = db.search("searchterm");
    expect(results.length).toBe(0);
  });

  it("deleteAll returns 0 on empty db", () => {
    expect(db.deleteAll()).toBe(0);
  });

  it("deleteByCategory only removes matching category", () => {
    db.write({ title: "A", category: "fact", tags: [] });
    db.write({ title: "B", category: "decision", tags: [] });
    db.write({ title: "C", category: "fact", tags: [] });
    const cleared = db.deleteByCategory("fact");
    expect(cleared).toBe(2);
    expect(db.list().length).toBe(1);
    expect(db.list()[0]!.category).toBe("decision");
  });

  it("deleteStaleCheckpoints removes old checkpoints only", () => {
    db.write({ title: "Fresh fact", category: "fact", tags: [] });
    const old = db.write({ title: "Old checkpoint", category: "checkpoint", tags: [] });
    // Backdate the checkpoint to 10 days ago so it's stale
    (db as unknown as { db: { run: (sql: string, ...p: string[]) => void } }).db.run(
      "UPDATE memories SET updated_at = datetime('now', '-10 days') WHERE id = ?",
      old.id,
    );
    const cleared = db.deleteStaleCheckpoints(7);
    expect(cleared).toBe(1);
    expect(db.list().length).toBe(1);
    expect(db.list()[0]!.category).toBe("fact");
  });

  it("deleteStaleCheckpoints preserves fresh checkpoints", () => {
    db.write({ title: "A decision", category: "decision", tags: [] });
    db.write({ title: "A checkpoint", category: "checkpoint", tags: [] });
    db.deleteStaleCheckpoints(7);
    expect(db.list().length).toBe(2);
  });
});

describe("MemoryDB — stress", () => {
  it("handles 500 writes without error", () => {
    for (let i = 0; i < 500; i++) {
      db.write({ title: `Record ${i}`, category: "fact", tags: [`tag${i % 10}`] });
    }
    expect(db.list().length).toBe(500);
  });

  it("search after many writes still works", () => {
    for (let i = 0; i < 100; i++) {
      db.write({ title: `Record about topic${i}`, category: "fact", tags: [] });
    }
    const results = db.search("topic50");
    expect(results.length).toBeGreaterThan(0);
  });

  it("handles rapid write-delete cycles", () => {
    for (let i = 0; i < 100; i++) {
      const r = db.write({ title: `Temp ${i}`, category: "fact", tags: [] });
      db.delete(r.id);
    }
    expect(db.list().length).toBe(0);
  });
});
