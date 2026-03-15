// ─── LSP Server Installer — Mason Registry ───
//
// Uses Mason's registry.json (576+ packages) as the package source.
// Reads local cache if available, otherwise downloads from GitHub.
// Installs to ~/.soulforge/lsp-servers/ via bun (npm), curl+tar (github), pip, go, cargo.

import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SOULFORGE_LSP_DIR = join(homedir(), ".soulforge", "lsp-servers");

const MASON_REGISTRY_LOCAL = join(
  homedir(),
  ".local",
  "share",
  "nvim",
  "mason",
  "registries",
  "github",
  "mason-org",
  "mason-registry",
  "registry.json",
);
const MASON_REGISTRY_URL =
  "https://raw.githubusercontent.com/mason-org/mason-registry/main/registry.json";
const REGISTRY_CACHE = join(homedir(), ".soulforge", "mason-registry.json");
const MASON_BIN_DIR = join(homedir(), ".local", "share", "nvim", "mason", "bin");

// ─── Types ───

export type InstallMethod = "npm" | "pypi" | "cargo" | "golang" | "github" | "unknown";
export type PackageCategory = "LSP" | "Formatter" | "Linter" | "DAP" | "Runtime" | "Compiler";

export interface MasonPackage {
  name: string;
  description: string;
  homepage: string;
  licenses: string[];
  languages: string[];
  categories: PackageCategory[];
  source: {
    id: string; // purl: pkg:npm/name@version, pkg:github/owner/repo@tag, etc.
    extra_packages?: string[];
    asset?: Array<{
      target: string;
      file: string;
      bin?: string;
    }>;
  };
  bin?: Record<string, string>;
  deprecation?: { since: string; message: string };
}

export interface PackageStatus {
  pkg: MasonPackage;
  installMethod: InstallMethod;
  installed: boolean;
  source: "PATH" | "soulforge" | "mason" | null;
  requiresToolchain: string | null; // "cargo", "go", "pip3", null
  toolchainAvailable: boolean;
  binaries: string[];
}

// ─── Purl Parsing ───

interface ParsedPurl {
  type: string; // npm, pypi, github, cargo, golang, etc.
  namespace: string; // e.g. "@angular" for scoped npm, "owner" for github
  name: string;
  version: string;
}

function parsePurl(id: string): ParsedPurl | null {
  // pkg:npm/name@version, pkg:npm/%40scope/name@version, pkg:github/owner/repo@tag
  const match = id.match(/^pkg:(\w+)\/(.+?)@(.+)$/);
  if (!match) return null;
  const type = match[1] ?? "";
  const path = match[2] ?? "";
  const version = match[3] ?? "";
  const decoded = decodeURIComponent(path);
  const lastSlash = decoded.lastIndexOf("/");
  if (lastSlash === -1) {
    return { type, namespace: "", name: decoded, version };
  }
  return {
    type,
    namespace: decoded.slice(0, lastSlash),
    name: decoded.slice(lastSlash + 1),
    version,
  };
}

function getInstallMethod(purl: ParsedPurl): InstallMethod {
  switch (purl.type) {
    case "npm":
      return "npm";
    case "pypi":
      return "pypi";
    case "cargo":
      return "cargo";
    case "golang":
      return "golang";
    case "github":
      return "github";
    default:
      return "unknown";
  }
}

function getToolchainRequirement(method: InstallMethod): string | null {
  switch (method) {
    case "cargo":
      return "cargo";
    case "golang":
      return "go";
    case "pypi":
      return "pip3";
    default:
      return null;
  }
}

// ─── Registry Loading ───

let registryCache: MasonPackage[] | null = null;

/** Load Mason registry from local cache, Neovim's Mason, or download */
export function loadRegistry(): MasonPackage[] {
  if (registryCache) return registryCache;

  // 1. Try Neovim's local Mason registry
  if (existsSync(MASON_REGISTRY_LOCAL)) {
    try {
      const raw = readFileSync(MASON_REGISTRY_LOCAL, "utf-8");
      registryCache = JSON.parse(raw) as MasonPackage[];
      return registryCache;
    } catch {
      // Fall through
    }
  }

  // 2. Try our cached copy
  if (existsSync(REGISTRY_CACHE)) {
    try {
      const raw = readFileSync(REGISTRY_CACHE, "utf-8");
      registryCache = JSON.parse(raw) as MasonPackage[];
      return registryCache;
    } catch {
      // Fall through
    }
  }

  // 3. No registry available — return empty (download happens async)
  return [];
}

/** Download registry.json from GitHub and cache it */
export async function downloadRegistry(): Promise<MasonPackage[]> {
  mkdirSync(join(homedir(), ".soulforge"), { recursive: true });
  try {
    const resp = await fetch(MASON_REGISTRY_URL);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`);
    const text = await resp.text();
    writeFileSync(REGISTRY_CACHE, text);
    registryCache = JSON.parse(text) as MasonPackage[];
    return registryCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download Mason registry: ${msg}`);
  }
}

