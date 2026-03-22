import { LspBackend } from "./backends/lsp/index.js";
import { RegexBackend } from "./backends/regex.js";
import { TreeSitterBackend } from "./backends/tree-sitter.js";
import { TsMorphBackend } from "./backends/ts-morph.js";
import { CodeIntelligenceRouter } from "./router.js";
import type { CodeIntelligenceConfig } from "./types.js";

let router: CodeIntelligenceRouter | null = null;

/**
 * Get or create the singleton intelligence router.
 * Registers all available backends on first call.
 */
export function getIntelligenceRouter(
  cwd: string,
  config: CodeIntelligenceConfig = {},
): CodeIntelligenceRouter {
  if (router) return router;

  router = new CodeIntelligenceRouter(cwd, config);

  // Tier 1: LSP for semantic intelligence (rename, diagnostics, references, etc.)
  const lsp = new LspBackend();
  router.registerBackend(lsp);

  // Tier 2: ts-morph for TypeScript/JavaScript (fallback when LSP unavailable)
  const tsMorph = new TsMorphBackend();
  router.registerBackend(tsMorph);

  // Tier 3: tree-sitter for universal AST parsing
  const treeSitter = new TreeSitterBackend();
  router.registerBackend(treeSitter);

  // Tier 4: regex fallback (always works)
  const regex = new RegexBackend();
  regex.setCache(router.fileCache);
  router.registerBackend(regex);

  return router;
}

/**
 * Eagerly warm up the intelligence system.
 * Initializes all backends for the detected project language and
 * spawns LSP servers so they're ready before the first tool call.
 * Call this once at app startup — runs in the background.
 */
export function warmupIntelligence(cwd: string, config: CodeIntelligenceConfig = {}): void {
  const r = getIntelligenceRouter(cwd, config);
  r.warmup().catch(() => {
    // Non-fatal — tools will lazy-init if warmup fails
  });
}

/** Get the status of the intelligence system (null if not yet initialized) */
export function getIntelligenceStatus(): {
  initialized: string[];
  lspServers: Array<{ language: string; command: string }>;
} | null {
  if (!router) return null;
  return router.getStatus();
}

/** Get detailed LSP server info for the status popup */
export function getDetailedLspServers(): Array<{
  language: string;
  command: string;
  args: string[];
  pid: number | null;
  cwd: string;
  openFiles: number;
  diagnosticCount: number;
  diagnostics: Array<{ file: string; message: string; severity: number }>;
  ready: boolean;
}> {
  if (!router) return [];
  return router.getDetailedLspServers();
}

/** Restart LSP servers. Pass filter to restart specific server/language, or omit for all. */
export async function restartLspServers(filter?: string): Promise<string[]> {
  if (!router) return [];
  return router.restartLspServers(filter);
}

/** Get neovim's active LSP clients */
export async function getNvimLspClients(): Promise<Array<{
  name: string;
  language: string;
  pid: number | null;
}> | null> {
  if (!router) return null;
  return router.getNvimLspClients();
}

/** Get PIDs of all child processes managed by the intelligence system */
export function getIntelligenceChildPids(): number[] {
  if (!router) return [];
  return router.getChildPids();
}

/** Run intelligence health check — probes all backends */
export async function runIntelligenceHealthCheck(
  onProgress?: (partial: import("./router.js").HealthCheckResult) => void,
) {
  if (!router) return null;
  return router.runHealthCheck(onProgress);
}

/** Dispose the singleton router and all backends */
export function disposeIntelligenceRouter(): void {
  if (router) {
    router.dispose();
    router = null;
  }
}
