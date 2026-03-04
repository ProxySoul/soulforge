import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const SOULFORGE_DIR = join(homedir(), ".soulforge");
const BIN_DIR = join(SOULFORGE_DIR, "bin");
const INSTALLS_DIR = join(SOULFORGE_DIR, "installs");
const FONTS_DIR = join(SOULFORGE_DIR, "fonts");

const NVIM_VERSION = "0.11.1";
const RG_VERSION = "14.1.1";
const PROXY_VERSION = "6.8.40";

// ─── Nerd Fonts ───

export interface NerdFont {
  id: string;
  name: string;
  /** Name as it appears in font selectors */
  family: string;
  /** Nerd Fonts release asset name (without .tar.xz) */
  asset: string;
  /** Prefix used in font filenames, e.g. "FiraCodeNerdFont" */
  filePrefix: string;
  description: string;
}

export const NERD_FONTS: NerdFont[] = [
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    family: "JetBrainsMono Nerd Font",
    asset: "JetBrainsMono",
    filePrefix: "JetBrainsMonoNerdFont",
    description: "Excellent ligatures, crisp at all sizes",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    family: "FiraCode Nerd Font",
    asset: "FiraCode",
    filePrefix: "FiraCodeNerdFont",
    description: "Popular ligature font, wide language support",
  },
  {
    id: "cascadia-code",
    name: "Cascadia Code",
    family: "CaskaydiaCove Nerd Font",
    asset: "CascadiaCode",
    filePrefix: "CaskaydiaCoveNerdFont",
    description: "Microsoft's terminal font, cursive italics",
  },
  {
    id: "iosevka",
    name: "Iosevka",
    family: "Iosevka Nerd Font",
    asset: "Iosevka",
    filePrefix: "IosevkaNerdFont",
    description: "Narrow and compact, fits more on screen",
  },
  {
    id: "hack",
    name: "Hack",
    family: "Hack Nerd Font",
    asset: "Hack",
    filePrefix: "HackNerdFont",
    description: "Classic monospace, very readable",
  },
];

interface PlatformAsset {
  url: string;
  binPath: string;
}

