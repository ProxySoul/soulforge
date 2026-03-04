#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./components/App.js";
import { loadConfig, loadProjectConfig } from "./config/index.js";
import { detectNeovim } from "./core/editor/detect.js";
import { getVendoredPath, installNeovim, installRipgrep } from "./core/setup/install.js";

// Load configuration (global + project)
const config = loadConfig();
const projectConfig = loadProjectConfig(process.cwd());

// Detect neovim before launching UI — auto-install if missing
let nvim = detectNeovim();

if (!nvim) {
  process.stderr.write("Installing Neovim 0.11...\n");
  try {
    const path = await installNeovim();
    nvim = { path, version: "0.11.1" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\x1b[1;31mFailed to install Neovim:\x1b[0m ${msg}\nInstall manually: brew install neovim\n`,
    );
    process.exit(1);
  }
}

config.nvimPath = nvim.path;

// Background-install ripgrep (non-blocking, non-fatal)
if (!getVendoredPath("rg")) {
  installRipgrep().catch(() => {});
}

// Clear terminal and dispose resources on exit
process.on("exit", () => {
  try {
    const { stopProxy } = require("./core/proxy/lifecycle.js");
    stopProxy();
  } catch {
    // Proxy module may not be loaded
  }
  try {
    const { disposeIntelligenceRouter } = require("./core/intelligence/index.js");
    disposeIntelligenceRouter();
  } catch {
    // Intelligence module may not be loaded
  }
  process.stdout.write("\x1b[2J\x1b[H");
});

// Clear screen and render
process.stdout.write("\x1b[2J\x1b[H");

render(<App config={config} projectConfig={projectConfig} />, {
  exitOnCtrlC: false,
});
