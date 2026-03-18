import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { truncateWithTee } from "./tee.js";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

type ProjectAction = "test" | "build" | "lint" | "typecheck" | "run" | "list";

interface ProjectArgs {
  action: ProjectAction;
  file?: string;
  fix?: boolean;
  script?: string;
  flags?: string;
  raw?: boolean;
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

export function detectProfile(cwd: string): ProjectProfile {
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
    profile.typecheck = has("pyrightconfig.json") ? `${prefix}pyright` : `${prefix}mypy .`;
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

  // PHP
  if (has("composer.json")) {
    profile.test = "vendor/bin/phpunit";
    profile.build = null;
    profile.lint =
      has("phpstan.neon") || has("phpstan.neon.dist")
        ? "vendor/bin/phpstan analyse"
        : has("psalm.xml") || has("psalm.xml.dist")
          ? "vendor/bin/psalm"
          : null;
    profile.typecheck = profile.lint;
    profile.run = has("artisan") ? "php artisan serve" : null;
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
  if (has("biome.json") || has("biome.jsonc")) return "biome check .";
  if (has("oxlintrc.json") || has(".oxlintrc.json")) return "oxlint .";
  if (
    has("eslint.config.js") ||
    has("eslint.config.mjs") ||
    has("eslint.config.ts") ||
    has(".eslintrc") ||
    has(".eslintrc.js") ||
    has(".eslintrc.json") ||
    has(".eslintrc.yml")
  )
    return "eslint .";
  return null;
}

function detectJsTypecheck(cwd: string): string | null {
  const has = (f: string) => existsSync(join(cwd, f));
  if (!has("tsconfig.json")) return null;
  if (has("bun.lock") || has("bun.lockb")) return "bunx tsc --noEmit";
  if (has("deno.json") || has("deno.lock")) return "deno check .";
  if (has("pnpm-lock.yaml")) return "pnpm tsc --noEmit";
  return "npx tsc --noEmit";
}

/**
 * Detect the native lint + typecheck commands from config files, bypassing package.json scripts.
 * Used by pre-commit checks to run the actual tool, not arbitrary user scripts.
 * Returns commands joined with &&.
 */
export function detectNativeChecks(cwd: string): string | null {
  const has = (f: string) => existsSync(join(cwd, f));
  const cmds: string[] = [];

  // JS/TS
  const jsLint = detectJsLinter(cwd);
  if (jsLint) cmds.push(jsLint);
  const jsTc = detectJsTypecheck(cwd);
  if (jsTc) cmds.push(jsTc);
  if (cmds.length > 0) return cmds.join(" && ");

  // Deno
  if (has("deno.json") || has("deno.lock")) return "deno lint && deno check .";

  // Rust
  if (has("Cargo.toml")) return "cargo clippy && cargo check";

  // Go
  if (has("go.mod")) {
    const lint =
      has(".golangci.yml") || has(".golangci.yaml") ? "golangci-lint run" : "go vet ./...";
    return `${lint} && go build ./...`;
  }

  // Python
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const pm = has("uv.lock")
      ? "uv run "
      : has("poetry.lock")
        ? "poetry run "
        : has("Pipfile.lock")
          ? "pipenv run "
          : "";
    const lint = has("ruff.toml") || has(".ruff.toml") ? `${pm}ruff check` : `${pm}flake8`;
    const tc = has("pyrightconfig.json") ? `${pm}pyright` : `${pm}mypy .`;
    return `${lint} && ${tc}`;
  }

  // PHP
  if (has("composer.json")) {
    if (has("phpstan.neon") || has("phpstan.neon.dist")) return "vendor/bin/phpstan analyse";
    if (has("psalm.xml") || has("psalm.xml.dist")) return "vendor/bin/psalm";
    return null;
  }

  // Swift
  if (has("Package.swift") && has(".swiftlint.yml")) return "swiftlint";

  // Ruby
  if (has("Gemfile") && has(".rubocop.yml")) return "bundle exec rubocop";

  return null;
}

// ─── Monorepo Package Discovery ───

interface PackageInfo {
  name: string;
  path: string;
  toolchain: string | null;
  hasLint: boolean;
  hasTest: boolean;
  hasTypecheck: boolean;
}

function discoverPackages(cwd: string): PackageInfo[] {
  const has = (f: string) => existsSync(join(cwd, f));
  const packages: PackageInfo[] = [];

  // JS/TS workspaces (pnpm, yarn, npm)
  const workspaceGlobs = getJsWorkspaceGlobs(cwd, has);
  if (workspaceGlobs.length > 0) {
    for (const glob of workspaceGlobs) {
      const base = glob.replace(/\/?\*.*$/, "");
      if (!base) continue;
      scanDir(join(cwd, base), cwd, packages, "package.json");
    }
  }

  // Cargo workspaces
  if (has("Cargo.toml")) {
    try {
      const cargo = readFileSync(join(cwd, "Cargo.toml"), "utf-8");
      const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
      if (membersMatch?.[1]) {
        const members =
          membersMatch[1].match(/["']([^"']+)["']/g)?.map((m) => m.replace(/["']/g, "")) ?? [];
        for (const member of members) {
          if (member.includes("*")) {
            scanDir(join(cwd, member.replace(/\/?\*$/, "")), cwd, packages, "Cargo.toml");
          } else if (existsSync(join(cwd, member, "Cargo.toml"))) {
            addPackage(packages, join(cwd, member), cwd);
          }
        }
      }
    } catch {}
  }

  // Go workspaces
  if (has("go.work")) {
    try {
      const goWork = readFileSync(join(cwd, "go.work"), "utf-8");
      const useMatch = goWork.match(/use\s*\(([\s\S]*?)\)/);
      const dirs = useMatch?.[1]
        ? (useMatch[1].match(/^\s*(\S+)/gm)?.map((d) => d.trim()) ?? [])
        : (goWork.match(/^use\s+(\S+)/gm)?.map((d) => d.replace(/^use\s+/, "").trim()) ?? []);
      for (const dir of dirs) {
        if (existsSync(join(cwd, dir, "go.mod"))) {
          addPackage(packages, join(cwd, dir), cwd);
        }
      }
    } catch {}
  }

  return packages;
}

function getJsWorkspaceGlobs(cwd: string, has: (f: string) => boolean): string[] {
  if (has("pnpm-workspace.yaml")) {
    try {
      const raw = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf-8");
      const quoted = raw.match(/['"]([^'"]+)['"]/g)?.map((g) => g.replace(/['"]/g, "")) ?? [];
      if (quoted.length > 0) return quoted;
      const simple = raw.match(/^\s*-\s+(.+)$/gm);
      return simple?.map((line) => line.replace(/^\s*-\s+/, "").trim()).filter(Boolean) ?? [];
    } catch {}
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
      const w = pkg.workspaces;
      return Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : [];
    } catch {}
  }
  return [];
}

function scanDir(dir: string, rootCwd: string, packages: PackageInfo[], marker: string): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(dir, entry.name);
      if (existsSync(join(pkgDir, marker))) addPackage(packages, pkgDir, rootCwd);
    }
  } catch {}
}

function addPackage(packages: PackageInfo[], pkgDir: string, rootCwd: string): void {
  const rel = pkgDir.replace(rootCwd, "").replace(/^\//, "");
  const profile = detectProfile(pkgDir);
  let name = rel;
  try {
    if (existsSync(join(pkgDir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
      if (pkg.name) name = pkg.name;
    } else if (existsSync(join(pkgDir, "Cargo.toml"))) {
      const cargo = readFileSync(join(pkgDir, "Cargo.toml"), "utf-8");
      const nameMatch = cargo.match(/name\s*=\s*["']([^"']+)["']/);
      if (nameMatch?.[1]) name = nameMatch[1];
    }
  } catch {}

  packages.push({
    name,
    path: rel,
    toolchain: profile.lint?.split(/\s/)[0] ?? profile.test?.split(/\s/)[0] ?? null,
    hasLint: !!profile.lint,
    hasTest: !!profile.test,
    hasTypecheck: !!profile.typecheck,
  });
}

function formatPackageList(packages: PackageInfo[]): string {
  if (packages.length === 0) return "No workspace packages found. This may not be a monorepo.";
  const lines = packages.map((p) => {
    const caps = [
      p.hasLint ? "lint" : null,
      p.hasTypecheck ? "typecheck" : null,
      p.hasTest ? "test" : null,
    ]
      .filter(Boolean)
      .join(", ");
    const toolLabel = p.toolchain ? ` (${p.toolchain})` : "";
    return `  ${p.name} — ${p.path}${toolLabel}${caps ? ` [${caps}]` : ""}`;
  });
  return `${String(packages.length)} packages:\n${lines.join("\n")}\n\nUse project(action: "lint", cwd: "<path>") to target a specific package.`;
}

export const projectTool = {
  name: "project",
  description:
    "Run project commands (test, build, lint, typecheck, list) with auto-detected toolchain.",
  execute: async (args: ProjectArgs): Promise<ToolResult> => {
    const cwd = args.cwd ? join(process.cwd(), args.cwd) : process.cwd();

    if (args.action === "list") {
      const packages = discoverPackages(cwd);
      return { success: true, output: formatPackageList(packages) };
    }

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
        if (command && args.fix && !args.raw) {
          if (command.includes("biome")) command += " --write";
          else if (command.includes("eslint")) command += " --fix";
          else if (command.includes("oxlint")) command += " --fix";
          else if (command.includes("ruff")) command = command.replace("check", "check --fix");
          else if (command.includes("clippy")) command += " --fix --allow-dirty";
          else if (command.includes("rubocop")) command += " -a";
          else if (command.includes("gofmt") || command.includes("goimports"))
            command = command.replace(/gofmt/, "gofmt -w").replace(/goimports/, "goimports -w");
          else if (command.includes("dart")) command = command.replace("analyze", "fix --apply");
          else if (command.includes("swiftlint")) command += " --fix";
          else if (command.includes("hlint"))
            command += ' --refactor --refactor-options="--inplace"';
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

    // Legacy fallback: if fix command fails with unknown-flag error, retry with older syntax
    const LEGACY_FIX: Record<string, string> = {
      "--write": "--apply",
      "--fix --allow-dirty": "--fix --allow-dirty --allow-staged",
      " --fix": " autocorrect",
    };

    const runCommand = async (cmd: string) => {
      const proc = Bun.spawn(["sh", "-c", cmd], {
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
      return { stdout, stderr, exitCode };
    };

    try {
      let { stdout, stderr, exitCode } = await runCommand(command);

      // Retry with legacy flag if the tool didn't recognize the modern flag
      if (exitCode !== 0 && args.fix) {
        const combined = [stdout, stderr].join("\n").toLowerCase();
        const isUnknownFlag =
          combined.includes("unknown") ||
          combined.includes("unrecognized") ||
          combined.includes("unexpected argument") ||
          combined.includes("invalid option");
        if (isUnknownFlag) {
          for (const [modern, legacy] of Object.entries(LEGACY_FIX)) {
            if (command.includes(modern)) {
              const fallback = command.replace(modern, legacy);
              const retry = await runCommand(fallback);
              stdout = retry.stdout;
              stderr = retry.stderr;
              exitCode = retry.exitCode;
              command = fallback;
              break;
            }
          }
        }
      }

      if (exitCode === null) {
        return {
          success: false,
          output: `${args.action} timed out after ${String((args.timeout ?? 120_000) / 1000)}s`,
          error: "timeout",
        };
      }

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const MAX_OUTPUT = 10_000;
      const { text: truncated } = truncateWithTee(output, MAX_OUTPUT, 3000, 5000, args.action);

      const cmdLabel = `[${args.action}] ${command}`;
      if (exitCode === 0) {
        const warningMatch = output.match(/Found (\d+) warning/);
        const errorMatch = output.match(/Found (\d+) error/);
        const warnCount = warningMatch ? Number(warningMatch[1]) : 0;
        const errCount = errorMatch ? Number(errorMatch[1]) : 0;
        if (warnCount > 0 || errCount > 0) {
          const issues = [
            errCount > 0 ? `${String(errCount)} errors` : "",
            warnCount > 0 ? `${String(warnCount)} warnings` : "",
          ]
            .filter(Boolean)
            .join(", ");
          return {
            success: false,
            output: `${cmdLabel} — has ${issues}. Fix them or run with fix: true to auto-fix.\n${truncated}`,
            error: issues,
          };
        }
        return {
          success: true,
          output: `${cmdLabel} — passed.\n${truncated}`,
        };
      }
      const flagHint =
        args.fix && !args.raw
          ? " If the fix flags are wrong for your tool version, retry with raw: true and provide your own flags."
          : "";
      return {
        success: false,
        output: `${cmdLabel} — failed (exit ${String(exitCode)}).${flagHint}\n${truncated}`,
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
