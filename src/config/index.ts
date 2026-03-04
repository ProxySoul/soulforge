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
 * Merge configs with priority: session > project > global.
 * Nested objects (editor, theme) are shallow-merged.
 */
export function mergeConfigs(
  global: AppConfig,
  project: Partial<AppConfig> | null,
  session: Partial<AppConfig> | null,
): AppConfig {
  const layers: Partial<AppConfig>[] = [global];
  if (project) layers.push(project);
  if (session) layers.push(session);

  let merged: AppConfig = { ...global };
  for (const layer of layers.slice(1)) {
    const ei = layer.editorIntegration
      ? { ...merged.editorIntegration, ...layer.editorIntegration }
      : merged.editorIntegration;
    const ci = layer.codeIntelligence
      ? { ...merged.codeIntelligence, ...layer.codeIntelligence }
      : merged.codeIntelligence;
    merged = {
      ...merged,
      ...layer,
      editor: { ...merged.editor, ...layer.editor },
      theme: { ...merged.theme, ...layer.theme },
      editorIntegration: ei,
      codeIntelligence: ci,
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

export function getConfigDir(): string {
  return CONFIG_DIR;
}
