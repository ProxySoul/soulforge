import { loadConfig, loadProjectConfig, mergeConfigs } from "../config/index.js";
import { getProviderSecretEntries, registerCustomProviders } from "../core/llm/providers/index.js";
import { registerProviderSecrets } from "../core/secrets.js";
import type { AppConfig } from "../types/index.js";
import { VERSION } from "./constants.js";
import { listModels, listProviders, setKey } from "./providers.js";
import { runChat, runPrompt } from "./run.js";
import type { HeadlessAction } from "./types.js";

export { parseHeadlessArgs } from "./parse.js";
export type { HeadlessAction, HeadlessChatOptions, HeadlessRunOptions } from "./types.js";

async function initConfig(cwd?: string): Promise<AppConfig> {
  const config = loadConfig();
  const projectConfig = loadProjectConfig(cwd ?? process.cwd());
  const merged = mergeConfigs(config, projectConfig);
  if (merged.keyPriority) {
    const { setDefaultKeyPriority } = await import("../core/secrets.js");
    setDefaultKeyPriority(merged.keyPriority);
  }
  if (merged.providers && merged.providers.length > 0) {
    registerCustomProviders(merged.providers);
  }
  registerProviderSecrets(getProviderSecretEntries());
  return merged;
}

export async function runHeadless(action: HeadlessAction): Promise<void> {
  if (action.type === "version") {
    process.stdout.write(`soulforge ${VERSION}\n`);
    return;
  }

  const cwd =
    action.type === "run" ? action.opts.cwd : action.type === "chat" ? action.opts.cwd : undefined;
  const config = await initConfig(cwd);

  switch (action.type) {
    case "list-providers":
      await listProviders();
      break;
    case "list-models":
      await listModels(action.provider);
      break;
    case "set-key":
      setKey(action.provider, action.key);
      break;
    case "run":
      await runPrompt(action.opts, config);
      break;
    case "chat":
      await runChat(action.opts, config);
      break;
  }
}
