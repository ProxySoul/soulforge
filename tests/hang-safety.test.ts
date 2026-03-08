import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegexBackend } from "../src/core/intelligence/backends/regex.js";
import { replaceInCode } from "../src/core/tools/rename-symbol.js";
import { tsJsHandler } from "../src/core/tools/move-symbol.js";

const TMP = join(tmpdir(), `hang-safety-${Date.now()}`);
const backend = new RegexBackend();

function writeTemp(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ── replaceInCode hang safety across languages ──

describe("replaceInCode — hang safety", () => {
  // JavaScript / TypeScript
  it("JS: regex literal with slashes", () => {
    expect(replaceInCode("const re = /foo/g; foo();", "foo", "bar")).toBe("const re = /bar/g; bar();");
  });

  it("JS: chained division operators", () => {
    expect(replaceInCode("foo / foo / foo", "foo", "bar")).toBe("bar / bar / bar");
  });

  it("JS: division in ternary", () => {
    expect(replaceInCode("x ? a / foo : foo / b", "foo", "bar")).toBe("x ? a / bar : bar / b");
  });

  it("JS: nested template literals", () => {
    const src = "`outer ${`inner ${foo}`} end`";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar");
  });

  it("JS: template literal with unmatched brace in string", () => {
    const src = '`${foo + "{"}`';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar");
  });

  it("JS: unclosed template literal at EOF", () => {
    const src = "`${foo";
    expect(() => replaceInCode(src, "foo", "bar")).not.toThrow();
  });

  it("JS: empty template literal", () => {
    expect(replaceInCode("``; foo()", "foo", "bar")).toBe("``; bar()");
  });

  it("JS: template literal with only static text", () => {
    expect(replaceInCode("`hello world`; foo()", "foo", "bar")).toBe("`hello world`; bar()");
  });

  // Python
  it("Python: hash in string literal (not a comment)", () => {
    expect(replaceInCode('foo = "# not a comment"; foo()', "foo", "bar")).toBe('bar = "# not a comment"; bar()');
  });

  it("Python: hash after tab (is a comment)", () => {
    expect(replaceInCode("x = foo\t# foo\nfoo()", "foo", "bar")).toBe("x = bar\t# foo\nbar()");
  });

  it("Python: multiple hash comments", () => {
    const src = "# foo\n# foo\n# foo\nfoo()";
    expect(replaceInCode(src, "foo", "bar")).toBe("# foo\n# foo\n# foo\nbar()");
  });

  it("Python: triple-quoted string (each quote handled individually)", () => {
    const src = '"""foo"""; foo()';
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  // CSS
  it("CSS: color hex values", () => {
    expect(replaceInCode(".foo { color: #fff; }", "foo", "bar")).toBe(".bar { color: #fff; }");
  });

  it("CSS: multiple hash colors", () => {
    const src = ".foo { color: #aaa; background: #bbb; }";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toBe(".bar { color: #aaa; background: #bbb; }");
  });

  // Go
  it("Go: raw string literal with backticks", () => {
    const src = "foo := `raw string`\nfoo()";
    const result = replaceInCode(src, "foo", "bar");
    expect(result).toContain("bar()");
  });

  // Rust
  it("Rust: division in expression", () => {
    expect(replaceInCode("let x = foo / 2;", "foo", "bar")).toBe("let x = bar / 2;");
  });

  it("Rust: doc comment ///", () => {
    const src = "/// foo docs\nfn foo() {}";
    expect(replaceInCode(src, "foo", "bar")).toBe("/// foo docs\nfn bar() {}");
  });

  // C / C++
  it("C: preprocessor #include (hash at line start)", () => {
    const src = '#include "foo.h"\nfoo();';
    expect(replaceInCode(src, "foo", "bar")).toBe('#include "foo.h"\nbar();');
  });

  it("C: #define (hash at line start)", () => {
    const src = "#define FOO 1\nFOO;";
    expect(replaceInCode(src, "FOO", "BAR")).toBe("#define FOO 1\nBAR;");
  });

  // Pathological inputs
  it("source of only slashes", () => {
    expect(() => replaceInCode("////", "foo", "bar")).not.toThrow();
  });

  it("source of only hashes after newlines", () => {
    expect(() => replaceInCode("\n#\n#\n#\n", "foo", "bar")).not.toThrow();
  });

  it("source of only quotes", () => {
    expect(() => replaceInCode('""""', "foo", "bar")).not.toThrow();
  });

  it("source of alternating special chars", () => {
    expect(() => replaceInCode('/"#`\'/"#`\'', "foo", "bar")).not.toThrow();
  });

  it("1000 consecutive slashes", () => {
    const src = "/".repeat(1000);
    const start = performance.now();
    expect(() => replaceInCode(src, "foo", "bar")).not.toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("1000 consecutive backticks", () => {
    const src = "`".repeat(1000);
    const start = performance.now();
    expect(() => replaceInCode(src, "foo", "bar")).not.toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("deeply nested template interpolations", () => {
    let src = "foo";
    for (let i = 0; i < 20; i++) src = `\`\${${src}}\``;
    const start = performance.now();
    expect(() => replaceInCode(src, "foo", "bar")).not.toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("unclosed multi-line comment at EOF", () => {
    expect(replaceInCode("foo(); /* unclosed", "foo", "bar")).toBe("bar(); /* unclosed");
  });

  it("unclosed string at EOF", () => {
    expect(replaceInCode('foo(); "unclosed', "foo", "bar")).toBe('bar(); "unclosed');
  });

  it("null bytes in source", () => {
    expect(() => replaceInCode("foo\x00bar", "foo", "bar")).not.toThrow();
  });

  it("empty string", () => {
    expect(replaceInCode("", "foo", "bar")).toBe("");
  });

  it("source with no code regions (all comments/strings)", () => {
    expect(replaceInCode('// foo\n"foo"\n/* foo */', "foo", "bar")).toBe('// foo\n"foo"\n/* foo */');
  });

  it("10KB source with lots of code", () => {
    const lines = Array.from({ length: 250 }, (_, i) =>
      `function fn${i}(foo: number) { return foo + ${i}; }`,
    );
    const src = lines.join("\n");
    expect(src.length).toBeGreaterThan(10000);
    const start = performance.now();
    const result = replaceInCode(src, "foo", "bar");
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toContain("bar");
    expect(result).not.toContain("foo");
  });

  it("alternating template expressions", () => {
    const fragment = "`${a}`";
    const src = `const x = ${fragment.repeat(100)}; foo();`;
    const start = performance.now();
    const result = replaceInCode(src, "foo", "bar");
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toContain("bar()");
  });
});

// ── RegexBackend hang safety across languages ──

describe("RegexBackend — hang safety", () => {
  it("TS: file with only comments", async () => {
    const f = writeTemp("comments.ts", "// line1\n/* block\n*/\n// line2");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toEqual([]);
  });

  it("TS: deeply nested braces", async () => {
    const braces = "{".repeat(50) + "}".repeat(50);
    const f = writeTemp("deep.ts", `function foo() ${braces}`);
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("TS: function with no closing brace", async () => {
    const f = writeTemp("unclosed.ts", "function foo() {\n  return 1;\n  // never closes");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("Python: deeply nested indentation", async () => {
    const lines = ["def foo():"];
    for (let i = 1; i <= 20; i++) lines.push(" ".repeat(i * 4) + `level${i}()`);
    const f = writeTemp("deep.py", lines.join("\n"));
    const block = await backend.readSymbol(f, "foo");
    expect(block?.content).toContain("level20");
  });

  it("Python: function at EOF with no trailing newline", async () => {
    const f = writeTemp("eof.py", "def foo():\n    pass");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("Python: empty function body", async () => {
    const f = writeTemp("empty.py", "def foo():\n\ndef bar():\n    pass");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
    expect(block?.content).not.toContain("bar");
  });

  it("Go: method receiver with pointer", async () => {
    const f = writeTemp("method.go", "func (s *Server) Start() {\n\treturn\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.[0]?.name).toBe("Start");
  });

  it("Go: interface with embedded types", async () => {
    const f = writeTemp("iface.go", "type Reader interface {\n\tRead(p []byte) (n int, err error)\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "Reader")).toBeDefined();
  });

  it("Rust: generic struct", async () => {
    const f = writeTemp("generic.rs", "pub struct Vec<T> {\n    ptr: *mut T,\n    len: usize,\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "Vec")).toBeDefined();
  });

  it("Rust: impl block (not a symbol)", async () => {
    const f = writeTemp("impl.rs", "impl Foo {\n    pub fn bar() {}\n}");
    const symbols = await backend.findSymbols(f);
    expect(symbols?.find((s) => s.name === "bar")).toBeDefined();
  });

  it("empty file", async () => {
    const f = writeTemp("empty.ts", "");
    const symbols = await backend.findSymbols(f);
    expect(symbols === null || symbols?.length === 0).toBe(true);
  });

  it("file with only whitespace", async () => {
    const f = writeTemp("ws.ts", "   \n\n\t\t\n   ");
    const symbols = await backend.findSymbols(f);
    expect(symbols).toEqual([]);
  });

  it("file with 10000 lines", async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `const x${i} = ${i};`);
    lines[5000] = "function target() {}";
    const f = writeTemp("big.ts", lines.join("\n"));
    const start = performance.now();
    const symbols = await backend.findSymbols(f, "target");
    expect(performance.now() - start).toBeLessThan(500);
    expect(symbols).toHaveLength(1);
    expect(symbols?.[0]?.location.line).toBe(5001);
  });

  it("binary-looking content doesn't crash", async () => {
    const f = writeTemp("binary.ts", "\x00\x01\x02function foo() {}\x00\x00");
    const symbols = await backend.findSymbols(f);
    expect(symbols).not.toBeNull();
  });

  it("readScope with startLine beyond file length", async () => {
    const f = writeTemp("short.ts", "const x = 1;");
    const block = await backend.readScope(f, 999);
    expect(block?.content).toBe("");
  });

  it("readScope with endLine before startLine", async () => {
    const f = writeTemp("backwards.ts", "line1\nline2\nline3");
    const block = await backend.readScope(f, 3, 1);
    expect(block).not.toBeNull();
  });

  it("file with 1000 functions — find last one", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `function fn${i}() { return ${i}; }`);
    const f = writeTemp("manyfns.ts", lines.join("\n"));
    const start = performance.now();
    const block = await backend.readSymbol(f, "fn999");
    expect(performance.now() - start).toBeLessThan(500);
    expect(block).not.toBeNull();
    expect(block?.content).toContain("fn999");
  });

  it("file with extremely long lines", async () => {
    const longLine = "x".repeat(10000);
    const lines = Array.from({ length: 10 }, (_, i) =>
      i === 5 ? `function target() { const s = "${longLine}"; }` : `const v${i} = "${longLine}";`,
    );
    const f = writeTemp("longlines.ts", lines.join("\n"));
    const start = performance.now();
    const symbols = await backend.findSymbols(f, "target");
    expect(performance.now() - start).toBeLessThan(500);
    expect(symbols).toHaveLength(1);
  });
});

// ── Import parser hang safety ──

describe("import parser — hang safety", () => {
  it("import with { but no closing } — runs to EOF without hanging", () => {
    const src = 'import { foo,\nbar,\nbaz\nfrom "./mod";\nconst x = 1;';
    const result = tsJsHandler.parse(src);
    expect(result).toBeDefined();
  });

  it("1000 imports", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `import { x${i} } from "./mod${i}";`);
    const start = performance.now();
    const result = tsJsHandler.parse(lines.join("\n"));
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toHaveLength(1000);
  });

  it("import with empty braces — skipped by production parser", () => {
    const src = 'import {} from "./empty";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("multiline export with 100 specifiers", () => {
    const specs = Array.from({ length: 100 }, (_, i) => `  Spec${i}`).join(",\n");
    const src = `export type {\n${specs}\n} from "./types";`;
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.isReExport).toBe(true);
    expect(result[0]?.isType).toBe(true);
  });

  it("line that looks like import but isn't", () => {
    const src = 'const s = "import { foo } from bar";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("export without from (not a re-export)", () => {
    const src = "export { foo };";
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("brace in string on same line as import (confusing parser)", () => {
    const src = 'import { foo } from "./bar"; // {tricky}';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("./bar");
  });
});

// ── Brace scope extraction hang safety ──

describe("extractBraceScope — hang safety via readSymbol", () => {
  it("braces inside string literals (false depth counting)", async () => {
    const src = [
      'function foo() {',
      '  const s = "}}}";',
      '  const t = "{{{";',
      '  return s + t;',
      '}',
    ].join("\n");
    const f = writeTemp("stringbraces.ts", src);
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("100 levels of nesting", async () => {
    const open = "function foo() " + "{".repeat(100);
    const close = "}".repeat(100);
    const f = writeTemp("deepnest.ts", `${open}\n  return 1;\n${close}`);
    const start = performance.now();
    const block = await backend.readSymbol(f, "foo");
    expect(performance.now() - start).toBeLessThan(500);
    expect(block).not.toBeNull();
  });

  it("mismatched braces — more closes than opens", async () => {
    const f = writeTemp("mismatch.ts", "function foo() {\n}\n}\n}\n}");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
    expect(block?.location.endLine).toBe(2);
  });

  it("mismatched braces — more opens than closes", async () => {
    const f = writeTemp("unclosed2.ts", "function foo() {\n  {\n    {\n");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });

  it("no braces at all (arrow function one-liner)", async () => {
    const f = writeTemp("arrow.ts", "const foo = () => 42;");
    const block = await backend.readSymbol(f, "foo");
    expect(block).not.toBeNull();
  });
});
