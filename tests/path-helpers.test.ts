import { describe, expect, it } from "bun:test";
import { looksLikeFilePath } from "../src/hooks/useChat.js";
import { tsJsHandler, pythonHandler } from "../src/core/tools/move-symbol.js";

const BACKTICK_PATH_RE = /`([^`\s]+)`/g;

function extractPathsFromText(text: string): string[] {
  if (text.length > 500_000) return [];
  const paths: string[] = [];
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    if (match[1] && looksLikeFilePath(match[1])) {
      paths.push(match[1]);
    }
  }
  return paths;
}

describe("looksLikeFilePath", () => {
  it("accepts typical file paths", () => {
    expect(looksLikeFilePath("src/core/diff.ts")).toBe(true);
    expect(looksLikeFilePath("./components/App.tsx")).toBe(true);
    expect(looksLikeFilePath("../utils/helpers.js")).toBe(true);
  });

  it("rejects too short strings", () => {
    expect(looksLikeFilePath("a")).toBe(false);
    expect(looksLikeFilePath("ab")).toBe(false);
  });

  it("rejects strings over 300 chars", () => {
    expect(looksLikeFilePath("a/b." + "x".repeat(300))).toBe(false);
  });

  it("rejects URLs", () => {
    expect(looksLikeFilePath("http://example.com/file.js")).toBe(false);
    expect(looksLikeFilePath("https://example.com/file.js")).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(looksLikeFilePath("src/$(cmd).ts")).toBe(false);
    expect(looksLikeFilePath("src/<T>.ts")).toBe(false);
    expect(looksLikeFilePath("src/{a,b}.ts")).toBe(false);
    expect(looksLikeFilePath("src/file.ts;rm -rf /")).toBe(false);
  });

  it("rejects strings with whitespace", () => {
    expect(looksLikeFilePath("src/my file.ts")).toBe(false);
    expect(looksLikeFilePath("src/file\t.ts")).toBe(false);
  });

  it("rejects strings without slashes", () => {
    expect(looksLikeFilePath("file.ts")).toBe(false);
    expect(looksLikeFilePath("README.md")).toBe(false);
  });

  it("rejects strings without extension", () => {
    expect(looksLikeFilePath("src/Makefile")).toBe(false);
  });

  it("rejects extensions with special chars", () => {
    expect(looksLikeFilePath("src/file.t-s")).toBe(false);
    expect(looksLikeFilePath("src/file.t_s")).toBe(false);
  });

  it("accepts long but valid extensions", () => {
    expect(looksLikeFilePath("src/file.typescript")).toBe(true);
  });

  it("rejects extensions longer than 10 chars", () => {
    expect(looksLikeFilePath("src/file.verylongextension")).toBe(false);
  });

  it("handles dot at start of filename", () => {
    expect(looksLikeFilePath(".gitignore")).toBe(false);
    expect(looksLikeFilePath("src/.env.local")).toBe(true);
  });

  it("handles path ending with dot", () => {
    expect(looksLikeFilePath("src/file.")).toBe(false);
  });

  it("handles path with multiple dots", () => {
    expect(looksLikeFilePath("src/file.test.ts")).toBe(true);
  });

  it("accepts absolute Unix paths", () => {
    expect(looksLikeFilePath("/usr/local/src/file.ts")).toBe(true);
  });

  it("accepts double-slash paths", () => {
    expect(looksLikeFilePath("src//file.ts")).toBe(true);
  });

  it("accepts paths with ..", () => {
    expect(looksLikeFilePath("../../file.ts")).toBe(true);
  });

  it("accepts paths with tilde", () => {
    expect(looksLikeFilePath("~/project/file.ts")).toBe(true);
  });

  it("accepts very short valid path", () => {
    expect(looksLikeFilePath("a/b.c")).toBe(true);
  });

  it("rejects path at min length without extension", () => {
    expect(looksLikeFilePath("a/b")).toBe(false);
  });

  it("accepts path with unicode characters", () => {
    expect(looksLikeFilePath("src/café.ts")).toBe(true);
  });
});

describe("extractPathsFromText", () => {
  it("extracts backtick-wrapped paths from text", () => {
    const text = "Modified `src/core/diff.ts` and `src/hooks/useChat.ts`";
    const paths = extractPathsFromText(text);
    expect(paths).toEqual(["src/core/diff.ts", "src/hooks/useChat.ts"]);
  });

  it("ignores non-path backtick content", () => {
    const text = "Use the `forEach` method on `Array` class";
    expect(extractPathsFromText(text)).toEqual([]);
  });

  it("ignores code blocks with spaces inside backticks", () => {
    const text = "Run `bun test src/core/diff.ts` to test";
    expect(extractPathsFromText(text)).toEqual([]);
  });

  it("returns empty for extremely long text", () => {
    const text = "`src/foo.ts`" + "x".repeat(600_000);
    expect(extractPathsFromText(text)).toEqual([]);
  });

  it("handles empty text", () => {
    expect(extractPathsFromText("")).toEqual([]);
  });

  it("handles adjacent backtick paths", () => {
    const text = "`src/a.ts``src/b.ts`";
    const paths = extractPathsFromText(text);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns empty when text has no backticks", () => {
    const text = "This is plain text with no backticks at all, not even src/foo.ts paths.";
    expect(extractPathsFromText(text)).toEqual([]);
  });

  it("filters out URLs inside backticks", () => {
    const text = "See `https://example.com/api/file.js` for reference";
    expect(extractPathsFromText(text)).toEqual([]);
  });

  it("extracts paths mixed with non-path backtick content", () => {
    const text =
      "Updated `src/core/diff.ts` using the `map` function, then modified `lib/utils/parse.js` accordingly";
    const paths = extractPathsFromText(text);
    expect(paths).toEqual(["src/core/diff.ts", "lib/utils/parse.js"]);
  });
});

