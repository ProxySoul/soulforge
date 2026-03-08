import { describe, expect, it } from "bun:test";

/**
 * Tests for buildDefinitionPattern from navigate.ts.
 * This is the rg fallback when LSP/tree-sitter aren't available —
 * it builds a regex to find symbol definitions across 14+ language families.
 * A bad pattern = navigate can't find anything = user stuck.
 */

const DEFINITION_KEYWORDS = [
  String.raw`(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum)\s+`,
  String.raw`(?:async\s+)?(?:def|class)\s+`,
  String.raw`(?:func\s+(?:\([^)]*\)\s+)?|type\s+)`,
  String.raw`(?:pub(?:\([^)]*\)\s+)?)?(?:async\s+)?(?:fn|struct|trait|type|const|static|enum|mod|union)\s+`,
  String.raw`(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|static\s+|final\s+|sealed\s+|data\s+|open\s+|internal\s+)*(?:class|interface|enum|record|object|annotation)\s+`,
  String.raw`(?:class|struct|enum(?:\s+class)?|namespace|typedef|using)\s+`,
  String.raw`(?:public\s+|private\s+|protected\s+|internal\s+)?(?:abstract\s+|static\s+|sealed\s+|partial\s+)*(?:class|struct|interface|enum|record|delegate)\s+`,
  String.raw`(?:def\s+(?:self\.)?|class\s+|module\s+)`,
  String.raw`(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:function|class|interface|trait|enum)\s+`,
  String.raw`(?:public\s+|private\s+|internal\s+|open\s+)?(?:class|struct|protocol|enum|typealias|func)\s+`,
  String.raw`(?:def|defp|defmodule|defmacro|defstruct)\s+`,
  String.raw`(?:abstract\s+)?(?:class|mixin|extension|typedef|enum)\s+`,
  String.raw`(?:pub\s+)?(?:fn|const)\s+`,
  String.raw`(?:local\s+)?function\s+(?:\w+[.:])?`,
];

function buildDefinitionPattern(symbol: string): string {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = DEFINITION_KEYWORDS.map((kw) => `(?:${kw})`).join("|");
  return `(?:${alts})${escaped}\\b`;
}

function matches(pattern: string, line: string): boolean {
  return new RegExp(pattern).test(line);
}

describe("buildDefinitionPattern — TypeScript/JavaScript", () => {
  const pat = buildDefinitionPattern("MyClass");

  it("matches class", () => expect(matches(pat, "class MyClass {")).toBe(true));
  it("matches export class", () => expect(matches(pat, "export class MyClass {")).toBe(true));
  it("matches abstract class", () => expect(matches(pat, "export abstract class MyClass {")).toBe(true));
  it("matches interface", () => expect(matches(pat, "interface MyClass {")).toBe(true));
  it("matches type", () => expect(matches(pat, "type MyClass = {")).toBe(true));
  it("matches const", () => expect(matches(pat, "const MyClass = 1;")).toBe(true));
  it("matches enum", () => expect(matches(pat, "enum MyClass {")).toBe(true));

  it("matches function", () => {
    const fp = buildDefinitionPattern("doStuff");
    expect(matches(fp, "function doStuff() {")).toBe(true);
    expect(matches(fp, "async function doStuff() {")).toBe(true);
    expect(matches(fp, "export async function doStuff() {")).toBe(true);
    expect(matches(fp, "export default function doStuff() {")).toBe(true);
  });

  it("matches generator function", () => {
    const fp = buildDefinitionPattern("gen");
    expect(matches(fp, "function* gen() {")).toBe(true);
  });

  it("doesn't match usage (no keyword)", () => {
    expect(matches(pat, "new MyClass()")).toBe(false);
    expect(matches(pat, "const x = MyClass.create()")).toBe(false);
  });

  it("doesn't match partial name", () => {
    expect(matches(pat, "class MyClassExtended {")).toBe(false);
  });
});

describe("buildDefinitionPattern — Python", () => {
  const pat = buildDefinitionPattern("my_func");

  it("matches def", () => expect(matches(pat, "def my_func():")).toBe(true));
  it("matches async def", () => expect(matches(pat, "async def my_func():")).toBe(true));

  it("matches class", () => {
    const cp = buildDefinitionPattern("MyModel");
    expect(matches(cp, "class MyModel:")).toBe(true);
    expect(matches(cp, "class MyModel(Base):")).toBe(true);
  });
});

describe("buildDefinitionPattern — Go", () => {
  it("matches func", () => {
    const pat = buildDefinitionPattern("HandleRequest");
    expect(matches(pat, "func HandleRequest(w http.ResponseWriter) {")).toBe(true);
  });

  it("matches method with receiver", () => {
    const pat = buildDefinitionPattern("ServeHTTP");
    expect(matches(pat, "func (s *Server) ServeHTTP(w http.ResponseWriter) {")).toBe(true);
  });

  it("matches type struct", () => {
    const pat = buildDefinitionPattern("Config");
    expect(matches(pat, "type Config struct {")).toBe(true);
  });

  it("matches type interface", () => {
    const pat = buildDefinitionPattern("Handler");
    expect(matches(pat, "type Handler interface {")).toBe(true);
  });
});

