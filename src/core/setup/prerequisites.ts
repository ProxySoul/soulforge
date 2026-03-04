import { execSync } from "node:child_process";
import { platform } from "node:os";
import { getVendoredPath, hasAnyNerdFont } from "./install.js";

export interface Prerequisite {
  name: string;
  description: string;
  required: boolean;
  check: () => boolean;
  install: Record<string, string[]>;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fontInstalled(): boolean {
  if (platform() === "win32") return true;
  return hasAnyNerdFont();
}

export const PREREQUISITES: Prerequisite[] = [
  {
    name: "Neovim",
    description: "Embedded editor (required, v0.11+)",
    required: true,
    check: () => getVendoredPath("nvim") !== null || commandExists("nvim"),
    install: {
      darwin: ["brew install neovim"],
      linux: [
        "# Ubuntu/Debian:",
        "sudo apt install neovim",
        "# or Arch:",
        "sudo pacman -S neovim",
        "# or Fedora:",
        "sudo dnf install neovim",
      ],
      win32: ["scoop install neovim", "# or: winget install Neovim.Neovim"],
    },
  },
  {
    name: "Git",
    description: "Version control (required)",
    required: true,
    check: () => commandExists("git"),
    install: {
      darwin: ["brew install git"],
      linux: ["sudo apt install git"],
      win32: ["winget install Git.Git"],
    },
  },
  {
    name: "Nerd Font",
    description: "Icons & ligatures (use /setup to pick one)",
    required: false,
    check: fontInstalled,
    install: {
      darwin: [
        "brew install --cask font-jetbrains-mono-nerd-font",
        "# Or use /setup to auto-install from 5 font choices",
      ],
      linux: [
        "# Use /setup to auto-install, or manually:",
        "curl -fsSL https://raw.githubusercontent.com/ryanoasis/nerd-fonts/HEAD/install.sh | bash -s -- JetBrainsMono",
      ],
      win32: ["scoop bucket add nerd-fonts && scoop install JetBrainsMono-NF"],
    },
  },
  {
    name: "lazygit",
    description: "Terminal git UI (optional, for /lazygit)",
    required: false,
    check: () => commandExists("lazygit"),
    install: {
      darwin: ["brew install lazygit"],
      linux: [
        "# Ubuntu (via PPA):",
        "sudo add-apt-repository ppa:lazygit-team/release",
        "sudo apt update && sudo apt install lazygit",
        "# or Arch:",
        "sudo pacman -S lazygit",
        "# or via Go:",
        "go install github.com/jesseduffield/lazygit@latest",
      ],
      win32: ["scoop install lazygit", "# or: winget install lazygit"],
    },
  },
  {
    name: "ripgrep",
    description: "Fast code search (used by /grep)",
    required: false,
    check: () => getVendoredPath("rg") !== null || commandExists("rg"),
    install: {
      darwin: ["brew install ripgrep"],
      linux: ["sudo apt install ripgrep"],
      win32: ["scoop install ripgrep"],
    },
  },
  {
    name: "CLIProxyAPI",
    description: "Proxy for Claude Max (optional, auto-installed)",
    required: false,
    check: () =>
      getVendoredPath("cli-proxy-api") !== null ||
      commandExists("cli-proxy-api") ||
      commandExists("cliproxyapi"),
    install: {
      darwin: ["Auto-installed when selecting Proxy provider"],
      linux: ["Auto-installed when selecting Proxy provider"],
    },
  },
];

export interface PrerequisiteStatus {
  prerequisite: Prerequisite;
  installed: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus[] {
  return PREREQUISITES.map((p) => ({
    prerequisite: p,
    installed: p.check(),
  }));
}

export function getInstallCommands(name: string): string[] {
  const os = platform();
  const prereq = PREREQUISITES.find((p) => p.name === name);
  if (!prereq) return [];
  return prereq.install[os] ?? prereq.install.linux ?? [];
}

export function getMissingRequired(): PrerequisiteStatus[] {
  return checkPrerequisites().filter((s) => !s.installed && s.prerequisite.required);
}

export function getMissingOptional(): PrerequisiteStatus[] {
  return checkPrerequisites().filter((s) => !s.installed && !s.prerequisite.required);
}
