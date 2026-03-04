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

  // Tier 1: ts-morph for TypeScript/JavaScript
  const tsMorph = new TsMorphBackend();
  router.registerBackend(tsMorph);

  // Tier 2: LSP for semantic intelligence (any language with an LSP server)
  const lsp = new LspBackend();
  router.registerBackend(lsp);

  // Tier 3: tree-sitter for universal AST parsing
  const treeSitter = new TreeSitterBackend();
  router.registerBackend(treeSitter);

  // Tier 4: regex fallback (always works)
  const regex = new RegexBackend();
  regex.setCache(router.fileCache);
  router.registerBackend(regex);

  return router;
}

/** Dispose the singleton router and all backends */
export function disposeIntelligenceRouter(): void {
  if (router) {
    router.dispose();
    router = null;
  }
}