describe("buildDefinitionPattern — Rust", () => {
  it("matches fn", () => {
    const pat = buildDefinitionPattern("process");
    expect(matches(pat, "fn process(data: &[u8]) -> Result<()> {")).toBe(true);
    expect(matches(pat, "pub fn process(data: &[u8]) {")).toBe(true);
    expect(matches(pat, "pub async fn process() {")).toBe(true);
  });

  it("matches struct", () => {
    const pat = buildDefinitionPattern("AppState");
    expect(matches(pat, "struct AppState {")).toBe(true);
    expect(matches(pat, "pub struct AppState {")).toBe(true);
    expect(matches(pat, "pub(crate) struct AppState {")).toBe(true);
  });

  it("matches trait", () => {
    const pat = buildDefinitionPattern("Drawable");
    expect(matches(pat, "trait Drawable {")).toBe(true);
    expect(matches(pat, "pub trait Drawable {")).toBe(true);
  });

  it("matches enum", () => {
    const pat = buildDefinitionPattern("Color");
    expect(matches(pat, "enum Color {")).toBe(true);
    expect(matches(pat, "pub enum Color {")).toBe(true);
  });

  it("matches mod", () => {
    const pat = buildDefinitionPattern("utils");
    expect(matches(pat, "mod utils {")).toBe(true);
    expect(matches(pat, "pub mod utils;")).toBe(true);
  });
});

describe("buildDefinitionPattern — Java/Kotlin/Scala", () => {
  it("matches Java class", () => {
    const pat = buildDefinitionPattern("UserService");
    expect(matches(pat, "public class UserService {")).toBe(true);
    expect(matches(pat, "public abstract class UserService {")).toBe(true);
    expect(matches(pat, "class UserService {")).toBe(true);
  });

  it("matches Java interface", () => {
    const pat = buildDefinitionPattern("Repository");
    expect(matches(pat, "public interface Repository {")).toBe(true);
  });

  it("matches Java enum", () => {
    const pat = buildDefinitionPattern("Status");
    expect(matches(pat, "public enum Status {")).toBe(true);
  });

  it("matches Java record", () => {
    const pat = buildDefinitionPattern("Point");
    expect(matches(pat, "public record Point(int x, int y) {")).toBe(true);
  });

  it("matches Kotlin data class", () => {
    const pat = buildDefinitionPattern("User");
    expect(matches(pat, "data class User(")).toBe(true);
  });

  it("matches Kotlin sealed class", () => {
    const pat = buildDefinitionPattern("Result");
    expect(matches(pat, "sealed class Result {")).toBe(true);
  });

  it("matches Kotlin object", () => {
    const pat = buildDefinitionPattern("Singleton");
    expect(matches(pat, "object Singleton {")).toBe(true);
  });
});

describe("buildDefinitionPattern — C/C++", () => {
  it("matches class", () => {
    const pat = buildDefinitionPattern("Widget");
    expect(matches(pat, "class Widget {")).toBe(true);
  });

  it("matches struct", () => {
    const pat = buildDefinitionPattern("Point");
    expect(matches(pat, "struct Point {")).toBe(true);
  });

  it("matches namespace", () => {
    const pat = buildDefinitionPattern("utils");
    expect(matches(pat, "namespace utils {")).toBe(true);
  });

  it("matches enum class", () => {
    const pat = buildDefinitionPattern("Color");
    expect(matches(pat, "enum class Color {")).toBe(true);
  });
});

describe("buildDefinitionPattern — Ruby", () => {
  it("matches def", () => {
    const pat = buildDefinitionPattern("process");
    expect(matches(pat, "def process")).toBe(true);
  });

  it("matches def self.method", () => {
    const pat = buildDefinitionPattern("create");
    expect(matches(pat, "def self.create")).toBe(true);
  });

  it("matches class", () => {
    const pat = buildDefinitionPattern("User");
    expect(matches(pat, "class User")).toBe(true);
    expect(matches(pat, "class User < Base")).toBe(true);
  });

  it("matches module", () => {
    const pat = buildDefinitionPattern("Auth");
    expect(matches(pat, "module Auth")).toBe(true);
  });
});

