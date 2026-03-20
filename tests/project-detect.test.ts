import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProfile } from "../src/core/tools/project.js";

/**
 * Tests for detectProfile — the production function, not a mirror.
 * Uses real temp directories with marker files that simulate real project structures.
 * Wrong detection = wrong test/build/lint/format commands = user confusion.
 */

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), "soulforge-detect-"));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

// ── JS/TS: Bun ──────────────────────────────────────────────

describe("Bun project (bun.lock)", () => {
  it("detects bun with biome formatter", () => {
    const cwd = makeProject("bun-biome", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome check ." } }),
      "biome.json": "{}",
      "tsconfig.json": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("bun test");
    expect(p.lint).toBe("bun run lint");
    expect(p.typecheck).toBe("bunx tsc --noEmit");
    expect(p.format).toBe("bunx biome format --write");
  });

  it("prefers scripts.format over auto-detect", () => {
    const cwd = makeProject("bun-format-script", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { format: "biome format ." } }),
      "biome.json": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.format).toBe("bun run format");
  });

  it("detects prettier when no biome", () => {
    const cwd = makeProject("bun-prettier", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
      ".prettierrc": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.format).toContain("prettier");
  });

  it("no formatter when nothing configured", () => {
    const cwd = makeProject("bun-no-format", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
    });
    const p = detectProfile(cwd);
    expect(p.format).toBeNull();
  });
});

// ── JS/TS: npm/pnpm/yarn ────────────────────────────────────

