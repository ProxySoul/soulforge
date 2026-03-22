#!/usr/bin/env bun

globalThis.AI_SDK_LOG_WARNINGS = false;

const cliArgs = process.argv.slice(2);
const hasCli =
  cliArgs.includes("--headless") ||
  cliArgs.includes("--list-providers") ||
  cliArgs.includes("--list-models") ||
  cliArgs.includes("--set-key") ||
  cliArgs.includes("--version") ||
  cliArgs.includes("-v") ||
  cliArgs.includes("--help") ||
  cliArgs.includes("-h");

if (hasCli) {
  const { parseHeadlessArgs, runHeadless } = await import("./headless/index.js");
  const action = await parseHeadlessArgs(cliArgs);
  if (action) await runHeadless(action);
  process.exit(0);
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isCompiledBinary = import.meta.url.includes("$bunfs");
if (isCompiledBinary) {
  const bundledWorker = join(homedir(), ".soulforge", "opentui-assets", "parser.worker.js");
  if (!process.env.OTUI_TREE_SITTER_WORKER_PATH && existsSync(bundledWorker)) {
    process.env.OTUI_TREE_SITTER_WORKER_PATH = bundledWorker;
  }
}

import { BRAND_SEGMENTS, garble, WISP_FRAMES, WORDMARK } from "./core/utils/splash.js";
import { logBackgroundError } from "./stores/errors.js";

const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

const PURPLE = rgb("#9B30FF");
const DIM_PURPLE = rgb("#4a1a6b");
const FAINT = rgb("#333333");
const MUTED = rgb("#555555");
const SUBTLE = rgb("#444444");
const RED = rgb("#FF0040");

const cols = process.stdout.columns ?? 80;
const rows = process.stdout.rows ?? 24;

const GHOST = (() => {
  // Check explicit config first
  try {
    const raw = readFileSync(join(homedir(), ".soulforge", "config.json"), "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.nerdFont === true) return "󰊠";
    if (cfg.nerdFont === false) return "◆";
  } catch {}
  // Auto-detect from terminal environment (mirrors detectNerdFont in icons.ts)
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  const termEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() ?? "";
  if (
    term.includes("kitty") ||
    term.includes("wezterm") ||
    term.includes("alacritty") ||
    term.includes("hyper") ||
    term.includes("iterm") ||
    term.includes("ghostty") ||
    termEmulator.includes("jetbrains") ||
    process.env.KITTY_WINDOW_ID ||
    process.env.WEZTERM_PANE
  ) {
    return "󰊠";
  }
  return "◆";
})();

const LAYOUT_H = 14;
const base = Math.max(1, Math.floor((rows - LAYOUT_H) / 2));

const ROW = {
  ghost: base,
  wisp: base + 1,
  word: base + 3,
  sub: base + 6,
  brand: base + 8,
  div: base + 10,
  status: base + 12,
};

const at = (r: number, c: number) => `\x1b[${r};${c}H`;

function center(row: number, text: string, style = ""): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
  const plain = text.replace(/\x1b\[[^m]*m/g, "");
  const c = Math.max(1, Math.floor((cols - plain.length) / 2) + 1);
  process.stdout.write(`${at(row, c)}${style}${text}${RST}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const bootStartWall = Date.now();
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Spinner runs in a child process so it stays alive even when the main
// event loop is blocked by Bun's synchronous module resolution (~3s).
// BUN_BE_BUN=1 makes compiled binaries act as the bun CLI (supports -e).
const spinnerProc = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
const RST = "\\x1b[0m";
const PURPLE = "\\x1b[38;2;155;48;255m";
const MUTED = "\\x1b[38;2;85;85;85m";
const DIM = "\\x1b[2m";
const SPINNER = ${JSON.stringify(SPINNER)};
const row = ${ROW.status};
const cols = ${cols};
const bootStart = ${bootStartWall};
const at = (r, c) => "\\x1b[" + r + ";" + c + "H";

let msgs = ["loading…"];
let msgIdx = 0;
let spinIdx = 0;
let msgSetAt = Date.now();

process.stdin.setEncoding("utf-8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line === "EXIT") { process.exit(0); }
    try { msgs = JSON.parse(line); msgIdx = 0; msgSetAt = Date.now(); } catch {}
  }
});

setInterval(() => {
  spinIdx++;
  const now = Date.now();
  if (msgs.length > 1 && now - msgSetAt > 1200) {
    msgIdx = (msgIdx + 1) % msgs.length;
    msgSetAt = now;
  }
  const elapsed = ((now - bootStart) / 1000).toFixed(1);
  const msg = msgs[msgIdx % msgs.length] || msgs[0];
  const frame = SPINNER[spinIdx % SPINNER.length];
  const full = frame + " " + msg + "  " + elapsed + "s";
  const c = Math.max(1, Math.floor((cols - full.length) / 2) + 1);
  process.stdout.write(
    at(row, 1) + "\\x1b[2K" + at(row, c) + PURPLE + frame + RST + " " + MUTED + msg + "  " + DIM + elapsed + "s" + RST
  );
}, 80);
`,
  ],
  { stdin: "pipe", stdout: "inherit", stderr: "ignore", env: { ...process.env, BUN_BE_BUN: "1" } },
);

function status(...msgs: string[]): void {
  spinnerProc.stdin.write(`${JSON.stringify(msgs)}\n`);
}

function stopSpinner(): void {
  spinnerProc.stdin.write("EXIT\n");
  spinnerProc.stdin.end();
}

process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");

const earlyModules = Promise.all([
  import("./config/index.js"),
  import("./core/editor/detect.js"),
  import("./core/icons.js"),
  import("./core/setup/install.js"),
]);

for (const frame of ["░", "▒", "▓", GHOST]) {
  center(ROW.ghost, frame, PURPLE + BOLD);
  await sleep(50);
}

center(ROW.wisp, WISP_FRAMES[0] ?? "", DIM + DIM_PURPLE);
let wispTick = 0;
const wispTimer = setInterval(() => {
  wispTick++;
  center(ROW.wisp, WISP_FRAMES[wispTick % WISP_FRAMES.length] ?? "", DIM + DIM_PURPLE);
}, 500);

const narrow = cols < 40;
await sleep(100);

if (narrow) {
  center(ROW.word + 1, "SOULFORGE", PURPLE + BOLD);
} else {
  for (let i = 0; i < 3; i++) {
    center(ROW.word + i, garble(WORDMARK[i] ?? ""), FAINT);
    await sleep(40);
    center(ROW.word + i, WORDMARK[i] ?? "", PURPLE + BOLD);
    await sleep(30);
  }
}

await sleep(60);
center(
  ROW.sub,
  `${SUBTLE}── ${RST}${MUTED}${ITALIC}AI-Powered Terminal IDE${RST}${SUBTLE} ──${RST}`,
);

await sleep(100);
const brandParts = BRAND_SEGMENTS.map((s) => ({ text: s.text, color: rgb(s.color) }));
const brandPlain = BRAND_SEGMENTS.map((s) => s.text).join("");
const brandCol = Math.max(1, Math.floor((cols - brandPlain.length) / 2) + 1);
let charIdx = 0;
for (const part of brandParts) {
  for (let _c = 0; _c < part.text.length; _c++) {
    charIdx++;
    let out = `${at(ROW.brand, brandCol)}`;
    let pos = 0;
    for (const p of brandParts) {
      const visible = p.text.slice(0, Math.max(0, charIdx - pos));
      out += `${p.color}${visible}`;
      pos += p.text.length;
    }
    out += `${RED}${charIdx < brandPlain.length ? "█" : ""}${RST}  `;
    process.stdout.write(out);
    await sleep(25);
  }
}
let brandFinal = `${at(ROW.brand, brandCol)}`;
for (const p of brandParts) brandFinal += `${p.color}${p.text}`;
brandFinal += `${RST}  `;
process.stdout.write(brandFinal);

await sleep(60);
const divW = Math.min(40, cols - 10);
for (let w = 2; w <= divW; w += 3) {
  const dc = Math.max(1, Math.floor((cols - w) / 2) + 1);
  process.stdout.write(`${at(ROW.div, dc)}${FAINT}${"─".repeat(w)}${RST}`);
  await sleep(8);
}
const divCol = Math.max(1, Math.floor((cols - divW) / 2) + 1);
process.stdout.write(`${at(ROW.div, divCol)}${FAINT}${"─".repeat(divW)}${RST}`);

// App.tsx pulls in the entire tool/hook/AI SDK module graph (~3s).
// Kick it off here so the spinner (child process) shows progress.

status("Gathering soul fragments…", "Unpacking the forge…");
const appReady = import("./components/App.js");
const [configMod, detectMod, iconsMod, installMod] = await earlyModules;

const { loadConfig, loadProjectConfig } = configMod;
const { detectNeovim } = detectMod;
const { initNerdFont } = iconsMod;
const { getVendoredPath, installNeovim, installRipgrep, installFd, installLazygit } = installMod;

let resumeSessionId: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--session" || arg === "--resume" || arg === "-s") {
    resumeSessionId = args[i + 1];
    i++;
  } else if (arg?.startsWith("--session=")) {
    resumeSessionId = arg.slice("--session=".length);
  } else if (arg?.startsWith("--resume=")) {
    resumeSessionId = arg.slice("--resume=".length);
  }
}

