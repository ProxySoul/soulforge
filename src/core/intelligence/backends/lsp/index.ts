//
// Semantic intelligence via LSP:
// - When Neovim is running → bridges to Neovim's LSP (nvim-bridge)
// - When Neovim is NOT running → spawns servers directly (standalone-client)

import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CallHierarchyResult,
  type CodeAction,
  type CodeBlock,
  type Diagnostic,
  detectLanguageFromPath,
  type ExportInfo,
  type FileOutline,
  type FormatEdit,
  type ImportInfo,
  type IntelligenceBackend,
  type Language,
  type RefactorResult,
  type SourceLocation,
  type SymbolInfo,
  type SymbolKind,
  type TypeHierarchyResult,
  type TypeInfo,
} from "../../types.js";

// Lazy-loaded to avoid pulling in the nvim module chain in worker threads
// where getNvimInstance() always returns null.
let _nvimBridge: typeof import("./nvim-bridge.js") | null = null;
function getNvimBridge(): typeof import("./nvim-bridge.js") | null {
  if (_nvimBridge === null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _nvimBridge = require("./nvim-bridge.js") as typeof import("./nvim-bridge.js");
    } catch {
      return null;
    }
  }
  return _nvimBridge;
}
const nvimBridge = new Proxy({} as typeof import("./nvim-bridge.js"), {
  get(_target, prop: string) {
    const mod = getNvimBridge();
    if (!mod) return prop === "isNvimAvailable" ? () => false : undefined;
    return (mod as Record<string, unknown>)[prop];
  },
});

import {
  type LspCallHierarchyItem,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspMarkupContent,
  type LspSymbolInformation,
  type LspTextDocumentEdit,
  type LspTextEdit,
  type LspTypeHierarchyItem,
  type LspWorkspaceEdit,
  lspSeverityToSeverity,
  lspSymbolKindToSymbolKind,
  uriToFilePath,
} from "./protocol.js";
import { findServersForLanguage } from "./server-registry.js";
import { StandaloneLspClient } from "./standalone-client.js";

const SUPPORTED_LANGUAGES: Set<Language> = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "swift",
  "dart",
  "elixir",
  "ocaml",
  "lua",
  "c",
  "cpp",
  "ruby",
  "php",
  "zig",
  "bash",
  "css",
  "html",
  "json",
  "toml",
  "yaml",
  "dockerfile",
  "vue",
]);

export class LspBackend implements IntelligenceBackend {
  readonly name = "lsp";
  readonly tier = 1;

  private cwd = "";
  /** command:projectRoot → client */
  private standaloneClients = new Map<string, StandaloneLspClient>();
  /** language:projectRoot → client[] (index for fast lookup) */
  private languageClients = new Map<string, StandaloneLspClient[]>();
  /** Servers that failed to start — retry after cooldown (keyed by command:projectRoot → timestamp) */
  private static readonly FAILED_SERVER_COOLDOWN_MS = 60_000;
  private failedServers = new Map<string, number>();
  /** Pending init promises for deduplication (keyed by langKey) */
  private pendingInits = new Map<string, Promise<StandaloneLspClient[]>>();

  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  /** Find a real source file to use as LSP buffer anchor (for workspace-wide queries) */
  private async findAnchorFile(): Promise<string | null> {
    // Common entry points that are likely to exist
    const candidates = [
      "src/index.ts",
      "src/main.ts",
      "src/app.ts",
      "index.ts",
      "main.ts",
      "src/index.js",
      "src/main.js",
      "index.js",
      "main.py",
      "src/main.py",
      "main.go",
      "src/main.go",
      "src/lib.rs",
      "src/main.rs",
    ];
    for (const candidate of candidates) {
      const full = join(this.cwd, candidate);
      if (existsSync(full)) return full;
    }
    // Fallback: find any source file in src/ or root
    for (const dir of [join(this.cwd, "src"), this.cwd]) {
      if (!existsSync(dir)) continue;
      try {
        const files = await readdir(dir);
        const source = files.find(
          (f: string) =>
            f.endsWith(".ts") ||
            f.endsWith(".js") ||
            f.endsWith(".py") ||
            f.endsWith(".go") ||
            f.endsWith(".rs"),
        );
        if (source) return join(dir, source);
      } catch {}
    }
    return null;
  }

  supportsLanguage(language: Language): boolean {
    return SUPPORTED_LANGUAGES.has(language);
  }

