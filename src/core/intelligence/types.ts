// ─── Code Intelligence Types ───

/** Languages with dedicated backend support */
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "scala"
  | "lua"
  | "elixir"
  | "dart"
  | "zig"
  | "bash"
  | "ocaml"
  | "objc"
  | "css"
  | "html"
  | "json"
  | "toml"
  | "vue"
  | "rescript"
  | "solidity"
  | "tlaplus"
  | "elisp"
  | "unknown";

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

/** A code action (quick-fix or refactoring suggestion) */
export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
}

/** Result of a format operation */
export interface FormatEdit {
  file: string;
  edits: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    newText: string;
  }[];
}

/** An item in a call hierarchy */
export interface CallHierarchyItem {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
}

/** Result of a call hierarchy query */
export interface CallHierarchyResult {
  item: CallHierarchyItem;
  incoming: CallHierarchyItem[];
  outgoing: CallHierarchyItem[];
}

/** An item in a type hierarchy */
export interface TypeHierarchyItem {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
}

/** Result of a type hierarchy query */
export interface TypeHierarchyResult {
  item: TypeHierarchyItem;
  supertypes: TypeHierarchyItem[];
  subtypes: TypeHierarchyItem[];
}

/** An unused import or export */
export interface UnusedItem {
  name: string;
  kind: "import" | "export";
  file: string;
  line: number;
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

  // ─── LSP Fundamentals ───
  getCodeActions?(
    file: string,
    startLine: number,
    endLine: number,
    diagnosticCodes?: (string | number)[],
  ): Promise<CodeAction[] | null>;

  findWorkspaceSymbols?(query: string): Promise<SymbolInfo[] | null>;

  formatDocument?(file: string): Promise<FormatEdit | null>;

  formatRange?(file: string, startLine: number, endLine: number): Promise<FormatEdit | null>;

  organizeImports?(file: string): Promise<RefactorResult | null>;

  // ─── Advanced Intelligence ───
  getCallHierarchy?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<CallHierarchyResult | null>;

  // ─── Power Features ───
  findImplementation?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null>;

  getTypeHierarchy?(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeHierarchyResult | null>;

  findUnused?(file: string): Promise<UnusedItem[] | null>;
}

// ─── Config ───

export type BackendPreference = "auto" | "ts-morph" | "lsp" | "tree-sitter" | "regex";

export interface CodeIntelligenceConfig {
  /** Force a specific backend instead of auto-detecting */
  backend?: BackendPreference;
  /** Override auto-detected language */
  language?: string;
}
