import { describe, expect, it } from "bun:test";
import {
  tsJsHandler,
  pythonHandler,
  rustHandler,
} from "../src/core/tools/move-symbol.js";

describe("tsJsHandler.parse", () => {
  it("parses single-line import", () => {
    const result = tsJsHandler.parse('import { foo } from "./bar";');
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["foo"]);
    expect(result[0]?.source).toBe("./bar");
  });

  it("parses multiline import", () => {
    const src = 'import {\n  foo,\n  bar,\n} from "./mod";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["foo", "bar"]);
    expect(result[0]?.startLine).toBe(0);
    expect(result[0]?.endLine).toBe(3);
  });

  it("parses type imports", () => {
    const src = 'import type { Foo } from "./types";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.isType).toBe(true);
  });

  it("parses re-exports", () => {
    const src = 'export { foo } from "./bar";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.isReExport).toBe(true);
  });

  it("parses multiline re-export (export type { ... } spread across lines)", () => {
    const src = 'export type {\n  Foo,\n  Bar,\n} from "./types";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.isReExport).toBe(true);
    expect(result[0]?.isType).toBe(true);
    expect(result[0]?.specifiers).toEqual(["Foo", "Bar"]);
  });

  it("handles import with 'as' alias", () => {
    const src = 'import { foo as bar } from "./mod";';
    const result = tsJsHandler.parse(src);
    expect(result[0]?.specifiers).toEqual(["foo as bar"]);
  });

  it("skips default imports (no braces)", () => {
    const src = 'import React from "react";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("skips namespace imports", () => {
    const src = 'import * as path from "path";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("handles mixed content (imports + code + exports)", () => {
    const src = [
      'import { a } from "./a";',
      "",
      "const x = 1;",
      "",
      'export { b } from "./b";',
    ].join("\n");
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(2);
    expect(result[0]?.specifiers).toEqual(["a"]);
    expect(result[1]?.specifiers).toEqual(["b"]);
    expect(result[1]?.isReExport).toBe(true);
  });

  it("handles import with trailing content on same line", () => {
    const src = 'import { foo } from "./bar"; // comment';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("./bar");
  });

  it("handles empty file", () => {
    expect(tsJsHandler.parse("")).toHaveLength(0);
  });

  it("handles multiline import that never closes brace", () => {
    const src = 'import {\n  foo,\n  bar,\nfrom "./mod";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("handles import where { is in a string on a non-import line", () => {
    const src = 'const x = "{ foo }";\nimport { bar } from "./mod";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["bar"]);
  });

  it("handles export without 'from' (not a re-export)", () => {
    const src = "export { foo };";
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  // ── Edge cases ──

  it("returns 0 results for empty braces import", () => {
    const src = 'import {} from "./foo";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("preserves alias in type import specifiers", () => {
    const src = 'import type { Foo as Bar } from "./types";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(1);
    expect(result[0]?.isType).toBe(true);
    expect(result[0]?.specifiers).toEqual(["Foo as Bar"]);
  });

  it("parses multiple re-exports in same file", () => {
    const src = [
      'export { alpha } from "./a";',
      'export { beta } from "./b";',
      'export type { Gamma } from "./c";',
    ].join("\n");
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(3);
    expect(result[0]?.specifiers).toEqual(["alpha"]);
    expect(result[0]?.isReExport).toBe(true);
    expect(result[1]?.specifiers).toEqual(["beta"]);
    expect(result[1]?.isReExport).toBe(true);
    expect(result[2]?.specifiers).toEqual(["Gamma"]);
    expect(result[2]?.isReExport).toBe(true);
    expect(result[2]?.isType).toBe(true);
  });

  it("skips import with no from clause", () => {
    const src = 'import "side-effects-only";';
    const result = tsJsHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("does not match 'import' inside a comment", () => {
    const src = [
      '// import { fake } from "./not-real";',
      'import { real } from "./actual";',
    ].join("\n");
    const result = tsJsHandler.parse(src);
    // The comment line starts with "// import" which still starts with "import" after trim? No — it starts with "//"
    // So only the real import is matched
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["real"]);
  });
});

describe("pythonHandler.parse", () => {
  it("parses from...import", () => {
    const result = pythonHandler.parse("from models import User, Post");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["User", "Post"]);
    expect(result[0]?.source).toBe("models");
  });

  it("parses relative imports", () => {
    const result = pythonHandler.parse("from .utils import helper");
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe(".utils");
  });

  it("parses double-dot relative imports", () => {
    const result = pythonHandler.parse("from ..base import Base");
    expect(result[0]?.source).toBe("..base");
  });

  it("skips plain 'import X' statements", () => {
    const result = pythonHandler.parse("import os");
    expect(result).toHaveLength(0);
  });

  it("handles empty file", () => {
    expect(pythonHandler.parse("")).toHaveLength(0);
  });

  it("handles import with alias", () => {
    const result = pythonHandler.parse("from os.path import join as pjoin");
    expect(result[0]?.specifiers).toEqual(["join as pjoin"]);
  });

  // ── Edge cases ──

  it("parses multiple imports on different lines", () => {
    const src = [
      "from os import getcwd",
      "from sys import argv, exit",
      "from pathlib import Path",
    ].join("\n");
    const result = pythonHandler.parse(src);
    expect(result).toHaveLength(3);
    expect(result[0]?.specifiers).toEqual(["getcwd"]);
    expect(result[0]?.source).toBe("os");
    expect(result[1]?.specifiers).toEqual(["argv", "exit"]);
    expect(result[1]?.source).toBe("sys");
    expect(result[2]?.specifiers).toEqual(["Path"]);
    expect(result[2]?.source).toBe("pathlib");
  });

  it("parses import with multiple aliases", () => {
    const result = pythonHandler.parse(
      "from os.path import join as pjoin, exists as pexists",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["join as pjoin", "exists as pexists"]);
    expect(result[0]?.source).toBe("os.path");
  });

  it("returns empty for empty file", () => {
    expect(pythonHandler.parse("")).toHaveLength(0);
  });

  it("parses import-like line inside a string (parser has no string awareness)", () => {
    const src = 's = "from fake import Nope"';
    const result = pythonHandler.parse(src);
    // The regex matches any line starting with "from ... import ...",
    // but this line starts with 's = "from' which doesn't match ^from
    expect(result).toHaveLength(0);
  });

  it("matches import-looking line if it literally starts at column 0 (e.g. in a docstring)", () => {
    const src = [
      '"""',
      "from example import Documented",
      '"""',
    ].join("\n");
    const result = pythonHandler.parse(src);
    // Parser is line-based with no string/docstring awareness — it matches
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["Documented"]);
  });

  it("parses deeply nested relative import", () => {
    const result = pythonHandler.parse("from ...base import Thing");
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("...base");
    expect(result[0]?.specifiers).toEqual(["Thing"]);
  });
});

