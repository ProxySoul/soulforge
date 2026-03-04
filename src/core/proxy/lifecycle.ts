import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getVendoredPath, installProxy } from "../setup/install.js";

let proxyProcess: ChildProcess | null = null;

const PROXY_URL = process.env.PROXY_API_URL || "http://127.0.0.1:8317/v1";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "soulforge";
const PROXY_CONFIG_DIR = join(homedir(), ".soulforge", "proxy");
const PROXY_CONFIG_PATH = join(PROXY_CONFIG_DIR, "config.yaml");

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

export function getProxyBinary(): string | null {
  const vendored = getVendoredPath("cli-proxy-api");
  if (vendored) return vendored;
  if (commandExists("cli-proxy-api")) return "cli-proxy-api";
  if (commandExists("cliproxyapi")) return "cliproxyapi";
  return null;
}

export async function isProxyRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${PROXY_URL}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${PROXY_API_KEY}` },
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureProxy(): Promise<{ ok: boolean; error?: string }> {
  // Already running (externally or from a previous call)
  if (await isProxyRunning()) return { ok: true };

  // Get or install binary
  let binary = getProxyBinary();
  if (!binary) {
    try {
      binary = await installProxy();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to install CLIProxyAPI: ${msg}` };
    }
  }

  // Spawn background process
  ensureConfig();
  try {
    proxyProcess = spawn(binary, ["-config", PROXY_CONFIG_PATH], {
      detached: false,
      stdio: "ignore",
    });
    proxyProcess.unref();
    proxyProcess.on("error", () => {
      proxyProcess = null;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to spawn CLIProxyAPI: ${msg}` };
  }

  // Poll health endpoint
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isProxyRunning()) return { ok: true };
  }

  return {
    ok: false,
    error:
      "CLIProxyAPI started but not responding. You may need to authenticate — run /proxy login",
  };
}

export function stopProxy(): void {
  if (proxyProcess) {
    try {
      proxyProcess.kill();
    } catch {
      // already dead
    }
    proxyProcess = null;
  }
}

export function proxyLogin(): { command: string; args: string[] } {
  const binary = getProxyBinary();
  ensureConfig();
  return {
    command: binary ?? "cli-proxy-api",
    args: ["-config", PROXY_CONFIG_PATH, "-claude-login"],
  };
}
