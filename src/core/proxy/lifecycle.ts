import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import { toErrorMessage } from "../../utils/errors.js";
import { trackProcess } from "../process-tracker.js";
import { getVendoredPath, installProxy, PROXY_VERSION } from "../setup/install.js";

let proxyProcess: ChildProcess | null = null;

const PROXY_URL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "soulforge";
const PROXY_CONFIG_DIR = join(homedir(), ".soulforge", "proxy");
const PROXY_CONFIG_PATH = join(PROXY_CONFIG_DIR, "config.yaml");
const HEALTH_TIMEOUT_MS = 2000;
const STARTUP_POLL_MS = 500;
const STARTUP_POLL_ATTEMPTS = 10;

type ProxyState = "stopped" | "starting" | "running" | "needs-auth" | "error";

let currentState: ProxyState = "stopped";
let lastError: string | null = null;
const stateListeners = new Set<(state: ProxyState, error: string | null) => void>();

function setState(state: ProxyState, error: string | null = null): void {
  currentState = state;
  lastError = error;
  for (const fn of stateListeners) fn(state, error);
}

function getProxyState(): { state: ProxyState; error: string | null } {
  return { state: currentState, error: lastError };
}

const VERSION_FILE = join(PROXY_CONFIG_DIR, "version");

function getInstalledProxyVersion(): string {
  try {
    if (existsSync(VERSION_FILE)) {
      const v = readFileSync(VERSION_FILE, "utf-8").trim();
      if (v) return v;
    }
  } catch {}
  return PROXY_VERSION;
}

function saveInstalledProxyVersion(version: string): void {
  mkdirSync(PROXY_CONFIG_DIR, { recursive: true });
  writeFileSync(VERSION_FILE, version);
}

// Marker stamped into the config so we know perf defaults were applied.
// Bump the version when defaults change — the old block is replaced.
const PERF_MARKER_PREFIX = "# soulforge-perf-defaults";
const PERF_MARKER_VERSION = 1;
const PERF_MARKER = `${PERF_MARKER_PREFIX} v${String(PERF_MARKER_VERSION)}`;

// Top-level YAML keys our perf block introduces.
// Go's yaml.v3 rejects duplicate keys, so we must skip if any already exist.
const PERF_KEYS = [
  "request-retry",
  "max-retry-interval",
  "max-retry-credentials",
  "streaming",
  "nonstream-keepalive-interval",
];

const PERF_BLOCK = [
  PERF_MARKER,
  "request-retry: 1",
  "max-retry-interval: 10",
  "max-retry-credentials: 2",
  "streaming:",
  "  keepalive-seconds: 15",
  "  bootstrap-retries: 1",
  "nonstream-keepalive-interval: 30",
].join("\n");

/**
 * Check whether any of our perf keys already exist as top-level YAML keys.
 * A top-level key is a non-indented, non-comment line starting with `key:`.
 */
function hasConflictingKeys(content: string): boolean {
  for (const line of content.split("\n")) {
    if (line.length === 0 || line[0] === "#" || line[0] === " " || line[0] === "\t") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (PERF_KEYS.includes(key)) return true;
  }
  return false;
}

