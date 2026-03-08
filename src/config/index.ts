import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../types";

const CONFIG_DIR = join(homedir(), ".soulforge");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: AppConfig = {
  defaultModel: "anthropic/claude-3-haiku-20240307",
  routerRules: [],
  editor: {
    command: "nvim",
    args: [],
  },
  theme: {
    accentColor: "cyan",
  },
  nvimConfig: "auto",
  editorIntegration: {
    diagnostics: true,
    symbols: true,
    hover: true,
    references: true,
    definition: true,
    codeActions: true,
    editorContext: true,
    rename: true,
    lspStatus: true,
    format: true,
  },
  codeExecution: false,
  webSearch: true,
};

/** Load global config from ~/.soulforge/config.json */
export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Load project-level config from <cwd>/.soulforge/config.json */
export function loadProjectConfig(cwd: string): Partial<AppConfig> | null {
  const projectFile = join(cwd, ".soulforge", "config.json");
  if (!existsSync(projectFile)) return null;
  try {
    const raw = readFileSync(projectFile, "utf-8");
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    return null;
  }
}

/**
 * Merge configs with priority: project > global.
 * Nested objects (editor, theme) are shallow-merged.
 */
export function mergeConfigs(global: AppConfig, project: Partial<AppConfig> | null): AppConfig {
  const layers: Partial<AppConfig>[] = [global];
  if (project) layers.push(project);

  let merged: AppConfig = { ...global };
  for (const layer of layers.slice(1)) {
    const ei = layer.editorIntegration
      ? { ...merged.editorIntegration, ...layer.editorIntegration }
      : merged.editorIntegration;
    const ci = layer.codeIntelligence
      ? { ...merged.codeIntelligence, ...layer.codeIntelligence }
      : merged.codeIntelligence;
    const th = layer.thinking ? { ...merged.thinking, ...layer.thinking } : merged.thinking;
    const perf = layer.performance
      ? { ...merged.performance, ...layer.performance }
      : merged.performance;
    const cm = layer.contextManagement
      ? { ...merged.contextManagement, ...layer.contextManagement }
      : merged.contextManagement;
    const comp = layer.compaction
      ? { ...merged.compaction, ...layer.compaction }
      : merged.compaction;
    merged = {
      ...merged,
      ...layer,
      editor: { ...merged.editor, ...layer.editor },
      theme: { ...merged.theme, ...layer.theme },
      editorIntegration: ei,
      codeIntelligence: ci,
      thinking: th,
      performance: perf,
      contextManagement: cm,
      compaction: comp,
    };
  }
  return merged;
}

/** Save global config to ~/.soulforge/config.json */
export function saveConfig(config: AppConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Save a partial config to <cwd>/.soulforge/config.json (deep-merge). */
export function saveProjectConfig(cwd: string, patch: Partial<AppConfig>): void {
  const dir = join(cwd, ".soulforge");
  const file = join(dir, "config.json");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Partial<AppConfig> = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf-8")) as Partial<AppConfig>;
  } catch {
    // no existing file
  }

  const merged: Partial<AppConfig> = { ...existing, ...patch };
  if (patch.thinking) merged.thinking = { ...existing.thinking, ...patch.thinking };
  if (patch.performance) merged.performance = { ...existing.performance, ...patch.performance };
  if (patch.contextManagement)
    merged.contextManagement = { ...existing.contextManagement, ...patch.contextManagement };

  writeFileSync(file, JSON.stringify(merged, null, 2));
}

/** Save a partial config to ~/.soulforge/config.json (deep-merge). */
export function saveGlobalConfig(patch: Partial<AppConfig>): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  let existing: AppConfig = DEFAULT_CONFIG;
  try {
    existing = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    // no existing file
  }

  const merged: AppConfig = { ...existing, ...patch };
  if (patch.thinking) merged.thinking = { ...existing.thinking, ...patch.thinking };
  if (patch.performance) merged.performance = { ...existing.performance, ...patch.performance };
  if (patch.contextManagement)
    merged.contextManagement = { ...existing.contextManagement, ...patch.contextManagement };

  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

/** Remove specific top-level keys from project config. */
export function removeProjectConfigKeys(cwd: string, keys: string[]): void {
  const file = join(cwd, ".soulforge", "config.json");
  if (!existsSync(file)) return;
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    for (const k of keys) delete existing[k];
    writeFileSync(file, JSON.stringify(existing, null, 2));
  } catch {}
}

/** Remove specific top-level keys from global config. */
export function removeGlobalConfigKeys(keys: string[]): void {
  if (!existsSync(CONFIG_FILE)) return;
  try {
    const existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    for (const k of keys) delete existing[k];
    writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
  } catch {}
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

const NESTED_KEYS = [
  "editor",
  "theme",
  "editorIntegration",
  "codeIntelligence",
  "thinking",
  "performance",
  "contextManagement",
] as const;

export function applyConfigPatch<T extends Partial<AppConfig>>(
  base: T,
  patch: Partial<AppConfig>,
): T {
  const result = { ...base, ...patch } as Record<string, unknown>;
  for (const key of NESTED_KEYS) {
    const b = (base as Record<string, unknown>)[key];
    const p = (patch as Record<string, unknown>)[key];
    if (p && b && typeof b === "object" && typeof p === "object") {
      result[key] = { ...b, ...p };
    }
  }
  return result as T;
}

export function stripConfigKeys<T extends Partial<AppConfig>>(config: T, keys: string[]): T {
  const result = { ...config };
  for (const k of keys) delete (result as Record<string, unknown>)[k];
  return result;
}
