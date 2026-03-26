import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap } from "../src/core/intelligence/repo-map.js";
import { initForbidden } from "../src/core/security/forbidden.js";

/**
 * Edge case tests for unused export detection.
 *
 * Covers: default exports, dynamic imports, type-only imports,
 * mixed import styles, destructured requires, re-export chains,
 * aliased imports, and language-specific patterns.
 */

const TMP = join(tmpdir(), `edge-cases-${Date.now()}`);
let repoMap: RepoMap;

function write(relPath: string, content: string): void {
  const abs = join(TMP, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content);
}

function getUnused(): Array<{ name: string; path: string; kind: string; usedInternally: boolean }> {
  return repoMap.getUnusedExports();
}

function unusedInFile(fileName: string): string[] {
  return getUnused()
    .filter((u) => u.path.includes(fileName))
    .map((u) => u.name);
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });

  // ════════════════════════════════════════════
  // TypeScript / JavaScript edge cases
  // ════════════════════════════════════════════

  // ── Default export (class) ──
  write(
    "ts/default-class.ts",
    `export default class ApiClient {
  fetch(url: string) { return url; }
}
export class DeadClient {
  fetch(url: string) { return url; }
}
`,
  );

  write(
    "ts/use-default-class.ts",
    `import ApiClient from "./default-class";
const c = new ApiClient();
c.fetch("/api");
`,
  );

  // ── Default export (function) ──
  write(
    "ts/default-fn.ts",
    `export default function createApp() { return {}; }
export function deadFactory() { return null; }
`,
  );

  write(
    "ts/use-default-fn.ts",
    `import createApp from "./default-fn";
createApp();
`,
  );

  // ── Default export (arrow) ──
  write(
    "ts/default-arrow.ts",
    `const handler = () => "hello";
export default handler;
export const deadArrow = () => "dead";
`,
  );

  write(
    "ts/use-default-arrow.ts",
    `import handler from "./default-arrow";
handler();
`,
  );

  // ── Type-only imports ──
  write(
    "ts/types-source.ts",
    `export interface UserConfig {
  name: string;
  age: number;
}
export type Theme = "light" | "dark";
export interface DeadType {
  unused: boolean;
}
`,
  );

  write(
    "ts/use-types.ts",
    `import type { UserConfig, Theme } from "./types-source";
const cfg: UserConfig = { name: "test", age: 25 };
const t: Theme = "dark";
console.log(cfg, t);
`,
  );

  // ── Mixed default + named import ──
  write(
    "ts/mixed-exports.ts",
    `export default class Store {
  data: string[] = [];
}
export function createStore(): Store { return new Store(); }
export function deadHelper(): void {}
`,
  );

  write(
    "ts/use-mixed.ts",
    `import Store, { createStore } from "./mixed-exports";
const s: Store = createStore();
console.log(s);
`,
  );

  // ── Aliased import (import { foo as bar }) ──
  write(
    "ts/aliased-source.ts",
    `export function originalName(): string { return "hello"; }
export function deadOriginal(): string { return "dead"; }
`,
  );

  write(
    "ts/use-aliased.ts",
    `import { originalName as renamed } from "./aliased-source";
console.log(renamed());
`,
  );

  // ── Re-export chain (A → B → C) ──
  write(
    "ts/chain/deep.ts",
    `export function deepFn(): string { return "deep"; }
export function deadDeep(): string { return "dead"; }
`,
  );

  write(
    "ts/chain/middle.ts",
    `export { deepFn } from "./deep";
`,
  );

  write(
    "ts/chain/top.ts",
    `import { deepFn } from "./middle";
deepFn();
`,
  );

  // ── Namespace import (import * as ns) ──
  write(
    "ts/namespace-source.ts",
    `export function nsFunc(): void {}
export const nsConst = 42;
export function deadNs(): void {}
`,
  );

  write(
    "ts/use-namespace.ts",
    `import * as NS from "./namespace-source";
NS.nsFunc();
console.log(NS.nsConst);
`,
  );

  // ── Side-effect import (no specifiers) ──
  write(
    "ts/side-effect.ts",
    `export function polyfill(): void {}
// This file is imported for side effects only
console.log("init");
`,
  );

  write(
    "ts/use-side-effect.ts",
    `import "./side-effect";
// No named imports — just side effects
`,
  );

  // ── CommonJS: require with destructuring ──
  write(
    "js/cjs-utils.js",
    `function encode(str) { return encodeURIComponent(str); }
function decode(str) { return decodeURIComponent(str); }
function deadCjs() { return null; }

module.exports = { encode, decode, deadCjs };
`,
  );

  write(
    "js/cjs-consumer.js",
    `const { encode, decode } = require('./cjs-utils');
console.log(encode('hello'), decode('%20'));
`,
  );

  // ── CommonJS: exports.foo = ──
  write(
    "js/exports-dot.js",
    `exports.greet = function(name) { return 'Hello ' + name; };
exports.deadExport = function() { return null; };
`,
  );

  // ── ES module with .mjs extension ──
  write(
    "js/module.mjs",
    `export function mjsHelper() { return "mjs"; }
export function deadMjs() { return null; }
`,
  );

  write(
    "js/use-mjs.mjs",
    `import { mjsHelper } from "./module.mjs";
mjsHelper();
`,
  );

  // ════════════════════════════════════════════
  // Python edge cases
  // ════════════════════════════════════════════

  // ── Python: from package import ──
  write(
    "py/utils/__init__.py",
    `from .formatter import format_date
from .validator import validate_email

__all__ = ['format_date', 'validate_email']
`,
  );

  write(
    "py/utils/formatter.py",
    `def format_date(d):
    return str(d)

def _internal_format():
    pass

def dead_format():
    pass
`,
  );

  write(
    "py/utils/validator.py",
    `def validate_email(email):
    return '@' in email

def dead_validate():
    pass
`,
  );

  write(
    "py/app.py",
    `from utils import format_date, validate_email

print(format_date("2024"))
print(validate_email("test@test.com"))
`,
  );

  // ── Python: class with methods ──
  write(
    "py/models.py",
    `class UserModel:
    def __init__(self, name):
        self.name = name

    def save(self):
        pass

class DeadModel:
    pass
`,
  );

  write(
    "py/service.py",
    `from models import UserModel

user = UserModel("test")
user.save()
`,
  );

  // ════════════════════════════════════════════
  // Rust edge cases
  // ════════════════════════════════════════════

  write(
    "rs/src/models.rs",
    `pub struct Config {
    pub host: String,
    pub port: u16,
}

pub struct DeadConfig {
    pub unused: bool,
}

pub fn new_config() -> Config {
    Config { host: String::from("localhost"), port: 8080 }
}
`,
  );

  write(
    "rs/src/main.rs",
    `use crate::models::{Config, new_config};

fn main() {
    let cfg: Config = new_config();
    println!("{}", cfg.host);
}
`,
  );

  // ════════════════════════════════════════════
  // Go edge cases
  // ════════════════════════════════════════════

  write(
    "go-proj/go.mod",
    `module github.com/user/goapp

go 1.22
`,
  );

  write(
    "go-proj/pkg/logger/logger.go",
    `package logger

func Info(msg string) {
    println(msg)
}

func Debug(msg string) {
    println("DEBUG: " + msg)
}

func UnusedLog(msg string) {
    println("UNUSED: " + msg)
}
`,
  );

  write(
    "go-proj/cmd/main.go",
    `package main

import "github.com/user/goapp/pkg/logger"

func main() {
    logger.Info("hello")
    logger.Debug("world")
}
`,
  );

  // ════════════════════════════════════════════
  // Kotlin edge cases
  // ════════════════════════════════════════════

  write(
    "kt/src/DataClass.kt",
    `data class User(val name: String, val age: Int)

data class UnusedDto(val id: Long)

object UserFactory {
    fun create(name: String): User = User(name, 0)
}

private object InternalHelper {
    fun help() {}
}
`,
  );

  write(
    "kt/src/Main.kt",
    `fun main() {
    val user = UserFactory.create("Alice")
    println(user)
}
`,
  );

  // ════════════════════════════════════════════
  // Swift edge cases
  // ════════════════════════════════════════════

  write(
    "swift/Sources/Protocol.swift",
    `public protocol Drawable {
    func draw()
}

public protocol Printable {
    func print()
}

protocol InternalProtocol {
    func internalMethod()
}
`,
  );

  write(
    "swift/Sources/Shape.swift",
    `public class Circle: Drawable {
    public func draw() {}
}

public class UnusedShape {
    func render() {}
}
`,
  );

  write(
    "swift/Sources/App.swift",
    `let circle = Circle()
circle.draw()
`,
  );

  initForbidden(TMP);
  repoMap = new RepoMap(TMP);
  await repoMap.scan();
});