function ensureConfig(): void {
  mkdirSync(PROXY_CONFIG_DIR, { recursive: true });

  if (!existsSync(PROXY_CONFIG_PATH)) {
    writeFileSync(
      PROXY_CONFIG_PATH,
      [
        "host: 127.0.0.1",
        "port: 8317",
        'auth-dir: "~/.cli-proxy-api"',
        "api-keys:",
        '  - "soulforge"',
        "",
        PERF_BLOCK,
        "",
      ].join("\n"),
    );
    return;
  }

  // Existing config — stamp or upgrade the perf block
  try {
    const existing = readFileSync(PROXY_CONFIG_PATH, "utf-8");

    if (existing.includes(PERF_MARKER)) return; // current version already applied

    // Strip any older perf block (different version) before appending the new one
    let cleaned = existing;
    if (existing.includes(PERF_MARKER_PREFIX)) {
      const lines = existing.split("\n");
      const start = lines.findIndex((l) => l.startsWith(PERF_MARKER_PREFIX));
      if (start !== -1) {
        // Remove from marker to next blank line or EOF
        let end = start + 1;
        while (end < lines.length && lines[end]?.trim() !== "") end++;
        lines.splice(start, end - start);
        cleaned = lines.join("\n");
      }
    }

    // If the user already set any of our keys manually, don't inject — would
    // create duplicate YAML keys and crash Go's yaml.v3 parser.
    if (hasConflictingKeys(cleaned)) return;

    const sep = cleaned.endsWith("\n") ? "" : "\n";
    writeFileSync(PROXY_CONFIG_PATH, `${cleaned}${sep}\n${PERF_BLOCK}\n`);
  } catch {
    // Don't block startup if config is unreadable
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getProxyBinary(): string | null {
  const vendored = getVendoredPath("cli-proxy-api");
  if (vendored) return vendored;
  if (commandExists("cli-proxy-api")) return "cli-proxy-api";
  if (commandExists("cliproxyapi")) return "cliproxyapi";
  return null;
}

async function healthCheck(): Promise<"ok" | "auth-required" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${PROXY_URL}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    });
    clearTimeout(timeout);
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "auth-required";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function ensureProxy(): Promise<{ ok: boolean; error?: string }> {
  if (currentState === "starting") {
    return { ok: false, error: "Proxy is already starting" };
  }

  const health = await healthCheck();
  if (health === "ok") {
    setState("running");
    return { ok: true };
  }
  if (health === "auth-required") {
    setState("needs-auth", "Authentication required — run /proxy login");
    return { ok: false, error: "Authentication required — run /proxy login" };
  }

  setState("starting");

  let binary = getProxyBinary();
  if (!binary) {
    try {
      binary = await installProxy();
      saveInstalledProxyVersion(PROXY_VERSION);
    } catch (err) {
      const msg = toErrorMessage(err);
      setState("error", `Failed to install CLIProxyAPI: ${msg}`);
      return { ok: false, error: `Failed to install CLIProxyAPI: ${msg}` };
    }
  }

  ensureConfig();
  try {
    proxyProcess = spawn(binary, ["-config", PROXY_CONFIG_PATH], {
      detached: false,
      stdio: "ignore",
    });
    trackProcess(proxyProcess);
    proxyProcess.on("error", (err) => {
      logBackgroundError("CLIProxyAPI", err.message);
      setState("error", `Process error: ${err.message}`);
      proxyProcess = null;
    });
    proxyProcess.on("exit", (code, signal) => {
      if (code != null && code !== 0) {
        logBackgroundError("CLIProxyAPI", `exited with code ${code}`);
        setState("error", `Process exited with code ${String(code)}`);
      } else if (signal) {
        logBackgroundError("CLIProxyAPI", `killed by ${signal}`);
        if (currentState !== "stopped") {
          setState("error", `Process killed by ${signal}`);
        }
      } else {
        setState("stopped");
      }
      proxyProcess = null;
    });
  } catch (err) {
    const msg = toErrorMessage(err);
    setState("error", `Failed to spawn CLIProxyAPI: ${msg}`);
    return { ok: false, error: `Failed to spawn CLIProxyAPI: ${msg}` };
  }

  for (let i = 0; i < STARTUP_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
    const status = await healthCheck();
    if (status === "ok") {
      setState("running");
      return { ok: true };
    }
    if (status === "auth-required") {
      setState("needs-auth", "Authentication required — run /proxy login");
      return { ok: false, error: "Authentication required — run /proxy login" };
    }
  }

  stopProxy();
  setState("error", "CLIProxyAPI started but not responding after 5s");
  return {
    ok: false,
    error:
      "CLIProxyAPI started but not responding. You may need to authenticate — run /proxy login",
  };
}

export function stopProxy(): void {
  if (proxyProcess) {
    const pid = proxyProcess.pid;
    try {
      proxyProcess.kill();
    } catch (err) {
      if (pid != null) {
        logBackgroundError(
          "CLIProxyAPI",
          `Failed to kill process ${String(pid)}: ${toErrorMessage(err)}`,
        );
      }
    }
    proxyProcess = null;
  }
  setState("stopped");
}

export function getProxyPid(): number | null {
  return proxyProcess?.pid ?? null;
}

interface ProxyProvider {
  id: string;
  name: string;
  flag: string;
  prefix: string;
}

export const PROXY_PROVIDERS: ProxyProvider[] = [
  { id: "claude", name: "Claude", flag: "-claude-login", prefix: "claude-" },
  { id: "google", name: "Google (Gemini)", flag: "-login", prefix: "gemini-" },
  { id: "openai", name: "OpenAI", flag: "-codex-login", prefix: "codex-" },
  { id: "codex", name: "Codex (device)", flag: "-codex-device-login", prefix: "codex-" },
  { id: "qwen", name: "Qwen", flag: "-qwen-login", prefix: "qwen-" },
  { id: "kimi", name: "Kimi", flag: "-kimi-login", prefix: "kimi-" },
  { id: "iflow", name: "iFlow", flag: "-iflow-login", prefix: "iflow-" },
];

const AUTH_DIR = join(homedir(), ".cli-proxy-api");

export interface ProxyAccount {
  file: string;
  provider: string;
  label: string;
}

export function listProxyAccounts(): ProxyAccount[] {
  if (!existsSync(AUTH_DIR)) return [];
  const files = readdirSync(AUTH_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const base = f.replace(/\.json$/, "");
    const provider =
      PROXY_PROVIDERS.find((p) => base.startsWith(p.prefix))?.name ??
      base.split("-")[0] ??
      "Unknown";
    const label = base.replace(/^[^-]+-/, "");
    return { file: f, provider, label };
  });
}

