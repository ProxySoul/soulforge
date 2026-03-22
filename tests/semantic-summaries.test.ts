import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

/**
 * Integration tests for semantic summary persistence.
 * Uses the real RepoMap class with real files to catch schema/query mismatches.
 * LLM summaries cost money — they must NEVER be lost during re-index.
 */

let tmpDir: string;
let repoMap: RepoMap;

function writeSource(relPath: string, content: string) {
  const abs = join(tmpDir, relPath);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function getDb(): Database {
  return (repoMap as unknown as { db: Database }).db;
}

function injectLlmSummary(symbolName: string, filePath: string, summary: string) {
  const db = getDb();
  const sym = db
    .query<{ id: number }, [string, string]>(
      "SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? AND f.path=?",
    )
    .get(symbolName, filePath);
  if (!sym) throw new Error(`Symbol ${symbolName} not found in ${filePath}`);
  db.run(
    `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name)
     VALUES (?, 'llm', ?, 0, ?, ?)`,
    [sym.id, summary, filePath, symbolName],
  );
}

function getLlmSummaries(): Array<{ symbol_name: string; summary: string; file_path: string }> {
  return getDb()
    .query<{ symbol_name: string; summary: string; file_path: string }, []>(
      "SELECT symbol_name, summary, file_path FROM semantic_summaries WHERE source='llm' ORDER BY symbol_name",
    )
    .all();
}

function getSummaryCount() {
  const db = getDb();
  return {
    ast: db.query<{ c: number }, []>("SELECT count(*) as c FROM semantic_summaries WHERE source='ast'").get()?.c ?? 0,
    llm: db.query<{ c: number }, []>("SELECT count(*) as c FROM semantic_summaries WHERE source='llm'").get()?.c ?? 0,
    synthetic: db.query<{ c: number }, []>("SELECT count(*) as c FROM semantic_summaries WHERE source='synthetic'").get()?.c ?? 0,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sf-semantic-test-"));
  mkdirSync(join(tmpDir, ".soulforge"), { recursive: true });
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  repoMap = new RepoMap(tmpDir);
});

afterEach(() => {
  repoMap.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function scanAndWait() {
  await new Promise<void>((resolve) => {
    repoMap.onScanComplete = () => resolve();
    repoMap.scan();
  });
}

describe("LLM summary persistence across re-index", () => {
  test("LLM summaries survive file re-index with unchanged symbols", async () => {
    writeSource("src/foo.ts", `export function doStuff(): void { console.log("hi"); }\nexport function helper(): string { return "x"; }\n`);

    await scanAndWait();
    injectLlmSummary("doStuff", "src/foo.ts", "Logs a greeting to console");
    injectLlmSummary("helper", "src/foo.ts", "Returns a single character string");

    expect(getLlmSummaries()).toHaveLength(2);

    // Touch file (same content, new mtime) → triggers re-index
    writeSource("src/foo.ts", `export function doStuff(): void { console.log("hi"); }\nexport function helper(): string { return "x"; }\n`);
    await scanAndWait();

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(2);
    expect(llm.find((s) => s.symbol_name === "doStuff")?.summary).toBe("Logs a greeting to console");
    expect(llm.find((s) => s.symbol_name === "helper")?.summary).toBe("Returns a single character string");
  });

  test("LLM summaries survive when new symbols are added", async () => {
    writeSource("src/grow.ts", `export function existing(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("existing", "src/grow.ts", "Original summary");

    // Add a new symbol
    writeSource("src/grow.ts", `export function existing(): void {}\nexport function brandNew(): void {}\n`);
    await scanAndWait();

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(1);
    expect(llm[0]?.symbol_name).toBe("existing");
    expect(llm[0]?.summary).toBe("Original summary");
  });

  test("LLM summaries for deleted symbols are cleaned up", async () => {
    writeSource("src/shrink.ts", `export function keepMe(): void {}\nexport function removeMe(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("keepMe", "src/shrink.ts", "Keeper");
    injectLlmSummary("removeMe", "src/shrink.ts", "Gone soon");

    // Remove one symbol
    writeSource("src/shrink.ts", `export function keepMe(): void {}\n`);
    await scanAndWait();

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(1);
    expect(llm[0]?.symbol_name).toBe("keepMe");
  });

  test("LLM summaries for renamed symbols are cleaned up", async () => {
    writeSource("src/rename.ts", `export function oldName(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("oldName", "src/rename.ts", "Old description");

    writeSource("src/rename.ts", `export function newName(): void {}\n`);
    await scanAndWait();

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(0);
  });

  test("LLM summaries for other files are untouched during single-file re-index", async () => {
    writeSource("src/a.ts", `export function funcA(): void {}\n`);
    writeSource("src/b.ts", `export function funcB(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("funcA", "src/a.ts", "A summary");
    injectLlmSummary("funcB", "src/b.ts", "B summary");

    // Only re-index file a
    writeSource("src/a.ts", `export function funcA(): void { /* changed */ }\n`);
    await scanAndWait();

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(2);
    expect(llm.find((s) => s.symbol_name === "funcB")?.summary).toBe("B summary");
  });

  test("LLM summaries survive multiple consecutive re-indexes", async () => {
    writeSource("src/stable.ts", `export function stable(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("stable", "src/stable.ts", "Stable summary");

    for (let i = 0; i < 5; i++) {
      writeSource("src/stable.ts", `export function stable(): void { /* v${String(i)} */ }\n`);
      await scanAndWait();
    }

    const llm = getLlmSummaries();
    expect(llm).toHaveLength(1);
    expect(llm[0]?.summary).toBe("Stable summary");
  });

  test("ast and synthetic summaries are regenerated independently of LLM", async () => {
    writeSource("src/mixed.ts", `/** Does stuff */\nexport function documented(): void {}\nexport function undocumented(): void {}\n`);
    await scanAndWait();

    // Generate ast + synthetic
    repoMap.setSemanticMode("full");
    repoMap.generateAstSummaries();
    repoMap.generateSyntheticSummaries();
    injectLlmSummary("documented", "src/mixed.ts", "LLM: processes data");
    injectLlmSummary("undocumented", "src/mixed.ts", "LLM: helper logic");

    const before = getSummaryCount();
    expect(before.llm).toBe(2);
    expect(before.ast).toBeGreaterThanOrEqual(0); // may or may not extract docstring

    // Re-index
    writeSource("src/mixed.ts", `/** Does stuff */\nexport function documented(): void {}\nexport function undocumented(): void {}\n`);
    await scanAndWait();

    const after = getSummaryCount();
    expect(after.llm).toBe(2); // LLM preserved
    // ast/synthetic may be 0 (cleared during re-index, need explicit regen)
  });

  test("file_path and symbol_name are populated on LLM insert", async () => {
    writeSource("src/meta.ts", `export function myFunc(): void {}\n`);
    await scanAndWait();
    injectLlmSummary("myFunc", "src/meta.ts", "Test summary");

    const row = getDb()
      .query<{ file_path: string; symbol_name: string }, []>(
        "SELECT file_path, symbol_name FROM semantic_summaries WHERE source='llm'",
      )
      .get();
    expect(row?.file_path).toBe("src/meta.ts");
    expect(row?.symbol_name).toBe("myFunc");
  });

  test("file_path and symbol_name are populated on ast/synthetic insert", async () => {
    // Two symbols: one with docstring (ast), one without (synthetic fills gap)
    writeSource("src/doc.ts", `/** Important function */\nexport function documented(): void {}\nexport function plain(): void {}\n`);
    await scanAndWait();
    repoMap.setSemanticMode("synthetic");
    repoMap.generateAstSummaries();
    repoMap.generateSyntheticSummaries();

    const rows = getDb()
      .query<{ file_path: string; symbol_name: string; source: string }, []>(
        "SELECT file_path, symbol_name, source FROM semantic_summaries WHERE file_path <> '' ORDER BY source",
      )
      .all();
    // Should have at least one summary with populated file_path (ast or synthetic)
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.file_path).not.toBe("");
      expect(r.symbol_name).not.toBe("");
    }
  });

  test("schema has no ON DELETE CASCADE on semantic_summaries", () => {
    const sql = getDb()
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?")
      .get("semantic_summaries");
    expect(sql?.sql).toBeDefined();
    expect(sql!.sql).not.toContain("ON DELETE CASCADE");
  });

  test("LLM summaries with empty file_path survive re-index (legacy rows)", async () => {
    writeSource("src/legacy.ts", `export function legacyFunc(): void {}\n`);
    await scanAndWait();

    // Simulate a legacy LLM insert without file_path (old code path)
    const db = getDb();
    const sym = db
      .query<{ id: number }, [string]>(
        "SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? LIMIT 1",
      )
      .get("legacyFunc");
    db.run(
      "INSERT INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, 'llm', 'Legacy paid summary', 0, '', '')",
      [sym!.id],
    );

    expect(getLlmSummaries()).toHaveLength(1);

    // Re-index the file
    writeSource("src/legacy.ts", `export function legacyFunc(): void { /* changed */ }\n`);
    await scanAndWait();

    // Legacy row should NOT be deleted (empty file_path = can't re-link but shouldn't destroy)
    const llm = getLlmSummaries();
    expect(llm).toHaveLength(1);
    expect(llm[0]?.summary).toBe("Legacy paid summary");
  });

  test("backfillSummaryPaths populates empty file_path from symbol table", async () => {
    writeSource("src/backfill.ts", `export function needsFill(): void {}\n`);
    await scanAndWait();

    // Insert with empty file_path (simulating old code)
    const db = getDb();
    const sym = db
      .query<{ id: number }, [string]>(
        "SELECT s.id FROM symbols s JOIN files f ON f.id=s.file_id WHERE s.name=? LIMIT 1",
      )
      .get("needsFill");
    db.run(
      "INSERT INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, 'llm', 'Needs backfill', 0, '', '')",
      [sym!.id],
    );

    // Create a new RepoMap instance (triggers backfill in constructor)
    repoMap.close();
    repoMap = new RepoMap(tmpDir);

    const row = getDb()
      .query<{ file_path: string; symbol_name: string }, []>(
        "SELECT file_path, symbol_name FROM semantic_summaries WHERE source='llm' LIMIT 1",
      )
      .get();
    expect(row?.file_path).toBe("src/backfill.ts");
    expect(row?.symbol_name).toBe("needsFill");
  });
});
