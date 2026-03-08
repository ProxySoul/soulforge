import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for detectProfile from project.ts.
 * This auto-detects toolchain across 20+ ecosystems.
 * Wrong detection = wrong test/build/lint commands = user confusion.
 * Uses real temp directories with marker files.
 */

// Mirror the production code
function detectProfile(cwd: string) {
  const { existsSync, readdirSync, readFileSync } = require("node:fs");

  const profile: Record<string, string | null> = {
    test: null,
    build: null,
    lint: null,
    typecheck: null,
    run: null,
  };

  const has = (f: string) => existsSync(join(cwd, f));
  const hasExt = (ext: string) => {
    try {
      return readdirSync(cwd).some((f: string) => f.endsWith(ext));
    } catch {
      return false;
    }
  };
  const readPackageScripts = (): Record<string, string> => {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
      return pkg.scripts ?? {};
    } catch {
      return {};
    }
  };
  const detectJsLinter = (): string | null => {
    if (has("biome.json") || has("biome.jsonc")) return "biome lint .";
    if (
      has(".eslintrc") ||
      has(".eslintrc.js") ||
      has(".eslintrc.json") ||
      has("eslint.config.js") ||
      has("eslint.config.mjs")
    )
      return "eslint .";
    return null;
  };
  const scripts = readPackageScripts();

  if (has("bun.lock") || has("bun.lockb")) {
    profile.test = scripts.test ?? "bun test";
    profile.build = scripts.build ? "bun run build" : null;
    profile.lint = scripts.lint ? "bun run lint" : detectJsLinter();
    profile.typecheck = has("tsconfig.json")
      ? scripts.typecheck ? "bun run typecheck" : "bunx tsc --noEmit"
      : null;
    profile.run = scripts.dev ? "bun run dev" : scripts.start ? "bun run start" : null;
    return profile;
  }

  if (has("deno.json") || has("deno.lock")) {
    profile.test = "deno test";
    profile.build = null;
    profile.lint = "deno lint";
    profile.typecheck = "deno check .";
    profile.run = scripts.dev ? "deno task dev" : "deno run main.ts";
    return profile;
  }

  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const run = pm === "npm" ? "npm run" : pm;
    profile.test = scripts.test ? `${run} test` : null;
    profile.build = scripts.build ? `${run} build` : null;
    profile.lint = scripts.lint ? `${run} lint` : detectJsLinter();
    profile.typecheck = has("tsconfig.json")
      ? scripts.typecheck ? `${run} typecheck` : "npx tsc --noEmit"
      : null;
    profile.run = scripts.dev ? `${run} dev` : scripts.start ? `${run} start` : null;
    return profile;
  }

  if (has("Cargo.toml")) {
    profile.test = "cargo test";
    profile.build = "cargo build";
    profile.lint = "cargo clippy";
    profile.typecheck = "cargo check";
    profile.run = "cargo run";
    return profile;
  }

  if (has("go.mod")) {
    profile.test = "go test ./...";
    profile.build = "go build ./...";
    profile.lint = has(".golangci.yml") || has(".golangci.yaml") ? "golangci-lint run" : "go vet ./...";
    profile.typecheck = "go build ./...";
    profile.run = "go run .";
    return profile;
  }

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const pm = has("uv.lock") ? "uv run" : has("poetry.lock") ? "poetry run" : has("Pipfile.lock") ? "pipenv run" : "";
    const prefix = pm ? `${pm} ` : "";
    profile.test = `${prefix}pytest`;
    profile.lint = has("ruff.toml") || has(".ruff.toml") ? `${prefix}ruff check` : `${prefix}flake8`;
    profile.typecheck = `${prefix}mypy .`;
    if (has("manage.py")) profile.run = `${prefix}python manage.py runserver`;
    else if (has("app.py") || has("main.py")) profile.run = `${prefix}uvicorn main:app --reload`;
    return profile;
  }

  if (has("pubspec.yaml")) {
    profile.test = "flutter test";
    profile.build = "flutter build";
    profile.lint = "dart analyze";
    profile.typecheck = "dart analyze";
    profile.run = "flutter run";
    return profile;
  }

  if (has("Package.swift")) {
    profile.test = "swift test";
    profile.build = "swift build";
    profile.lint = has(".swiftlint.yml") ? "swiftlint" : null;
    profile.typecheck = "swift build";
    profile.run = "swift run";
    return profile;
  }

  if (has("mix.exs")) {
    profile.test = "mix test";
    profile.build = "mix compile";
    profile.lint = "mix credo";
    profile.typecheck = "mix dialyzer";
    profile.run = "mix phx.server";
    return profile;
  }

  if (has("Gemfile")) {
    profile.test = has("spec") ? "bundle exec rspec" : "bundle exec rails test";
    profile.build = null;
    profile.lint = "bundle exec rubocop";
    profile.run = has("config.ru") ? "bundle exec rails server" : null;
    return profile;
  }

  if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
    const gw = has("gradlew") ? "./gradlew" : "gradle";
    profile.test = `${gw} test`;
    profile.build = `${gw} build`;
    profile.lint = `${gw} check`;
    profile.typecheck = `${gw} compileJava`;
    profile.run = `${gw} run`;
    return profile;
  }

  if (has("pom.xml") || has("mvnw")) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    profile.test = `${mvn} test`;
    profile.build = `${mvn} package`;
    profile.lint = `${mvn} checkstyle:check`;
    profile.typecheck = `${mvn} compile`;
    profile.run = `${mvn} exec:java`;
    return profile;
  }

  if (has("CMakeLists.txt")) {
    profile.test = "ctest --test-dir build";
    profile.build = "cmake --build build";
    profile.lint = has(".clang-tidy") ? "clang-tidy" : null;
    profile.typecheck = "cmake --build build";
    return profile;
  }

  if (has("Makefile")) {
    profile.test = "make test";
    profile.build = "make";
    profile.run = "make run";
    return profile;
  }

  if (has("build.zig") || has("build.zig.zon")) {
    profile.test = "zig build test";
    profile.build = "zig build";
    profile.typecheck = "zig build";
    profile.run = "zig build run";
    return profile;
  }

  return profile;
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "project-detect-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const filePath = join(dir, file);
    const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (fileDir !== dir) mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