describe("npm project (package.json only)", () => {
  it("detects npm with eslint and prettier", () => {
    const cwd = makeProject("npm-prettier", {
      "package.json": JSON.stringify({
        scripts: { test: "jest", lint: "eslint .", build: "tsc" },
      }),
      ".prettierrc.json": "{}",
      "tsconfig.json": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("npm run test");
    expect(p.build).toBe("npm run build");
    expect(p.lint).toBe("npm run lint");
    expect(p.typecheck).toBe("npx tsc --noEmit");
    expect(p.format).toContain("prettier");
  });
});

describe("pnpm project", () => {
  it("detects pnpm with dprint", () => {
    const cwd = makeProject("pnpm-dprint", {
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "pnpm-lock.yaml": "",
      "dprint.json": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("pnpm test");
    expect(p.format).toContain("dprint");
  });
});

describe("yarn project", () => {
  it("detects yarn with biome", () => {
    const cwd = makeProject("yarn-biome", {
      "package.json": JSON.stringify({ scripts: { test: "jest", build: "tsc" } }),
      "yarn.lock": "",
      "biome.jsonc": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("yarn test");
    expect(p.build).toBe("yarn build");
    expect(p.format).toContain("biome");
  });
});

// ── JS/TS: Deno ─────────────────────────────────────────────

describe("Deno project", () => {
  it("detects deno with built-in formatter", () => {
    const cwd = makeProject("deno", {
      "deno.json": JSON.stringify({ tasks: { dev: "deno run --watch main.ts" } }),
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("deno test");
    expect(p.lint).toBe("deno lint");
    expect(p.typecheck).toBe("deno check .");
    expect(p.format).toBe("deno fmt");
  });
});

// ── Rust ────────────────────────────────────────────────────

describe("Rust project (Cargo.toml)", () => {
  it("detects cargo toolchain", () => {
    const cwd = makeProject("rust", {
      "Cargo.toml": '[package]\nname = "myapp"\nversion = "0.1.0"',
      "src/main.rs": "fn main() {}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("cargo test");
    expect(p.build).toBe("cargo build");
    expect(p.lint).toBe("cargo clippy");
    expect(p.typecheck).toBe("cargo check");
    expect(p.format).toBe("rustfmt");
  });
});

// ── Go ──────────────────────────────────────────────────────

describe("Go project (go.mod)", () => {
  it("detects go with golangci-lint", () => {
    const cwd = makeProject("go-lint", {
      "go.mod": "module example.com/myapp\n\ngo 1.21",
      ".golangci.yml": "linters:\n  enable:\n    - gofmt",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("go test ./...");
    expect(p.lint).toBe("golangci-lint run");
    expect(p.format).toBe("gofmt -w");
  });

  it("falls back to go vet without golangci config", () => {
    const cwd = makeProject("go-noconfig", {
      "go.mod": "module example.com/myapp\n\ngo 1.21",
    });
    const p = detectProfile(cwd);
    expect(p.lint).toBe("go vet ./...");
    expect(p.format).toBe("gofmt -w");
  });
});

// ── Python ──────────────────────────────────────────────────

describe("Python project (pyproject.toml)", () => {
  it("detects uv with ruff", () => {
    const cwd = makeProject("py-uv-ruff", {
      "pyproject.toml": "[project]\nname = 'myapp'",
      "uv.lock": "",
      "ruff.toml": "[lint]\nselect = ['E', 'F']",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("uv run pytest");
    expect(p.lint).toBe("uv run ruff check");
    expect(p.format).toBe("uv run ruff format");
  });

  it("detects poetry with black fallback", () => {
    const cwd = makeProject("py-poetry-black", {
      "pyproject.toml": "[tool.poetry]\nname = 'myapp'",
      "poetry.lock": "",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("poetry run pytest");
    expect(p.format).toBe("poetry run black");
  });

  it("detects plain python with Django", () => {
    const cwd = makeProject("py-django", {
      "requirements.txt": "django>=4.0\nblack",
      "manage.py": "#!/usr/bin/env python",
    });
    const p = detectProfile(cwd);
    expect(p.run).toContain("manage.py");
    expect(p.format).toBe("black");
  });
});

// ── PHP ─────────────────────────────────────────────────────

describe("PHP project (composer.json)", () => {
  it("detects Laravel with Pint", () => {
    const cwd = makeProject("php-laravel", {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^10" } }),
      "artisan": "",
      "pint.json": "{}",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("vendor/bin/phpunit");
    expect(p.lint).toContain("pint");
    expect(p.format).toBe("vendor/bin/pint");
    expect(p.run).toContain("artisan");
  });

  it("detects PHP with php-cs-fixer", () => {
    const cwd = makeProject("php-fixer", {
      "composer.json": JSON.stringify({}),
      ".php-cs-fixer.php": "<?php return [];",
    });
    const p = detectProfile(cwd);
    expect(p.format).toBe("vendor/bin/php-cs-fixer fix");
  });
});

// ── Flutter/Dart ────────────────────────────────────────────

describe("Flutter project (pubspec.yaml)", () => {
  it("detects flutter/dart toolchain", () => {
    const cwd = makeProject("flutter", {
      "pubspec.yaml": "name: myapp\ndescription: A Flutter app",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("flutter test");
    expect(p.lint).toBe("dart analyze");
    expect(p.format).toBe("dart format");
  });
});

// ── Elixir ──────────────────────────────────────────────────

describe("Elixir project (mix.exs)", () => {
  it("detects mix toolchain", () => {
    const cwd = makeProject("elixir", {
      "mix.exs": 'defmodule MyApp.MixProject do\n  use Mix.Project\nend',
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("mix test");
    expect(p.lint).toBe("mix credo");
    expect(p.format).toBe("mix format");
  });
});

// ── Ruby ────────────────────────────────────────────────────

describe("Ruby project (Gemfile)", () => {
  it("detects Rails with rspec", () => {
    const cwd = makeProject("ruby-rails", {
      "Gemfile": "source 'https://rubygems.org'\ngem 'rails'",
      "config.ru": "require_relative 'config/environment'",
      "spec/.keep": "",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("bundle exec rspec");
    expect(p.lint).toBe("bundle exec rubocop");
    expect(p.format).toContain("rubocop");
    expect(p.run).toContain("rails server");
  });
});

// ── Swift ───────────────────────────────────────────────────

describe("Swift project (Package.swift)", () => {
  it("detects swift with swiftformat", () => {
    const cwd = makeProject("swift", {
      "Package.swift": "// swift-tools-version:5.9\nimport PackageDescription",
      ".swiftformat": "",
      ".swiftlint.yml": "",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("swift test");
    expect(p.build).toBe("swift build");
    expect(p.lint).toBe("swiftlint");
    expect(p.format).toBe("swiftformat");
  });

  it("no formatter without .swiftformat config", () => {
    const cwd = makeProject("swift-noformat", {
      "Package.swift": "// swift-tools-version:5.9",
    });
    const p = detectProfile(cwd);
    expect(p.format).toBeNull();
  });
});

// ── Java/Kotlin: Gradle ─────────────────────────────────────

describe("Gradle project", () => {
  it("detects gradle with spotless", () => {
    const cwd = makeProject("gradle-spotless", {
      "gradlew": "#!/bin/sh",
      "build.gradle.kts": 'plugins {\n  id("com.diffplug.spotless")\n}',
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("./gradlew test");
    expect(p.lint).toBe("./gradlew spotlessCheck");
    expect(p.format).toBeNull(); // spotless doesn't support single-file
  });

  it("detects gradle with ktlint", () => {
    const cwd = makeProject("gradle-ktlint", {
      "gradlew": "#!/bin/sh",
      "build.gradle.kts": 'plugins {\n  id("org.jlleitschuh.gradle.ktlint")\n}',
    });
    const p = detectProfile(cwd);
    expect(p.lint).toBe("./gradlew ktlintCheck");
  });

  it("falls back to gradle check without linter plugin", () => {
    const cwd = makeProject("gradle-plain", {
      "build.gradle": "apply plugin: 'java'",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("gradle test");
    expect(p.lint).toBe("gradle check");
  });
});

// ── Java: Maven ─────────────────────────────────────────────

describe("Maven project (pom.xml)", () => {
  it("detects maven with wrapper", () => {
    const cwd = makeProject("maven", {
      "mvnw": "#!/bin/sh",
      "pom.xml": "<project></project>",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("./mvnw test");
    expect(p.build).toBe("./mvnw package");
  });
});

// ── C/C++ ───────────────────────────────────────────────────

describe("CMake project", () => {
  it("detects cmake with clang-tidy", () => {
    const cwd = makeProject("cmake", {
      "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)",
      ".clang-tidy": "Checks: '-*,clang-analyzer-*'",
    });
    const p = detectProfile(cwd);
    expect(p.build).toBe("cmake --build build");
    expect(p.lint).toBe("clang-tidy");
  });
});

describe("Makefile project", () => {
  it("detects make", () => {
    const cwd = makeProject("make", {
      "Makefile": "all:\n\tgcc main.c",
    });
    const p = detectProfile(cwd);
    expect(p.build).toBe("make");
    expect(p.test).toBe("make test");
  });
});

// ── Zig ─────────────────────────────────────────────────────

describe("Zig project", () => {
  it("detects zig toolchain", () => {
    const cwd = makeProject("zig", {
      "build.zig": "const std = @import(\"std\");",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("zig build test");
    expect(p.build).toBe("zig build");
    expect(p.format).toBe("zig fmt");
  });
});

// ── .NET ────────────────────────────────────────────────────

describe(".NET project", () => {
  it("detects dotnet with csproj", () => {
    const cwd = makeProject("dotnet", {
      "MyApp.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />",
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("dotnet test");
    expect(p.build).toBe("dotnet build");
    expect(p.run).toBe("dotnet run");
  });
});

// ── Edge Cases ──────────────────────────────────────────────

describe("edge cases", () => {
  it("returns all nulls for empty directory", () => {
    const cwd = makeProject("empty", {});
    const p = detectProfile(cwd);
    expect(p.test).toBeNull();
    expect(p.build).toBeNull();
    expect(p.lint).toBeNull();
    expect(p.typecheck).toBeNull();
    expect(p.run).toBeNull();
    expect(p.format).toBeNull();
  });

  it("bun takes priority over npm when both exist", () => {
    const cwd = makeProject("bun-over-npm", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
    });
    const p = detectProfile(cwd);
    expect(p.test).toBe("bun test"); // bun default, not npm
  });

  it("Cargo.toml takes priority over Makefile", () => {
    const cwd = makeProject("rust-with-makefile", {
      "Cargo.toml": '[package]\nname = "app"',
      "Makefile": "all:\n\tcargo build",
    });
    const p = detectProfile(cwd);
    expect(p.build).toBe("cargo build"); // Cargo, not make
  });

  it("handles nonexistent directory gracefully", () => {
    const p = detectProfile("/tmp/nonexistent-soulforge-test-dir-xyz");
    expect(p.test).toBeNull();
  });
});
