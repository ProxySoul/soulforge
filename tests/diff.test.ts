import { describe, expect, it } from "bun:test";
import { computeDiff, langFromPath } from "../src/core/diff.js";

describe("langFromPath", () => {
  it("returns correct language for known extensions", () => {
    expect(langFromPath("file.ts")).toBe("ts");
    expect(langFromPath("file.py")).toBe("python");
    expect(langFromPath("file.go")).toBe("go");
    expect(langFromPath("file.rs")).toBe("rust");
  });

  it("returns empty string for no extension", () => {
    expect(langFromPath("Makefile")).toBe("");
    expect(langFromPath("Dockerfile")).toBe("");
  });

  it("returns empty string for unknown extensions", () => {
    expect(langFromPath("file.xyz")).toBe("");
    expect(langFromPath("file.md")).toBe("");
  });

  it("handles hidden files (dot at position 0 of filename)", () => {
    // .gitignore → lastIndexOf(".") = 0 in basename, ext = ".gitignore"
    expect(langFromPath(".gitignore")).toBe("");
  });

  it("handles dotfiles with known extensions", () => {
    expect(langFromPath(".eslintrc.js")).toBe("js");
  });

  it("handles paths with dots in directories", () => {
    expect(langFromPath("src/v2.0/file.ts")).toBe("ts");
  });

  it("handles uppercase extensions (case-insensitive via toLowerCase)", () => {
    // The code calls .toLowerCase() on the extension
    expect(langFromPath("file.TS")).toBe("ts");
    expect(langFromPath("file.Ts")).toBe("ts");
  });

  it("handles empty string", () => {
    expect(langFromPath("")).toBe("");
  });

  it("handles path that is just a dot", () => {
    expect(langFromPath(".")).toBe("");
  });

  it("handles path ending in dot", () => {
    // "file." → lastIndexOf(".") = 4, ext = "" → EXT_MAP[""] = undefined → ""
    expect(langFromPath("file.")).toBe("");
  });
});

describe("computeDiff", () => {
  it("handles creation (empty old string)", () => {
    const result = computeDiff("", "line1\nline2\nline3");
    expect(result.isCreation).toBe(true);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
  });

  it("handles identical strings (no diff)", () => {
    const result = computeDiff("foo\nbar", "foo\nbar");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("handles both empty strings", () => {
    const result = computeDiff("", "");
    expect(result.isCreation).toBe(true);
    expect(result.added).toBe(1); // split("") → [""]
  });

  it("handles single character diff", () => {
    const result = computeDiff("a", "b");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("collapses creation with >10 lines to 3+collapsed+2", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const result = computeDiff("", lines.join("\n"));
    expect(result.isCreation).toBe(true);
    // Should have 3 add lines + 1 collapsed + 2 add lines = 6
    expect(result.lines.length).toBe(6);
    expect(result.lines[3]?.kind).toBe("collapsed");
    expect(result.lines[3]?.collapsedCount).toBe(15); // 20 - 5
  });

  it("applies startLine offset correctly", () => {
    const result = computeDiff("old", "new", 10);
    const addLine = result.lines.find((l) => l.kind === "add");
    expect(addLine?.newNum).toBe(10); // offset applied
  });

  it("handles very large matrices by falling back to full remove+add", () => {
    // LCS guard: n * m > 100_000
    const a = Array.from({ length: 400 }, (_, i) => `old${i}`).join("\n");
    const b = Array.from({ length: 300 }, (_, i) => `new${i}`).join("\n");
    // 400 * 300 = 120,000 > 100,000 → should use fallback
    const result = computeDiff(a, b);
    expect(result.removed).toBe(400);
    expect(result.added).toBe(300);
  });

  it("collapses long runs of context lines", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[0] = "changed";
    const result = computeDiff(oldLines.join("\n"), newLines.join("\n"));
    const collapsed = result.lines.find((l) => l.kind === "collapsed");
    expect(collapsed).toBeDefined();
  });

  it("handles trailing newline differences", () => {
    const result = computeDiff("foo\n", "foo\n\n");
    // "foo\n" splits to ["foo", ""], "foo\n\n" splits to ["foo", "", ""]
    expect(result.added).toBe(1);
  });
});

describe("computeDiff — edge cases", () => {
  it("handles deletion (non-empty old, empty new)", () => {
    const result = computeDiff("old content\nline 2\n", "");
    expect(result.isCreation).toBe(false);
    expect(result.removed).toBeGreaterThan(0);
    const removeLines = result.lines.filter((l) => l.kind === "remove");
    expect(removeLines.some((l) => l.content === "old content")).toBe(true);
    expect(removeLines.some((l) => l.content === "line 2")).toBe(true);
  });

  it("handles whitespace-only changes", () => {
    const result = computeDiff("  foo()", "    foo()");
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    const removeLine = result.lines.find((l) => l.kind === "remove");
    const addLine = result.lines.find((l) => l.kind === "add");
    expect(removeLine?.content).toBe("  foo()");
    expect(addLine?.content).toBe("    foo()");
  });

  it("handles single-line file", () => {
    const result = computeDiff("old", "new");
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
  });

  it("handles unicode content", () => {
    const result = computeDiff("café\n日本語", "café\n中文");
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    const removeLine = result.lines.find((l) => l.kind === "remove");
    const addLine = result.lines.find((l) => l.kind === "add");
    expect(removeLine?.content).toBe("日本語");
    expect(addLine?.content).toBe("中文");
  });

  it("handles very long lines (10K chars)", () => {
    const long = "x".repeat(10000);
    const result = computeDiff(long, `${long}y`);
    expect(result).toBeDefined();
    expect(result.added).toBeGreaterThanOrEqual(1);
  });

  it("handles file with only newlines", () => {
    const result = computeDiff("\n\n\n", "\n\n");
    expect(result).toBeDefined();
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });
});

describe("langFromPath — additional extensions", () => {
  it("handles .scss", () => expect(langFromPath("file.scss")).toBe("css"));
  it("handles .jsx", () => expect(langFromPath("file.jsx")).toBe("jsx"));
  it("handles .mjs (unmapped)", () => expect(langFromPath("file.mjs")).toBe(""));
  it("handles .cjs (unmapped)", () => expect(langFromPath("file.cjs")).toBe(""));
  it("handles .mts (unmapped)", () => expect(langFromPath("file.mts")).toBe(""));
  it("handles .yml (unmapped)", () => expect(langFromPath("file.yml")).toBe(""));
  it("handles .sh", () => expect(langFromPath("file.sh")).toBe("bash"));
});