status("Reading the scrolls…");
const config = loadConfig();
const projectConfig = loadProjectConfig(process.cwd());
initNerdFont(config.nerdFont);

// Register custom providers from global + project config (project overrides global by id)
{
  const globalP = config.providers ?? [];
  const projectP = projectConfig?.providers ?? [];
  if (globalP.length > 0 || projectP.length > 0) {
    const map = new Map(globalP.map((p) => [p.id, p]));
    for (const p of projectP) map.set(p.id, p);
    const { registerCustomProviders } = await import("./core/llm/providers/index.js");
    registerCustomProviders([...map.values()]);
  }
}

// Pre-init ContextManager async — yields between heavy sync steps so the spinner stays alive.
const contextManagerReady = import("./core/context/manager.js").then(({ ContextManager }) =>
  ContextManager.createAsync(process.cwd(), (step) => status(step)),
);

status("Summoning the editor spirit…");
let nvim = detectNeovim();
if (!nvim) {
  status("Forging Neovim from scratch…", "This only happens once…");
  try {
    const path = await installNeovim();
    nvim = { path, version: "0.11.1" };
  } catch {
    // Continue without neovim — editor panel will show install instructions
  }
}
if (nvim) {
  config.nvimPath = nvim.path;
  import("./core/editor/neovim.js")
    .then(({ bootstrapNeovimPlugins }) => {
      bootstrapNeovimPlugins(nvim.path);
    })
    .catch(() => {});
}

