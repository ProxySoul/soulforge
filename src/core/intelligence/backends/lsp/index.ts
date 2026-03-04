// ─── LSP Backend (Tier 2) ───
//
// Semantic intelligence via LSP:
// - When Neovim is running → bridges to Neovim's LSP (nvim-bridge)
// - When Neovim is NOT running → spawns servers directly (standalone-client)

import { readFileSync } from "node:fs";
import type {
  Diagnostic,
  IntelligenceBackend,
  Language,
  RefactorResult,
  SourceLocation,
  SymbolInfo,
  TypeInfo,
} from "../../types.js";
import * as nvimBridge from "./nvim-bridge.js";
import {
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspMarkupContent,
  type LspSymbolInformation,
  type LspTextDocumentEdit,
  type LspTextEdit,
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
]);

export class LspBackend implements IntelligenceBackend {
  readonly name = "lsp";
  readonly tier = 2;

  private cwd = "";
  /** language:cwd → client */
  private standaloneClients = new Map<string, StandaloneLspClient>();
  /** Languages where no server was found — skip retrying */
  private failedLanguages = new Set<string>();

  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;
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
        edit = await client.textDocumentRename(file, pos.line, pos.col, newName);
      } catch {
        /* fall through */
      }
    }

    if (!edit) return null;
    return workspaceEditToRefactorResult(edit, symbol, newName);
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

  /** Get or create a standalone LSP client for the file's language */
  private async getStandaloneClient(file: string): Promise<StandaloneLspClient | null> {
    const language = detectLanguage(file);
    if (!language || this.failedLanguages.has(language)) return null;

    const key = `${language}:${this.cwd}`;
    const existing = this.standaloneClients.get(key);
    if (existing?.isReady) return existing;

    // Find a server for this language
    const config = findServerForLanguage(language);
    if (!config) {
      this.failedLanguages.add(language);
      return null;
    }

    const client = new StandaloneLspClient(config, this.cwd);
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
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const map: Record<string, Language> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? null;
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