describe("computeTsPath (via tsJsHandler.computePath)", () => {
  it("computes relative path for same directory", () => {
    expect(tsJsHandler.computePath("/project/src/a.ts", "/project/src/b.ts")).toBe("./b.js");
  });

  it("computes relative path going up", () => {
    expect(tsJsHandler.computePath("/project/src/deep/a.ts", "/project/src/b.ts")).toBe(
      "../b.js",
    );
  });

  it("strips .tsx extension too", () => {
    expect(tsJsHandler.computePath("/project/src/a.ts", "/project/src/Component.tsx")).toBe(
      "./Component.js",
    );
  });

  it("adds ./ prefix for same-level paths", () => {
    const result = tsJsHandler.computePath("/a/b.ts", "/a/c.ts");
    expect(result.startsWith("./")).toBe(true);
  });

  it("handles .jsx files", () => {
    expect(tsJsHandler.computePath("/project/src/a.ts", "/project/src/Button.jsx")).toBe(
      "./Button.jsx",
    );
  });

  it("handles same directory without going up", () => {
    expect(tsJsHandler.computePath("/project/a.ts", "/project/b.ts")).toBe("./b.js");
  });

  it("handles going up multiple levels", () => {
    expect(
      tsJsHandler.computePath("/project/src/deep/nested/a.ts", "/project/lib/b.ts"),
    ).toBe("../../../lib/b.js");
  });
});

describe("computePyPath (via pythonHandler.computePath)", () => {
  it("computes dotted path for same directory", () => {
    expect(pythonHandler.computePath("/project/src/a.py", "/project/src/b.py")).toBe("b");
  });

  it("computes relative path going up", () => {
    const result = pythonHandler.computePath("/project/src/deep/a.py", "/project/src/b.py");
    expect(result).toBe("..b");
  });

  it("computes path for deeper target", () => {
    expect(pythonHandler.computePath("/project/a.py", "/project/sub/b.py")).toBe("sub.b");
  });

  it("handles going up 2+ levels", () => {
    const result = pythonHandler.computePath(
      "/project/src/deep/nested/a.py",
      "/project/src/b.py",
    );
    expect(result).toBe("...b");
  });

  it("handles deeply nested target", () => {
    expect(
      pythonHandler.computePath("/project/a.py", "/project/pkg/sub/deep/module.py"),
    ).toBe("pkg.sub.deep.module");
  });
});
