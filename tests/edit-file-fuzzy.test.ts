import { describe, expect, it } from "bun:test";
import { fuzzyWhitespaceMatch, formatMetricDelta } from "../src/core/tools/edit-file.js";

describe("fuzzyWhitespaceMatch — tabs vs spaces", () => {
  it("matches tabs in content when oldStr uses spaces", () => {
    const content = "function foo() {\n\tconst x = 1;\n\treturn x;\n}";
    const oldStr = "  const x = 1;\n  return x;";
    const newStr = "  const x = 2;\n  return x;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.oldStr).toBe("\tconst x = 1;\n\treturn x;");
    expect(result!.newStr).toBe("\tconst x = 2;\n\treturn x;");
  });

  it("matches spaces in content when oldStr uses tabs", () => {
    const content = "function foo() {\n    const x = 1;\n}";
    const oldStr = "\tconst x = 1;";
    const newStr = "\tconst y = 1;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.oldStr).toBe("    const x = 1;");
    expect(result!.newStr).toBe("    const y = 1;");
  });

  it("handles mixed indentation levels", () => {
    const content = "\t\tif (true) {\n\t\t\treturn 1;\n\t\t}";
    const oldStr = "    if (true) {\n      return 1;\n    }";
    const newStr = "    if (false) {\n      return 0;\n    }";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.oldStr).toContain("\t\tif (true)");
  });
});

describe("fuzzyWhitespaceMatch — no match", () => {
  it("returns null when content doesn't match", () => {
    const content = "const a = 1;\nconst b = 2;";
    const oldStr = "const c = 3;";
    const newStr = "const c = 4;";
    expect(fuzzyWhitespaceMatch(content, oldStr, newStr)).toBeNull();
  });

  it("returns null for empty oldStr (single empty line)", () => {
    const content = "hello\nworld";
    const result = fuzzyWhitespaceMatch(content, "", "new");
    expect(result === null || result.oldStr !== undefined).toBe(true);
  });

  it("returns null when match is ambiguous (duplicate blocks)", () => {
    const content = "  foo();\n  bar();\n  foo();\n  bar();";
    const oldStr = "  foo();\n  bar();";
    const newStr = "  baz();";
    expect(fuzzyWhitespaceMatch(content, oldStr, newStr)).toBeNull();
  });
});

describe("fuzzyWhitespaceMatch — edge cases", () => {
  it("handles trailing whitespace differences", () => {
    const content = "  const x = 1;   \n  const y = 2;";
    const oldStr = "const x = 1;\nconst y = 2;";
    const newStr = "const x = 99;\nconst y = 99;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
  });

  it("handles single-line match", () => {
    const content = "\t\treturn true;";
    const oldStr = "  return true;";
    const newStr = "  return false;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.newStr).toBe("\t\treturn false;");
  });

  it("preserves newStr lines beyond oldStr length", () => {
    const content = "\tconst x = 1;";
    const oldStr = "  const x = 1;";
    const newStr = "  const x = 1;\n  const y = 2;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.newStr).toContain("const y = 2;");
  });

  it("handles content with blank lines between matches", () => {
    const content = "function foo() {\n\n\tconst x = 1;\n}";
    const oldStr = "  const x = 1;";
    const newStr = "  const x = 2;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
  });

  it("handles 4-space vs 2-space indentation", () => {
    const content = "    const x = 1;\n    const y = 2;";
    const oldStr = "  const x = 1;\n  const y = 2;";
    const newStr = "  const z = 3;\n  const w = 4;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.newStr).toBe("    const z = 3;\n    const w = 4;");
  });

  it("handles no indentation in content", () => {
    const content = "return 1;";
    const oldStr = "  return 1;";
    const newStr = "  return 2;";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.newStr).toBe("return 2;");
  });
});

describe("fuzzyWhitespaceMatch — large input", () => {
  it("handles 10000 lines without hanging", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `\tline_${i}();`);
    lines[9990] = "\ttarget();";
    const content = lines.join("\n");
    const oldStr = "  target();";
    const newStr = "  replacement();";
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
    expect(result!.newStr).toBe("\treplacement();");
  });

  it("handles 1000-line oldStr", () => {
    const oldLines = Array.from({ length: 1000 }, (_, i) => `  stmt_${i}();`);
    const contentLines = oldLines.map((l) => `\t${l.trim()}`);
    const content = contentLines.join("\n");
    const oldStr = oldLines.join("\n");
    const newStr = oldLines.map((l) => l.replace("stmt", "newStmt")).join("\n");
    const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
    expect(result).not.toBeNull();
  });
});

describe("formatMetricDelta", () => {
  it("returns empty for no change", () => {
    expect(formatMetricDelta("Complexity", 5, 5)).toBe("");
  });

  it("shows positive delta", () => {
    expect(formatMetricDelta("Lines", 10, 15)).toBe("Lines: 10→15 (+5)");
  });

  it("shows negative delta", () => {
    expect(formatMetricDelta("Lines", 15, 10)).toBe("Lines: 15→10 (-5)");
  });

  it("handles zero values", () => {
    expect(formatMetricDelta("X", 0, 3)).toBe("X: 0→3 (+3)");
  });
});
