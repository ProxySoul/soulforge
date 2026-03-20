import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileCache } from "../cache.js";
import {
  type CodeBlock,
  detectLanguageFromPath,
  type ExportInfo,
  type FileOutline,
  type ImportInfo,
  type IntelligenceBackend,
  type Language,
  type SourceLocation,
  type SymbolInfo,
  type SymbolKind,
} from "../types.js";

interface LanguagePatterns {
  function: RegExp;
  class: RegExp;
  interface?: RegExp;
  type?: RegExp;
  imports: RegExp;
  exports?: RegExp;
  constant?: RegExp;
}

const TS_PATTERNS: LanguagePatterns = {
  function: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  class: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  interface: /^(?:export\s+)?interface\s+(\w+)/,
  type: /^(?:export\s+)?type\s+(\w+)/,
  imports:
    /^import\s+(?:type\s+)?(?:(\{[^}]+\})|(\w+)(?:\s*,\s*(\{[^}]+\}))?|(\*\s+as\s+\w+))\s+from\s+["']([^"']+)["']/,
  exports:
    /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|interface|type|const|let|var|enum)\s+(\w+)/,
  constant: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/,
};

const JS_PATTERNS: LanguagePatterns = {
  function: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  class: /^(?:export\s+)?class\s+(\w+)/,
  imports:
    /^import\s+(?:(\{[^}]+\})|(\w+)(?:\s*,\s*(\{[^}]+\}))?|(\*\s+as\s+\w+))\s+from\s+["']([^"']+)["']/,
  exports: /^export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var)\s+(\w+)/,
  constant: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/,
};

const PY_PATTERNS: LanguagePatterns = {
  function: /^(?:async\s+)?def\s+(\w+)/,
  class: /^class\s+(\w+)/,
  imports: /^(?:from\s+(\S+)\s+)?import\s+(.+)/,
};

const GO_PATTERNS: LanguagePatterns = {
  function: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
  class: /^type\s+(\w+)\s+struct/,
  interface: /^type\s+(\w+)\s+interface/,
  imports: /^import\s+(?:\(\s*)?(?:"([^"]+)")?/,
};

const RUST_PATTERNS: LanguagePatterns = {
  function: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  class: /^(?:pub\s+)?struct\s+(\w+)/,
  interface: /^(?:pub\s+)?trait\s+(\w+)/,
  type: /^(?:pub\s+)?type\s+(\w+)/,
  imports: /^use\s+(.+);/,
  constant: /^(?:pub\s+)?(?:const|static)\s+(\w+)/,
};

function getPatternsForLanguage(language: Language): LanguagePatterns | null {
  switch (language) {
    case "typescript":
      return TS_PATTERNS;
    case "javascript":
      return JS_PATTERNS;
    case "python":
      return PY_PATTERNS;
    case "go":
      return GO_PATTERNS;
    case "rust":
      return RUST_PATTERNS;
    default:
      return TS_PATTERNS; // Fallback to TS patterns
  }
}

function extractBraceScope(lines: string[], startIdx: number): { endIdx: number } {
  let depth = 0;
  let foundOpen = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return { endIdx: i };
        }
      }
    }
  }

  return { endIdx: Math.min(startIdx + 50, lines.length - 1) };
}

function extractIndentScope(lines: string[], startIdx: number): { endIdx: number } {
  if (startIdx >= lines.length) return { endIdx: startIdx };
  const startLine = lines[startIdx] ?? "";
  const baseIndent = startLine.search(/\S/);
  let endIdx = startIdx;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      endIdx = i;
      continue;
    }
    const indent = line.search(/\S/);
    if (indent <= baseIndent) break;
    endIdx = i;
  }

  return { endIdx };
}

function extractScope(lines: string[], startIdx: number, language: Language): { endIdx: number } {
  if (language === "python") {
    return extractIndentScope(lines, startIdx);
  }
  return extractBraceScope(lines, startIdx);
}

/**
 * Regex-based fallback backend (Tier 4).
 * Works for any language with basic pattern matching.
 * Supports: symbols, imports, exports, readSymbol, readScope.
 */
export class RegexBackend implements IntelligenceBackend {
  readonly name = "regex";
  readonly tier = 4;
  private cache: FileCache | null = null;

  initialize(_cwd: string): Promise<void> {
    return Promise.resolve();
  }

  setCache(cache: FileCache): void {
    this.cache = cache;
  }

  supportsLanguage(_language: Language): boolean {
    return true; // Regex works for all languages
  }