function getNvimAsset(): PlatformAsset {
  const { platform, arch } = process;
  let asset: string;

  if (platform === "darwin" && arch === "arm64") {
    asset = "nvim-macos-arm64.tar.gz";
  } else if (platform === "darwin" && arch === "x64") {
    asset = "nvim-macos-x86_64.tar.gz";
  } else if (platform === "linux" && arch === "x64") {
    asset = "nvim-linux-x86_64.tar.gz";
  } else if (platform === "linux" && arch === "arm64") {
    asset = "nvim-linux-arm64.tar.gz";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const dirName = asset.replace(".tar.gz", "");

  return {
    url: `https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/${asset}`,
    binPath: join(INSTALLS_DIR, `nvim-${NVIM_VERSION}`, dirName, "bin", "nvim"),
  };
}

function getRgAsset(): PlatformAsset {
  const { platform, arch } = process;
  let triplet: string;

  if (platform === "darwin" && arch === "arm64") {
    triplet = "aarch64-apple-darwin";
  } else if (platform === "darwin" && arch === "x64") {
    triplet = "x86_64-apple-darwin";
  } else if (platform === "linux" && arch === "x64") {
    triplet = "x86_64-unknown-linux-musl";
  } else if (platform === "linux" && arch === "arm64") {
    triplet = "aarch64-unknown-linux-gnu";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const dirName = `ripgrep-${RG_VERSION}-${triplet}`;

  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.tar.gz`,
    binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg"),
  };
}

function getProxyAsset(): PlatformAsset {
  const { platform, arch } = process;
  let suffix: string;

  if (platform === "darwin" && arch === "arm64") {
    suffix = "darwin_arm64";
  } else if (platform === "darwin" && arch === "x64") {
    suffix = "darwin_amd64";
  } else if (platform === "linux" && arch === "x64") {
    suffix = "linux_amd64";
  } else if (platform === "linux" && arch === "arm64") {
    suffix = "linux_arm64";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const asset = `CLIProxyAPI_${PROXY_VERSION}_${suffix}.tar.gz`;

  return {
    url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${PROXY_VERSION}/${asset}`,
    binPath: join(INSTALLS_DIR, `cliproxyapi-${PROXY_VERSION}`, "cli-proxy-api"),
  };
}

/**
 * Returns the vendored binary path if it exists, or null.
 */
export function getVendoredPath(binary: "nvim" | "rg" | "cli-proxy-api"): string | null {
  const binLink = join(BIN_DIR, binary);
  if (existsSync(binLink)) {
    return binLink;
  }
  return null;
}

function ensureDirs(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(INSTALLS_DIR, { recursive: true });
}

async function downloadAndExtract(url: string, extractDir: string): Promise<void> {
  mkdirSync(extractDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }

  const tmpFile = join(extractDir, "download.tar.gz");
  const buffer = await response.arrayBuffer();
  await Bun.write(tmpFile, buffer);

  execSync(`tar xzf "${tmpFile}" -C "${extractDir}"`, { stdio: "ignore" });
  unlinkSync(tmpFile);
}

function createSymlink(target: string, link: string): void {
  if (existsSync(link)) {
    unlinkSync(link);
  }
  symlinkSync(target, link);
}

/**
 * Download and install Neovim to ~/.soulforge/. Returns path to nvim binary.
 */
export async function installNeovim(): Promise<string> {
  ensureDirs();

  const asset = getNvimAsset();
  const extractDir = join(INSTALLS_DIR, `nvim-${NVIM_VERSION}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }

  if (!existsSync(asset.binPath)) {
    throw new Error(`Neovim binary not found after extraction at ${asset.binPath}`);
  }

  execSync(`chmod +x "${asset.binPath}"`, { stdio: "ignore" });
  createSymlink(asset.binPath, join(BIN_DIR, "nvim"));

  return join(BIN_DIR, "nvim");
}

/**
 * Download and install ripgrep to ~/.soulforge/. Returns path to rg binary.
 */
export async function installRipgrep(): Promise<string> {
  ensureDirs();

  const asset = getRgAsset();
  const extractDir = join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }

  if (!existsSync(asset.binPath)) {
    throw new Error(`ripgrep binary not found after extraction at ${asset.binPath}`);
  }

  execSync(`chmod +x "${asset.binPath}"`, { stdio: "ignore" });
  createSymlink(asset.binPath, join(BIN_DIR, "rg"));

  return join(BIN_DIR, "rg");
}

/**
 * Download and install CLIProxyAPI to ~/.soulforge/. Returns path to binary.
 */
export async function installProxy(): Promise<string> {
  ensureDirs();

  const asset = getProxyAsset();
  const extractDir = join(INSTALLS_DIR, `cliproxyapi-${PROXY_VERSION}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }

  if (!existsSync(asset.binPath)) {
    throw new Error(`CLIProxyAPI binary not found after extraction at ${asset.binPath}`);
  }

  execSync(`chmod +x "${asset.binPath}"`, { stdio: "ignore" });
  createSymlink(asset.binPath, join(BIN_DIR, "cli-proxy-api"));

  return join(BIN_DIR, "cli-proxy-api");
}

// ─── Font install ───

function getUserFontDir(): string {
  const os = platform();
  if (os === "darwin") {
    return join(homedir(), "Library", "Fonts");
  }
  // Linux / fallback
  return join(homedir(), ".local", "share", "fonts");
}

/**
 * Get all font directories to scan (user + system).
 */
function getFontDirs(): string[] {
  const dirs: string[] = [];
  const os = platform();
  if (os === "darwin") {
    dirs.push(join(homedir(), "Library", "Fonts"));
    dirs.push("/Library/Fonts");
    dirs.push("/System/Library/Fonts");
  } else {
    dirs.push(join(homedir(), ".local", "share", "fonts"));
    dirs.push("/usr/share/fonts");
    dirs.push("/usr/local/share/fonts");
  }
  return dirs;
}

/**
 * Check if a font's files exist in any system font directory.
 */
function fontExistsOnSystem(font: NerdFont): boolean {
  for (const dir of getFontDirs()) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir, { recursive: true });
      for (const f of files) {
        const name = typeof f === "string" ? f : f.toString();
        if (name.includes(font.filePrefix) && (name.endsWith(".ttf") || name.endsWith(".otf"))) {
          return true;
        }
      }
    } catch {
      // permission denied etc
    }
  }
  return false;
}

