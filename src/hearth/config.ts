/**
 * Hearth config loader — merges ~/.soulforge/hearth.json and .soulforge/hearth.json
 * and fills defaults. Single source of truth for daemon + approve-cli.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ChatBinding,
  ExternalChatId,
  HearthConfig,
  HearthSurfaceConfig,
  SurfaceId,
} from "./types.js";

export const DEFAULT_SOCKET_PATH = join(homedir(), ".soulforge", "hearth.sock");
export const DEFAULT_STATE_PATH = join(homedir(), ".soulforge", "hearth-state.json");
export const DEFAULT_LOG_PATH = join(homedir(), ".soulforge", "hearth.log");
export const GLOBAL_CONFIG_PATH = join(homedir(), ".soulforge", "hearth.json");

const DEFAULT_AUTO_APPROVE = [
  "read",
  "Read",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
  "navigate",
  "Grep",
  "Glob",
  "list_dir",
  "discover_pattern",
];

const DEFAULT_AUTO_DENY = [
  "rm -rf /",
  "rm -rf /*",
  "git push --force*",
  "git push --force-with-lease*",
  "DROP TABLE *",
  "DROP DATABASE *",
];

export function makeDefaultConfig(): HearthConfig {
  return {
    surfaces: {},
    defaults: {
      autoApprove: [...DEFAULT_AUTO_APPROVE],
      autoDeny: [...DEFAULT_AUTO_DENY],
      readDenylistExtra: [],
      maxTabs: 5,
      caps: "main",
    },
    daemon: {
      socketPath: DEFAULT_SOCKET_PATH,
      stateFile: DEFAULT_STATE_PATH,
      logFile: DEFAULT_LOG_PATH,
      maxChats: 20,
      maxTabsPerChat: 5,
      approvalTimeoutMs: 5 * 60_000,
      pairingTtlMs: 10 * 60_000,
    },
  };
}

function readJsonFile<T>(path: string): Partial<T> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<T>;
  } catch {
    return null;
  }
}

function mergeSurfaces(
  a: Record<string, HearthSurfaceConfig>,
  b: Record<string, Partial<HearthSurfaceConfig>> | undefined,
): Record<SurfaceId, HearthSurfaceConfig> {
  const out: Record<string, HearthSurfaceConfig> = { ...a };
  for (const [id, cfg] of Object.entries(b ?? {})) {
    const existing = out[id];
    out[id] = {
      enabled: cfg?.enabled ?? existing?.enabled ?? true,
      transport: cfg?.transport ?? existing?.transport,
      chats: { ...(existing?.chats ?? {}), ...(cfg?.chats ?? {}) },
      allowed: { ...(existing?.allowed ?? {}), ...(cfg?.allowed ?? {}) },
    };
  }
  return out as Record<SurfaceId, HearthSurfaceConfig>;
}

export function loadHearthConfig(cwd?: string): HearthConfig {
  const base = makeDefaultConfig();
  const global = readJsonFile<HearthConfig>(GLOBAL_CONFIG_PATH) ?? {};
  const project = cwd
    ? (readJsonFile<HearthConfig>(join(cwd, ".soulforge", "hearth.json")) ?? {})
    : {};

  const merged: HearthConfig = {
    surfaces: mergeSurfaces(base.surfaces, {
      ...(global.surfaces ?? {}),
      ...(project.surfaces ?? {}),
    }),
    defaults: {
      ...base.defaults,
      ...(global.defaults ?? {}),
      ...(project.defaults ?? {}),
    },
    daemon: {
      ...base.daemon,
      ...(global.daemon ?? {}),
      ...(project.daemon ?? {}),
    },
  };

  // Resolve tilde in socket/state/log paths
  merged.daemon.socketPath = expandHome(merged.daemon.socketPath);
  merged.daemon.stateFile = expandHome(merged.daemon.stateFile);
  merged.daemon.logFile = expandHome(merged.daemon.logFile);
  return merged;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a chat binding with surface+global defaults applied. */
export function resolveChatBinding(
  config: HearthConfig,
  surfaceId: SurfaceId,
  externalId: ExternalChatId,
): ChatBinding | null {
  const surface = config.surfaces[surfaceId];
  if (!surface) return null;
  const chat = surface.chats[externalId];
  if (!chat) return null;

  const cwd = chat.cwd ? resolve(expandHome(chat.cwd)) : null;
  if (!cwd) return null;

  return {
    surfaceId,
    externalId,
    label: chat.label,
    cwd,
    defaultModel: chat.defaultModel,
    mode: chat.mode,
    caps: chat.caps ?? config.defaults.caps,
    autoApprove: chat.autoApprove ?? config.defaults.autoApprove,
    autoDeny: chat.autoDeny ?? config.defaults.autoDeny,
    readDenylistExtra: chat.readDenylistExtra ?? config.defaults.readDenylistExtra,
    dailyTokenBudget: chat.dailyTokenBudget,
    maxTabs: chat.maxTabs ?? config.defaults.maxTabs,
  };
}

export function writeGlobalHearthConfig(config: HearthConfig): void {
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Persist a freshly paired chat into the global config. Idempotent. */
export function upsertChatBinding(
  config: HearthConfig,
  surfaceId: SurfaceId,
  externalId: ExternalChatId,
  patch: Partial<ChatBinding>,
): HearthConfig {
  const surface = config.surfaces[surfaceId] ?? { enabled: true, chats: {}, allowed: {} };
  const existing = surface.chats[externalId] ?? {};
  const next: Partial<ChatBinding> = { ...existing, ...patch, surfaceId, externalId };
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      [surfaceId]: { ...surface, chats: { ...surface.chats, [externalId]: next } },
    },
  };
}
export const DEFAULT_PID_PATH = join(homedir(), ".soulforge", "hearth.pid");
