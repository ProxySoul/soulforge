//
// Uses Mason's registry.json (576+ packages) as the package source.
// Reads local cache if available, otherwise downloads from GitHub.
// Installs to ~/.soulforge/lsp-servers/ via bun (npm), curl+tar (github), pip, go, cargo.

import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOULFORGE_LSP_DIR = join(homedir(), ".soulforge", "lsp-servers");
const VERSIONS_FILE = join(homedir(), ".soulforge", "lsp-versions.json");

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
const MASON_REGISTRY_RELEASE_URL =
  "https://api.github.com/repos/mason-org/mason-registry/releases/latest";
const REGISTRY_CACHE = join(homedir(), ".soulforge", "mason-registry.json");
const MASON_BIN_DIR = join(homedir(), ".local", "share", "soulforge", "mason", "bin");

type InstallMethod = "npm" | "pypi" | "cargo" | "golang" | "github" | "unknown";
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
  installedVersion: string | null;
  registryVersion: string | null;
  hasUpdate: boolean;
}

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

/** Compare versions: returns true if `a` is newer than `b`. Strips leading 'v', compares numeric segments. */
function isNewerVersion(a: string, b: string): boolean {
  const normalize = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false; // equal
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

/** Download registry.json from GitHub releases (zipped since 2025) and cache it */
export async function downloadRegistry(): Promise<MasonPackage[]> {
  mkdirSync(join(homedir(), ".soulforge"), { recursive: true });
  try {
    const releaseResp = await fetch(MASON_REGISTRY_RELEASE_URL, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "SoulForge" },
    });
    if (!releaseResp.ok) throw new Error(`GitHub API HTTP ${String(releaseResp.status)}`);
    const release = (await releaseResp.json()) as {
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const asset = release.assets?.find((a) => a.name === "registry.json.zip");
    if (!asset) throw new Error("registry.json.zip not found in latest release");

    const zipResp = await fetch(asset.browser_download_url);
    if (!zipResp.ok) throw new Error(`Download HTTP ${String(zipResp.status)}`);
    const zipBuf = await zipResp.arrayBuffer();

    const tmpZip = join(homedir(), ".soulforge", "mason-registry.zip");
    writeFileSync(tmpZip, Buffer.from(zipBuf));

    const { execSync } = await import("node:child_process");
    execSync(`unzip -qo "${tmpZip}" registry.json -d "${join(homedir(), ".soulforge")}"`, {
      stdio: "ignore",
      timeout: 10_000,
    });
    unlinkSync(tmpZip);

    const jsonPath = join(homedir(), ".soulforge", "registry.json");
    const text = readFileSync(jsonPath, "utf-8");
    writeFileSync(REGISTRY_CACHE, text);
    unlinkSync(jsonPath);

    registryCache = JSON.parse(text) as MasonPackage[];
    return registryCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download Mason registry: ${msg}`);
  }
}

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

// ── Version tracking ──────────────────────────────────────────────────

type VersionMap = Record<string, { version: string; installedAt: string }>;

let versionCache: VersionMap | null = null;

function loadVersions(): VersionMap {
  if (versionCache) return versionCache;
  try {
    if (existsSync(VERSIONS_FILE)) {
      versionCache = JSON.parse(readFileSync(VERSIONS_FILE, "utf-8")) as VersionMap;
      return versionCache;
    }
  } catch {}
  return {};
}

function saveVersions(map: VersionMap): void {
  versionCache = map;
  try {
    mkdirSync(join(homedir(), ".soulforge"), { recursive: true });
    writeFileSync(VERSIONS_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch {}
}

function recordInstalledVersion(pkg: MasonPackage): void {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return;
  const map = loadVersions();
  map[pkg.name] = { version: purl.version, installedAt: new Date().toISOString() };
  saveVersions(map);
}

function removeInstalledVersion(pkg: MasonPackage): void {
  const map = loadVersions();
  delete map[pkg.name];
  saveVersions(map);
}

/** Get the version we recorded at install time (null if unknown) */
export function getInstalledVersion(pkgName: string): string | null {
  return loadVersions()[pkgName]?.version ?? null;
}

/** Get packages that have a newer version in the registry */
export function getUpdatablePackages(): PackageStatus[] {
  const all = getAllPackageStatus();
  return all.filter((s) => s.hasUpdate);
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

  const registryVersion = purl?.version ?? null;
  const installedVersion = installed ? getInstalledVersion(pkg.name) : null;
  const hasUpdate =
    installed &&
    installedVersion !== null &&
    registryVersion !== null &&
    isNewerVersion(registryVersion, installedVersion);

  return {
    pkg,
    installMethod: method,
    installed,
    source,
    requiresToolchain: toolchain,
    toolchainAvailable: toolchainAvailable(toolchain),
    binaries,
    installedVersion,
    registryVersion,
    hasUpdate,
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
function detectProjectLanguages(cwd: string): string[] {
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
            const sfBin = join(homedir(), ".soulforge", "bin", "bun");
            if (existsSync(sfBin)) return sfBin;
            return "bun";
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
    recordInstalledVersion(pkg);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

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
    removeInstalledVersion(pkg);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/** Update a package: uninstall then reinstall at the registry version */
export async function updatePackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const status = checkPackageStatus(pkg);
  if (!status.installed) {
    return installPackage(pkg, onProgress);
  }
  const log = (msg: string) => onProgress?.(msg);
  const old = status.installedVersion ?? "unknown";
  const next = status.registryVersion ?? "latest";
  log(`Updating ${pkg.name} ${old} → ${next}...`);

  // Only uninstall soulforge-managed packages; PATH/mason ones just get overwritten
  if (status.source === "soulforge") {
    const rm = await uninstallPackage(pkg, onProgress);
    if (!rm.success) return rm;
  }
  return installPackage(pkg, onProgress);
}

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
