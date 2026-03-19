import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

/**
 * Unused exports detection tests.
 *
 * Verifies that getUnusedExports correctly identifies dead exports
 * across languages, handles duplicate symbol names, and resolves
 * import sources to avoid false negatives.
 */

const TMP = join(tmpdir(), `unused-exports-${Date.now()}`);

function write(relPath: string, content: string): void {
  const abs = join(TMP, relPath);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
}

let repoMap: RepoMap;

// ══════════════════════════════════════════════════════════════
// Test fixture: multi-language codebase with known dead/alive exports
// ══════════════════════════════════════════════════════════════

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });

  // ── TypeScript: basic alive + dead exports ──
  write(
    "src/utils.ts",
    `export function formatDate(d: Date): string { return d.toISOString(); }
export function deadHelper(): void { /* never imported */ }
export const MAGIC = 42;
`,
  );

  write(
    "src/app.ts",
    `import { formatDate, MAGIC } from "./utils";
console.log(formatDate(new Date()), MAGIC);
`,
  );

  // ── TypeScript: duplicate symbol names across files ──
  write(
    "src/config/database.ts",
    `export interface Config {
  host: string;
  port: number;
}
export function createConfig(): Config { return { host: "localhost", port: 5432 }; }
`,
  );

  write(
    "src/config/cache.ts",
    `export interface Config {
  ttl: number;
  maxSize: number;
}
export function createCacheConfig(): Config { return { ttl: 60, maxSize: 100 }; }
`,
  );

  write(
    "src/server.ts",
    `import { Config, createConfig } from "./config/database";
const cfg: Config = createConfig();
console.log(cfg.host);
`,
  );
  // cache.ts Config is NOT imported by anyone → should be detected as unused
  // BUT with name-only matching, it would be hidden by database.ts Config

  // ── TypeScript: re-exports ──
  write(
    "src/index.ts",
    `export { formatDate } from "./utils";
export { Config } from "./config/database";
`,
  );

  // ── Python: alive + dead exports ──
  write(
    "lib/helpers.py",
    `def parse_json(raw: str) -> dict:
    import json
    return json.loads(raw)

def _private_helper():
    pass

def dead_function():
    """Never imported anywhere"""
    pass
`,
  );

  write(
    "lib/main.py",
    `from helpers import parse_json

data = parse_json('{"key": "value"}')
print(data)
`,
  );

  // ── Go: capitalized = public, used + unused ──
  write(
    "pkg/handler.go",
    `package handler

func ServeHTTP(w Writer, r *Request) {
    w.Write([]byte("hello"))
}

func UnusedHandler() {
    // never called from outside
}
`,
  );

  write(
    "cmd/main.go",
    `package main

import "handler"

func main() {
    handler.ServeHTTP(nil, nil)
}
`,
  );

  // ── Rust: pub = public, used + unused ──
  write(
    "src/lib.rs",
    `pub fn process_data(input: &str) -> String {
    input.to_uppercase()
}

pub fn unused_utility() -> i32 {
    42
}

fn private_helper() {
    // not exported
}
`,
  );

  write(
    "src/main.rs",
    `use crate::lib::process_data;

fn main() {
    let result = process_data("hello");
    println!("{}", result);
}
`,
  );

  // ── Java: public class used + unused ──
  write(
    "src/main/java/UserService.java",
    `public class UserService {
    public User getUser(String id) {
        return new User(id);
    }
}
`,
  );

  write(
    "src/main/java/DeadService.java",
    `public class DeadService {
    public void doNothing() {
        // never instantiated or referenced
    }
}
`,
  );

  write(
    "src/main/java/App.java",
    `import UserService;

public class App {
    public static void main(String[] args) {
        UserService svc = new UserService();
        svc.getUser("123");
    }
}
`,
  );

  // ── Kotlin: public by default, private = hidden ──
  write(
    "src/main/kotlin/Repository.kt",
    `class Repository {
    fun findAll(): List<String> = listOf("a", "b")
}

class UnusedRepository {
    fun findNone(): List<String> = emptyList()
}

private class InternalHelper {
    fun help() {}
}
`,
  );

  write(
    "src/main/kotlin/Main.kt",
    `fun main() {
    val repo = Repository()
    println(repo.findAll())
}
`,
  );

  // ── Swift: public/open = exported, internal = default ──
  write(
    "Sources/NetworkClient.swift",
    `public class NetworkClient {
    public func fetch(url: String) -> Data? {
        return nil
    }
}

public class UnusedClient {
    public func unused() {}
}

class InternalHelper {
    func help() {}
}
`,
  );

  write(
    "Sources/App.swift",
    `let client = NetworkClient()
client.fetch(url: "https://example.com")
`,
  );

  // ── C: header = public ──
  write(
    "include/math_utils.h",
    `int c_add(int a, int b);
int c_multiply(int a, int b);
int c_dead_function(void);
`,
  );

  write(
    "src/math_utils.c",
    `#include "math_utils.h"

int c_add(int a, int b) { return a + b; }
int c_multiply(int a, int b) { return a * b; }
int c_dead_function(void) { return 0; }
`,
  );

  write(
    "src/main.c",
    `#include "math_utils.h"

int main() {
    int sum = c_add(1, 2);
    int prod = c_multiply(3, 4);
    return 0;
}
`,
  );

  // ── Elixir: def = public, defp = private ──
  write(
    "lib/parser.ex",
    `defmodule Parser do
  def parse(input) do
    String.split(input, ",")
  end

  def unused_parse(input) do
    String.split(input, ";")
  end

  defp internal_helper(x) do
    x
  end
end
`,
  );

  write(
    "lib/app.ex",
    `defmodule App do
  def run do
    Parser.parse("a,b,c")
  end
end
`,
  );

  // ── PHP: public/private visibility ──
  write(
    "src/UserController.php",
    `<?php
class UserController {
    public function index() {
        return $this->getUsers();
    }

    private function getUsers() {
        return [];
    }
}

class DeadController {
    public function dead() {}
}
`,
  );

  write(
    "src/routes.php",
    `<?php
$controller = new UserController();
$controller->index();
`,
  );

  // ── Ruby: everything public by convention ──
  write(
    "lib/calculator.rb",
    `class Calculator
  def add(a, b)
    a + b
  end

  def unused_method
    nil
  end
end
`,
  );

  write(
    "app.rb",
    `require_relative 'lib/calculator'

calc = Calculator.new
puts calc.add(1, 2)
`,
  );

  // ── Dart: underscore = private ──
  write(
    "lib/widget.dart",
    `class AppWidget {
  void build() {}
}

class _PrivateWidget {
  void build() {}
}

class UnusedWidget {
  void build() {}
}
`,
  );

  write(
    "lib/main.dart",
    `import 'widget.dart';

void main() {
  final w = AppWidget();
  w.build();
}
`,
  );

  // ── Legacy JavaScript (CommonJS) ──
  write(
    "legacy/utils.js",
    `function formatName(first, last) {
  return first + ' ' + last;
}

function deadLegacy() {
  return null;
}

module.exports = { formatName, deadLegacy };
`,
  );

  write(
    "legacy/app.js",
    `const { formatName } = require('./utils');
console.log(formatName('John', 'Doe'));
`,
  );

  // ── TypeScript: export * wildcard re-export ──
  write(
    "src/barrel/math.ts",
    `export function add(a: number, b: number): number { return a + b; }
export function subtract(a: number, b: number): number { return a - b; }
export function deadMath(): number { return 0; }
`,
  );

  write(
    "src/barrel/index.ts",
    `export * from "./math";
`,
  );

  write(
    "src/barrel/consumer.ts",
    `import { add } from "./index";
console.log(add(1, 2));
`,
  );

  // ── TypeScript: tsconfig path aliases ──
  write(
    "tsconfig.json",
    `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@utils/*": ["src/alias-utils/*"]
    }
  }
}
`,
  );

  write(
    "src/alias-utils/format.ts",
    `export function formatCurrency(n: number): string { return "$" + n.toFixed(2); }
export function deadFormat(): string { return ""; }
`,
  );

  write(
    "src/alias-consumer.ts",
    `import { formatCurrency } from "@utils/format";
console.log(formatCurrency(9.99));
`,
  );

  // ── Go: module-relative imports ──
  write(
    "go.mod",
    `module github.com/example/myproject

go 1.21
`,
  );

  write(
    "internal/service.go",
    `package service

func Process(data string) string {
    return data
}

func UnusedService() string {
    return ""
}
`,
  );

  write(
    "cmd/server.go",
    `package main

import "github.com/example/myproject/internal/service"

func main() {
    service.Process("hello")
}
`,
  );

  // ── TypeScript: path-like imports (not aliases, just deep relative) ──
  write(
    "src/deep/nested/helper.ts",
    `export function deepHelper(): string { return "deep"; }
export function deadDeepHelper(): string { return "dead"; }
`,
  );

  write(
    "src/deep/consumer.ts",
    `import { deepHelper } from "./nested/helper";
console.log(deepHelper());
`,
  );

  // ── TypeScript: same name, different kind (function + type) ──
  write(
    "src/models/user.ts",
    `export interface Validator { validate(): boolean; }
export class UserValidator implements Validator {
  validate() { return true; }
}
`,
  );

  write(
    "src/models/product.ts",
    `export interface Validator { check(): boolean; }
export class ProductValidator implements Validator {
  check() { return true; }
}
`,
  );

  write(
    "src/validation.ts",
    `import { UserValidator } from "./models/user";
const v = new UserValidator();
v.validate();
`,
  );

  // ── TypeScript: default export ──
  write(
    "src/logger.ts",
    `export default class Logger {
  log(msg: string) { console.log(msg); }
}
export function createLogger(): Logger { return new Logger(); }
`,
  );

  write(
    "src/main-logger.ts",
    `import Logger from "./logger";
const l = new Logger();
l.log("hello");
`,
  );

  // ── Short symbol names that could collide ──
  write(
    "src/short/a.ts",
    `export function run(): void {}
export function go(): void {}
`,
  );

  write(
    "src/short/b.ts",
    `export function run(): void {}
export function stop(): void {}
`,
  );

  write(
    "src/short/consumer.ts",
    `import { run } from "./a";
run();
`,
  );

  // ── Dead file: all exports unused, no dependents ──
  write(
    "src/dead-module/helpers.ts",
    `export function orphanA(): void {}
export function orphanB(): void {}
export const ORPHAN_CONST = 99;
`,
  );

  // ── Dead barrel: nothing imports through it ──
  write(
    "src/dead-barrel/widget.ts",
    `export function widgetRender(): void {}
`,
  );
  write(
    "src/dead-barrel/index.ts",
    `export { widgetRender } from "./widget";
`,
  );
  // No consumer imports from src/dead-barrel or src/dead-barrel/index

  // ── Live barrel: something imports through it ──
  write(
    "src/live-barrel/thing.ts",
    `export function doThing(): string { return "thing"; }
`,
  );
  write(
    "src/live-barrel/index.ts",
    `export { doThing } from "./thing";
`,
  );
  write(
    "src/live-barrel/consumer.ts",
    `import { doThing } from "./index";
console.log(doThing());
`,
  );

  // ── Test-only exports: only imported by test files ──
  write(
    "src/test-helpers.ts",
    `export function createMockUser(): { id: string } { return { id: "mock" }; }
export function createMockOrder(): { id: string } { return { id: "order" }; }
`,
  );
  write(
    "tests/user.test.ts",
    `import { createMockUser, createMockOrder } from "../src/test-helpers";
const u = createMockUser();
const o = createMockOrder();
console.log(u, o);
`,
  );

  // ── Export cluster: file with many dead exports but some alive ──
  write(
    "src/cluster/big-module.ts",
    `export function alive(): void {}
export function deadOne(): void {}
export function deadTwo(): void {}
export function deadThree(): void {}
export function deadFour(): void {}
`,
  );
  write(
    "src/cluster/user.ts",
    `import { alive } from "./big-module";
alive();
`,
  );

  // ── Python: dead __init__.py barrel ──
  write(
    "lib/dead_pkg/__init__.py",
    `from .core import transform_input
from .core import dead_export
`,
  );
  write(
    "lib/dead_pkg/core.py",
    `def transform_input(x):
    return x

def dead_export():
    pass
`,
  );
  // Nobody imports from dead_pkg

  // ── Python: live __init__.py barrel ──
  write(
    "lib/live_pkg/__init__.py",
    `from .helpers import format_output
`,
  );
  write(
    "lib/live_pkg/helpers.py",
    `def format_output(data):
    return str(data)
`,
  );
  write(
    "lib/consumer.py",
    `from live_pkg import format_output

print(format_output("hello"))
`,
  );

  // ── Rust: dead mod.rs barrel ──
  write(
    "src/dead_mod/mod.rs",
    `pub mod utils;
pub use utils::dead_util;
`,
  );
  write(
    "src/dead_mod/utils.rs",
    `pub fn dead_util() -> i32 { 0 }
`,
  );
  // Nobody imports from dead_mod

  // ── Rust: live mod.rs barrel ──
  write(
    "src/live_mod/mod.rs",
    `pub mod tools;
pub use tools::live_tool;
`,
  );
  write(
    "src/live_mod/tools.rs",
    `pub fn live_tool() -> String { String::from("ok") }
`,
  );
  write(
    "src/live_consumer.rs",
    `use crate::live_mod::live_tool;

fn main() {
    live_tool();
}
`,
  );

  repoMap = new RepoMap(TMP);
  await repoMap.scan();
});