afterAll(() => {
  repoMap?.close();
  rmSync(TMP, { recursive: true, force: true });
});

// ════════════════════════════════════════════
// TypeScript / JavaScript tests
// ════════════════════════════════════════════

describe("default export — class", () => {
  it("does not flag ApiClient (default import)", () => {
    expect(unusedInFile("default-class")).not.toContain("ApiClient");
  });

  it("detects DeadClient as unused", () => {
    expect(unusedInFile("default-class")).toContain("DeadClient");
  });
});

describe("default export — function", () => {
  it("does not flag createApp (default import)", () => {
    expect(unusedInFile("default-fn")).not.toContain("createApp");
  });

  it("detects deadFactory as unused", () => {
    expect(unusedInFile("default-fn")).toContain("deadFactory");
  });
});

describe("default export — arrow/variable", () => {
  it("does not flag handler (default import)", () => {
    expect(unusedInFile("default-arrow")).not.toContain("handler");
  });

  it("detects deadArrow as unused", () => {
    expect(unusedInFile("default-arrow")).toContain("deadArrow");
  });
});

describe("type-only imports", () => {
  it("does not flag UserConfig (import type)", () => {
    expect(unusedInFile("types-source")).not.toContain("UserConfig");
  });

  it("does not flag Theme (import type)", () => {
    expect(unusedInFile("types-source")).not.toContain("Theme");
  });

  it("detects DeadType as unused", () => {
    expect(unusedInFile("types-source")).toContain("DeadType");
  });
});

