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

import { applyTheme, getThemeTokens, watchThemes } from "./core/theme/index.js";
import { garble, WORDMARK } from "./core/utils/splash.js";
import { logBackgroundError } from "./stores/errors.js";

const RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

function rgb(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3)
    h =
      (h[0] ?? "0") + (h[0] ?? "0") + (h[1] ?? "0") + (h[1] ?? "0") + (h[2] ?? "0") + (h[2] ?? "0");
  const n = parseInt(h, 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

// Sync-load theme name from config before React mounts
try {
  const raw = readFileSync(join(homedir(), ".soulforge", "config.json"), "utf-8");
  const cfg = JSON.parse(raw);
  if (cfg.theme?.name)
    applyTheme(cfg.theme.name, cfg.theme?.transparent, {
      userMessageOpacity: cfg.theme?.userMessageOpacity,
      diffOpacity: cfg.theme?.diffOpacity,
      borderStrength: cfg.theme?.borderStrength,
    });
} catch {
  applyTheme("dark", true);
}
watchThemes();

const _t = getThemeTokens();
const PURPLE = rgb(_t.brand);
const DIM_PURPLE = rgb(_t.brandDim);
const FAINT = rgb("#333333");
const MUTED = rgb("#777777");
const SUBTLE = rgb("#555555");

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

// ── Boot splash — unique forge ignition sequence ────────────────────
// Ghost fades in, wordmark glitch-decodes, rune spinner shows loading.
// Distinct from the landing page — this is the forge warming up.

const RUNE_SPINNER = ["ᛁ", "ᚲ", "ᚠ", "ᛊ", "ᛏ", "ᛉ", "ᛞ", "ᛉ", "ᛏ", "ᛊ", "ᚠ", "ᚲ"];

const LAYOUT_H = 12;
const base = Math.max(1, Math.floor((rows - LAYOUT_H) / 2));

const ROW = {
  ghost: base,
  wisp: base + 1,
  word: base + 3,
  sub: base + 6,
  spinner: base + 8, // rune spinner on its own row
  status: base + 9, // status text below spinner
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

// Rune spinner subprocess — stays alive during sync module resolution.
// Uses the ForgeSpinner's oscillating rune wheel instead of braille dots.
function hexToAnsi(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `\\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}
// Ensure spinner subprocess is killed if boot crashes or is interrupted.
// This runs BEFORE index.tsx's signal handlers are registered.
function killSpinner(): void {
  try {
    spinnerProc?.kill();
  } catch {}
}
process.on("exit", killSpinner);
process.on("SIGINT", killSpinner);
process.on("SIGTERM", killSpinner);

const spinnerProc = Bun.spawn(
  [
    process.execPath,
    "-e",
    `
const RST = "\\x1b[0m";
const BRAND = "${hexToAnsi(_t.brand)}";
const SPARK = "${hexToAnsi(_t.warning)}";
const MUTED = "${hexToAnsi("#777777")}";
const FAINT = "${hexToAnsi("#555555")}";
const DIM_C = "\\x1b[2m";
const RUNES = ${JSON.stringify(RUNE_SPINNER)};
const INTENSITY = [0,0,1,2,2,3,4,3,2,2,1,0];
const spinnerRow = ${ROW.spinner};
const statusRow = ${ROW.status};
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
  const rune = RUNES[spinIdx % RUNES.length];
  const intensity = INTENSITY[spinIdx % INTENSITY.length];
  const runeColor = intensity >= 4 ? SPARK : intensity >= 2 ? BRAND : intensity >= 1 ? MUTED : FAINT;
  // Rune spinner centered on its own row
  const runeC = Math.max(1, Math.floor((cols - 1) / 2) + 1);
  process.stdout.write(at(spinnerRow, 1) + "\\x1b[2K" + at(spinnerRow, runeC) + runeColor + rune + RST);
  // Status text centered below
  const statusFull = msg + "  " + elapsed + "s";
  const statusC = Math.max(1, Math.floor((cols - statusFull.length) / 2) + 1);
  process.stdout.write(at(statusRow, 1) + "\\x1b[2K" + at(statusRow, statusC) + MUTED + msg + "  " + DIM_C + elapsed + "s" + RST);
}, 150);
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
  // Remove early-boot signal handlers — index.tsx takes over cleanup from here.
  process.removeListener("exit", killSpinner);
  process.removeListener("SIGINT", killSpinner);
  process.removeListener("SIGTERM", killSpinner);
}