afterAll(() => {
  repoMap?.close();
  rmSync(TMP, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

function getUnused(): Array<{ name: string; path: string; kind: string; lineCount: number; usedInternally: boolean }> {
  return repoMap.getUnusedExports();
}

function unusedNames(): string[] {
  return getUnused().map((u) => u.name);
}



describe("unused exports — TypeScript", () => {
  it("detects deadHelper as unused", () => {
    const unused = getUnused();
    expect(unused.some((u) => u.name === "deadHelper")).toBe(true);
  });

  it("does not flag formatDate as unused (imported by app.ts)", () => {
    expect(unusedNames()).not.toContain("formatDate");
  });

  it("does not flag MAGIC as unused (imported by app.ts)", () => {
    expect(unusedNames()).not.toContain("MAGIC");
  });
});

describe("unused exports — duplicate symbol names", () => {
  it("does not flag database Config as unused (imported by server.ts)", () => {
    const unused = getUnused();
    const dbConfig = unused.find(
      (u) => u.name === "Config" && u.path.includes("database"),
    );
    expect(dbConfig).toBeUndefined();
  });

  it("detects cache Config as unused when source resolution works", () => {
    // With name-only matching, both Configs appear "used" because
    // server.ts refs "Config" which matches both definitions.
    // With source_file_id resolution, only database.ts Config is
    // matched (server.ts imports from "./config/database").
    const unused = getUnused();
    const cacheConfig = unused.find(
      (u) => u.name === "Config" && u.path.includes("cache"),
    );
    // This test documents the expected behavior after source resolution.
    // If this fails, source_file_id resolution is not working yet.
    expect(cacheConfig).toBeDefined();
  });

  it("detects createCacheConfig as unused (never imported)", () => {
    expect(unusedNames()).toContain("createCacheConfig");
  });
});

describe("unused exports — Python", () => {
  it("detects dead_function as unused", () => {
    const unused = getUnused();
    const found = unused.find((u) => u.name === "dead_function" && u.path.includes(".py"));
    expect(found).toBeDefined();
  });

  it("does not flag parse_json as unused", () => {
    expect(unusedNames()).not.toContain("parse_json");
  });

  it("does not flag _private_helper (not exported due to underscore)", () => {
    expect(unusedNames()).not.toContain("_private_helper");
  });
});

describe("unused exports — Go", () => {
  it("detects UnusedHandler as unused", () => {
    expect(unusedNames()).toContain("UnusedHandler");
  });

  it("does not flag ServeHTTP as unused", () => {
    expect(unusedNames()).not.toContain("ServeHTTP");
  });
});

describe("unused exports — Rust", () => {
  it("detects unused_utility as unused", () => {
    expect(unusedNames()).toContain("unused_utility");
  });

  it("does not flag process_data as unused", () => {
    expect(unusedNames()).not.toContain("process_data");
  });

  it("does not flag private_helper (not exported, no pub)", () => {
    expect(unusedNames()).not.toContain("private_helper");
  });
});

describe("unused exports — Java", () => {
  it("detects DeadService as unused", () => {
    expect(unusedNames()).toContain("DeadService");
  });

  it("does not flag UserService as unused", () => {
    expect(unusedNames()).not.toContain("UserService");
  });
});

describe("unused exports — Kotlin", () => {
  it("detects UnusedRepository as unused", () => {
    expect(unusedNames()).toContain("UnusedRepository");
  });

  it("does not flag Repository as unused", () => {
    expect(unusedNames()).not.toContain("Repository");
  });

  it("does not flag InternalHelper (private)", () => {
    expect(unusedNames()).not.toContain("InternalHelper");
  });
});

describe("unused exports — Swift", () => {
  it("detects UnusedClient as unused", () => {
    expect(unusedNames()).toContain("UnusedClient");
  });

  it("does not flag NetworkClient as unused", () => {
    expect(unusedNames()).not.toContain("NetworkClient");
  });
});

describe("unused exports — Elixir", () => {
  it("detects unused_parse as unused", () => {
    expect(unusedNames()).toContain("unused_parse");
  });

  it("does not flag parse as unused", () => {
    expect(unusedNames()).not.toContain("parse");
  });

  it("does not flag internal_helper (defp = private)", () => {
    expect(unusedNames()).not.toContain("internal_helper");
  });
});

describe("unused exports — PHP", () => {
  it("detects DeadController as unused", () => {
    expect(unusedNames()).toContain("DeadController");
  });

  it("does not flag UserController as unused", () => {
    expect(unusedNames()).not.toContain("UserController");
  });
});

describe("unused exports — Dart", () => {
  it("detects UnusedWidget as unused", () => {
    expect(unusedNames()).toContain("UnusedWidget");
  });

  it("does not flag AppWidget as unused", () => {
    expect(unusedNames()).not.toContain("AppWidget");
  });

  it("does not flag _PrivateWidget (underscore = private)", () => {
    expect(unusedNames()).not.toContain("_PrivateWidget");
  });
});

describe("unused exports — usedInternally classification", () => {
  it("marks deadHelper as not used internally", () => {
    const dead = getUnused().find((u) => u.name === "deadHelper");
    expect(dead).toBeDefined();
    expect(dead!.usedInternally).toBe(false);
  });
});

describe("unused exports — re-exports", () => {
  it("does not flag formatDate (re-exported via index.ts)", () => {
    expect(unusedNames()).not.toContain("formatDate");
  });
});

// CommonJS tests moved to dedicated section at end of file

describe("unused exports — deep relative imports", () => {
  it("does not flag deepHelper (imported via ./nested/helper)", () => {
    expect(unusedNames()).not.toContain("deepHelper");
  });

  it("detects deadDeepHelper as unused", () => {
    expect(unusedNames()).toContain("deadDeepHelper");
  });
});

describe("unused exports — duplicate names different kinds", () => {
  it("does not flag UserValidator (imported by validation.ts)", () => {
    expect(unusedNames()).not.toContain("UserValidator");
  });

  it("detects ProductValidator as unused (never imported)", () => {
    expect(unusedNames()).toContain("ProductValidator");
  });

  it("detects product Validator interface as unused when source resolution works", () => {
    const unused = getUnused();
    const productValidator = unused.find(
      (u) => u.name === "Validator" && u.path.includes("product"),
    );
    expect(productValidator).toBeDefined();
  });
});

describe("unused exports — short/colliding symbol names", () => {
  it("does not flag run in a.ts (imported by consumer.ts)", () => {
    const unused = getUnused();
    const aRun = unused.find((u) => u.name === "run" && u.path.includes("short/a"));
    expect(aRun).toBeUndefined();
  });

  it("detects run in b.ts as unused (same name, different file, not imported)", () => {
    const unused = getUnused();
    const bRun = unused.find((u) => u.name === "run" && u.path.includes("short/b"));
    expect(bRun).toBeDefined();
  });

  it("detects go as unused (only in a.ts, never imported)", () => {
    expect(unusedNames()).toContain("go");
  });

  it("detects stop as unused (only in b.ts, never imported)", () => {
    expect(unusedNames()).toContain("stop");
  });
});

describe("unused exports — default exports", () => {
  it("does not flag Logger (default import by main-logger.ts)", () => {
    expect(unusedNames()).not.toContain("Logger");
  });

  it("detects createLogger as unused (never imported)", () => {
    expect(unusedNames()).toContain("createLogger");
  });
});

describe("unused exports — export * wildcard re-exports", () => {
  it("does not flag add in barrel math.ts (re-exported via export * and imported by consumer)", () => {
    const unused = getUnused();
    const barrelAdd = unused.find(
      (u) => u.name === "add" && u.path.includes("barrel/math"),
    );
    expect(barrelAdd).toBeUndefined();
  });

  it("does not flag add in barrel index.ts (re-export of math.ts)", () => {
    const unused = getUnused();
    const indexAdd = unused.find(
      (u) => u.name === "add" && u.path.includes("barrel/index"),
    );
    expect(indexAdd).toBeUndefined();
  });

  it("detects deadMath as unused (in barrel source, never imported)", () => {
    expect(unusedNames()).toContain("deadMath");
  });
});

describe("unused exports — TypeScript path aliases (tsconfig)", () => {
  it("does not flag formatCurrency (imported via @utils/format alias)", () => {
    expect(unusedNames()).not.toContain("formatCurrency");
  });

  it("detects deadFormat as unused (in aliased module, never imported)", () => {
    expect(unusedNames()).toContain("deadFormat");
  });
});

describe("unused exports — Go module-relative imports", () => {
  it("does not flag Process (imported via module path)", () => {
    expect(unusedNames()).not.toContain("Process");
  });

  it("detects UnusedService as unused", () => {
    expect(unusedNames()).toContain("UnusedService");
  });
});

describe("unused exports — CommonJS module.exports", () => {
  it("detects deadLegacy as unused", () => {
    expect(unusedNames()).toContain("deadLegacy");
  });

  it("does not flag formatName (imported via require)", () => {
    expect(unusedNames()).not.toContain("formatName");
  });
});

// ══════════════════════════════════════════════════════════════
// Dead files, barrels, test-only, clusters
// ══════════════════════════════════════════════════════════════

describe("dead files — all exports unused with no dependents", () => {
  it("detects all exports from dead-module/helpers.ts as unused", () => {
    const unused = getUnused();
    const deadModule = unused.filter((u) => u.path.includes("dead-module/helpers"));
    expect(deadModule.length).toBe(3);
    expect(deadModule.map((u) => u.name).sort()).toEqual(["ORPHAN_CONST", "orphanA", "orphanB"]);
  });

  it("includes lineCount in unused export results", () => {
    const unused = getUnused();
    const deadModule = unused.find((u) => u.path.includes("dead-module/helpers"));
    expect(deadModule).toBeDefined();
    expect(deadModule!.lineCount).toBeGreaterThan(0);
  });

  it("getFileExportCount returns correct count for dead file", () => {
    const count = repoMap.getFileExportCount("src/dead-module/helpers.ts");
    expect(count).toBe(3);
  });

  it("dead file has no dependents", () => {
    const deps = repoMap.getFileDependents("src/dead-module/helpers.ts");
    expect(deps.length).toBe(0);
  });
});

describe("dead barrels — barrel files with no dependents", () => {
  it("detects dead-barrel/index.ts as a dead barrel", () => {
    const barrels = repoMap.getDeadBarrels();
    const deadBarrel = barrels.find((b) => b.path.includes("dead-barrel/index"));
    expect(deadBarrel).toBeDefined();
    expect(deadBarrel!.lineCount).toBeGreaterThan(0);
  });

  it("does not flag live-barrel/index.ts (consumer imports from ./index)", () => {
    const barrels = repoMap.getDeadBarrels();
    const liveBarrel = barrels.find((b) => b.path.includes("live-barrel/index"));
    expect(liveBarrel).toBeUndefined();
  });

  it("does not flag barrel/index.ts from original fixtures (consumer imports from ./index)", () => {
    const barrels = repoMap.getDeadBarrels();
    const barrelIndex = barrels.find(
      (b) => b.path === "src/barrel/index.ts",
    );
    expect(barrelIndex).toBeUndefined();
  });

  it("detects Python dead __init__.py barrel", () => {
    const barrels = repoMap.getDeadBarrels();
    const pyBarrel = barrels.find((b) => b.path.includes("dead_pkg/__init__.py"));
    expect(pyBarrel).toBeDefined();
    expect(pyBarrel!.language).toBe("python");
  });

  it("does not flag Python live __init__.py barrel", () => {
    const barrels = repoMap.getDeadBarrels();
    const liveBarrel = barrels.find((b) => b.path.includes("live_pkg/__init__.py"));
    expect(liveBarrel).toBeUndefined();
  });

  it("detects Rust dead mod.rs barrel", () => {
    const barrels = repoMap.getDeadBarrels();
    const rsBarrel = barrels.find((b) => b.path.includes("dead_mod/mod.rs"));
    expect(rsBarrel).toBeDefined();
    expect(rsBarrel!.language).toBe("rust");
  });

  it("does not flag Rust live mod.rs barrel", () => {
    const barrels = repoMap.getDeadBarrels();
    const liveBarrel = barrels.find((b) => b.path.includes("live_mod/mod.rs"));
    expect(liveBarrel).toBeUndefined();
  });

  it("includes language field on all dead barrels", () => {
    const barrels = repoMap.getDeadBarrels();
    for (const b of barrels) {
      expect(b.language).toBeDefined();
      expect(typeof b.language).toBe("string");
    }
  });
});

describe("test-only exports — only imported by test files", () => {
  it("detects createMockUser as test-only", () => {
    const testOnly = repoMap.getTestOnlyExports();
    expect(testOnly.some((t) => t.name === "createMockUser")).toBe(true);
  });

  it("detects createMockOrder as test-only", () => {
    const testOnly = repoMap.getTestOnlyExports();
    expect(testOnly.some((t) => t.name === "createMockOrder")).toBe(true);
  });

  it("does not flag formatDate as test-only (imported by production code)", () => {
    const testOnly = repoMap.getTestOnlyExports();
    expect(testOnly.some((t) => t.name === "formatDate")).toBe(false);
  });

  it("does not include dead exports in test-only (they have no refs at all)", () => {
    const testOnly = repoMap.getTestOnlyExports();
    expect(testOnly.some((t) => t.name === "deadHelper")).toBe(false);
    expect(testOnly.some((t) => t.name === "orphanA")).toBe(false);
  });
});

describe("export clusters — files with 3+ dead exports", () => {
  it("detects dead exports in big-module.ts cluster", () => {
    const unused = getUnused();
    const cluster = unused.filter((u) => u.path.includes("cluster/big-module"));
    expect(cluster.length).toBe(4);
    expect(cluster.map((u) => u.name).sort()).toEqual(["deadFour", "deadOne", "deadThree", "deadTwo"]);
  });

  it("does not flag alive in big-module.ts", () => {
    const unused = getUnused();
    const alive = unused.find((u) => u.name === "alive" && u.path.includes("cluster/big-module"));
    expect(alive).toBeUndefined();
  });
});

describe("getUnusedExports limit parameter", () => {
  it("respects custom limit", () => {
    const limited = repoMap.getUnusedExports(3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it("default limit is high enough to catch all test fixtures", () => {
    const all = repoMap.getUnusedExports();
    expect(all.length).toBeGreaterThan(10);
  });
});
