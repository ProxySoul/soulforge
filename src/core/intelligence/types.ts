// ─── Code Intelligence Types ───

/** Languages with dedicated backend support */
export type Language = "typescript" | "javascript" | "python" | "go" | "rust" | "unknown";

/** A location in source code */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** Symbol kinds for classification */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "constant"
  | "enum"
  | "property"
  | "module"
  | "namespace"
  | "unknown";

/** A symbol found in source code */
export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  location: SourceLocation;
  containerName?: string;
}

/** A diagnostic (error/warning) from static analysis */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string | number;
  source?: string;
}

/** A block of code extracted from a file */
export interface CodeBlock {
  content: string;
  location: SourceLocation;
  symbolName?: string;
  symbolKind?: SymbolKind;
  language: Language;
}

/** Result of a refactoring operation */
export interface RefactorResult {
  edits: FileEdit[];
  description: string;
}

/** A single file edit from a refactoring */
export interface FileEdit {
  file: string;
  oldContent: string;
  newContent: string;
}

/** Import information */
export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  location: SourceLocation;
}

/** Export information */
export interface ExportInfo {
  name: string;
  isDefault: boolean;
  kind: SymbolKind;
  location: SourceLocation;
}

/** File outline — top-level structure */
export interface FileOutline {
  file: string;
  language: Language;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

/** Type information for a symbol */
export interface TypeInfo {
  symbol: string;
  type: string;
  documentation?: string;
}

// ─── Backend Interface ───

/**
 * All methods are optional — backends implement what they can.
 * The router calls the highest-tier backend that supports each operation.
 */
export interface IntelligenceBackend {
  readonly name: string;
  readonly tier: number;

  /** Initialize the backend (lazy — called on first use) */
  initialize?(cwd: string): Promise<void>;

  /** Dispose resources */
  dispose?(): void;

  /** Check if this backend supports a given language */
  supportsLanguage(language: Language): boolean;

  // ─── Navigation ───
  findDefinition?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  findReferences?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  findSymbols?(file: string, query?: string): Promise<SymbolInfo[] | null>;

  findImports?(file: string): Promise<ImportInfo[] | null>;
  findExports?(file: string): Promise<ExportInfo[] | null>;

  // ─── Analysis ───
  getDiagnostics?(file: string): Promise<Diagnostic[] | null>;
  getTypeInfo?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeInfo | null>;
  getFileOutline?(file: string): Promise<FileOutline | null>;

  // ─── Reading ───
  readSymbol?(file: string, symbolName: string, symbolKind?: SymbolKind): Promise<CodeBlock | null>;

  readScope?(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null>;

  // ─── Refactoring ───
  rename?(
    file: string,
    symbol: string,
    newName: string,
    line?: number,
    column?: number,
  ): Promise<RefactorResult | null>;

  extractFunction?(
    file: string,
    startLine: number,
    endLine: number,
    functionName: string,
  ): Promise<RefactorResult | null>;

  extractVariable?(
    file: string,
    startLine: number,
    endLine: number,
    variableName: string,
  ): Promise<RefactorResult | null>;
}

// ─── Config ───

export type BackendPreference = "auto" | "ts-morph" | "lsp" | "tree-sitter" | "regex";

export interface CodeIntelligenceConfig {
  /** Force a specific backend instead of auto-detecting */
  backend?: BackendPreference;
  /** Override auto-detected language */
  language?: string;
}
