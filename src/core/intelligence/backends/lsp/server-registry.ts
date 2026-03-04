// ─── LSP Server Registry ───

import { execSync } from "node:child_process";
import type { Language } from "../../types.js";

export interface LspServerConfig {
  command: string;
  args: string[];
  language: Language;
}

interface ServerCandidate {
  command: string;
  args: string[];
}

const SERVER_CANDIDATES: Record<string, ServerCandidate[]> = {
  typescript: [{ command: "typescript-language-server", args: ["--stdio"] }],
  javascript: [{ command: "typescript-language-server", args: ["--stdio"] }],
  python: [
    { command: "pyright-langserver", args: ["--stdio"] },
    { command: "pylsp", args: [] },
  ],
  go: [{ command: "gopls", args: ["serve"] }],
  rust: [{ command: "rust-analyzer", args: [] }],
};

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Cache of probed commands to avoid repeated shell execs */
const probeCache = new Map<string, boolean>();

function commandExistsCached(cmd: string): boolean {
  const cached = probeCache.get(cmd);
  if (cached !== undefined) return cached;
  const exists = commandExists(cmd);
  probeCache.set(cmd, exists);
  return exists;
}

/**
 * Find an LSP server for the given language.
 * Probes PATH for known server binaries, returns the first match.
 */
export function findServerForLanguage(language: Language): LspServerConfig | null {
  const candidates = SERVER_CANDIDATES[language];
  if (!candidates) return null;

  for (const candidate of candidates) {
    if (commandExistsCached(candidate.command)) {
      return {
        command: candidate.command,
        args: candidate.args,
        language,
      };
    }
  }

  return null;
}

/** Clear the probe cache (useful for testing) */
export function clearProbeCache(): void {
  probeCache.clear();
}
