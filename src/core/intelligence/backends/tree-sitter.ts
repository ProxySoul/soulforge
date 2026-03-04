import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileCache } from "../cache.js";
import type {
  CodeBlock,
  ExportInfo,
  FileOutline,
  ImportInfo,
  IntelligenceBackend,
  Language,
  SymbolInfo,
  SymbolKind,
} from "../types.js";

// Tree-sitter query patterns per language
const QUERIES: Record<string, string> = {
  typescript: `
    (function_declaration name: (identifier) @name) @func
    (export_statement (function_declaration name: (identifier) @name)) @func
    (class_declaration name: (type_identifier) @name) @class
    (interface_declaration name: (type_identifier) @name) @iface
    (type_alias_declaration name: (type_identifier) @name) @type
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  javascript: `
    (function_declaration name: (identifier) @name) @func
    (class_declaration name: (identifier) @name) @class
    (lexical_declaration (variable_declarator name: (identifier) @name)) @var
    (import_statement source: (string) @source) @import
    (export_statement) @export
  `,
  python: `
    (function_definition name: (identifier) @name) @func
    (class_definition name: (identifier) @name) @class
    (import_statement) @import
    (import_from_statement) @import
  `,
  go: `
    (function_declaration name: (identifier) @name) @func
    (method_declaration name: (field_identifier) @name) @func
    (type_declaration (type_spec name: (type_identifier) @name)) @type
    (import_declaration) @import
  `,
  rust: `
    (function_item name: (identifier) @name) @func
    (struct_item name: (type_identifier) @name) @struct
    (trait_item name: (type_identifier) @name) @trait
    (type_item name: (type_identifier) @name) @type
    (use_declaration) @import
    (impl_item) @impl
  `,
};

const GRAMMAR_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
};

// Dynamically import web-tree-sitter types
type TSParser = import("web-tree-sitter").Parser;
type TSLanguage = import("web-tree-sitter").Language;
type TSTree = import("web-tree-sitter").Tree;
type TSQuery = import("web-tree-sitter").Query;
type TSQueryCapture = import("web-tree-sitter").QueryCapture;
type TSNode = import("web-tree-sitter").Node;

// Store the module reference for Query construction
let TSQueryClass: (new (lang: TSLanguage, source: string) => TSQuery) | null = null;

function createQuery(lang: TSLanguage, source: string): TSQuery {
  if (!TSQueryClass) throw new Error("tree-sitter not initialized");
  return new TSQueryClass(lang, source);
}

/**
 * Tree-sitter based backend (Tier 3).
 * Provides universal AST parsing with lazy grammar loading.
 */
interface TreeCacheEntry {
  tree: TSTree;
  content: string; // content used to parse — invalidate if changed
}

export class TreeSitterBackend implements IntelligenceBackend {
  readonly name = "tree-sitter";
  readonly tier = 3;
  private parser: TSParser | null = null;
  private languages = new Map<string, TSLanguage>();
  private initPromise: Promise<void> | null = null;
  private cache: FileCache | null = null;
  /** Parse tree cache: absPath → { tree, content } */
  private treeCache = new Map<string, TreeCacheEntry>();
  private readonly treeCacheMaxSize = 50;

  supportsLanguage(language: Language): boolean {
    return language in GRAMMAR_FILES;
  }

  setCache(cache: FileCache): void {
    this.cache = cache;
  }

  async initialize(_cwd: string): Promise<void> {
    if (this.parser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  dispose(): void {
    for (const entry of this.treeCache.values()) {
      entry.tree.delete();
    }
    this.treeCache.clear();
    this.parser?.delete();
    this.parser = null;
    this.languages.clear();
    this.initPromise = null;
  }

  async findSymbols(file: string, query?: string): Promise<SymbolInfo[] | null> {
    const parsed = await this.parseWithQuery(file);
    if (!parsed) return null;
    const { tree, tsQuery } = parsed;

    const symbols: SymbolInfo[] = [];

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
        if (!nameCapture) continue;

        const name = nameCapture.node.text;
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;

        const patternCapture = match.captures.find(
          (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
        );
        const kind = this.captureToKind(patternCapture?.name ?? "unknown");

        symbols.push({
          name,
          kind,
          location: {
            file: resolve(file),
            line: nameCapture.node.startPosition.row + 1,
            column: nameCapture.node.startPosition.column + 1,
            endLine: nameCapture.node.endPosition.row + 1,
          },
        });
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return symbols;
  }

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(language);
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const importQueryStr =
      language === "typescript" || language === "javascript"
        ? `(import_statement source: (string) @source) @import`
        : language === "python"
          ? `(import_statement) @import (import_from_statement module_name: (dotted_name) @source) @import`
          : language === "go"
            ? `(import_declaration) @import`
            : language === "rust"
              ? `(use_declaration) @import`
              : null;

    if (!importQueryStr) {
      tree.delete();
      return null;
    }

    const imports: ImportInfo[] = [];
    const tsQuery = createQuery(tsLang, importQueryStr);

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const importNode = match.captures.find((c: TSQueryCapture) => c.name === "import");
        const sourceNode = match.captures.find((c: TSQueryCapture) => c.name === "source");

        if (!importNode) continue;

        const source = sourceNode
          ? sourceNode.node.text.replace(/['"]/g, "")
          : importNode.node.text;

        imports.push({
          source,
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          location: {
            file: resolve(file),
            line: importNode.node.startPosition.row + 1,
            column: importNode.node.startPosition.column + 1,
          },
        });
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return imports;
  }

  async findExports(file: string): Promise<ExportInfo[] | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    if (language !== "typescript" && language !== "javascript") {
      tree.delete();
      return null;
    }

    const tsLang = this.languages.get(language);
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const exports: ExportInfo[] = [];
    const tsQuery = createQuery(tsLang, `(export_statement) @export`);

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const exportCapture = match.captures.find((c: TSQueryCapture) => c.name === "export");
        if (!exportCapture) continue;

        const node = exportCapture.node;
        const isDefault = node.text.includes("export default");

        // Try to find the exported name
        const decl = node.namedChildren.find(
          (c: TSNode) =>
            c.type === "function_declaration" ||
            c.type === "class_declaration" ||
            c.type === "interface_declaration" ||
            c.type === "type_alias_declaration" ||
            c.type === "lexical_declaration",
        );

        if (decl) {
          const nameNode =
            decl.childForFieldName("name") ??
            decl.namedChildren
              .find((c: TSNode) => c.type === "variable_declarator")
              ?.childForFieldName("name");

          if (nameNode) {
            let kind: SymbolKind = "variable";
            if (decl.type.includes("function")) kind = "function";
            else if (decl.type.includes("class")) kind = "class";
            else if (decl.type.includes("interface")) kind = "interface";
            else if (decl.type.includes("type")) kind = "type";

            exports.push({
              name: nameNode.text,
              isDefault,
              kind,
              location: {
                file: resolve(file),
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
              },
            });
          }
        }
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return exports;
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    // Single parse, extract all data from one tree
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(language);
    if (!tsLang) {
      tree.delete();
      return null;
    }

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const absFile = resolve(file);

    // Extract symbols using the main query
    const mainQueryStr = QUERIES[language];
    if (mainQueryStr) {
      const mainQuery = createQuery(tsLang, mainQueryStr);
      try {
        const matches = mainQuery.matches(tree.rootNode);
        for (const match of matches) {
          const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
          const sourceCapture = match.captures.find((c: TSQueryCapture) => c.name === "source");
          const patternCapture = match.captures.find(
            (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
          );

          // Handle imports
          if (patternCapture?.name === "import") {
            const source = sourceCapture
              ? sourceCapture.node.text.replace(/['"]/g, "")
              : patternCapture.node.text;
            imports.push({
              source,
              specifiers: [],
              isDefault: false,
              isNamespace: false,
              location: {
                file: absFile,
                line: patternCapture.node.startPosition.row + 1,
                column: patternCapture.node.startPosition.column + 1,
              },
            });
            continue;
          }

          // Handle exports
          if (patternCapture?.name === "export") {
            const node = patternCapture.node;
            const isDefault = node.text.includes("export default");
            const decl = node.namedChildren.find(
              (c: TSNode) =>
                c.type === "function_declaration" ||
                c.type === "class_declaration" ||
                c.type === "interface_declaration" ||
                c.type === "type_alias_declaration" ||
                c.type === "lexical_declaration",
            );
            if (decl) {
              const expNameNode =
                decl.childForFieldName("name") ??
                decl.namedChildren
                  .find((c: TSNode) => c.type === "variable_declarator")
                  ?.childForFieldName("name");
              if (expNameNode) {
                let kind: SymbolKind = "variable";
                if (decl.type.includes("function")) kind = "function";
                else if (decl.type.includes("class")) kind = "class";
                else if (decl.type.includes("interface")) kind = "interface";
                else if (decl.type.includes("type")) kind = "type";
                exports.push({
                  name: expNameNode.text,
                  isDefault,
                  kind,
                  location: {
                    file: absFile,
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column + 1,
                  },
                });
              }
            }
            continue;
          }

          // Handle symbols
          if (nameCapture) {
            const kind = this.captureToKind(patternCapture?.name ?? "unknown");
            symbols.push({
              name: nameCapture.node.text,
              kind,
              location: {
                file: absFile,
                line: nameCapture.node.startPosition.row + 1,
                column: nameCapture.node.startPosition.column + 1,
                endLine: nameCapture.node.endPosition.row + 1,
              },
            });
          }
        }
      } finally {
        mainQuery.delete();
      }
    }

    tree.delete();

    return {
      file: absFile,
      language,
      symbols,
      imports,
      exports,
    };
  }

  async readSymbol(
    file: string,
    symbolName: string,
    symbolKind?: SymbolKind,
  ): Promise<CodeBlock | null> {
    const parsed = await this.parseWithQuery(file);
    if (!parsed) return null;
    const { tree, tsQuery } = parsed;

    try {
      const matches = tsQuery.matches(tree.rootNode);

      for (const match of matches) {
        const nameCapture = match.captures.find((c: TSQueryCapture) => c.name === "name");
        if (!nameCapture || nameCapture.node.text !== symbolName) continue;

        const patternCapture = match.captures.find(
          (c: TSQueryCapture) => c.name !== "name" && c.name !== "source",
        );
        const kind = this.captureToKind(patternCapture?.name ?? "unknown");

        if (symbolKind && kind !== symbolKind) continue;

        // Get the full node (not just the name)
        const node = patternCapture?.node ?? nameCapture.node.parent;
        if (!node) continue;

        const language = this.detectLang(file);
        return {
          content: node.text,
          location: {
            file: resolve(file),
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
          },
          symbolName,
          symbolKind: kind,
          language,
        };
      }
    } finally {
      tsQuery.delete();
      tree.delete();
    }

    return null;
  }

  async readScope(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null> {
    const content = this.readFileContent(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const lines = content.split("\n");
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = endLine
      ? Math.min(endLine - 1, lines.length - 1)
      : Math.min(startIdx + 50, lines.length - 1);

    const blockContent = lines.slice(startIdx, endIdx + 1).join("\n");

    return {
      content: blockContent,
      location: {
        file: resolve(file),
        line: startLine,
        column: 1,
        endLine: endIdx + 1,
      },
      language,
    };
  }

  // ─── Private helpers ───

  private async doInit(): Promise<void> {
    const mod = await import("web-tree-sitter");
    TSQueryClass = mod.Query;
    await mod.Parser.init();
    this.parser = new mod.Parser();
  }

  private async loadLanguage(language: string): Promise<TSLanguage | null> {
    const cached = this.languages.get(language);
    if (cached) return cached;

    const wasmFile = GRAMMAR_FILES[language];
    if (!wasmFile) return null;

    try {
      const mod = await import("web-tree-sitter");
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
      const lang = await mod.Language.load(wasmPath);
      this.languages.set(language, lang);
      return lang;
    } catch {
      return null;
    }
  }

  private async parseFile(file: string): Promise<TSTree | null> {
    if (!this.parser) return null;

    const absPath = resolve(file);
    const content = this.readFileContent(absPath);
    if (!content) return null;

    // Check tree cache — reuse if content hasn't changed
    const cached = this.treeCache.get(absPath);
    if (cached && cached.content === content) {
      // Return a copy since callers delete the tree
      return cached.tree.copy();
    }

    const language = this.detectLang(file);
    const lang = await this.loadLanguage(language);
    if (!lang) return null;

    this.parser.setLanguage(lang);
    const tree = this.parser.parse(content);
    if (!tree) return null;

    // Cache the tree (evict oldest if full)
    if (cached) cached.tree.delete();
    if (this.treeCache.size >= this.treeCacheMaxSize) {
      const firstKey = this.treeCache.keys().next().value;
      if (firstKey) {
        this.treeCache.get(firstKey)?.tree.delete();
        this.treeCache.delete(firstKey);
      }
    }
    this.treeCache.set(absPath, { tree: tree.copy(), content });

    return tree;
  }

  /**
   * Parse file and create the main language query in one step.
   * Returns both tree and query, or null if either fails.
   * Caller is responsible for deleting both in a finally block.
   */
  private async parseWithQuery(file: string): Promise<{ tree: TSTree; tsQuery: TSQuery } | null> {
    const tree = await this.parseFile(file);
    if (!tree) return null;

    const language = this.detectLang(file);
    const tsLang = this.languages.get(language);
    const queryStr = QUERIES[language];
    if (!tsLang || !queryStr) {
      tree.delete();
      return null;
    }

    try {
      const tsQuery = createQuery(tsLang, queryStr);
      return { tree, tsQuery };
    } catch {
      tree.delete();
      return null;
    }
  }

  private readFileContent(file: string): string | null {
    const absPath = resolve(file);
    if (this.cache) {
      return this.cache.get(absPath);
    }
    try {
      return readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  private detectLang(file: string): Language {
    const ext: Record<string, Language> = {
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
    const dot = file.lastIndexOf(".");
    if (dot === -1) return "unknown";
    return ext[file.slice(dot)] ?? "unknown";
  }

  private captureToKind(captureName: string): SymbolKind {
    switch (captureName) {
      case "func":
        return "function";
      case "class":
      case "struct":
        return "class";
      case "iface":
      case "trait":
        return "interface";
      case "type":
        return "type";
      case "var":
        return "variable";
      case "impl":
        return "class";
      default:
        return "unknown";
    }
  }
}