  async findSymbols(file: string, query?: string): Promise<SymbolInfo[] | null> {
    const content = this.readFile(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const patterns = getPatternsForLanguage(language);
    if (!patterns) return null;

    const lines = content.split("\n");
    const symbols: SymbolInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trimStart();
      const entries: Array<{ pattern: RegExp; kind: SymbolKind }> = [
        { pattern: patterns.function, kind: "function" },
        { pattern: patterns.class, kind: "class" },
      ];
      if (patterns.interface) entries.push({ pattern: patterns.interface, kind: "interface" });
      if (patterns.type) entries.push({ pattern: patterns.type, kind: "type" });
      if (patterns.constant) entries.push({ pattern: patterns.constant, kind: "constant" });

      for (const { pattern, kind } of entries) {
        const match = line.match(pattern);
        if (match?.[1]) {
          if (query && !match[1].toLowerCase().includes(query.toLowerCase())) {
            continue;
          }
          symbols.push({
            name: match[1],
            kind,
            location: { file: resolve(file), line: i + 1, column: 1 },
          });
          break;
        }
      }
    }

    return symbols;
  }

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const content = this.readFile(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const patterns = getPatternsForLanguage(language);
    if (!patterns) return null;

    const lines = content.split("\n");
    const imports: ImportInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const match = (lines[i] ?? "").match(patterns.imports);
      if (!match) continue;

      if (language === "typescript" || language === "javascript") {
        const namedImports = match[1] || match[3];
        const defaultImport = match[2];
        const namespaceImport = match[4];
        const source = match[5];

        const specifiers: string[] = [];
        if (defaultImport) specifiers.push(defaultImport);
        if (namedImports) {
          const cleaned = namedImports.replace(/[{}]/g, "").trim();
          specifiers.push(
            ...cleaned
              .split(",")
              .map((s) => s.trim().replace(/^type\s+/, ""))
              .filter(Boolean),
          );
        }

        imports.push({
          source: source ?? "",
          specifiers,
          isDefault: !!defaultImport,
          isNamespace: !!namespaceImport,
          location: { file: resolve(file), line: i + 1, column: 1 },
        });
      } else if (language === "python") {
        const module = (match[1] || "").trim();
        const importList = (match[2] || "").trim();
        const specifiers = importList
          .split(",")
          .map((s) => {
            const parts = s.trim().split(/\s+as\s+/);
            const name = (parts[1] || parts[0] || "").trim();
            const last = name.split(".").pop();
            return last || "";
          })
          .filter(Boolean);
        imports.push({
          source: module || importList,
          specifiers,
          isDefault: false,
          isNamespace: false,
          location: { file: resolve(file), line: i + 1, column: 1 },
        });
      } else if (language === "rust") {
        const usePath = (match[1] || "").trim();
        const specifiers: string[] = [];
        const braceMatch = usePath.match(/\{([^}]+)\}/);
        if (braceMatch) {
          for (const item of braceMatch[1]?.split(",") ?? []) {
            const parts = item.trim().split(/\s+as\s+/);
            const name = (parts[1] || parts[0] || "").trim();
            if (name && name !== "self") specifiers.push(name);
          }
        } else {
          const segments = usePath.replace(/;$/, "").split("::");
          const last = segments.pop()?.trim();
          if (last && last !== "*" && last !== "self") specifiers.push(last);
        }
        imports.push({
          source: usePath,
          specifiers,
          isDefault: false,
          isNamespace: false,
          location: { file: resolve(file), line: i + 1, column: 1 },
        });
      } else {
        imports.push({
          source: (match[1] || match[2] || "").trim(),
          specifiers: (match[2] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          isDefault: false,
          isNamespace: false,
          location: { file: resolve(file), line: i + 1, column: 1 },
        });
      }
    }

    return imports;
  }

  async findExports(file: string): Promise<ExportInfo[] | null> {
    const content = this.readFile(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const patterns = getPatternsForLanguage(language);
    if (!patterns?.exports) return null;

    const lines = content.split("\n");
    const exports: ExportInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trimStart();
      const match = line.match(patterns.exports);
      if (match?.[1]) {
        const isDefault = line.includes("export default");
        let kind: SymbolKind = "variable";
        if (/function/.test(line)) kind = "function";
        else if (/class/.test(line)) kind = "class";
        else if (/interface/.test(line)) kind = "interface";
        else if (/type/.test(line)) kind = "type";
        else if (/enum/.test(line)) kind = "enum";
        else if (/const|let|var/.test(line)) kind = "variable";

        exports.push({
          name: match[1],
          isDefault,
          kind,
          location: { file: resolve(file), line: i + 1, column: 1 },
        });
      }
    }

    return exports;
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    const language = this.detectLang(file);
    const [symbols, imports, exports] = await Promise.all([
      this.findSymbols(file),
      this.findImports(file),
      this.findExports(file),
    ]);

    if (!symbols) return null;

    return {
      file: resolve(file),
      language,
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
    const content = this.readFile(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const lines = content.split("\n");

    // Find the symbol declaration line
    const symbols = await this.findSymbols(file);
    if (!symbols) return null;

    const target = symbols.find(
      (s) => s.name === symbolName && (!symbolKind || s.kind === symbolKind),
    );
    if (!target) return null;

    const startIdx = target.location.line - 1;
    const { endIdx } = extractScope(lines, startIdx, language);

    const blockContent = lines.slice(startIdx, endIdx + 1).join("\n");

    return {
      content: blockContent,
      location: {
        file: resolve(file),
        line: target.location.line,
        column: 1,
        endLine: endIdx + 1,
      },
      symbolName,
      symbolKind: target.kind,
      language,
    };
  }

  async readScope(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null> {
    const content = this.readFile(file);
    if (!content) return null;

    const language = this.detectLang(file);
    const lines = content.split("\n");
    const startIdx = Math.max(0, startLine - 1);

    let endIdx: number;
    if (endLine) {
      endIdx = Math.min(endLine - 1, lines.length - 1);
    } else {
      const result = extractScope(lines, startIdx, language);
      endIdx = result.endIdx;
    }

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

  async findDefinition(file: string, symbol: string): Promise<SourceLocation[] | null> {
    // Regex can only find definitions in the same file
    const symbols = await this.findSymbols(file);
    if (!symbols) return null;

    const matches = symbols.filter((s) => s.name === symbol);
    if (matches.length === 0) return null;

    return matches.map((s) => s.location);
  }

  private readFile(file: string): string | null {
    if (this.cache) {
      return this.cache.get(resolve(file));
    }
    try {
      return readFileSync(resolve(file), "utf-8");
    } catch {
      return null;
    }
  }

  private detectLang(file: string): Language {
    return detectLanguageFromPath(file);
  }
}
