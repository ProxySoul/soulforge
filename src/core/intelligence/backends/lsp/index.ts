// ─── LSP Backend (Tier 2) ───
//
// Semantic intelligence via LSP:
// - When Neovim is running → bridges to Neovim's LSP (nvim-bridge)
// - When Neovim is NOT running → spawns servers directly (standalone-client)

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import * as nvimBridge from "./nvim-bridge.js";
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
import { findServerForLanguage } from "./server-registry.js";
import { StandaloneLspClient } from "./standalone-client.js";

const SUPPORTED_LANGUAGES: Set<Language> = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
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
  "yaml",
  "dockerfile",
]);

export class LspBackend implements IntelligenceBackend {
  readonly name = "lsp";
  readonly tier = 1;

  private cwd = "";
  /** language:cwd → client */
  private standaloneClients = new Map<string, StandaloneLspClient>();
  /** Languages where no server was found — skip retrying */
  private failedLanguages = new Set<string>();

  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  /** Find a real source file to use as LSP buffer anchor (for workspace-wide queries) */
  private findAnchorFile(): string | null {
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
        const files = readdirSync(dir);
        const source = files.find(
          (f) =>
            f.endsWith(".ts") ||
            f.endsWith(".js") ||
            f.endsWith(".py") ||
            f.endsWith(".go") ||
            f.endsWith(".rs"),
        );
        if (source) return join(dir, source);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  supportsLanguage(language: Language): boolean {
    return SUPPORTED_LANGUAGES.has(language);
  }

  // ─── Navigation ───

  async findDefinition(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const locations = await nvimBridge.findDefinition(file, pos.line, pos.col);
      if (locations && locations.length > 0) return locations.map(lspLocationToSourceLocation);
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const locations = await client.textDocumentDefinition(file, pos.line, pos.col);
      if (locations.length > 0) return locations.map(lspLocationToSourceLocation);
    } catch {
      /* fall through */
    }
    return null;
  }

  async findReferences(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const locations = await nvimBridge.findReferences(file, pos.line, pos.col);
      if (locations && locations.length > 0) return locations.map(lspLocationToSourceLocation);
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const locations = await client.textDocumentReferences(file, pos.line, pos.col);
      if (locations.length > 0) return locations.map(lspLocationToSourceLocation);
    } catch {
      /* fall through */
    }
    return null;
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
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Imports & Exports (derived from documentSymbol + file content) ───

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const absFile = resolve(file);
    let content: string;
    try {
      content = readFileSync(absFile, "utf-8");
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
      content = readFileSync(absFile, "utf-8");
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
      content = readFileSync(absFile, "utf-8");
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

  // ─── Analysis ───

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

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const diags = await client.getDiagnostics(file);
      if (diags.length > 0) {
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
    } catch {
      /* fall through */
    }
    return null;
  }

  async getTypeInfo(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeInfo | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    let hover: LspHover | null = null;

    if (nvimBridge.isNvimAvailable()) {
      hover = await nvimBridge.getHover(file, pos.line, pos.col);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        hover = await client.textDocumentHover(file, pos.line, pos.col);
      } catch {
        /* fall through */
      }
    }