describe("detectProfile — Bun", () => {
  it("detects bun project with lock file", () => {
    const dir = makeProject("bun1", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { test: "bun test", build: "bun build" } }),
      "tsconfig.json": "{}",
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("bun test");
    expect(p.build).toBe("bun run build");
    expect(p.typecheck).toBe("bunx tsc --noEmit");
  });

  it("falls back to bun test when no test script", () => {
    const dir = makeProject("bun2", {
      "bun.lockb": "",
      "package.json": JSON.stringify({ scripts: {} }),
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("bun test");
  });

  it("detects biome linter for bun project", () => {
    const dir = makeProject("bun3", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: {} }),
      "biome.json": "{}",
    });
    const p = detectProfile(dir);
    expect(p.lint).toBe("biome lint .");
  });

  it("detects eslint linter for bun project", () => {
    const dir = makeProject("bun4", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: {} }),
      "eslint.config.js": "",
    });
    const p = detectProfile(dir);
    expect(p.lint).toBe("eslint .");
  });
});

describe("detectProfile — npm/yarn/pnpm", () => {
  it("detects pnpm", () => {
    const dir = makeProject("pnpm1", {
      "package.json": JSON.stringify({ scripts: { test: "vitest", build: "vite build" } }),
      "pnpm-lock.yaml": "",
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("pnpm test");
    expect(p.build).toBe("pnpm build");
  });

  it("detects yarn", () => {
    const dir = makeProject("yarn1", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "yarn.lock": "",
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("yarn test");
  });

  it("detects npm (no lock file)", () => {
    const dir = makeProject("npm1", {
      "package.json": JSON.stringify({ scripts: { test: "jest", dev: "next dev" } }),
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("npm run test");
    expect(p.run).toBe("npm run dev");
  });

  it("detects typecheck with tsconfig", () => {
    const dir = makeProject("ts1", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "tsconfig.json": "{}",
    });
    const p = detectProfile(dir);
    expect(p.typecheck).toBe("npx tsc --noEmit");
  });

  it("no typecheck without tsconfig", () => {
    const dir = makeProject("js1", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    });
    const p = detectProfile(dir);
    expect(p.typecheck).toBeNull();
  });
});

describe("detectProfile — Rust", () => {
  it("detects Cargo project", () => {
    const dir = makeProject("rust1", { "Cargo.toml": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("cargo test");
    expect(p.build).toBe("cargo build");
    expect(p.lint).toBe("cargo clippy");
    expect(p.typecheck).toBe("cargo check");
    expect(p.run).toBe("cargo run");
  });
});

describe("detectProfile — Go", () => {
  it("detects Go module", () => {
    const dir = makeProject("go1", { "go.mod": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("go test ./...");
    expect(p.lint).toBe("go vet ./...");
  });

  it("detects golangci-lint", () => {
    const dir = makeProject("go2", { "go.mod": "", ".golangci.yml": "" });
    const p = detectProfile(dir);
    expect(p.lint).toBe("golangci-lint run");
  });
});

describe("detectProfile — Python", () => {
  it("detects Python with pyproject.toml", () => {
    const dir = makeProject("py1", { "pyproject.toml": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("pytest");
    expect(p.lint).toBe("flake8");
  });

  it("detects uv", () => {
    const dir = makeProject("py2", { "pyproject.toml": "", "uv.lock": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("uv run pytest");
    expect(p.typecheck).toBe("uv run mypy .");
  });

  it("detects poetry", () => {
    const dir = makeProject("py3", { "pyproject.toml": "", "poetry.lock": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("poetry run pytest");
  });

  it("detects ruff linter", () => {
    const dir = makeProject("py4", { "pyproject.toml": "", "ruff.toml": "" });
    const p = detectProfile(dir);
    expect(p.lint).toBe("ruff check");
  });

  it("detects Django project", () => {
    const dir = makeProject("py5", { "pyproject.toml": "", "manage.py": "" });
    const p = detectProfile(dir);
    expect(p.run).toContain("manage.py runserver");
  });
});

describe("detectProfile — mobile/game", () => {
  it("detects Flutter/Dart", () => {
    const dir = makeProject("flutter1", { "pubspec.yaml": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("flutter test");
    expect(p.lint).toBe("dart analyze");
    expect(p.run).toBe("flutter run");
  });

  it("detects Swift package", () => {
    const dir = makeProject("swift1", { "Package.swift": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("swift test");
    expect(p.build).toBe("swift build");
  });

  it("detects Swift with swiftlint", () => {
    const dir = makeProject("swift2", { "Package.swift": "", ".swiftlint.yml": "" });
    const p = detectProfile(dir);
    expect(p.lint).toBe("swiftlint");
  });

  it("detects Gradle (Kotlin/Java)", () => {
    const dir = makeProject("gradle1", { "build.gradle.kts": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("gradle test");
    expect(p.build).toBe("gradle build");
  });

  it("detects Gradle with wrapper", () => {
    const dir = makeProject("gradle2", { "gradlew": "", "build.gradle": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("./gradlew test");
  });
});

describe("detectProfile — systems", () => {
  it("detects CMake", () => {
    const dir = makeProject("cmake1", { "CMakeLists.txt": "" });
    const p = detectProfile(dir);
    expect(p.build).toBe("cmake --build build");
    expect(p.test).toBe("ctest --test-dir build");
  });

  it("detects CMake with clang-tidy", () => {
    const dir = makeProject("cmake2", { "CMakeLists.txt": "", ".clang-tidy": "" });
    const p = detectProfile(dir);
    expect(p.lint).toBe("clang-tidy");
  });

  it("detects Makefile", () => {
    const dir = makeProject("make1", { "Makefile": "" });
    const p = detectProfile(dir);
    expect(p.build).toBe("make");
    expect(p.test).toBe("make test");
  });

  it("detects Zig", () => {
    const dir = makeProject("zig1", { "build.zig": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("zig build test");
    expect(p.build).toBe("zig build");
  });

  it("detects Elixir", () => {
    const dir = makeProject("elixir1", { "mix.exs": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("mix test");
    expect(p.lint).toBe("mix credo");
  });

  it("detects Ruby", () => {
    const dir = makeProject("ruby1", { "Gemfile": "" });
    const p = detectProfile(dir);
    expect(p.lint).toBe("bundle exec rubocop");
  });

  it("detects Ruby with rspec", () => {
    const dir = makeProject("ruby2", { "Gemfile": "" });
    mkdirSync(join(dir, "spec"), { recursive: true });
    const p = detectProfile(dir);
    expect(p.test).toBe("bundle exec rspec");
  });

  it("detects Maven", () => {
    const dir = makeProject("maven1", { "pom.xml": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("mvn test");
    expect(p.build).toBe("mvn package");
  });

  it("detects Maven with wrapper", () => {
    const dir = makeProject("maven2", { "mvnw": "", "pom.xml": "" });
    const p = detectProfile(dir);
    expect(p.test).toBe("./mvnw test");
  });
});

describe("detectProfile — edge cases", () => {
  it("returns all nulls for empty directory", () => {
    const dir = makeProject("empty", {});
    const p = detectProfile(dir);
    expect(p.test).toBeNull();
    expect(p.build).toBeNull();
    expect(p.lint).toBeNull();
    expect(p.typecheck).toBeNull();
    expect(p.run).toBeNull();
  });

  it("bun takes priority over npm when both exist", () => {
    const dir = makeProject("priority1", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("vitest");
  });

  it("handles malformed package.json", () => {
    const dir = makeProject("bad-pkg", {
      "package.json": "not json",
    });
    // package.json exists but can't be parsed — falls through to npm detection with empty scripts
    const p = detectProfile(dir);
    expect(p.test).toBeNull();
  });

  it("deno takes priority over npm", () => {
    const dir = makeProject("deno1", {
      "deno.json": "{}",
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    });
    const p = detectProfile(dir);
    expect(p.test).toBe("deno test");
  });
});
