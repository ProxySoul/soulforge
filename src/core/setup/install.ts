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
const FD_VERSION = "10.2.0";
const LAZYGIT_VERSION = "0.44.1";
const PROXY_VERSION = "6.8.40";

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

type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

function getPlatformKey(): PlatformKey {
  const key = `${process.platform}-${process.arch}` as PlatformKey;
  if (key !== "darwin-arm64" && key !== "darwin-x64" && key !== "linux-x64" && key !== "linux-arm64") {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }
  return key;
}

interface BinaryConfig {
  name: string;
  binName: string;
  version: string;
  getAsset: (key: PlatformKey) => PlatformAsset;
}

async function installBinary(config: BinaryConfig): Promise<string> {
  ensureDirs();
  const key = getPlatformKey();
  const asset = config.getAsset(key);
  const extractDir = join(INSTALLS_DIR, `${config.name}-${config.version}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }
  if (!existsSync(asset.binPath)) {
    throw new Error(`${config.name} binary not found after extraction at ${asset.binPath}`);
  }

  execSync(`chmod +x "${asset.binPath}"`, { stdio: "ignore" });
  createSymlink(asset.binPath, join(BIN_DIR, config.binName));
  return join(BIN_DIR, config.binName);
}

const NVIM_ASSETS: Record<PlatformKey, string> = {
  "darwin-arm64": "nvim-macos-arm64.tar.gz",
  "darwin-x64": "nvim-macos-x86_64.tar.gz",
  "linux-x64": "nvim-linux-x86_64.tar.gz",
  "linux-arm64": "nvim-linux-arm64.tar.gz",
};

const RUST_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const FD_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const PROXY_SUFFIXES: Record<PlatformKey, string> = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_amd64",
  "linux-x64": "linux_amd64",
  "linux-arm64": "linux_arm64",
};

const LAZYGIT_SUFFIXES: Record<PlatformKey, string> = {
  "darwin-arm64": "Darwin_arm64",
  "darwin-x64": "Darwin_x86_64",
  "linux-x64": "Linux_x86_64",
  "linux-arm64": "Linux_arm64",
};

export function getVendoredPath(
  binary: "nvim" | "rg" | "fd" | "lazygit" | "cli-proxy-api",
): string | null {
  const binLink = join(BIN_DIR, binary);
  return existsSync(binLink) ? binLink : null;
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

export async function installNeovim(): Promise<string> {
  return installBinary({
    name: "nvim",
    binName: "nvim",
    version: NVIM_VERSION,
    getAsset: (key) => {
      const asset = NVIM_ASSETS[key];
      const dirName = asset.replace(".tar.gz", "");
      return {
        url: `https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/${asset}`,
        binPath: join(INSTALLS_DIR, `nvim-${NVIM_VERSION}`, dirName, "bin", "nvim"),
      };
    },
  });
}

export async function installRipgrep(): Promise<string> {
  return installBinary({
    name: "ripgrep",
    binName: "rg",
    version: RG_VERSION,
    getAsset: (key) => {
      const triplet = RUST_TRIPLETS[key];
      const dirName = `ripgrep-${RG_VERSION}-${triplet}`;
      return {
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg"),
      };
    },
  });
}

export async function installFd(): Promise<string> {
  return installBinary({
    name: "fd",
    binName: "fd",
    version: FD_VERSION,
    getAsset: (key) => {
      const triplet = FD_TRIPLETS[key];
      const dirName = `fd-v${FD_VERSION}-${triplet}`;
      return {
        url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `fd-${FD_VERSION}`, dirName, "fd"),
      };
    },
  });
}

export async function installLazygit(): Promise<string> {
  return installBinary({
    name: "lazygit",
    binName: "lazygit",
    version: LAZYGIT_VERSION,
    getAsset: (key) => {
      const suffix = LAZYGIT_SUFFIXES[key];
      return {
        url: `https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_${suffix}.tar.gz`,
        binPath: join(INSTALLS_DIR, `lazygit-${LAZYGIT_VERSION}`, "lazygit"),
      };
    },
  });
}

export async function installProxy(): Promise<string> {
  return installBinary({
    name: "cliproxyapi",
    binName: "cli-proxy-api",
    version: PROXY_VERSION,
    getAsset: (key) => {
      const suffix = PROXY_SUFFIXES[key];
      const asset = `CLIProxyAPI_${PROXY_VERSION}_${suffix}.tar.gz`;
      return {
        url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${PROXY_VERSION}/${asset}`,
        binPath: join(INSTALLS_DIR, `cliproxyapi-${PROXY_VERSION}`, "cli-proxy-api"),
      };
    },
  });
}

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
    } catch {}
  }
  return false;
}

/**
 * Detect which nerd fonts are installed (checks vendored dir + system font dirs).
 */
export function detectInstalledFonts(): NerdFont[] {
  const installed: NerdFont[] = [];

  for (const font of NERD_FONTS) {
    const vendoredDir = join(FONTS_DIR, font.id);
    if (existsSync(vendoredDir)) {
      try {
        const files = readdirSync(vendoredDir);
        if (files.some((f) => f.endsWith(".ttf") || f.endsWith(".otf"))) {
          installed.push(font);
          continue;
        }
      } catch {}
    }

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