/** Force reload the registry from disk */
export function reloadRegistry(): void {
  registryCache = null;
  pathCache.clear();
}

// ─── Package Status ───

function getBinaries(pkg: MasonPackage): string[] {
  if (!pkg.bin) return [];
  return Object.keys(pkg.bin);
}

// Cache PATH lookups across a single status scan to avoid 576 × execSync
const pathCache = new Map<string, boolean>();

function commandOnPath(cmd: string): boolean {
  const cached = pathCache.get(cmd);
  if (cached !== undefined) return cached;
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore", timeout: 500 });
    pathCache.set(cmd, true);
    return true;
  } catch {
    pathCache.set(cmd, false);
    return false;
  }
}

function toolchainAvailable(toolchain: string | null): boolean {
  if (!toolchain) return true;
  return commandOnPath(toolchain);
}

/** Clear the PATH cache (call after install) */
export function clearPathCache(): void {
  pathCache.clear();
}

/** Check install status for a single package */
export function checkPackageStatus(pkg: MasonPackage): PackageStatus {
  const purl = parsePurl(pkg.source.id);
  const method = purl ? getInstallMethod(purl) : "unknown";
  const toolchain = getToolchainRequirement(method);
  const binaries = getBinaries(pkg);

  // Check if any binary is installed
  let installed = false;
  let source: PackageStatus["source"] = null;

  for (const bin of binaries) {
    // PATH
    if (commandOnPath(bin)) {
      installed = true;
      source = "PATH";
      break;
    }
    // SoulForge npm bin
    if (existsSync(join(SOULFORGE_LSP_DIR, "node_modules", ".bin", bin))) {
      installed = true;
      source = "soulforge";
      break;
    }
    // SoulForge direct bin
    if (existsSync(join(SOULFORGE_LSP_DIR, "bin", bin))) {
      installed = true;
      source = "soulforge";
      break;
    }
    // Mason
    if (existsSync(join(MASON_BIN_DIR, bin))) {
      installed = true;
      source = "mason";
      break;
    }
  }

  return {
    pkg,
    installMethod: method,
    installed,
    source,
    requiresToolchain: toolchain,
    toolchainAvailable: toolchainAvailable(toolchain),
    binaries,
  };
}

/** Get status for all packages, optionally filtered by category */
export function getAllPackageStatus(category?: PackageCategory): PackageStatus[] {
  const registry = loadRegistry();
  const filtered = category ? registry.filter((p) => p.categories.includes(category)) : registry;
  return filtered
    .filter((p) => !p.deprecation) // skip deprecated
    .map(checkPackageStatus);
}

// ─── Auto-detection ───

/** File patterns that suggest which languages a project uses */
const PROJECT_INDICATORS: Record<string, string[]> = {
  TypeScript: ["tsconfig.json", "*.ts", "*.tsx"],
  JavaScript: ["package.json", "*.js", "*.jsx"],
  Python: ["pyproject.toml", "setup.py", "requirements.txt", "*.py"],
  Go: ["go.mod", "*.go"],
  Rust: ["Cargo.toml", "*.rs"],
  Lua: ["*.lua", ".luacheckrc"],
  C: ["*.c", "*.h", "CMakeLists.txt", "Makefile"],
  "C++": ["*.cpp", "*.hpp", "*.cc", "CMakeLists.txt"],
  Ruby: ["Gemfile", "*.rb"],
  PHP: ["composer.json", "*.php"],
  Zig: ["build.zig", "*.zig"],
  Bash: ["*.sh", "*.bash"],
  CSS: ["*.css", "*.scss", "*.less"],
  HTML: ["*.html", "*.htm"],
  JSON: ["*.json"],
  YAML: ["*.yaml", "*.yml"],
  Dockerfile: ["Dockerfile", "docker-compose.yml"],
  Java: ["pom.xml", "build.gradle", "*.java"],
  Kotlin: ["*.kt", "build.gradle.kts"],
  Swift: ["Package.swift", "*.swift"],
  Dart: ["pubspec.yaml", "*.dart"],
};

/** Detect which languages are used in the current project */
export function detectProjectLanguages(cwd: string): string[] {
  const languages: string[] = [];
  const { readdirSync } = require("node:fs") as typeof import("node:fs");

  let files: string[];
  try {
    files = readdirSync(cwd);
  } catch {
    return [];
  }

  for (const [lang, patterns] of Object.entries(PROJECT_INDICATORS)) {
    for (const pattern of patterns) {
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1);
        if (files.some((f) => f.endsWith(ext))) {
          languages.push(lang);
          break;
        }
      } else if (files.includes(pattern)) {
        languages.push(lang);
        break;
      }
    }
  }
  return languages;
}