process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");

const earlyModules = Promise.all([
  import("./config/index.js"),
  import("./core/editor/detect.js"),
  import("./core/icons.js"),
  import("./core/setup/install.js"),
]);

// ── Ghost materialization ───────────────────────────────────────────

for (const frame of ["░", "▒", "▓", GHOST]) {
  center(ROW.ghost, frame, PURPLE + BOLD);
  await sleep(60);
}

center(ROW.wisp, "∿~·~∿", DIM + DIM_PURPLE);

await sleep(100);

// ── Wordmark glitch-decode ──────────────────────────────────────────

const narrow = cols < 40;

if (narrow) {
  center(ROW.word + 1, garble("SOULFORGE"), FAINT);
  await sleep(60);
  center(ROW.word + 1, "SOULFORGE", PURPLE + BOLD);
} else {
  for (let i = 0; i < 3; i++) {
    center(ROW.word + i, garble(WORDMARK[i] ?? ""), FAINT);
  }
  await sleep(70);
  for (let i = 0; i < 3; i++) {
    center(ROW.word + i, garble(WORDMARK[i] ?? ""), FAINT);
  }
  await sleep(70);
  for (let i = 0; i < 3; i++) {
    center(ROW.word + i, WORDMARK[i] ?? "", PURPLE + BOLD);
    await sleep(25);
  }
}

await sleep(60);

// ── Tagline ─────────────────────────────────────────────────────────

center(
  ROW.sub,
  `${SUBTLE}── ${RST}${MUTED}${ITALIC}Graph-Powered Code Intelligence${RST}${SUBTLE} ──${RST}`,
);

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
let forceWizard = false;
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
  } else if (arg === "--wizard") {
    forceWizard = true;
  }
}

status("Reading the scrolls…");
const config = loadConfig();
const projectConfig = loadProjectConfig(process.cwd());
initNerdFont(config.nerdFont);

{
  const priority = projectConfig?.keyPriority ?? config.keyPriority;
  if (priority) {
    const { setDefaultKeyPriority } = await import("./core/secrets.js");
    setDefaultKeyPriority(priority);
  }
}

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
  // Sync provider secret keys into the secrets system (single source of truth)
  const { getProviderSecretEntries } = await import("./core/llm/providers/index.js");
  const { registerProviderSecrets } = await import("./core/secrets.js");
  registerProviderSecrets(getProviderSecretEntries());
}

// Pre-init ContextManager async — yields between heavy sync steps so the spinner stays alive.
const repoMapEnabled = (projectConfig?.repoMap ?? config.repoMap) !== false;
const contextManagerReady = import("./core/context/manager.js").then(({ ContextManager }) =>
  ContextManager.createAsync(process.cwd(), (step) => status(step), { repoMapEnabled }),
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
const { prewarmAllModels } = await import("./core/llm/models.js");
const [bootProviders, bootPrereqs] = await Promise.all([
  checkProviders(),
  Promise.resolve(checkPrerequisites()),
]);
// Pre-warm model caches AFTER boot-critical work completes.
// Fire-and-forget — populates caches in background so Ctrl+L opens instantly.
prewarmAllModels();

status("Kicking the neurons awake…", "Waking the tree-sitter…");
// Ensure setIntelligenceClient() has run before warmup to avoid spawning
// duplicate LSP servers on both main thread and worker.
contextManagerReady
  .then(() => import("./core/intelligence/index.js"))
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

stopSpinner();
process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");

await start({
  App,
  createCliRenderer,
  createRoot,
  config,
  projectConfig,
  resumeSessionId,
  forceWizard,
  bootProviders,
  bootPrereqs,
  contextManager,
});
