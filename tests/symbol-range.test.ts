import { describe, expect, it } from "bun:test";
import { findSymbolRange, findCommentStart, line as getLine } from "../src/core/tools/move-symbol.js";

describe("findSymbolRange", () => {
  it("finds a simple function", () => {
    const lines = ["function foo() {", "  return 1;", "}"];
    const result = findSymbolRange(lines, "foo");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds an exported function", () => {
    const lines = ["export function foo() {", "  return 1;", "}"];
    const result = findSymbolRange(lines, "foo");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds export default function", () => {
    const lines = ["export default function foo() {", "}"];
    const result = findSymbolRange(lines, "foo");
    expect(result).toEqual({ start: 0, end: 1 });
  });

  it("finds type alias (no braces, ends with ;)", () => {
    const lines = ["type Foo = string;"];
    const result = findSymbolRange(lines, "Foo");
    expect(result).toEqual({ start: 0, end: 0 });
  });

  it("finds interface with body", () => {
    const lines = ["interface Foo {", "  name: string;", "}"];
    const result = findSymbolRange(lines, "Foo");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds Rust pub(crate) struct", () => {
    const lines = ["pub(crate) struct Config {", "  pub name: String,", "}"];
    const result = findSymbolRange(lines, "Config");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds Rust fn", () => {
    const lines = ["pub fn process() {", "  todo!()", "}"];
    const result = findSymbolRange(lines, "process");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds Python def", () => {
    const lines = ["def my_func():", "    return 1"];
    const result = findSymbolRange(lines, "my_func");
    expect(result?.start).toBe(0);
  });

  it("finds Go func", () => {
    const lines = ["func main() {", "  fmt.Println()", "}"];
    const result = findSymbolRange(lines, "main");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("returns null for missing symbol", () => {
    const lines = ["function bar() {", "}"];
    expect(findSymbolRange(lines, "foo")).toBeNull();
  });

  it("handles nested braces correctly", () => {
    const lines = [
      "function foo() {",
      "  if (true) {",
      "    while (x) {",
      "      break;",
      "    }",
      "  }",
      "}",
    ];
    const result = findSymbolRange(lines, "foo");
    expect(result).toEqual({ start: 0, end: 6 });
  });

  it("handles symbol name that is a prefix of another (word boundary)", () => {
    const lines = ["function fooBar() {", "}", "function foo() {", "}"];
    const result = findSymbolRange(lines, "foo");
    expect(result?.start).toBe(2);
  });

  it("handles const with no braces and semicolon", () => {
    const lines = ["export const MAX_SIZE = 100;"];
    const result = findSymbolRange(lines, "MAX_SIZE");
    expect(result).toEqual({ start: 0, end: 0 });
  });

  it("handles abstract class", () => {
    const lines = ["export abstract class Base {", "  abstract run(): void;", "}"];
    const result = findSymbolRange(lines, "Base");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("handles enum", () => {
    const lines = ["enum Color {", "  Red,", "  Blue,", "}"];
    const result = findSymbolRange(lines, "Color");
    expect(result).toEqual({ start: 0, end: 3 });
  });

  it("known limitation: braces in string literals cause early close", () => {
    const lines = ['function foo() {', '  const s = "}";', '  return s;', '}'];
    const result = findSymbolRange(lines, "foo");
    // BUG: brace counter sees } inside string literal and closes at line 1 instead of 3
    // Correct behavior would be: expect(result).toEqual({ start: 0, end: 3 });
    expect(result?.end).toBe(1);
  });

  it("handles unclosed function (no closing brace)", () => {
    const lines = ["function foo() {", "  return 1;"];
    const result = findSymbolRange(lines, "foo");
    expect(result?.start).toBe(0);
    // No closing brace found, so end equals start (line 0 only)
    expect(result?.end).toBe(0);
  });

  // ─── Edge Cases ──────────────────────────────────────────

  it("returns null for empty lines array", () => {
    expect(findSymbolRange([], "foo")).toBeNull();
  });

  it("handles symbol on last line with no closing brace", () => {
    const lines = ["const x = 1;", "function foo() {"];
    const result = findSymbolRange(lines, "foo");
    expect(result).not.toBeNull();
    expect(result?.start).toBe(1);
  });

  it("finds multiline type alias ending with semicolon", () => {
    const lines = ["type Foo =", "  string | number;"];
    const result = findSymbolRange(lines, "Foo");
    expect(result).toEqual({ start: 0, end: 1 });
  });

  it("finds Rust impl block", () => {
    const lines = ["impl Foo {", "  fn bar(&self) {}", "}"];
    const result = findSymbolRange(lines, "Foo");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("finds Rust trait", () => {
    const lines = ["trait MyTrait {", "  fn required(&self);", "}"];
    const result = findSymbolRange(lines, "MyTrait");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("handles const with object value (brace counting)", () => {
    const lines = ["const config = {", "  port: 3000,", "};"];
    const result = findSymbolRange(lines, "config");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("returns first occurrence for duplicate symbol name", () => {
    const lines = [
      "function handler() {",
      "  return 1;",
      "}",
      "function handler() {",
      "  return 2;",
      "}",
    ];
    const result = findSymbolRange(lines, "handler");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("matches indented keyword (leading whitespace)", () => {
    const lines = ["  export function foo() {", "    return 1;", "  }"];
    const result = findSymbolRange(lines, "foo");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("handles very long symbol name (50 chars)", () => {
    const name = "a".repeat(50);
    const lines = [`function ${name}() {`, "  return 1;", "}"];
    const result = findSymbolRange(lines, name);
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("handles symbol name with underscore prefix", () => {
    const lines = ["function _privateHelper() {", "  return 1;", "}"];
    const result = findSymbolRange(lines, "_privateHelper");
    expect(result).toEqual({ start: 0, end: 2 });
  });

  it("handles symbol name with numbers", () => {
    const lines = ["function handler2() {", "  return 2;", "}"];
    const result = findSymbolRange(lines, "handler2");
    expect(result).toEqual({ start: 0, end: 2 });
  });
});

describe("findCommentStart", () => {
  it("finds JSDoc comment above definition", () => {
    const lines = ["/**", " * Description", " */", "function foo() {}"];
    expect(findCommentStart(lines, 3)).toBe(0);
  });

  it("finds single-line comments above definition", () => {
    const lines = ["// comment 1", "// comment 2", "function foo() {}"];
    expect(findCommentStart(lines, 2)).toBe(0);
  });

  it("finds Rust doc comments (///)", () => {
    const lines = ["/// Documentation", "pub fn foo() {}"];
    expect(findCommentStart(lines, 1)).toBe(0);
  });

  it("includes Rust attributes (#[derive])", () => {
    const lines = ["#[derive(Debug)]", '#[serde(rename_all = "camelCase")]', "pub struct Foo {}"];
    expect(findCommentStart(lines, 2)).toBe(0);
  });

  it("includes attributes after doc comment", () => {
    const lines = ["/// Documentation", "#[derive(Clone)]", "pub struct Foo {}"];
    expect(findCommentStart(lines, 2)).toBe(1);
  });

  it("returns defStart when no comment above", () => {
    const lines = ["", "function foo() {}"];
    expect(findCommentStart(lines, 1)).toBe(1);
  });

  it("stops at non-comment line", () => {
    const lines = ["const x = 1;", "// comment", "function foo() {}"];
    expect(findCommentStart(lines, 2)).toBe(1);
  });

  it("handles defStart at line 0", () => {
    const lines = ["function foo() {}"];
    expect(findCommentStart(lines, 0)).toBe(0);
  });

  // ─── Edge Cases ──────────────────────────────────────────

  it("finds block comment (/* ... */) above definition", () => {
    const lines = ["/*", " * Block comment", " */", "function foo() {}"];
    // "/*" alone doesn't match any comment marker (needs "/**"), so scanning
    // stops at " * Block comment" (line 1). Documents that bare /* is missed.
    expect(findCommentStart(lines, 3)).toBe(1);
  });

  it("does not include blank lines between comment and definition", () => {
    const lines = ["// orphaned comment", "", "function foo() {}"];
    expect(findCommentStart(lines, 2)).toBe(2);
  });

  it("does not detect Python decorators (documents limitation)", () => {
    const lines = ["@decorator", "def foo():", "    pass"];
    expect(findCommentStart(lines, 1)).toBe(1);
  });

  it("finds Rust #[cfg(test)] attribute", () => {
    const lines = ["#[cfg(test)]", "mod tests {", "}"];
    expect(findCommentStart(lines, 1)).toBe(0);
  });

  it("finds multiple stacked Rust attributes", () => {
    const lines = [
      "#[derive(Debug, Clone)]",
      "#[serde(rename_all = \"camelCase\")]",
      "#[cfg(feature = \"full\")]",
      "pub struct Config {}",
    ];
    expect(findCommentStart(lines, 3)).toBe(0);
  });

  it("returns 0 when defStart is 0 (no lines above)", () => {
    const lines = ["pub fn foo() {}"];
    expect(findCommentStart(lines, 0)).toBe(0);
  });
});

describe("line helper", () => {
  it("returns line content for valid index", () => {
    expect(getLine(["a", "b", "c"], 1)).toBe("b");
  });

  it("returns empty string for out-of-bounds index", () => {
    expect(getLine(["a"], 5)).toBe("");
  });
});