export function removeProxyAccount(file: string): boolean {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) return false;
  const resolved = join(AUTH_DIR, file);
  if (!resolved.startsWith(AUTH_DIR)) return false;
  if (!existsSync(resolved)) return false;
  unlinkSync(resolved);
  return true;
}

interface ProxyLoginHandle {
  promise: Promise<{ ok: boolean }>;
  abort: () => void;
}

export function runProxyLogin(
  onOutput: (line: string) => void,
  providerFlag?: string,
): ProxyLoginHandle {
  const binary = getProxyBinary();
  if (!binary) {
    onOutput("CLIProxyAPI binary not found. Run /proxy install first.");
    return { promise: Promise.resolve({ ok: false }), abort: () => {} };
  }
  ensureConfig();

  const flag = providerFlag ?? "-claude-login";
  const proc = spawn(binary, ["-config", PROXY_CONFIG_PATH, flag], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackProcess(proc);

  const handleData = (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) onOutput(trimmed);
    }
  };

  proc.stdout?.on("data", handleData);
  proc.stderr?.on("data", handleData);

  const promise = new Promise<{ ok: boolean }>((resolve) => {
    proc.on("close", async (code) => {
      if (code === 0) {
        const result = await ensureProxy();
        resolve({ ok: result.ok });
      } else {
        resolve({ ok: false });
      }
    });
    proc.on("error", (err) => {
      onOutput(`Login failed: ${err.message}`);
      resolve({ ok: false });
    });
  });

  const abort = () => {
    try {
      proc.kill();
    } catch {}
  };

  return { promise, abort };
}

interface ProxyVersionInfo {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
}

let cachedLatest: { version: string; checkedAt: number } | null = null;
const VERSION_CACHE_TTL = 10 * 60 * 1000; // 10 min

export async function checkForProxyUpdate(): Promise<ProxyVersionInfo> {
  const installed = getInstalledProxyVersion();
  const now = Date.now();

  if (cachedLatest && now - cachedLatest.checkedAt < VERSION_CACHE_TTL) {
    return {
      installed,
      latest: cachedLatest.version,
      updateAvailable: cachedLatest.version !== installed,
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
      {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    clearTimeout(timeout);
    if (!res.ok) return { installed, latest: null, updateAvailable: false };
    const data = (await res.json()) as { tag_name?: string };
    const tag = data.tag_name?.replace(/^v/, "") ?? null;
    if (tag) cachedLatest = { version: tag, checkedAt: now };
    return { installed, latest: tag, updateAvailable: tag != null && tag !== installed };
  } catch {
    return { installed, latest: null, updateAvailable: false };
  }
}

export async function upgradeProxy(
  onStatus: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const vinfo = await checkForProxyUpdate();
  if (!vinfo.updateAvailable || !vinfo.latest) {
    return { ok: true };
  }

  const wasRunning = currentState === "running";

  if (wasRunning) {
    onStatus("Stopping proxy…");
    stopProxy();
    await new Promise((r) => setTimeout(r, 500));
  }

  onStatus(`Downloading CLIProxyAPI v${vinfo.latest}…`);
  try {
    await installProxy(vinfo.latest);
    saveInstalledProxyVersion(vinfo.latest);
  } catch (err) {
    const msg = toErrorMessage(err);
    onStatus(`Upgrade failed: ${msg}`);
    if (wasRunning) {
      onStatus("Restarting proxy with previous version…");
      await ensureProxy();
    }
    return { ok: false, error: msg };
  }

  cachedLatest = null;

  if (wasRunning) {
    onStatus("Starting proxy…");
    const result = await ensureProxy();
    if (!result.ok) {
      onStatus(`Upgraded but failed to restart: ${result.error ?? "unknown"}`);
      return { ok: false, error: result.error };
    }
  }

  onStatus(`Upgraded to v${vinfo.latest}`);
  return { ok: true };
}

interface ProxyStatus {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  state: ProxyState;
  endpoint: string;
  pid: number | null;
  models: string[];
  error: string | null;
  version: ProxyVersionInfo | null;
}

export async function fetchProxyStatus(): Promise<ProxyStatus> {
  const binaryPath = getProxyBinary();
  const pid = getProxyPid();
  const { state, error } = getProxyState();
  const status: ProxyStatus = {
    installed: !!binaryPath,
    binaryPath,
    running: false,
    state,
    endpoint: PROXY_URL.replace(/\/v1$/, ""),
    pid,
    models: [],
    error,
    version: null,
  };

  const [, versionInfo] = await Promise.all([
    (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
        const res = await fetch(`${PROXY_URL}/models`, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
        });
        clearTimeout(timeout);
        if (res.ok) {
          status.running = true;
          const data = (await res.json()) as { data?: { id: string }[] };
          status.models = (data.data ?? []).map((m) => m.id);
        }
      } catch (err) {
        status.error = toErrorMessage(err);
      }
    })(),
    checkForProxyUpdate(),
  ]);
  status.version = versionInfo;

  return status;
}