    if (!hover) return null;
    const typeStr = extractTypeFromHover(hover);
    if (!typeStr) return null;
    return { symbol, type: typeStr };
  }

  // ─── Code Actions ───

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
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Workspace Symbols ───

  async findWorkspaceSymbols(query: string): Promise<SymbolInfo[] | null> {
    // Need a real file buffer to get an LSP client attached
    if (nvimBridge.isNvimAvailable()) {
      // Find a real file to use as the buffer anchor (LSP won't attach to ".")
      const anchorFile = this.findAnchorFile();
      if (anchorFile) {
        const raw = await nvimBridge.workspaceSymbols(anchorFile, query);
        if (raw && raw.length > 0) {
          return flattenDocumentSymbols(raw, anchorFile, query);
        }
      }
      return null;
    }

    // Standalone: try any existing client
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
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  // ─── Formatting ───

  async formatDocument(file: string): Promise<FormatEdit | null> {
    let edits: LspTextEdit[] | null = null;

    if (nvimBridge.isNvimAvailable()) {
      edits = await nvimBridge.formatDocument(file);
    } else {
      const client = await this.getStandaloneClient(file);
      if (!client) return null;
      try {
        edits = await client.textDocumentFormatting(file);
      } catch {
        /* fall through */
      }
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
      } catch {
        /* fall through */
      }
    }

    if (!edits || edits.length === 0) return null;
    return lspTextEditsToFormatEdit(file, edits);
  }

  // ─── Organize Imports ───

  async organizeImports(file: string): Promise<RefactorResult | null> {
    if (nvimBridge.isNvimAvailable()) {
      const actions = await nvimBridge.organizeImports(file);
      if (actions && actions.length > 0) {
        const action = actions[0] as (typeof actions)[0];
        if (action?.edit) {
          return workspaceEditToRefactorResult(action.edit, "imports", "organized");
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
        return workspaceEditToRefactorResult(first.edit, "imports", "organized");
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Call Hierarchy ───

  async getCallHierarchy(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<CallHierarchyResult | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const result = await nvimBridge.callHierarchy(file, pos.line, pos.col);
      if (!result) return null;
      return lspCallHierarchyToResult(result);
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const items = await client.prepareCallHierarchy(file, pos.line, pos.col);
      const item = items[0];
      if (!item) return null;
      const [incoming, outgoing] = await Promise.all([
        client.callHierarchyIncomingCalls(item),
        client.callHierarchyOutgoingCalls(item),
      ]);
      return lspCallHierarchyToResult({ item, incoming, outgoing });
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Implementation ───

  async findImplementation(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const locations = await nvimBridge.findImplementation(file, pos.line, pos.col);
      if (locations && locations.length > 0) return locations.map(lspLocationToSourceLocation);
      return null;
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const locations = await client.textDocumentImplementation(file, pos.line, pos.col);
      if (locations.length > 0) return locations.map(lspLocationToSourceLocation);
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Type Hierarchy ───

  async getTypeHierarchy(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeHierarchyResult | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
    if (!pos) return null;

    if (nvimBridge.isNvimAvailable()) {
      const result = await nvimBridge.typeHierarchy(file, pos.line, pos.col);
      if (!result) return null;
      return lspTypeHierarchyToResult(result);
    }

    const client = await this.getStandaloneClient(file);
    if (!client) return null;
    try {
      const items = await client.prepareTypeHierarchy(file, pos.line, pos.col);
      const item = items[0];
      if (!item) return null;
      const [supertypes, subtypes] = await Promise.all([
        client.typeHierarchySupertypes(item),
        client.typeHierarchySubtypes(item),
      ]);
      return lspTypeHierarchyToResult({ item, supertypes, subtypes });
    } catch {
      /* fall through */
    }
    return null;
  }

  // ─── Refactoring ───

  async rename(
    file: string,
    symbol: string,
    newName: string,
    line?: number,
    column?: number,
  ): Promise<RefactorResult | null> {
    const pos = this.resolvePosition(file, symbol, line, column);
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
      } catch {
        /* fall through */
      }
    }

    if (!edit) return null;
    return workspaceEditToRefactorResult(edit, symbol, newName);
  }

  /** Ensure a standalone LSP server is running for a file, regardless of Neovim state. */
  async ensureStandaloneReady(file: string): Promise<void> {
    await this.getStandaloneClient(file);
  }

  /** Get info about active standalone LSP servers */
  getActiveServers(): Array<{ language: string; command: string }> {
    const servers: Array<{ language: string; command: string }> = [];
    for (const [key, client] of this.standaloneClients) {
      if (!client.isReady) continue;
      const language = key.split(":")[0] ?? "unknown";
      servers.push({ language, command: client.serverCommand });
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
    for (const [key, client] of this.standaloneClients) {
      const language = key.split(":")[0] ?? "unknown";
      servers.push({
        language,
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

  // ─── Lifecycle ───

  dispose(): void {
    for (const client of this.standaloneClients.values()) {
      client.stop().catch(() => {});
    }
    this.standaloneClients.clear();
    this.failedLanguages.clear();
  }

  // ─── Private ───

  /**
   * Resolve symbol name to a line:col position.
   * If line/column are provided, use them (converting to 0-based).
   * Otherwise, scan the file for the symbol as a word-boundary match,
   * preferring definition-like lines (function/class/const/let/type/interface/def/fn/func).
   */
  private resolvePosition(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): { line: number; col: number } | null {
    if (line !== undefined && line > 0) {
      // Convert from 1-based to 0-based
      return { line: line - 1, col: column !== undefined && column > 0 ? column - 1 : 0 };
    }

    // Scan file for the symbol name with word boundary matching
    try {
      const content = readFileSync(file, "utf-8");
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
    } catch {
      /* file not readable */
    }

    return null;
  }

  /** Get or create a standalone LSP client for the file's project */
  private async getStandaloneClient(file: string): Promise<StandaloneLspClient | null> {
    const language = detectLanguage(file);
    if (!language || this.failedLanguages.has(language)) return null;

    const projectRoot = findProjectRootForLanguage(file, language) ?? this.cwd;
    const key = `${language}:${projectRoot}`;
    const existing = this.standaloneClients.get(key);
    if (existing?.isReady) return existing;

    // Find a server for this language
    const config = findServerForLanguage(language);
    if (!config) {
      this.failedLanguages.add(language);
      return null;
    }

    const client = new StandaloneLspClient(config, projectRoot);
    try {
      await client.start();
      this.standaloneClients.set(key, client);
      return client;
    } catch {
      this.failedLanguages.add(language);
      return null;
    }
  }
}

// ─── Helpers ───

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
function workspaceEditToRefactorResult(
  edit: LspWorkspaceEdit,
  oldName: string,
  newName: string,
): RefactorResult {
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
      content = readFileSync(filePath, "utf-8");
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

    const lines = newContent.split("\n");
    for (const textEdit of sorted) {
      const startLine = textEdit.range.start.line;
      const startChar = textEdit.range.start.character;
      const endLine = textEdit.range.end.line;
      const endChar = textEdit.range.end.character;

      // Convert line/character offsets to a flat string offset
      let startOffset = 0;
      for (let i = 0; i < startLine && i < lines.length; i++) {
        startOffset += (lines[i]?.length ?? 0) + 1; // +1 for newline
      }
      startOffset += startChar;

      let endOffset = 0;
      for (let i = 0; i < endLine && i < lines.length; i++) {
        endOffset += (lines[i]?.length ?? 0) + 1;
      }
      endOffset += endChar;

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
};

function findProjectRootForLanguage(file: string, language: Language): string | null {
  const markers = PROJECT_FILES[language];
  if (!markers) return null;

  let dir = dirname(resolve(file));
  const root = resolve("/");
  while (dir !== root) {
    for (const marker of markers) {
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
  /\b(function|class|const|let|var|type|interface|enum|struct|trait|fn|def|func|impl|mod|pub)\b/;

function isDefinitionLine(line: string): boolean {
  // Skip comments
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
    return false;
  }
  return DEFINITION_KEYWORDS.test(line);
}
