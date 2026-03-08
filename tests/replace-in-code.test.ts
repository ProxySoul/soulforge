import { describe, expect, it } from "bun:test";
import { replaceInCode } from "../src/core/tools/rename-symbol.js";

describe("replaceInCode", () => {
  it("replaces symbol in plain code", () => {
    expect(replaceInCode("const foo = bar(foo);", "foo", "baz")).toBe("const baz = bar(baz);");
  });

  it("does not replace inside double-quoted strings", () => {
    const src = 'const x = "foo is cool"; foo();';
    expect(replaceInCode(src, "foo", "bar")).toBe('const x = "foo is cool"; bar();');
  });

  it("does not replace inside single-quoted strings", () => {
    const src = "const x = 'foo'; foo();";
    expect(replaceInCode(src, "foo", "bar")).toBe("const x = 'foo'; bar();");
  });

  it("does not replace inside single-line comments", () => {
    const src = "// foo is here\nfoo();";
    expect(replaceInCode(src, "foo", "bar")).toBe("// foo is here\nbar();");
  });

  it("does not replace inside multi-line comments", () => {
    const src = "/* foo */ foo();";
    expect(replaceInCode(src, "foo", "bar")).toBe("/* foo */ bar();");
  });

  it("does not replace inside Python hash comments", () => {
    const src = "# foo comment\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("# foo comment\nbar()");
  });

  it("handles hash comment after whitespace", () => {
    const src = "x = 1 # foo\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("x = 1 # foo\nbar()");
  });

  it("handles division operator (lone / is not a comment)", () => {
    const src = "foo / foo";
    expect(replaceInCode(src, "foo", "bar")).toBe("bar / bar");
  });

  it("handles CSS color hash (# mid-word is not a comment)", () => {
    const src = "color:#foo;";
    expect(replaceInCode(src, "foo", "bar")).toBe("color:#bar;");
  });

  it("handles unterminated multi-line comment", () => {
    const src = "/* foo forever\nfoo foo foo";
    expect(replaceInCode(src, "foo", "bar")).toBe("/* foo forever\nfoo foo foo");
  });

  it("handles escaped quotes inside strings", () => {
    const src = 'const s = "foo \\"foo\\" end"; foo();';
    expect(replaceInCode(src, "foo", "bar")).toBe('const s = "foo \\"foo\\" end"; bar();');
  });

  it("handles backslash at end of string (escaped backslash before closing quote)", () => {
    const src = '"foo\\\\";\nfoo();';
    expect(replaceInCode(src, "foo", "bar")).toBe('"foo\\\\";\nbar();');
  });

  it("handles empty source", () => {
    expect(replaceInCode("", "foo", "bar")).toBe("");
  });

  it("handles source with only a comment", () => {
    expect(replaceInCode("// foo", "foo", "bar")).toBe("// foo");
  });

  it("handles source with only a string", () => {
    expect(replaceInCode('"foo"', "foo", "bar")).toBe('"foo"');
  });

  it("handles adjacent strings and comments", () => {
    const src = '"a"/*b*/\'c\'//d\nfoo';
    expect(replaceInCode(src, "foo", "bar")).toBe('"a"/*b*/\'c\'//d\nbar');
  });

  it("preserves content between comment end and next code", () => {
    const src = "/* comment */  foo  /* comment */";
    expect(replaceInCode(src, "foo", "bar")).toBe("/* comment */  bar  /* comment */");
  });

  it("replaces symbols inside template literal interpolations", () => {
    expect(replaceInCode("`${foo}`", "foo", "bar")).toBe("`${bar}`");
  });

  it("preserves static text in template literals while replacing interpolations", () => {
    expect(replaceInCode("`hello ${foo} world`", "foo", "bar")).toBe("`hello ${bar} world`");
  });

  it("handles nested braces inside template interpolation", () => {
    expect(replaceInCode("`${foo({ a: 1 })}`", "foo", "bar")).toBe("`${bar({ a: 1 })}`");
  });

  it("handles single-char source that is a quote", () => {
    expect(replaceInCode('"', "foo", "bar")).toBe('"');
  });

  it("handles regex-like content after division", () => {
    const src = "a = b / c; foo();";
    expect(replaceInCode(src, "foo", "bar")).toBe("a = b / c; bar();");
  });

  it("handles multiple slashes", () => {
    const src = "a / b / foo";
    expect(replaceInCode(src, "foo", "bar")).toBe("a / b / bar");
  });

  // --- Edge cases ---

  it("replaces symbol at start of source", () => {
    expect(replaceInCode("foo = 1", "foo", "bar")).toBe("bar = 1");
  });

  it("replaces symbol at end of source", () => {
    expect(replaceInCode("x = foo", "foo", "bar")).toBe("x = bar");
  });

  it("respects word boundaries — substring of another identifier is untouched", () => {
    expect(replaceInCode("foobar = foo", "foo", "baz")).toBe("foobar = baz");
  });

  it("treats regex literal as code (no regex literal detection — / is division)", () => {
    const src = "const re = /foo/g; foo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("const re = /bar/g; bar()");
  });

  it("handles Python triple-quoted string — each quote pair is a separate string", () => {
    // The parser sees: "" (empty string), then "foo" (string), then "" (empty string)
    // So foo is inside a string and protected
    expect(replaceInCode('"""foo"""', "foo", "bar")).toBe('"""foo"""');
  });

  it("handles Rust raw string r#\"foo\"# — r is code, content is string", () => {
    // The parser sees: r (code), then #"foo"# where "foo" is a string and trailing # is code
    expect(replaceInCode('r#"foo"#', "foo", "bar")).toBe('r#"foo"#');
  });

  it("protects JSX string attribute", () => {
    const src = '<div className="foo">';
    expect(replaceInCode(src, "foo", "bar")).toBe('<div className="foo">');
  });

  it("only replaces code foo when multiple adjacent comments precede it", () => {
    const src = "// foo\n/* foo */\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("// foo\n/* foo */\nbar()");
  });

  it("does not treat # after colon as a comment (CSS color mid-line)", () => {
    const src = "color:#fff";
    expect(replaceInCode(src, "fff", "000")).toBe("color:#000");
  });

  it("handles very long source (1000 lines)", () => {
    const line = "foo = foo + 1;\n";
    const src = line.repeat(1000);
    const expected = "bar = bar + 1;\n".repeat(1000);
    expect(replaceInCode(src, "foo", "bar")).toBe(expected);
  });

  it("replaces single-char symbol", () => {
    expect(replaceInCode("a = b", "a", "x")).toBe("x = b");
  });

  it("handles empty symbol name without crashing", () => {
    // Empty symbol creates regex /\b\b/g which matches zero-width word boundaries
    // This inserts "bar" at every word boundary position
    const result = replaceInCode("foo", "", "bar");
    expect(result).toBe("barfoobar");
  });

  it("replaces symbol with trailing newline preserved", () => {
    expect(replaceInCode("foo\n", "foo", "bar")).toBe("bar\n");
  });

  it("returns whitespace-only source unchanged", () => {
    expect(replaceInCode("   ", "foo", "bar")).toBe("   ");
  });

  it("replaces tab-indented code but not tab-indented comment", () => {
    const src = "\tfoo();\n\t// foo\n";
    expect(replaceInCode(src, "foo", "bar")).toBe("\tbar();\n\t// foo\n");
  });
});