/** Get packages relevant to the current project */
export function getRecommendedPackages(cwd: string): PackageStatus[] {
  const langs = detectProjectLanguages(cwd);
  if (langs.length === 0) return [];

  const langSet = new Set(langs.map((l) => l.toLowerCase()));
  const registry = loadRegistry();

  return registry
    .filter((p) => {
      if (p.deprecation) return false;
      return p.languages.some((l) => langSet.has(l.toLowerCase()));
    })
    .map(checkPackageStatus);
}

// ─── Installation ───

/** Install a package to ~/.soulforge/lsp-servers/ */
export async function installPackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return { success: false, error: "Cannot parse package source" };

  mkdirSync(SOULFORGE_LSP_DIR, { recursive: true });
  const log = (msg: string) => onProgress?.(msg);

  try {
    switch (purl.type) {
      case "npm": {
        const fullName = purl.namespace
          ? `${purl.namespace}/${purl.name}@${purl.version}`
          : `${purl.name}@${purl.version}`;
        const extras = pkg.source.extra_packages ?? [];
        log(`Installing ${fullName} via bun...`);
        const bunBin = (() => {
          try {
            execSync("command -v bun", { stdio: "ignore" });
            return "bun";
          } catch {
            return process.execPath;
          }
        })();
        await runCommand(bunBin, ["add", "--cwd", SOULFORGE_LSP_DIR, fullName, ...extras], log, {
          BUN_BE_BUN: "1",
        });
        break;
      }

      case "pypi": {
        log(`Installing ${purl.name} via pip3...`);
        const binDir = join(SOULFORGE_LSP_DIR, "bin");
        const pipDir = join(SOULFORGE_LSP_DIR, "pip-packages");
        mkdirSync(binDir, { recursive: true });
        mkdirSync(pipDir, { recursive: true });
        await runCommand(
          "pip3",
          ["install", "--target", pipDir, `${purl.name}==${purl.version}`],
          log,
        );
        // Create wrapper scripts for each binary
        if (pkg.bin) {
          for (const binName of Object.keys(pkg.bin)) {
            const wrapper = join(binDir, binName);
            writeFileSync(
              wrapper,
              `#!/usr/bin/env bash\nPYTHONPATH="${pipDir}:$PYTHONPATH" exec python3 -m ${purl.name.replace(/-/g, "_")} "$@"\n`,
            );
            chmodSync(wrapper, 0o755);
          }
        }
        break;
      }

      case "golang": {
        log(`Installing ${purl.namespace}/${purl.name} via go install...`);
        const binDir = join(SOULFORGE_LSP_DIR, "bin");
        mkdirSync(binDir, { recursive: true });
        const fullPkg = `${purl.namespace}/${purl.name}@${purl.version}`;
        await runCommand("go", ["install", fullPkg], log, { GOBIN: binDir });
        break;
      }

      case "cargo": {
        log(`Installing ${purl.name} via cargo...`);
        mkdirSync(join(SOULFORGE_LSP_DIR, "bin"), { recursive: true });
        await runCommand(
          "cargo",
          ["install", purl.name, "--version", purl.version, "--root", SOULFORGE_LSP_DIR],
          log,
        );
        break;
      }

      case "github": {
        log(`Downloading ${purl.namespace}/${purl.name} from GitHub...`);
        const binDir = join(SOULFORGE_LSP_DIR, "bin");
        mkdirSync(binDir, { recursive: true });

        // Find the right asset for this platform
        const asset = findPlatformAsset(pkg);
        if (!asset) {
          return {
            success: false,
            error: `No pre-built binary for ${process.platform}/${process.arch}`,
          };
        }

        const version = purl.version;
        const fileUrl = `https://github.com/${purl.namespace}/${purl.name}/releases/download/${version}/${resolveAssetTemplate(asset.file, version)}`;
        const tmpDir = join(SOULFORGE_LSP_DIR, ".tmp");
        mkdirSync(tmpDir, { recursive: true });

        log(`Downloading ${fileUrl}...`);
        await runCommand("curl", ["-fSL", "-o", join(tmpDir, "download"), fileUrl], log);

        // Extract based on file extension
        const fname = asset.file.toLowerCase();
        if (fname.endsWith(".tar.gz") || fname.endsWith(".tgz")) {
          await runCommand("tar", ["-xzf", join(tmpDir, "download"), "-C", tmpDir], log);
        } else if (fname.endsWith(".zip")) {
          await runCommand("unzip", ["-o", join(tmpDir, "download"), "-d", tmpDir], log);
        }

        // Copy binaries
        if (pkg.bin) {
          for (const [binName, binPath] of Object.entries(pkg.bin)) {
            const resolvedBin = binPath.includes("{{") ? (asset.bin ?? binName) : binPath;
            // Try to find the binary in the extracted files
            const candidates = [
              join(tmpDir, resolvedBin),
              join(tmpDir, binName),
              join(tmpDir, purl.name, resolvedBin),
              join(tmpDir, purl.name, binName),
            ];
            for (const candidate of candidates) {
              if (existsSync(candidate)) {
                const { copyFileSync } = await import("node:fs");
                const dest = join(binDir, binName);
                copyFileSync(candidate, dest);
                chmodSync(dest, 0o755);
                break;
              }
            }
          }
        }

        // Clean up
        const { rmSync } = await import("node:fs");
        rmSync(tmpDir, { recursive: true, force: true });
        break;
      }

      default:
        return { success: false, error: `Unsupported install method: ${purl.type}` };
    }

    log(`✓ ${pkg.name} installed`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Uninstallation ───

/** Uninstall a package installed by SoulForge */
export async function uninstallPackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return { success: false, error: "Cannot parse package source" };

  const log = (msg: string) => onProgress?.(msg);
  const binaries = getBinaries(pkg);

  try {
    switch (purl.type) {
      case "npm": {
        const fullName = purl.namespace ? `${purl.namespace}/${purl.name}` : purl.name;
        log(`Removing ${fullName} via bun...`);
        const { execSync: exec } = await import("node:child_process");
        try {
          exec(`bun remove --cwd ${SOULFORGE_LSP_DIR} ${fullName}`, { stdio: "pipe" });
        } catch {
          // If bun remove fails, manually remove the binaries
          const { unlinkSync } = await import("node:fs");
          for (const bin of binaries) {
            const binPath = join(SOULFORGE_LSP_DIR, "node_modules", ".bin", bin);
            try {
              unlinkSync(binPath);
            } catch {}
          }
        }
        break;
      }

      case "pypi": {
        log(`Removing ${purl.name}...`);
        const { rmSync, unlinkSync } = await import("node:fs");
        // Remove pip packages
        const pipDir = join(SOULFORGE_LSP_DIR, "pip-packages");
        const pkgDir = join(pipDir, purl.name.replace(/-/g, "_"));
        try {
          rmSync(pkgDir, { recursive: true, force: true });
        } catch {}
        // Remove wrapper scripts
        for (const bin of binaries) {
          try {
            unlinkSync(join(SOULFORGE_LSP_DIR, "bin", bin));
          } catch {}
        }
        break;
      }

      case "golang":
      case "cargo": {
        log(`Removing ${purl.name} binaries...`);
        const { unlinkSync } = await import("node:fs");
        for (const bin of binaries) {
          try {
            unlinkSync(join(SOULFORGE_LSP_DIR, "bin", bin));
          } catch {}
        }
        break;
      }

      case "github": {
        log(`Removing ${purl.name} binaries...`);
        const { unlinkSync } = await import("node:fs");
        for (const bin of binaries) {
          try {
            unlinkSync(join(SOULFORGE_LSP_DIR, "bin", bin));
          } catch {}
        }
        break;
      }

      default:
        return { success: false, error: `Unsupported install method: ${purl.type}` };
    }

    log(`✓ ${pkg.name} uninstalled`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── GitHub Release Helpers ───

function getMasonTarget(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}_${arch}`;
}

function findPlatformAsset(
  pkg: MasonPackage,
): { target: string; file: string; bin?: string } | null {
  if (!pkg.source.asset) return null;
  const target = getMasonTarget();

  // Try exact match first
  let match = pkg.source.asset.find((a) => a.target === target);
  if (match) return match;

  // Try with _gnu suffix (common for linux)
  match = pkg.source.asset.find((a) => a.target === `${target}_gnu`);
  if (match) return match;

  // Try without _gnu for darwin
  if (target.startsWith("darwin")) {
    match = pkg.source.asset.find(
      (a) =>
        a.target.startsWith("darwin") &&
        a.target.includes(process.arch === "arm64" ? "arm64" : "x64"),
    );
    if (match) return match;
  }

  return null;
}

function resolveAssetTemplate(template: string, version: string): string {
  return template
    .replace(/\{\{\s*version\s*\}\}/g, version)
    .replace(/\{\{\s*version\s*\|\s*strip_prefix\s*"v"\s*\}\}/g, version.replace(/^v/, ""));
}

// ─── Command Runner ───

function runCommand(
  cmd: string,
  args: string[],
  log: (msg: string) => void,
  extraEnv?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });

    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${cmd} exited with code ${String(code)}: ${stderr.slice(0, 500).trim()}`),
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run ${cmd}: ${err.message}`));
    });
  });
}
