import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../../types/index.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

type ProjectAction = "test" | "build" | "lint" | "typecheck" | "run";

interface ProjectArgs {
  action: ProjectAction;
  file?: string;
  fix?: boolean;
  script?: string;
  flags?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

interface ProjectProfile {
  test: string | null;
  build: string | null;
  lint: string | null;
  typecheck: string | null;
  run: string | null;
}

function detectProfile(cwd: string): ProjectProfile {
  const profile: ProjectProfile = {
    test: null,
    build: null,
    lint: null,
    typecheck: null,
    run: null,
  };

  const has = (f: string) => existsSync(join(cwd, f));
  const hasExt = (ext: string) => {
    try {
      return readdirSync(cwd).some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  };
  const scripts = readPackageScripts(cwd);

  // JS/TS — Bun
  if (has("bun.lock") || has("bun.lockb")) {
    profile.test = scripts.test ?? "bun test";
    profile.build = scripts.build ? `bun run build` : null;
    profile.lint = scripts.lint ? "bun run lint" : detectJsLinter(cwd);
    profile.typecheck = has("tsconfig.json")
      ? scripts.typecheck
        ? "bun run typecheck"
        : "bunx tsc --noEmit"
      : null;
    profile.run = scripts.dev ? "bun run dev" : scripts.start ? "bun run start" : null;
    return profile;
  }

  // JS/TS — Deno
  if (has("deno.json") || has("deno.lock")) {
    profile.test = "deno test";
    profile.build = null;
    profile.lint = "deno lint";
    profile.typecheck = "deno check .";
    profile.run = scripts.dev ? "deno task dev" : "deno run main.ts";
    return profile;
  }

  // JS/TS — pnpm/yarn/npm
  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const run = pm === "npm" ? "npm run" : pm;
    profile.test = scripts.test ? `${run} test` : null;
    profile.build = scripts.build ? `${run} build` : null;
    profile.lint = scripts.lint ? `${run} lint` : detectJsLinter(cwd);
    profile.typecheck = has("tsconfig.json")
      ? scripts.typecheck
        ? `${run} typecheck`
        : "npx tsc --noEmit"
      : null;
    profile.run = scripts.dev ? `${run} dev` : scripts.start ? `${run} start` : null;
    return profile;
  }

  // Rust
  if (has("Cargo.toml")) {
    profile.test = "cargo test";
    profile.build = "cargo build";
    profile.lint = "cargo clippy";
    profile.typecheck = "cargo check";
    profile.run = "cargo run";
    return profile;
  }

  // Go
  if (has("go.mod")) {
    profile.test = "go test ./...";
    profile.build = "go build ./...";
    profile.lint =
      has(".golangci.yml") || has(".golangci.yaml") ? "golangci-lint run" : "go vet ./...";
    profile.typecheck = "go build ./...";
    profile.run = "go run .";
    return profile;
  }

  // Python
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const pm = has("uv.lock")
      ? "uv run"
      : has("poetry.lock")
        ? "poetry run"
        : has("Pipfile.lock")
          ? "pipenv run"
          : "";
    const prefix = pm ? `${pm} ` : "";
    profile.test = `${prefix}pytest`;
    profile.build = null;
    profile.lint =
      has("ruff.toml") || has(".ruff.toml") ? `${prefix}ruff check` : `${prefix}flake8`;
    profile.typecheck = `${prefix}mypy .`;
    // Framework-specific run commands
    if (has("manage.py")) profile.run = `${prefix}python manage.py runserver`;
    else if (has("app.py") || has("main.py")) profile.run = `${prefix}uvicorn main:app --reload`;
    return profile;
  }

  // .NET / C#
  if (has("global.json") || hasExt(".csproj") || hasExt(".sln")) {
    profile.test = "dotnet test";
    profile.build = "dotnet build";
    profile.lint = null;
    profile.typecheck = "dotnet build";
    profile.run = "dotnet run";
    return profile;
  }

  // Swift
  if (has("Package.swift")) {
    profile.test = "swift test";
    profile.build = "swift build";
    profile.lint = has(".swiftlint.yml") ? "swiftlint" : null;
    profile.typecheck = "swift build";
    profile.run = "swift run";
    return profile;
  }

  // iOS / Xcode
  if (hasExt(".xcodeproj") || hasExt(".xcworkspace")) {
    profile.test =
      "xcodebuild test -scheme \"$(xcodebuild -list -json 2>/dev/null | python3 -c \"import json,sys;print(json.load(sys.stdin)['project']['schemes'][0])\")\" -destination 'platform=iOS Simulator,name=iPhone 16'";
    profile.build = "xcodebuild build";
    profile.lint = has(".swiftlint.yml") ? "swiftlint" : null;
    profile.typecheck = "xcodebuild build";
    profile.run = null;
    return profile;
  }

  // Flutter / Dart
  if (has("pubspec.yaml")) {
    profile.test = "flutter test";
    profile.build = "flutter build";
    profile.lint = "dart analyze";
    profile.typecheck = "dart analyze";
    profile.run = "flutter run";
    return profile;
  }

  // Elixir
  if (has("mix.exs")) {
    profile.test = "mix test";
    profile.build = "mix compile";
    profile.lint = "mix credo";
    profile.typecheck = "mix dialyzer";
    profile.run = "mix phx.server";
    return profile;
  }

  // Ruby
  if (has("Gemfile")) {
    profile.test = has("spec") ? "bundle exec rspec" : "bundle exec rails test";
    profile.build = null;
    profile.lint = "bundle exec rubocop";
    profile.typecheck = null;
    profile.run = has("config.ru") ? "bundle exec rails server" : null;
    return profile;
  }

