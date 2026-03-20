import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRETS_DIR = join(homedir(), ".soulforge");
const SECRETS_FILE = join(SECRETS_DIR, "secrets.json");
const KEYCHAIN_SERVICE = "soulforge";

type SecretKey =
  | "brave-api-key"
  | "jina-api-key"
  | "anthropic-api-key"
  | "openai-api-key"
  | "google-api-key"
  | "xai-api-key"
  | "openrouter-api-key"
  | "llmgateway-api-key"
  | "vercel-gateway-api-key";

const ENV_MAP: Record<SecretKey, string> = {
  "brave-api-key": "BRAVE_SEARCH_API_KEY",
  "jina-api-key": "JINA_API_KEY",
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "openai-api-key": "OPENAI_API_KEY",
  "google-api-key": "GOOGLE_GENERATIVE_AI_API_KEY",
  "xai-api-key": "XAI_API_KEY",
  "openrouter-api-key": "OPENROUTER_API_KEY",
  "llmgateway-api-key": "LLM_GATEWAY_API_KEY",
  "vercel-gateway-api-key": "AI_GATEWAY_API_KEY",
};

function keychainAvailable(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform === "linux") {
    const result = spawnSync("which", ["secret-tool"], { timeout: 2000 });
    return result.status === 0;
  }
  return false;
}

function keychainGet(key: SecretKey): string | null {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "security",
        ["find-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key, "-w"],
        { timeout: 5000, encoding: "utf-8" },
      );
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    }

    if (process.platform === "linux") {
      const result = spawnSync("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
        encoding: "utf-8",
      });
      if (result.status === 0 && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    }
  } catch {}
  return null;
}

function keychainSet(key: SecretKey, value: string): boolean {
  try {
    if (process.platform === "darwin") {
      spawnSync("security", ["delete-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key], {
        timeout: 5000,
      });
      const result = spawnSync(
        "security",
        ["add-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key, "-w", value],
        { timeout: 5000 },
      );
      return result.status === 0;
    }

    if (process.platform === "linux") {
      const result = spawnSync(
        "secret-tool",
        ["store", "--label", `SoulForge ${key}`, "service", KEYCHAIN_SERVICE, "key", key],
        { input: value, timeout: 5000, encoding: "utf-8" },
      );
      return result.status === 0;
    }
  } catch {}
  return false;
}

function keychainDelete(key: SecretKey): boolean {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync(
        "security",
        ["delete-generic-password", "-a", KEYCHAIN_SERVICE, "-s", key],
        { timeout: 5000 },
      );
      return result.status === 0;
    }

    if (process.platform === "linux") {
      const result = spawnSync("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "key", key], {
        timeout: 5000,
      });
      return result.status === 0;
    }
  } catch {}
  return false;
}

function fileRead(): Record<string, string> {
  try {
    if (existsSync(SECRETS_FILE)) {
      return JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as Record<string, string>;
    }
  } catch {}
  return {};
}

function fileWrite(data: Record<string, string>): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2));
  chmodSync(SECRETS_FILE, 0o600);
}

export function getSecret(key: SecretKey): string | null {
  const envVar = ENV_MAP[key];
  if (envVar) {
    const envValue = process.env[envVar];
    if (envValue) return envValue;
  }

  if (keychainAvailable()) {
    const value = keychainGet(key);
    if (value) return value;
  }

  const data = fileRead();
  return data[key] ?? null;
}

export interface SetSecretResult {
  success: boolean;
  storage: "keychain" | "file";
  path?: string;
}

export function setSecret(key: SecretKey, value: string): SetSecretResult {
  if (keychainAvailable()) {
    if (keychainSet(key, value)) {
      const data = fileRead();
      if (data[key]) {
        delete data[key];
        fileWrite(data);
      }
      return { success: true, storage: "keychain" };
    }
  }

  const data = fileRead();
  data[key] = value;
  fileWrite(data);
  return { success: true, storage: "file", path: SECRETS_FILE };
}

/**
 * Store a secret using an arbitrary label (for custom providers).
 * Uses the same keychain/file backends as setSecret but bypasses the SecretKey union.
 */
export function setCustomSecret(label: string, value: string): SetSecretResult {
  if (keychainAvailable()) {
    if (keychainSet(label as SecretKey, value)) {
      const data = fileRead();
      if (data[label]) {
        delete data[label];
        fileWrite(data);
      }
      return { success: true, storage: "keychain" };
    }
  }

  const data = fileRead();
  data[label] = value;
  fileWrite(data);
  return { success: true, storage: "file", path: SECRETS_FILE };
}

export function deleteSecret(key: SecretKey): { success: boolean; storage: "keychain" | "file" } {
  let deleted = false;
  let storage: "keychain" | "file" = "file";

  if (keychainAvailable()) {
    deleted = keychainDelete(key);
    if (deleted) storage = "keychain";
  }

  const data = fileRead();
  if (data[key]) {
    delete data[key];
    fileWrite(data);
    deleted = true;
  }

  return { success: deleted, storage };
}

export function hasSecret(key: SecretKey): {
  set: boolean;
  source: "env" | "keychain" | "file" | "none";
} {
  const envVar = ENV_MAP[key];
  if (envVar && process.env[envVar]) {
    return { set: true, source: "env" };
  }

  if (keychainAvailable()) {
    const value = keychainGet(key);
    if (value) return { set: true, source: "keychain" };
  }

  const data = fileRead();
  if (data[key]) return { set: true, source: "file" };

  return { set: false, source: "none" };
}

export function getStorageBackend(): "keychain" | "file" {
  return keychainAvailable() ? "keychain" : "file";
}

export type { SecretKey };

/** Reverse lookup: given an env var name, find its SecretKey */
const ENV_TO_SECRET = new Map(Object.entries(ENV_MAP).map(([k, v]) => [v, k as SecretKey]));

/**
 * Resolve a provider API key: checks process.env first, then secrets store.
 * Used by provider createModel/fetchModels as a drop-in for process.env[envVar].
 */
export function getProviderApiKey(envVar: string): string | undefined {
  const envValue = process.env[envVar];
  if (envValue) return envValue;
  const secretKey = ENV_TO_SECRET.get(envVar);
  if (secretKey) return getSecret(secretKey) ?? undefined;
  // Custom provider keys: check keychain and file store by env var name
  if (keychainAvailable()) {
    const value = keychainGet(envVar as SecretKey);
    if (value) return value;
  }
  const data = fileRead();
  return data[envVar] ?? undefined;
}