/**
 * Detect which nerd fonts are installed (checks vendored dir + system font dirs).
 */
export function detectInstalledFonts(): NerdFont[] {
  const installed: NerdFont[] = [];

  for (const font of NERD_FONTS) {
    // Check vendored fonts first
    const vendoredDir = join(FONTS_DIR, font.id);
    if (existsSync(vendoredDir)) {
      try {
        const files = readdirSync(vendoredDir);
        if (files.some((f) => f.endsWith(".ttf") || f.endsWith(".otf"))) {
          installed.push(font);
          continue;
        }
      } catch {
        // ignore
      }
    }

    // Check system font directories
    if (fontExistsOnSystem(font)) {
      installed.push(font);
    }
  }

  return installed;
}

/**
 * Check if any nerd font is installed.
 */
export function hasAnyNerdFont(): boolean {
  return detectInstalledFonts().length > 0;
}

/**
 * Install a nerd font from GitHub releases to ~/.soulforge/fonts/ and
 * symlink/copy into the user's font directory.
 */
export async function installFont(fontId: string): Promise<string> {
  const font = NERD_FONTS.find((f) => f.id === fontId);
  if (!font) {
    throw new Error(
      `Unknown font: ${fontId}. Available: ${NERD_FONTS.map((f) => f.id).join(", ")}`,
    );
  }

  mkdirSync(FONTS_DIR, { recursive: true });
  const fontDir = join(FONTS_DIR, font.id);

  if (!existsSync(fontDir) || readdirSync(fontDir).length === 0) {
    mkdirSync(fontDir, { recursive: true });

    // Download from Nerd Fonts releases (tar.xz)
    const url = `https://github.com/ryanoasis/nerd-fonts/releases/latest/download/${font.asset}.tar.xz`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Font download failed: ${response.status} ${response.statusText}`);
    }

    const tmpFile = join(fontDir, "download.tar.xz");
    const buffer = await response.arrayBuffer();
    await Bun.write(tmpFile, buffer);

    execSync(`tar xJf "${tmpFile}" -C "${fontDir}"`, { stdio: "ignore" });
    unlinkSync(tmpFile);

    // Remove non-font files (LICENSE, README)
    for (const f of readdirSync(fontDir)) {
      if (!f.endsWith(".ttf") && !f.endsWith(".otf")) {
        try {
          unlinkSync(join(fontDir, f));
        } catch {
          // directory or locked file, skip
        }
      }
    }
  }

  // Copy font files to user font directory
  const userFontDir = getUserFontDir();
  mkdirSync(userFontDir, { recursive: true });

  for (const file of readdirSync(fontDir)) {
    if (file.endsWith(".ttf") || file.endsWith(".otf")) {
      const src = join(fontDir, file);
      const dest = join(userFontDir, file);
      if (!existsSync(dest)) {
        const data = await Bun.file(src).arrayBuffer();
        await Bun.write(dest, data);
      }
    }
  }

  // Refresh font cache on Linux
  if (platform() === "linux") {
    try {
      execSync("fc-cache -f", { stdio: "ignore", timeout: 10_000 });
    } catch {
      // non-fatal
    }
  }

  return font.family;
}