describe("buildDefinitionPattern — Swift", () => {
  it("matches func", () => {
    const pat = buildDefinitionPattern("viewDidLoad");
    expect(matches(pat, "func viewDidLoad() {")).toBe(true);
  });

  it("matches class", () => {
    const pat = buildDefinitionPattern("ViewController");
    expect(matches(pat, "class ViewController: UIViewController {")).toBe(true);
  });

  it("matches struct", () => {
    const pat = buildDefinitionPattern("ContentView");
    expect(matches(pat, "struct ContentView: View {")).toBe(true);
    expect(matches(pat, "public struct ContentView {")).toBe(true);
  });

  it("matches protocol", () => {
    const pat = buildDefinitionPattern("Drawable");
    expect(matches(pat, "protocol Drawable {")).toBe(true);
  });

  it("matches enum", () => {
    const pat = buildDefinitionPattern("Direction");
    expect(matches(pat, "enum Direction {")).toBe(true);
  });
});

describe("buildDefinitionPattern — Elixir", () => {
  it("matches def", () => {
    const pat = buildDefinitionPattern("handle_call");
    expect(matches(pat, "def handle_call(msg, _from, state) do")).toBe(true);
  });

  it("matches defp", () => {
    const pat = buildDefinitionPattern("do_work");
    expect(matches(pat, "defp do_work(data) do")).toBe(true);
  });

  it("matches defmodule", () => {
    const pat = buildDefinitionPattern("MyApp");
    expect(matches(pat, "defmodule MyApp do")).toBe(true);
  });
});

describe("buildDefinitionPattern — special characters in symbol", () => {
  it("escapes regex special chars", () => {
    const pat = buildDefinitionPattern("Map.Entry");
    expect(() => new RegExp(pat)).not.toThrow();
    // The dot is escaped, so "MapXEntry" shouldn't match
    expect(matches(pat, "class MapXEntry {")).toBe(false);
  });

  it("handles symbols with $", () => {
    const pat = buildDefinitionPattern("$scope");
    expect(() => new RegExp(pat)).not.toThrow();
  });

  it("handles symbols with underscores", () => {
    const pat = buildDefinitionPattern("__init__");
    expect(matches(pat, "def __init__(self):")).toBe(true);
  });
});

describe("buildDefinitionPattern — word boundary", () => {
  it("doesn't match prefix", () => {
    const pat = buildDefinitionPattern("User");
    expect(matches(pat, "class UserManager {")).toBe(false);
  });

  it("matches exact word", () => {
    const pat = buildDefinitionPattern("User");
    expect(matches(pat, "class User {")).toBe(true);
  });

  it("matches at end of line", () => {
    const pat = buildDefinitionPattern("User");
    expect(matches(pat, "class User")).toBe(true);
  });
});

describe("findEnclosingSymbol", () => {
  type SymbolInfo = {
    name: string;
    kind: string;
    location: { file: string; line: number; endLine?: number };
    containerName?: string;
  };

  function findEnclosingSymbol(symbols: SymbolInfo[], line: number): SymbolInfo | null {
    let best: SymbolInfo | null = null;
    for (const sym of symbols) {
      const end = sym.location.endLine ?? sym.location.line;
      if (sym.location.line <= line && end >= line) {
        if (!best || sym.location.line > best.location.line) best = sym;
      }
    }
    return best;
  }

  const symbols: SymbolInfo[] = [
    { name: "App", kind: "class", location: { file: "a.ts", line: 1, endLine: 50 } },
    { name: "render", kind: "function", location: { file: "a.ts", line: 10, endLine: 30 } },
    { name: "helper", kind: "function", location: { file: "a.ts", line: 15, endLine: 20 } },
    { name: "standalone", kind: "function", location: { file: "a.ts", line: 60, endLine: 70 } },
  ];

  it("finds innermost enclosing symbol", () => {
    expect(findEnclosingSymbol(symbols, 17)?.name).toBe("helper");
  });

  it("finds middle-level when not in innermost", () => {
    expect(findEnclosingSymbol(symbols, 25)?.name).toBe("render");
  });

  it("finds outermost when only top-level matches", () => {
    expect(findEnclosingSymbol(symbols, 5)?.name).toBe("App");
  });

  it("returns null when line is outside all symbols", () => {
    expect(findEnclosingSymbol(symbols, 55)).toBeNull();
  });

  it("handles boundary lines (start)", () => {
    expect(findEnclosingSymbol(symbols, 10)?.name).toBe("render");
  });

  it("handles boundary lines (end)", () => {
    expect(findEnclosingSymbol(symbols, 20)?.name).toBe("helper");
  });

  it("handles single-line symbols (no endLine)", () => {
    const syms: SymbolInfo[] = [
      { name: "x", kind: "variable", location: { file: "a.ts", line: 5 } },
    ];
    expect(findEnclosingSymbol(syms, 5)?.name).toBe("x");
    expect(findEnclosingSymbol(syms, 6)).toBeNull();
  });

  it("handles empty symbol list", () => {
    expect(findEnclosingSymbol([], 10)).toBeNull();
  });

  it("handles standalone symbol", () => {
    expect(findEnclosingSymbol(symbols, 65)?.name).toBe("standalone");
  });
});
