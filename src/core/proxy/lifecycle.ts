import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import { getVendoredPath, installProxy } from "../setup/install.js";

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



function ensureConfig(): void {
  if (existsSync(PROXY_CONFIG_PATH)) return;
  mkdirSync(PROXY_CONFIG_DIR, { recursive: true });
  writeFileSync(
    PROXY_CONFIG_PATH,
    [
      "host: 127.0.0.1",
      "port: 8317",
      'auth-dir: "~/.cli-proxy-api"',
      "api-keys:",
      '  - "soulforge"',
      "",
    ].join("\n"),
  );
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    proxyProcess.unref();
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
    const msg = err instanceof Error ? err.message : String(err);
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
          `Failed to kill process ${String(pid)}: ${err instanceof Error ? err.message : String(err)}`,
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

interface ProxyLoginHandle {
  promise: Promise<{ ok: boolean }>;
  abort: () => void;
}

export function runProxyLogin(onOutput: (line: string) => void): ProxyLoginHandle {
  const binary = getProxyBinary();
  if (!binary) {
    onOutput("CLIProxyAPI binary not found. Run /proxy install first.");
    return { promise: Promise.resolve({ ok: false }), abort: () => {} };
  }
  ensureConfig();

  const proc = spawn(binary, ["-config", PROXY_CONFIG_PATH, "-claude-login"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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

interface ProxyStatus {
  installed: boolean;
  binaryPath: string | null;
  running: boolean;
  state: ProxyState;
  endpoint: string;
  pid: number | null;
  models: string[];
  error: string | null;
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
  };

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
    status.error = err instanceof Error ? err.message : String(err);
  }

  return status;
}