describe("mixed default + named imports", () => {
  it("does not flag Store (default)", () => {
    expect(unusedInFile("mixed-exports")).not.toContain("Store");
  });

  it("does not flag createStore (named)", () => {
    expect(unusedInFile("mixed-exports")).not.toContain("createStore");
  });

  it("detects deadHelper as unused", () => {
    expect(unusedInFile("mixed-exports")).toContain("deadHelper");
  });
});

describe("aliased imports", () => {
  it("does not flag originalName (imported as renamed)", () => {
    expect(unusedInFile("aliased-source")).not.toContain("originalName");
  });

  it("detects deadOriginal as unused", () => {
    expect(unusedInFile("aliased-source")).toContain("deadOriginal");
  });
});

describe("re-export chains (A → B → C)", () => {
  it("does not flag deepFn (re-exported through middle.ts)", () => {
    expect(unusedInFile("chain/deep")).not.toContain("deepFn");
  });

  it("detects deadDeep as unused (not re-exported)", () => {
    expect(unusedInFile("chain/deep")).toContain("deadDeep");
  });
});

describe("namespace imports (import * as)", () => {
  it("does not flag nsFunc (accessed via NS.nsFunc)", () => {
    expect(unusedInFile("namespace-source")).not.toContain("nsFunc");
  });

  it("does not flag nsConst (accessed via NS.nsConst)", () => {
    expect(unusedInFile("namespace-source")).not.toContain("nsConst");
  });

  it("detects deadNs as unused", () => {
    expect(unusedInFile("namespace-source")).toContain("deadNs");
  });
});

describe("CommonJS — module.exports destructured require", () => {
  it("does not flag encode (destructured require)", () => {
    expect(unusedInFile("cjs-utils")).not.toContain("encode");
  });

  it("does not flag decode (destructured require)", () => {
    expect(unusedInFile("cjs-utils")).not.toContain("decode");
  });

  it("detects deadCjs as unused", () => {
    expect(unusedInFile("cjs-utils")).toContain("deadCjs");
  });
});

describe("ES modules — .mjs extension", () => {
  it("does not flag mjsHelper (imported from .mjs)", () => {
    expect(unusedInFile("module.mjs")).not.toContain("mjsHelper");
  });

  it("detects deadMjs as unused", () => {
    expect(unusedInFile("module.mjs")).toContain("deadMjs");
  });
});

// ════════════════════════════════════════════
// Python tests
// ════════════════════════════════════════════

describe("Python — classes", () => {
  it("does not flag UserModel (imported by service.py)", () => {
    expect(unusedInFile("models.py")).not.toContain("UserModel");
  });

  it("detects DeadModel as unused", () => {
    expect(unusedInFile("models.py")).toContain("DeadModel");
  });
});

describe("Python — package functions", () => {
  it("detects dead_format as unused", () => {
    expect(unusedInFile("formatter.py")).toContain("dead_format");
  });

  it("does not flag _internal_format (underscore = private)", () => {
    expect(unusedInFile("formatter.py")).not.toContain("_internal_format");
  });

  it("detects dead_validate as unused", () => {
    expect(unusedInFile("validator.py")).toContain("dead_validate");
  });
});

// ════════════════════════════════════════════
// Rust tests
// ════════════════════════════════════════════

describe("Rust — structs and functions", () => {
  it("does not flag Config (imported via crate::models)", () => {
    expect(unusedInFile("models.rs")).not.toContain("Config");
  });

  it("does not flag new_config (imported via crate::models)", () => {
    expect(unusedInFile("models.rs")).not.toContain("new_config");
  });

  it("detects DeadConfig as unused", () => {
    expect(unusedInFile("models.rs")).toContain("DeadConfig");
  });
});

// ════════════════════════════════════════════
// Kotlin tests
// ════════════════════════════════════════════

describe("Kotlin — data classes and objects", () => {
  it("does not flag UserFactory (used in Main.kt)", () => {
    expect(unusedInFile("DataClass")).not.toContain("UserFactory");
  });

  it("detects UnusedDto as unused", () => {
    expect(unusedInFile("DataClass")).toContain("UnusedDto");
  });

  it("does not flag InternalHelper (private)", () => {
    expect(unusedInFile("DataClass")).not.toContain("InternalHelper");
  });
});

// ════════════════════════════════════════════
// Swift tests
// ════════════════════════════════════════════

describe("Swift — protocols and classes", () => {
  it("does not flag Circle (used in App.swift)", () => {
    expect(unusedInFile("Shape")).not.toContain("Circle");
  });

  it("detects UnusedShape as unused", () => {
    expect(unusedInFile("Shape")).toContain("UnusedShape");
  });
});