  private async lspPositionRequest(
    file: string,
    symbol: string,
    line: number | undefined,
    column: number | undefined,
    method: "definition" | "references" | "implementation",
  ): Promise<SourceLocation[] | null> {
    const pos = await this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const locations =
        method === "definition"
          ? await nvimBridge.findDefinition(file, pos.line, pos.col)
          : method === "references"
            ? await nvimBridge.findReferences(file, pos.line, pos.col)
            : await nvimBridge.findImplementation(file, pos.line, pos.col);
      if (locations && locations.length > 0) return locations.map(lspLocationToSourceLocation);
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;

    const maxAttempts = client.isWarmingUp ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const locations =
          method === "definition"
            ? await client.textDocumentDefinition(file, pos.line, pos.col)
            : method === "references"
              ? await client.textDocumentReferences(file, pos.line, pos.col)
              : await client.textDocumentImplementation(file, pos.line, pos.col);
        if (locations.length > 0) return locations.map(lspLocationToSourceLocation);
      } catch {}
      if (attempt === 0 && client.isWarmingUp) {
        await new Promise<void>((r) => setTimeout(r, 2_000));
      }
    }
    return null;
  }

  async findDefinition(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    return this.lspPositionRequest(file, symbol, line, column, "definition");
  }

  async findReferences(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    return this.lspPositionRequest(file, symbol, line, column, "references");
  }

  async findSymbols(file: string, query?: string): Promise<SymbolInfo[] | null> {
    if (nvimBridge.isNvimAvailable()) {
      const raw = await nvimBridge.documentSymbols(file);
      if (raw && raw.length > 0) return flattenDocumentSymbols(raw, file, query);
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const raw = await client.textDocumentDocumentSymbol(file);
      if (raw.length > 0) return flattenDocumentSymbols(raw, file, query);
    } catch {}
    return null;
  }

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const absFile = resolve(file);
    let content: string;
    try {
      content = await readFile(absFile, "utf-8");
    } catch {
      return null;
    }

    const imports: ImportInfo[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      // JS/TS: import ... from '...' or import '...'
      const jsImport = trimmed.match(
        /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/,
      );
      if (jsImport) {
        const specifiers: string[] = [];
        let isDefault = false;
        let isNamespace = false;
        const specMatch = trimmed.match(/import\s+(\w+)/);
        const namedMatch = trimmed.match(/\{([^}]+)\}/);
        const nsMatch = trimmed.match(/\*\s+as\s+(\w+)/);
        if (nsMatch?.[1]) {
          isNamespace = true;
          specifiers.push(nsMatch[1]);
        } else if (specMatch?.[1] && specMatch[1] !== "type") {
          isDefault = true;
          specifiers.push(specMatch[1]);
        }
        if (namedMatch?.[1]) {
          specifiers.push(
            ...namedMatch[1]
              .split(",")
              .map((s) => s.trim().split(/\s+as\s+/)[0] ?? "")
              .filter(Boolean),
          );
        }
        imports.push({
          source: jsImport[1] ?? "",
          specifiers,
          isDefault,
          isNamespace,
          location: { file: absFile, line: i + 1, column: 1 },
        });
        continue;
      }

      // Python: import X / from X import Y
      if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
        const pyFrom = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
        const pyImport = trimmed.match(/^import\s+([\w.]+)/);
        if (pyFrom?.[1] && pyFrom[2]) {
          imports.push({
            source: pyFrom[1],
            specifiers: pyFrom[2]
              .split(",")
              .map((s) => s.trim().split(/\s+as\s+/)[0] ?? "")
              .filter(Boolean),
            isDefault: false,
            isNamespace: false,
            location: { file: absFile, line: i + 1, column: 1 },
          });
        } else if (pyImport?.[1]) {
          imports.push({
            source: pyImport[1],
            specifiers: [],
            isDefault: false,
            isNamespace: true,
            location: { file: absFile, line: i + 1, column: 1 },
          });
        }
        continue;
      }

      // Go: import "pkg" or import ( "pkg" )
      const goImport = trimmed.match(/^import\s+(?:(\w+)\s+)?["']([^"']+)["']/);
      if (goImport?.[2]) {
        imports.push({
          source: goImport[2],
          specifiers: goImport[1] ? [goImport[1]] : [],
          isDefault: false,
          isNamespace: !!goImport[1],
          location: { file: absFile, line: i + 1, column: 1 },
        });
        continue;
      }
      // Go: inside import block
      if (trimmed === "import (") {
        for (let j = i + 1; j < lines.length; j++) {
          const inner = (lines[j] ?? "").trim();
          if (inner === ")") break;
          const goInner = inner.match(/^(?:(\w+)\s+)?["']([^"']+)["']/);
          if (goInner?.[2]) {
            imports.push({
              source: goInner[2],
              specifiers: goInner[1] ? [goInner[1]] : [],
              isDefault: false,
              isNamespace: !!goInner[1],
              location: { file: absFile, line: j + 1, column: 1 },
            });
          }
        }
        continue;
      }

      // Rust: use crate::... / use std::...
      const rustUse = trimmed.match(/^use\s+([\w:]+)/);
      if (rustUse?.[1]) {
        imports.push({
          source: rustUse[1],
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          location: { file: absFile, line: i + 1, column: 1 },
        });
        continue;
      }

      // C/C++: #include <...> or #include "..."
      const cInclude = trimmed.match(/^#include\s+[<"]([^>"]+)[>"]/);
      if (cInclude?.[1]) {
        imports.push({
          source: cInclude[1],
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          location: { file: absFile, line: i + 1, column: 1 },
        });
        continue;
      }

      // Ruby: require 'x' / require_relative 'x'
      const rbRequire = trimmed.match(/^(?:require|require_relative)\s+['"]([^'"]+)['"]/);
      if (rbRequire?.[1]) {
        imports.push({
          source: rbRequire[1],
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          location: { file: absFile, line: i + 1, column: 1 },
        });
        continue;
      }

      // PHP: use Namespace\Class
      const phpUse = trimmed.match(/^use\s+([\w\\]+)/);
      if (phpUse?.[1]) {
        imports.push({
          source: phpUse[1],
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          location: { file: absFile, line: i + 1, column: 1 },
        });
      }
    }

    return imports.length > 0 ? imports : null;
  }

  async findExports(file: string): Promise<ExportInfo[] | null> {
    const absFile = resolve(file);
    let content: string;
    try {
      content = await readFile(absFile, "utf-8");
    } catch {
      return null;
    }

    // Get document symbols for richer data
    const symbols = await this.findSymbols(file);
    const exports: ExportInfo[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();

      // JS/TS: export ...
      if (trimmed.startsWith("export ")) {
        const isDefault = trimmed.startsWith("export default ");
        let name = "";
        let kind: SymbolKind = "variable";

        const funcMatch = trimmed.match(/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
        const classMatch = trimmed.match(/export\s+(?:default\s+)?class\s+(\w+)/);
        const constMatch = trimmed.match(/export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/);
        const typeMatch = trimmed.match(/export\s+(?:default\s+)?(?:type|interface)\s+(\w+)/);
        const enumMatch = trimmed.match(/export\s+(?:default\s+)?enum\s+(\w+)/);

        if (funcMatch?.[1]) {
          name = funcMatch[1];
          kind = "function";
        } else if (classMatch?.[1]) {
          name = classMatch[1];
          kind = "class";
        } else if (typeMatch?.[1]) {
          name = typeMatch[1];
          kind = trimmed.includes("interface") ? "interface" : "type";
        } else if (enumMatch?.[1]) {
          name = enumMatch[1];
          kind = "enum";
        } else if (constMatch?.[1]) {
          name = constMatch[1];
          kind = "variable";
        } else if (isDefault) {
          name = "default";
        }

        // Try to enrich with symbol info from documentSymbol
        if (name && symbols) {
          const sym = symbols.find((s) => s.name === name);
          if (sym?.kind) kind = sym.kind;
        }

        if (name) {
          exports.push({
            name,
            isDefault,
            kind,
            location: { file: absFile, line: i + 1, column: 1 },
          });
        }
        continue;
      }

      // Re-exports: export { ... } from '...'
      const reExport = trimmed.match(/^export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/);
      if (reExport?.[1]) {
        const names = reExport[1]
          .split(",")
          .map(
            (s) =>
              s
                .trim()
                .split(/\s+as\s+/)
                .pop() ?? "",
          )
          .filter(Boolean);
        for (const n of names) {
          exports.push({
            name: n,
            isDefault: false,
            kind: "variable",
            location: { file: absFile, line: i + 1, column: 1 },
          });
        }
      }

      // Python: __all__ = [...]
      if (trimmed.startsWith("__all__")) {
        const allMatch = content
          .slice(lines.slice(0, i).join("\n").length)
          .match(/__all__\s*=\s*\[([^\]]+)\]/);
        if (allMatch) {
          const names = allMatch[1]?.match(/['"](\w+)['"]/g);
          if (names) {
            for (const n of names) {
              exports.push({
                name: n.replace(/['"]/g, ""),
                isDefault: false,
                kind: "variable",
                location: { file: absFile, line: i + 1, column: 1 },
              });
            }
          }
        }
      }

      // Go: Exported names start with uppercase
      // We don't parse Go exports from content — use symbols
    }

    // For Go: any symbol starting with uppercase is exported
    if (symbols && exports.length === 0) {
      const lang = detectLanguage(file);
      if (lang === "go") {
        for (const sym of symbols) {
          if (
            sym.name[0] &&
            sym.name[0] === sym.name[0].toUpperCase() &&
            /[A-Z]/.test(sym.name[0])
          ) {
            exports.push({
              name: sym.name,
              isDefault: false,
              kind: sym.kind,
              location: sym.location ?? { file: absFile, line: 1, column: 1 },
            });
          }
        }
      }
    }

    return exports.length > 0 ? exports : null;
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    const symbols = await this.findSymbols(file);
    if (!symbols) return null;

    const imports = await this.findImports(file);
    const exports = await this.findExports(file);
    const lang = detectLanguage(file);

    return {
      file: resolve(file),
      language: lang ?? "unknown",
      symbols,
      imports: imports ?? [],
      exports: exports ?? [],
    };
  }

  async readSymbol(
    file: string,
    symbolName: string,
    symbolKind?: SymbolKind,
  ): Promise<CodeBlock | null> {
    // Get document symbols to find the range
    const symbols = await this.getDocumentSymbolsWithRange(file);
    if (!symbols) return null;

    // Find matching symbol
    const match = symbols.find(
      (s) => s.name === symbolName && (!symbolKind || s.kind === symbolKind),
    );
    if (!match?.range) return null;

    // Read the source at the range
    const absFile = resolve(file);
    let content: string;
    try {
      content = await readFile(absFile, "utf-8");
    } catch {
      return null;
    }

    const lines = content.split("\n");
    const startLine = match.range.start.line;
    const endLine = match.range.end.line;
    const block = lines.slice(startLine, endLine + 1).join("\n");
    const lang = detectLanguage(file);

    return {
      content: block,
      location: {
        file: absFile,
        line: startLine + 1,
        column: match.range.start.character + 1,
        endLine: endLine + 1,
      },
      symbolName,
      symbolKind: match.kind,
      language: lang ?? "unknown",
    };
  }

  /**
   * Get document symbols with their LSP range info preserved.
   * Unlike findSymbols which returns SymbolInfo, this returns the raw range
   * so readSymbol can extract the exact source text.
   */
  private async getDocumentSymbolsWithRange(file: string): Promise<Array<{
    name: string;
    kind: SymbolKind;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  }> | null> {
    let raw: unknown[] | null = null;

    if (nvimBridge.isNvimAvailable()) {
      raw = await nvimBridge.documentSymbols(file);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        raw = await client.textDocumentDocumentSymbol(file);
      } catch {
        return null;
      }
    }

    if (!raw || raw.length === 0) return null;

    const result: Array<{
      name: string;
      kind: SymbolKind;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }> = [];

    function walk(symbols: unknown[]): void {
      for (const sym of symbols) {
        const s = sym as Record<string, unknown>;
        const name = s.name as string;
        const kind = lspSymbolKindToSymbolKind(s.kind as number);

        if (s.range) {
          const ds = s as unknown as LspDocumentSymbol;
          result.push({ name, kind, range: ds.range });
          if (ds.children) walk(ds.children);
        } else if (s.location) {
          const si = s as unknown as LspSymbolInformation;
          result.push({ name, kind, range: si.location.range });
        }
      }
    }

    walk(raw);
    return result;
  }

  async getDiagnostics(file: string): Promise<Diagnostic[] | null> {
    if (nvimBridge.isNvimAvailable()) {
      const diags = await nvimBridge.getDiagnostics(file);
      if (diags && diags.length > 0) {
        return diags.map((d) => ({
          file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: lspSeverityToSeverity(d.severity),
          message: d.message,
          code: d.code,
          source: d.source,
        }));
      }
      return null;
    }

    // Diagnostics: merge from ALL servers (e.g. biome lint + tsserver types)
    const clients = await this.getStandaloneClients(file);
    if (clients.length === 0) return null;

    const merged: Diagnostic[] = [];
    const seen = new Set<string>();

    await Promise.all(
      clients.map(async (client) => {
        try {
          const diags = await client.getDiagnostics(file);
          for (const d of diags) {
            const key = `${String(d.range.start.line)}:${String(d.range.start.character)}:${d.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({
              file,
              line: d.range.start.line + 1,
              column: d.range.start.character + 1,
              severity: lspSeverityToSeverity(d.severity),
              message: d.message,
              code: d.code,
              source: d.source,
            });
          }
        } catch {}
      }),
    );

    return merged.length > 0 ? merged : null;
  }

  async getTypeInfo(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeInfo | null> {
    const pos = await this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    let hover: LspHover | null = null;

    if (nvimBridge.isNvimAvailable()) {
      hover = await nvimBridge.getHover(file, pos.line, pos.col);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        hover = await client.textDocumentHover(file, pos.line, pos.col);
      } catch {}
    }

    if (!hover) return null;
    const typeStr = extractTypeFromHover(hover);
    if (!typeStr) return null;
    return { symbol, type: typeStr };
  }

  async getCodeActions(
    file: string,
    startLine: number,
    endLine: number,
    diagnosticCodes?: (string | number)[],
  ): Promise<CodeAction[] | null> {
    if (nvimBridge.isNvimAvailable()) {
      const actions = await nvimBridge.getCodeActions(
        file,
        startLine - 1,
        0,
        endLine - 1,
        0,
        diagnosticCodes,
      );
      if (actions && actions.length > 0) {
        return actions.map((a) => ({
          title: a.title,
          kind: a.kind,
          isPreferred: a.isPreferred,
        }));
      }
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const actions = await client.textDocumentCodeAction(file, startLine - 1, 0, endLine - 1, 0);
      if (actions.length > 0) {
        return actions.map((a) => ({
          title: a.title,
          kind: a.kind,
          isPreferred: a.isPreferred,
        }));
      }
    } catch {}
    return null;
  }

  async findWorkspaceSymbols(query: string): Promise<SymbolInfo[] | null> {
    // Need a real file buffer to get an LSP client attached
    if (nvimBridge.isNvimAvailable()) {
      // Find a real file to use as the buffer anchor (LSP won't attach to ".")
      const anchorFile = await this.findAnchorFile();
      if (anchorFile) {
        const raw = await nvimBridge.workspaceSymbols(anchorFile, query);
        if (raw && raw.length > 0) {
          return flattenDocumentSymbols(raw, anchorFile, query);
        }
      }
      return null;
    }

    // Standalone: try each client until one returns results
    for (const client of this.standaloneClients.values()) {
      if (!client.isReady) continue;
      try {
        const symbols = await client.workspaceSymbol(query);
        if (symbols.length > 0) {
          return symbols.map((s) => ({
            name: s.name,
            kind: lspSymbolKindToSymbolKind(s.kind),
            location: lspLocationToSourceLocation(s.location),
            containerName: s.containerName,
          }));
        }
      } catch {}
    }
    return null;
  }

  async formatDocument(file: string): Promise<FormatEdit | null> {
    let edits: LspTextEdit[] | null = null;

    if (nvimBridge.isNvimAvailable()) {
      edits = await nvimBridge.formatDocument(file);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        edits = await client.textDocumentFormatting(file);
      } catch {}
    }

    if (!edits || edits.length === 0) return null;
    return lspTextEditsToFormatEdit(file, edits);
  }

  async formatRange(file: string, startLine: number, endLine: number): Promise<FormatEdit | null> {
    let edits: LspTextEdit[] | null = null;

    if (nvimBridge.isNvimAvailable()) {
      edits = await nvimBridge.formatRange(file, startLine - 1, 0, endLine - 1, 0);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        edits = await client.textDocumentRangeFormatting(file, startLine - 1, 0, endLine - 1, 0);
      } catch {}
    }

    if (!edits || edits.length === 0) return null;
    return lspTextEditsToFormatEdit(file, edits);
  }

  async organizeImports(file: string): Promise<RefactorResult | null> {
    if (nvimBridge.isNvimAvailable()) {
      const actions = await nvimBridge.organizeImports(file);
      if (actions && actions.length > 0) {
        const action = actions[0] as (typeof actions)[0];
        if (action?.edit) {
          return await workspaceEditToRefactorResult(action.edit, "imports", "organized");
        }
      }
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const actions = await client.textDocumentCodeAction(file, 0, 0, 0, 0, [
        "source.organizeImports",
      ]);
      const first = actions[0];
      if (first?.edit) {
        return await workspaceEditToRefactorResult(first.edit, "imports", "organized");
      }
    } catch {}
    return null;
  }

  /** Shared logic for call/type hierarchy requests. */
  private async hierarchyRequest<TItem, TResult>(
    file: string,
    symbol: string,
    line: number | undefined,
    column: number | undefined,
    nvimFn: (file: string, line: number, col: number) => Promise<unknown | null>,
    convertNvim: (raw: never) => TResult,
    prepare: (
      client: StandaloneLspClient,
      file: string,
      line: number,
      col: number,
    ) => Promise<TItem[]>,
    fetchPair: (client: StandaloneLspClient, item: TItem) => Promise<[unknown[], unknown[]]>,
    convertStandalone: (raw: { item: TItem; a: unknown[]; b: unknown[] }) => TResult,
  ): Promise<TResult | null> {
    const pos = await this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const result = await nvimFn(file, pos.line, pos.col);
      if (!result) return null;
      return convertNvim(result as never);
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const items = await prepare(client, file, pos.line, pos.col);
      const item = items[0];
      if (!item) return null;
      const [a, b] = await fetchPair(client, item);
      return convertStandalone({ item, a, b });
    } catch {}
    return null;
  }

  async getCallHierarchy(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<CallHierarchyResult | null> {
    return this.hierarchyRequest(
      file,
      symbol,
      line,
      column,
      nvimBridge.callHierarchy,
      lspCallHierarchyToResult,
      (c, f, l, col) => c.prepareCallHierarchy(f, l, col),
      (c, item) =>
        Promise.all([c.callHierarchyIncomingCalls(item), c.callHierarchyOutgoingCalls(item)]),
      ({ item, a, b }) =>
        lspCallHierarchyToResult({
          item,
          incoming: a as LspCallHierarchyItem[],
          outgoing: b as LspCallHierarchyItem[],
        }),
    );
  }

  async findImplementation(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    return this.lspPositionRequest(file, symbol, line, column, "implementation");
  }

  async getTypeHierarchy(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeHierarchyResult | null> {
    return this.hierarchyRequest(
      file,
      symbol,
      line,
      column,
      nvimBridge.typeHierarchy,
      lspTypeHierarchyToResult,
      (c, f, l, col) => c.prepareTypeHierarchy(f, l, col),
      (c, item) => Promise.all([c.typeHierarchySupertypes(item), c.typeHierarchySubtypes(item)]),
      ({ item, a, b }) =>
        lspTypeHierarchyToResult({
          item,
          supertypes: a as LspTypeHierarchyItem[],
          subtypes: b as LspTypeHierarchyItem[],
        }),
    );
  }

  async rename(
    file: string,
    symbol: string,
    newName: string,
    line?: number,
    column?: number,
  ): Promise<RefactorResult | null> {
    const pos = await this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    let edit: LspWorkspaceEdit | null = null;

    if (nvimBridge.isNvimAvailable()) {
      edit = await nvimBridge.rename(file, pos.line, pos.col, newName);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        // Wait for diagnostics first — ensures the LSP has loaded the full project
        // from tsconfig before we request a cross-file rename.
        await client.getDiagnostics(file);
        edit = await client.textDocumentRename(file, pos.line, pos.col, newName);
      } catch {}
    }

    if (!edit) return null;
    return await workspaceEditToRefactorResult(edit, symbol, newName);
  }

  /** Ensure all standalone LSP servers are running AND indexed for a file. */
  async ensureStandaloneReady(file: string): Promise<void> {
    const clients = await this.getStandaloneClients(file);
    if (clients.length === 0) return;
    const client = clients[0];
    if (!client) return;

    // Open the file so the server starts indexing the project
    await client.ensureDocumentOpen(file);

    // Poll documentSymbol until the server returns real results (= project loaded).
    // Don't trust diagnostics — servers may emit bogus parse errors before loading tsconfig.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const symbols = await Promise.race([
          client.textDocumentDocumentSymbol(file),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 3_000)),
        ]);
        if (Array.isArray(symbols) && symbols.length > 0) return;
      } catch {}
      await new Promise<void>((r) => setTimeout(r, 500));
    }
  }

  /** Whether nvim is currently running and available for LSP. */
  isNvimAvailable(): boolean {
    return nvimBridge.isNvimAvailable();
  }

  /** Warm up nvim LSP by opening a file and waiting for diagnostics. */
  async warmupNvim(file: string): Promise<boolean> {
    if (!nvimBridge.isNvimAvailable()) return false;
    return nvimBridge.warmupBuffer(file);
  }

  /**
   * Probe standalone LSP client directly, bypassing the nvim bridge.
   * Used by health check to test both paths independently.
   */
  async probeStandalone(file: string, op: string): Promise<unknown> {
    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    switch (op) {
      case "findSymbols":
        return client.textDocumentDocumentSymbol(file);
      case "findImports":
        // findImports is always regex — test it directly
        return this.findImports(file);
      case "findExports":
        return client.textDocumentDocumentSymbol(file);
      case "getFileOutline":
        return client.textDocumentDocumentSymbol(file);
      case "getDiagnostics":
        return client.getDiagnostics(file);
      case "readSymbol":
        return client.textDocumentDocumentSymbol(file);
      default:
        return null;
    }
  }

  /** Get neovim's active LSP clients (null if neovim not running) */
  async getNvimClients(): Promise<Array<{
    name: string;
    language: string;
    pid: number | null;
  }> | null> {
    if (!nvimBridge.isNvimAvailable()) return null;
    return nvimBridge.getActiveClients();
  }

  /** Get info about active standalone LSP servers */
  getActiveServers(): Array<{ language: string; command: string }> {
    const servers: Array<{ language: string; command: string }> = [];
    for (const client of this.standaloneClients.values()) {
      if (!client.isReady) continue;
      servers.push({ language: client.language, command: client.serverCommand });
    }
    return servers;
  }

  /** Get detailed info about active servers for the LSP status popup */
  getDetailedServers(): Array<{
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
    const servers: Array<{
      language: string;
      command: string;
      args: string[];
      pid: number | null;
      cwd: string;
      openFiles: number;
      diagnosticCount: number;
      diagnostics: Array<{ file: string; message: string; severity: number }>;
      ready: boolean;
    }> = [];
    for (const client of this.standaloneClients.values()) {
      servers.push({
        language: client.language,
        command: client.serverCommand,
        args: client.serverArgs,
        pid: client.pid,
        cwd: client.workspaceRoot,
        openFiles: client.openDocumentCount,
        diagnosticCount: client.diagnosticCount,
        diagnostics: client.getRecentDiagnostics(10),
        ready: client.isReady,
      });
    }
    return servers;
  }

  /** Get PIDs of all running LSP server processes */
  getChildPids(): number[] {
    const pids: number[] = [];
    for (const client of this.standaloneClients.values()) {
      const pid = client.pid;
      if (pid != null) pids.push(pid);
    }
    return pids;
  }

  /** Restart standalone LSP servers. Pass a command name to restart specific, or omit for all. */
  async restartServers(filter?: string): Promise<string[]> {
    const restarted: string[] = [];
    const toRestart: Array<{ key: string; client: StandaloneLspClient }> = [];

    for (const [key, client] of this.standaloneClients) {
      if (filter && !client.serverCommand.includes(filter) && !client.language.includes(filter)) {
        continue;
      }
      toRestart.push({ key, client });
    }

    for (const { key, client } of toRestart) {
      const lang = client.language;
      const cmd = client.serverCommand;
      await client.stop().catch(() => {});
      this.standaloneClients.delete(key);
      // Clear from language index
      for (const [lk, clients] of this.languageClients) {
        const idx = clients.indexOf(client);
        if (idx >= 0) {
          clients.splice(idx, 1);
          if (clients.length === 0) this.languageClients.delete(lk);
        }
      }
      restarted.push(`${lang}:${cmd}`);
    }

    // Clear failed servers so they can be retried
    if (filter) {
      for (const key of this.failedServers.keys()) {
        if (key.includes(filter)) this.failedServers.delete(key);
      }
    } else {
      this.failedServers.clear();
    }

    return restarted;
  }

  dispose(): void {
    for (const client of this.standaloneClients.values()) {
      client.stop().catch(() => {});
    }
    this.standaloneClients.clear();
    this.languageClients.clear();
    this.failedServers.clear();
  }

  /**
   * Resolve symbol name to a line:col position.
   * If line/column are provided, use them (converting to 0-based).
   * Otherwise, scan the file for the symbol as a word-boundary match,
   * preferring definition-like lines (function/class/const/let/type/interface/def/fn/func).
   */
  private async resolvePosition(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<{ line: number; col: number } | null> {
    if (line !== undefined && line > 0) {
      // Convert from 1-based to 0-based
      return { line: line - 1, col: column !== undefined && column > 0 ? column - 1 : 0 };
    }

    // Scan file for the symbol name with word boundary matching
    try {
      const content = await readFile(file, "utf-8");
      const fileLines = content.split("\n");
      const wordPattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);

      // First pass: look for definition-like lines
      for (let i = 0; i < fileLines.length; i++) {
        const lineText = fileLines[i];
        if (!lineText) continue;
        const match = wordPattern.exec(lineText);
        if (match !== null && isDefinitionLine(lineText)) {
          return { line: i, col: match.index };
        }
      }

      // Second pass: any word-boundary match
      for (let i = 0; i < fileLines.length; i++) {
        const lineText = fileLines[i];
        if (!lineText) continue;
        const match = wordPattern.exec(lineText);
        if (match !== null) {
          return { line: i, col: match.index };
        }
      }
    } catch {}

    return null;
  }

  /**
   * Get or create ALL standalone LSP clients for a file's language.
   * Starts all available servers (not just the first match).
   * Deduplicates concurrent calls for the same language to prevent duplicate processes.
   */
  private async getStandaloneClients(file: string): Promise<StandaloneLspClient[]> {
    const language = detectLanguage(file);
    if (!language) return [];

    const projectRoot = findProjectRootForLanguage(file, language) ?? this.cwd;
    const langKey = `${language}:${projectRoot}`;

    const existing = this.languageClients.get(langKey);
    if (existing && existing.length > 0 && existing.every((c) => c.isReady)) {
      return existing;
    }

    const pending = this.pendingInits.get(langKey);
    if (pending) return pending;

    const initPromise = this.initClientsForLanguage(langKey, projectRoot, language);
    this.pendingInits.set(langKey, initPromise);
    try {
      return await initPromise;
    } finally {
      this.pendingInits.delete(langKey);
    }
  }

  private async initClientsForLanguage(
    langKey: string,
    projectRoot: string,
    language: Language,
  ): Promise<StandaloneLspClient[]> {
    const configs = findServersForLanguage(language);
    if (configs.length === 0) return [];

    const clients: StandaloneLspClient[] = [];
    for (const config of configs) {
      const serverKey = `${config.command}:${projectRoot}`;
      const failedAt = this.failedServers.get(serverKey);
      if (failedAt !== undefined && Date.now() - failedAt < LspBackend.FAILED_SERVER_COOLDOWN_MS) {
        continue;
      }

      const existingClient = this.standaloneClients.get(serverKey);
      if (existingClient?.isReady) {
        clients.push(existingClient);
        this.failedServers.delete(serverKey);
        continue;
      }

      const client = new StandaloneLspClient(config, projectRoot);
      try {
        await client.start();
        this.standaloneClients.set(serverKey, client);
        this.failedServers.delete(serverKey);
        clients.push(client);
      } catch {
        this.failedServers.set(serverKey, Date.now());
      }
    }

    this.languageClients.set(langKey, clients);
    return clients;
  }

  /** Get the first available standalone client (for operations where first-wins is fine) */
  private async getStandaloneClient(file: string): Promise<StandaloneLspClient | null> {
    const clients = await this.getStandaloneClients(file);
    return clients[0] ?? null;
  }
}

function detectLanguage(file: string): Language | null {
  const lang = detectLanguageFromPath(file);
  return lang === "unknown" ? null : lang;
}

function lspLocationToSourceLocation(loc: LspLocation): SourceLocation {
  return {
    file: uriToFilePath(loc.uri),
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
    endLine: loc.range.end.line + 1,
    endColumn: loc.range.end.character + 1,
  };
}

function flattenDocumentSymbols(raw: unknown[], file: string, query?: string): SymbolInfo[] {
  const result: SymbolInfo[] = [];

  function walk(symbols: unknown[], container?: string): void {
    for (const sym of symbols) {
      const s = sym as Record<string, unknown>;
      const name = s.name as string;
      const kind = s.kind as number;

      // Check if it has a range (DocumentSymbol) or location (SymbolInformation)
      if (s.range) {
        const ds = s as unknown as LspDocumentSymbol;
        const info: SymbolInfo = {
          name,
          kind: lspSymbolKindToSymbolKind(kind),
          location: {
            file,
            line: ds.range.start.line + 1,
            column: ds.range.start.character + 1,
            endLine: ds.range.end.line + 1,
            endColumn: ds.range.end.character + 1,
          },
          containerName: container,
        };
        if (!query || name.toLowerCase().includes(query.toLowerCase())) {
          result.push(info);
        }
        if (ds.children) walk(ds.children, name);
      } else if (s.location) {
        const si = s as unknown as LspSymbolInformation;
        const info: SymbolInfo = {
          name,
          kind: lspSymbolKindToSymbolKind(kind),
          location: {
            file: uriToFilePath(si.location.uri),
            line: si.location.range.start.line + 1,
            column: si.location.range.start.character + 1,
            endLine: si.location.range.end.line + 1,
            endColumn: si.location.range.end.character + 1,
          },
          containerName: si.containerName,
        };
        if (!query || name.toLowerCase().includes(query.toLowerCase())) {
          result.push(info);
        }
      }
    }
  }

  walk(raw);
  return result;
}

/** Extract a type string from hover markdown */
function extractTypeFromHover(hover: LspHover): string | null {
  let text = "";

  if (typeof hover.contents === "string") {
    text = hover.contents;
  } else if (Array.isArray(hover.contents)) {
    text = hover.contents
      .map((c) => (typeof c === "string" ? c : (c as { value: string }).value))
      .join("\n");
  } else {
    const mc = hover.contents as LspMarkupContent;
    text = mc.value;
  }

  if (!text) return null;

  // Try to extract type from markdown code blocks
  const codeBlockMatch = /```\w*\n([\s\S]*?)```/.exec(text);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try inline code
  const inlineMatch = /`([^`]+)`/.exec(text);
  if (inlineMatch?.[1]) {
    return inlineMatch[1].trim();
  }

  // Return the first non-empty line
  const firstLine = text.split("\n").find((l) => l.trim());
  return firstLine?.trim() ?? null;
}

/** Convert LSP WorkspaceEdit to our RefactorResult */
async function workspaceEditToRefactorResult(
  edit: LspWorkspaceEdit,
  oldName: string,
  newName: string,
): Promise<RefactorResult> {
  const fileEdits = new Map<string, LspTextEdit[]>();

  // Collect edits from both changes and documentChanges
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = uriToFilePath(uri);
      const existing = fileEdits.get(filePath) ?? [];
      existing.push(...edits);
      fileEdits.set(filePath, existing);
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const docChange = change as LspTextDocumentEdit;
      if (docChange.textDocument && docChange.edits) {
        const filePath = uriToFilePath(docChange.textDocument.uri);
        const existing = fileEdits.get(filePath) ?? [];
        existing.push(...docChange.edits);
        fileEdits.set(filePath, existing);
      }
    }
  }

  const result: RefactorResult = {
    edits: [],
    description: `Renamed '${oldName}' to '${newName}' across ${String(fileEdits.size)} file(s)`,
  };

  for (const [filePath, edits] of fileEdits) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const oldContent = content;
    let newContent = content;

    // Apply edits in reverse order (by position) to preserve offsets
    const sorted = [...edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    // Pre-compute line start offsets (0-indexed: lineStarts[0] = offset of line 0)
    // Handles both \n and \r\n line endings correctly
    const lineStarts: number[] = [0];
    for (let i = 0; i < newContent.length; i++) {
      if (newContent[i] === "\n") {
        lineStarts.push(i + 1);
      }
    }

    for (const textEdit of sorted) {
      const startOffset =
        (lineStarts[textEdit.range.start.line] ?? 0) + textEdit.range.start.character;
      const endOffset = (lineStarts[textEdit.range.end.line] ?? 0) + textEdit.range.end.character;

      newContent =
        newContent.slice(0, startOffset) + textEdit.newText + newContent.slice(endOffset);
    }

    if (newContent !== oldContent) {
      result.edits.push({ file: filePath, oldContent, newContent });
    }
  }

  return result;
}

/** Convert LSP TextEdits to FormatEdit */
function lspTextEditsToFormatEdit(file: string, edits: LspTextEdit[]): FormatEdit {
  return {
    file,
    edits: edits.map((e) => ({
      startLine: e.range.start.line + 1,
      startCol: e.range.start.character + 1,
      endLine: e.range.end.line + 1,
      endCol: e.range.end.character + 1,
      newText: e.newText,
    })),
  };
}

/** Convert LSP call hierarchy result to our type */
function lspCallHierarchyToResult(raw: {
  item: LspCallHierarchyItem;
  incoming: LspCallHierarchyItem[];
  outgoing: LspCallHierarchyItem[];
}): CallHierarchyResult {
  const convert = (i: LspCallHierarchyItem) => ({
    name: i.name,
    kind: lspSymbolKindToSymbolKind(i.kind),
    file: uriToFilePath(i.uri),
    line: i.range.start.line + 1,
    column: i.range.start.character + 1,
  });
  return {
    item: convert(raw.item),
    incoming: raw.incoming.map(convert),
    outgoing: raw.outgoing.map(convert),
  };
}

/** Convert LSP type hierarchy result to our type */
function lspTypeHierarchyToResult(raw: {
  item: LspTypeHierarchyItem;
  supertypes: LspTypeHierarchyItem[];
  subtypes: LspTypeHierarchyItem[];
}): TypeHierarchyResult {
  const convert = (i: LspTypeHierarchyItem) => ({
    name: i.name,
    kind: lspSymbolKindToSymbolKind(i.kind),
    file: uriToFilePath(i.uri),
    line: i.range.start.line + 1,
  });
  return {
    item: convert(raw.item),
    supertypes: raw.supertypes.map(convert),
    subtypes: raw.subtypes.map(convert),
  };
}

const PROJECT_FILES: Partial<Record<Language, string[]>> = {
  typescript: ["tsconfig.json"],
  javascript: ["jsconfig.json", "tsconfig.json"],
  python: ["pyproject.toml", "setup.py"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  kotlin: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"],
  scala: ["build.sbt"],
  csharp: [".csproj", ".sln"],
  dart: ["pubspec.yaml"],
  elixir: ["mix.exs"],
  ruby: ["Gemfile"],
  php: ["composer.json"],
  swift: ["Package.swift"],
};

function findProjectRootForLanguage(file: string, language: Language): string | null {
  const markers = PROJECT_FILES[language];
  if (!markers) return null;

  let dir = dirname(resolve(file));
  const root = resolve("/");
  const MAX_DIRS = 100;
  let dirCount = 0;
  while (dir !== root && dirCount < MAX_DIRS) {
    dirCount++;
    // Check if any markers are extension-only (e.g. ".csproj", ".sln")
    const extMarkers = markers.filter((m) => m.startsWith(".") && !m.includes("/"));
    const nameMarkers = markers.filter((m) => !m.startsWith(".") || m.includes("/"));

    // Read directory once for all extension markers
    if (extMarkers.length > 0) {
      try {
        const entries = readdirSync(dir);
        for (const marker of extMarkers) {
          if (entries.some((e) => e.endsWith(marker))) return dir;
        }
      } catch {}
    }

    for (const marker of nameMarkers) {
      if (existsSync(join(dir, marker))) return dir;
    }

    dir = dirname(dir);
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DEFINITION_KEYWORDS =
  /\b(function|class|const|let|var|type|interface|enum|struct|trait|fn|def|func|impl|mod|pub|public|private|protected|static|void|abstract|override|sealed|record|annotation|object|fun|suspend|data|inline|operator|infix|external|companion|lateinit|val)\b/;

function isDefinitionLine(line: string): boolean {
  // Skip comments
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
    return false;
  }
  return DEFINITION_KEYWORDS.test(line);
}
