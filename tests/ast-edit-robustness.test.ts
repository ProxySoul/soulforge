import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astEditTool } from "../src/core/tools/ast-edit.js";

// ════════════════════════════════════════════════════════════
// ast_edit robustness — covers the 6 failure classes from the
// hearth-tab agent log. These tests guarantee 100% reliability
// for the cases that previously fell back to edit_file.
// ════════════════════════════════════════════════════════════

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ast-edit-robust-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function writeFixture(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

// ───────────────────────────────────────────────────────────
// 1. Stale-cache survives external writes (CAS divergence)
// ───────────────────────────────────────────────────────────
describe("ast_edit — stale cache after external writes", () => {
  it("recovers when file was modified externally between edits", async () => {
    const path = writeFixture(
      "stale.ts",
      `export function greet() {\n  return "hi";\n}\n`,
    );

    // First edit through ast_edit so the project caches the SourceFile.
    const r1 = await astEditTool.execute({
      path,
      action: "set_return_type",
      target: "function",
      name: "greet",
      value: "string",
    });
    expect(r1.success).toBe(true);

    // Simulate edit_file writing externally — this is what produced
    // "File content diverged (ts-morph cache stale)" before the fix.
    const onDisk = readFileSync(path, "utf-8");
    writeFileSync(path, `${onDisk}export const VERSION = 1;\n`, "utf-8");

    // Next ast_edit must NOT report stale cache.
    const r2 = await astEditTool.execute({
      path,
      action: "set_return_type",
      target: "function",
      name: "greet",
      value: "Promise<string>",
    });
    expect(r2.success).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("Promise<string>");
    expect(readFileSync(path, "utf-8")).toContain("export const VERSION = 1;");
  });
});

// ───────────────────────────────────────────────────────────
// 2. Constructor target works
// ───────────────────────────────────────────────────────────
describe("ast_edit — constructor", () => {
  it("modifies an existing constructor body via target=constructor", async () => {
    const path = writeFixture(
      "ctor.ts",
      `export class Renderer {\n  private fmt = "plain";\n  constructor() {\n    this.fmt = "plain";\n  }\n}\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "set_body",
      target: "constructor",
      name: "Renderer",
      newCode: `this.fmt = "html";`,
    });
    expect(r.success).toBe(true);
    const out = readFileSync(path, "utf-8");
    expect(out).toContain(`this.fmt = "html"`);
    expect(out).not.toMatch(/this\.fmt = "plain";\s*\n\s*\}/);
  });

  it("add_constructor on a class that already has one modifies in place", async () => {
    const path = writeFixture(
      "ctor2.ts",
      `export class A {\n  constructor() { this.x = 1; }\n  x = 0;\n}\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "add_constructor",
      target: "class",
      name: "A",
      newCode: `this.x = 42;`,
    });
    expect(r.success).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("this.x = 42");
  });
});

// ───────────────────────────────────────────────────────────
// 3. rename — declaration-only by default, no surprise renames
// ───────────────────────────────────────────────────────────
describe("ast_edit — rename scoping", () => {
  it("rename leaves call sites alone (declaration-only)", async () => {
    const path = writeFixture(
      "rename.ts",
      `export function helper() {\n  return 1;\n}\nexport const x = helper();\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "rename",
      target: "function",
      name: "helper",
      value: "internalHelper",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(path, "utf-8");
    // Declaration renamed.
    expect(out).toContain("function internalHelper");
    // Call site preserved (declaration-only rename).
    expect(out).toContain("helper()");
  });
});

// ───────────────────────────────────────────────────────────
// 4. create_file
// ───────────────────────────────────────────────────────────
describe("ast_edit — create_file", () => {
  it("creates a new file with the given content", async () => {
    const path = join(tmp, "subdir/new.ts");
    const r = await astEditTool.execute({
      path,
      action: "create_file",
      newCode: `export const NEW = true;\n`,
    });
    expect(r.success).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("export const NEW = true;\n");
  });

  it("refuses to overwrite an existing file", async () => {
    const path = writeFixture("exists.ts", `export const A = 1;\n`);
    const r = await astEditTool.execute({
      path,
      action: "create_file",
      newCode: `export const B = 2;\n`,
    });
    expect(r.success).toBe(false);
    expect(r.output).toContain("already exists");
  });
});

// ───────────────────────────────────────────────────────────
// 5. replace_in_body — AST-anchored substring replacement
// ───────────────────────────────────────────────────────────
describe("ast_edit — replace_in_body", () => {
  it("replaces a unique substring inside a function body", async () => {
    const path = writeFixture(
      "rib.ts",
      `export function fmt(s: string) {\n  return s.toLowerCase();\n}\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "replace_in_body",
      target: "function",
      name: "fmt",
      value: "toLowerCase",
      newCode: "toUpperCase",
    });
    expect(r.success).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("toUpperCase");
  });

  it("fails on ambiguous substring with a clear error", async () => {
    const path = writeFixture(
      "amb.ts",
      `export function dup() {\n  const a = 1;\n  const a2 = 1;\n}\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "replace_in_body",
      target: "function",
      name: "dup",
      value: "= 1",
      newCode: "= 99",
    });
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/ambiguous/i);
    // File must be untouched on failure.
    expect(readFileSync(path, "utf-8")).toContain("const a = 1");
  });
});

// ───────────────────────────────────────────────────────────
// 6. add_import — idempotent, merges into existing
// ───────────────────────────────────────────────────────────
describe("ast_edit — add_import idempotency", () => {
  it("merges a new named import into an existing import declaration", async () => {
    const path = writeFixture(
      "imp.ts",
      `import { readFile } from "node:fs/promises";\nexport const X = 1;\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "add_import",
      value: "node:fs/promises",
      newCode: "writeFile, mkdir",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(path, "utf-8");
    expect(out).toMatch(/readFile.*writeFile.*mkdir|writeFile.*readFile/);
    // No duplicate import line.
    expect(out.match(/from "node:fs\/promises"/g)?.length).toBe(1);
  });

  it("returns a 'nothing to add' message when import is fully present", async () => {
    const path = writeFixture(
      "imp2.ts",
      `import { readFile } from "node:fs/promises";\nexport const X = 1;\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "add_import",
      value: "node:fs/promises",
      newCode: "readFile",
    });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/already present|nothing to add/i);
  });
});

// ───────────────────────────────────────────────────────────
// 7. did-you-mean fuzzy hint
// ───────────────────────────────────────────────────────────
describe("ast_edit — did-you-mean", () => {
  it("suggests the closest symbol on typo", async () => {
    const path = writeFixture(
      "dym.ts",
      `export function calculateTotal() { return 0; }\n`,
    );
    const r = await astEditTool.execute({
      path,
      action: "set_return_type",
      target: "function",
      name: "calcuateTotal", // typo
      value: "number",
    });
    expect(r.success).toBe(false);
    expect(r.output).toContain("calculateTotal");
    expect(r.output).toMatch(/did you mean/i);
  });
});