  // Java/Kotlin — Gradle
  if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
    const gw = has("gradlew") ? "./gradlew" : "gradle";
    profile.test = `${gw} test`;
    profile.build = `${gw} build`;
    profile.lint = `${gw} check`;
    profile.typecheck = `${gw} compileJava`;
    profile.run = `${gw} run`;
    return profile;
  }

  // Java — Maven
  if (has("pom.xml") || has("mvnw")) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    profile.test = `${mvn} test`;
    profile.build = `${mvn} package`;
    profile.lint = `${mvn} checkstyle:check`;
    profile.typecheck = `${mvn} compile`;
    profile.run = `${mvn} exec:java`;
    return profile;
  }

  // C/C++ — CMake
  if (has("CMakeLists.txt")) {
    profile.test = "ctest --test-dir build";
    profile.build = "cmake --build build";
    profile.lint = has(".clang-tidy") ? "clang-tidy" : null;
    profile.typecheck = "cmake --build build";
    profile.run = null;
    return profile;
  }

  // C/C++ — Make
  if (has("Makefile")) {
    profile.test = "make test";
    profile.build = "make";
    profile.lint = null;
    profile.typecheck = null;
    profile.run = "make run";
    return profile;
  }

  // Zig
  if (has("build.zig") || has("build.zig.zon")) {
    profile.test = "zig build test";
    profile.build = "zig build";
    profile.lint = null;
    profile.typecheck = "zig build";
    profile.run = "zig build run";
    return profile;
  }

  // Haskell
  if (has("stack.yaml")) {
    profile.test = "stack test";
    profile.build = "stack build";
    profile.lint = "hlint .";
    profile.typecheck = "stack build";
    profile.run = "stack run";
    return profile;
  }

  // Scala
  if (has("build.sbt")) {
    profile.test = "sbt test";
    profile.build = "sbt compile";
    profile.lint = null;
    profile.typecheck = "sbt compile";
    profile.run = "sbt run";
    return profile;
  }

  // Clojure
  if (has("deps.edn") || has("project.clj")) {
    const tool = has("project.clj") ? "lein" : "clj";
    profile.test = tool === "lein" ? "lein test" : "clj -M:test";
    profile.build = tool === "lein" ? "lein uberjar" : null;
    profile.lint = "clj-kondo --lint src";
    profile.typecheck = null;
    profile.run = tool === "lein" ? "lein run" : "clj -M -m core";
    return profile;
  }

  return profile;
}

function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function detectJsLinter(cwd: string): string | null {
  const has = (f: string) => existsSync(join(cwd, f));
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
}

export const projectTool = {
  name: "project",
  description:
    "Run project commands with auto-detected toolchain. " +
    "Knows the correct test runner, build system, linter, and type checker for any project. " +
    "Use this instead of shell for test/build/lint/typecheck — it always picks the right command.",
  execute: async (args: ProjectArgs): Promise<ToolResult> => {
    const cwd = args.cwd ? join(process.cwd(), args.cwd) : process.cwd();
    const profile = detectProfile(cwd);

    let command: string | null = null;

    switch (args.action) {
      case "test": {
        command = profile.test;
        if (command && args.file) {
          command = `${command} ${shellQuote(args.file)}`;
        }
        break;
      }
      case "build":
        command = profile.build;
        break;
      case "lint": {
        command = profile.lint;
        if (command && args.fix) {
          if (command.includes("biome")) command += " --write";
          else if (command.includes("eslint")) command += " --fix";
          else if (command.includes("ruff")) command = command.replace("check", "check --fix");
          else if (command.includes("clippy")) command += " --fix";
          else if (command.includes("rubocop")) command += " -a";
        }
        if (command && args.file) {
          command = `${command} ${shellQuote(args.file)}`;
        }
        break;
      }
      case "typecheck":
        command = profile.typecheck;
        break;
      case "run":
        command = args.script ? resolveRunScript(profile, args.script, cwd) : profile.run;
        break;
    }

    if (command && args.flags) {
      command = `${command} ${shellQuote(args.flags)}`;
    }

    if (!command) {
      return {
        success: false,
        output: `No ${args.action} command detected for this project. Use shell to run manually.`,
        error: "no command",
      };
    }

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...args.env },
      });

      const timeoutMs = args.timeout ?? 120_000;
      const timer = setTimeout(() => proc.kill(), timeoutMs);

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      if (exitCode === null) {
        return {
          success: false,
          output: `${args.action} timed out after ${String(timeoutMs / 1000)}s`,
          error: "timeout",
        };
      }

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const MAX_OUTPUT = 10_000;
      let truncated: string;
      if (output.length <= MAX_OUTPUT) {
        truncated = output;
      } else {
        const HEAD = 3000;
        const TAIL = 5000;
        truncated = `${output.slice(0, HEAD)}\n\n... (${String(output.length - HEAD - TAIL)} chars truncated) ...\n\n${output.slice(-TAIL)}`;
      }

      if (exitCode === 0) {
        return {
          success: true,
          output: `${args.action} passed.\n${truncated}`,
        };
      }
      return {
        success: false,
        output: `${args.action} failed (exit ${String(exitCode)}).\n${truncated}`,
        error: `exit ${String(exitCode)}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};

function resolveRunScript(profile: ProjectProfile, script: string, cwd: string): string | null {
  const scripts = readPackageScripts(cwd);
  if (scripts[script]) {
    const has = (f: string) => existsSync(join(cwd, f));
    if (has("bun.lock") || has("bun.lockb")) return `bun run ${script}`;
    if (has("pnpm-lock.yaml")) return `pnpm ${script}`;
    if (has("yarn.lock")) return `yarn ${script}`;
    return `npm run ${script}`;
  }
  return profile.run;
}