describe("rustHandler.parse", () => {
  it("parses brace-style use", () => {
    const result = rustHandler.parse("use std::collections::{HashMap, HashSet};");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["HashMap", "HashSet"]);
    expect(result[0]?.source).toBe("std::collections");
  });

  it("parses single-item use", () => {
    const result = rustHandler.parse("use std::io::Read;");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["Read"]);
    expect(result[0]?.source).toBe("std::io");
  });

  it("handles use with self", () => {
    const result = rustHandler.parse("use std::io::{self, Read};");
    expect(result[0]?.specifiers).toEqual(["self", "Read"]);
  });

  it("handles single-segment use", () => {
    const result = rustHandler.parse("use serde;");
    expect(result[0]?.specifiers).toEqual(["serde"]);
    expect(result[0]?.source).toBe("");
  });

  it("skips lines without semicolons (e.g. multiline use — not supported)", () => {
    const src = "use std::{\n    io,\n    fs,\n};";
    const result = rustHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("handles empty file", () => {
    expect(rustHandler.parse("")).toHaveLength(0);
  });

  // ── Edge cases ──

  it("skips pub use re-exports (line must start with 'use')", () => {
    const src = "pub use crate::module::Item;";
    const result = rustHandler.parse(src);
    expect(result).toHaveLength(0);
  });

  it("parses crate path use", () => {
    const result = rustHandler.parse("use crate::module::Item;");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["Item"]);
    expect(result[0]?.source).toBe("crate::module");
  });

  it("parses super path use", () => {
    const result = rustHandler.parse("use super::parent::Thing;");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["Thing"]);
    expect(result[0]?.source).toBe("super::parent");
  });

  it("parses glob import", () => {
    const result = rustHandler.parse("use std::io::*;");
    expect(result).toHaveLength(1);
    expect(result[0]?.specifiers).toEqual(["*"]);
    expect(result[0]?.source).toBe("std::io");
  });

  it("parses multiple use statements", () => {
    const src = [
      "use std::io::Read;",
      "use std::fs::File;",
      "use std::collections::{HashMap, BTreeMap};",
    ].join("\n");
    const result = rustHandler.parse(src);
    expect(result).toHaveLength(3);
    expect(result[0]?.specifiers).toEqual(["Read"]);
    expect(result[0]?.source).toBe("std::io");
    expect(result[1]?.specifiers).toEqual(["File"]);
    expect(result[1]?.source).toBe("std::fs");
    expect(result[2]?.specifiers).toEqual(["HashMap", "BTreeMap"]);
    expect(result[2]?.source).toBe("std::collections");
  });

  it("returns empty for empty file", () => {
    expect(rustHandler.parse("")).toHaveLength(0);
  });
});