if (!getVendoredPath("rg")) {
  status("Sharpening the search blade…");
  installRipgrep().catch((err) => {
    logBackgroundError(
      "boot",
      `ripgrep install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

if (!getVendoredPath("fd")) {
  status("Summoning the file finder…");
  installFd().catch((err) => {
    logBackgroundError(
      "boot",
      `fd install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

if (!getVendoredPath("lazygit")) {
  status("Conjuring the git spirit…");
  installLazygit().catch((err) => {
    logBackgroundError(
      "boot",
      `lazygit install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

status("Reaching out to the LLM gods…", "Negotiating API keys…");
const { checkProviders } = await import("./core/llm/provider.js");
const { checkPrerequisites } = await import("./core/setup/prerequisites.js");
const [bootProviders, bootPrereqs] = await Promise.all([
  checkProviders(),
  Promise.resolve(checkPrerequisites()),
]);

status("Kicking the neurons awake…", "Waking the tree-sitter…");
import("./core/intelligence/index.js")
  .then(({ warmupIntelligence }) => warmupIntelligence(process.cwd(), config.codeIntelligence))
  .catch((err) => {
    logBackgroundError(
      "boot",
      `intelligence warmup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

status("Assembling the forge…", "Almost there…", "Sharpening the tools…");
const [{ App }, contextManager] = await Promise.all([appReady, contextManagerReady]);
// Instant — App.tsx already pulled these into the module cache
const { createCliRenderer } = await import("@opentui/core");
const { createRoot } = await import("@opentui/react");
const { start } = await import("./index.js");

status("Igniting…");

clearInterval(wispTimer);
stopSpinner();
process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");

await start({
  App,
  createCliRenderer,
  createRoot,
  config,
  projectConfig,
  resumeSessionId,
  bootProviders,
  bootPrereqs,
  contextManager,
});
