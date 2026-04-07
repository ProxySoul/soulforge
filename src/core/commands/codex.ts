import { getProvider } from "../llm/providers/index.js";
import type { CommandHandler } from "./types.js";

async function handleCodexLogin(_input: string): Promise<void> {
  const provider = getProvider("codex");
  if (!provider?.onRequestAuth) {
    throw new Error("Codex auth flow is not available.");
  }
  await provider.onRequestAuth();
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/codex login", handleCodexLogin);
}
