import { resolve } from "node:path";
import type {
  CodeBlock,
  Diagnostic,
  ExportInfo,
  FileEdit,
  FileOutline,
  ImportInfo,
  IntelligenceBackend,
  Language,
  RefactorResult,
  SourceLocation,
  SymbolInfo,
  SymbolKind,
  TypeHierarchyResult,
  TypeInfo,
  UnusedItem,
} from "../types.js";

// Lazy import to avoid loading ts-morph until needed
type TsMorphModule = typeof import("ts-morph");
type Project = import("ts-morph").Project;
type SourceFile = import("ts-morph").SourceFile;
type Node = import("ts-morph").Node;

let tsMorphModule: TsMorphModule | null = null;

async function getTsMorph(): Promise<TsMorphModule> {
  if (!tsMorphModule) {
    tsMorphModule = await import("ts-morph");
  }
  return tsMorphModule;
}

/**
 * ts-morph based backend (Tier 2) for TypeScript/JavaScript.
 * Full semantic analysis: definitions, references, diagnostics, rename, etc.
 * Falls back here when LSP is unavailable.
 */
export class TsMorphBackend implements IntelligenceBackend {
  readonly name = "ts-morph";
  readonly tier = 2;
  private project: Project | null = null;
  private cwd = "";

  supportsLanguage(language: Language): boolean {
    return language === "typescript" || language === "javascript";
  }

  async initialize(cwd: string): Promise<void> {
    this.cwd = cwd;
    // Project is created lazily on first use
  }

  dispose(): void {
    this.project = null;
  }

  async findDefinition(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const ts = await getTsMorph();
    if (!ts.Node.isIdentifier(node)) {
      return null;
    }

    const defs = node.getDefinitionNodes();
    if (defs.length === 0) return null;

    return defs.map((d: import("ts-morph").Node) => ({
      file: d.getSourceFile().getFilePath(),
      line: d.getStartLineNumber(),
      column: d.getStart() - d.getStartLinePos() + 1,
    }));
  }

  async findReferences(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const ts = await getTsMorph();
    if (!ts.Node.isIdentifier(node)) return null;

    const refs = node.findReferencesAsNodes();
    if (refs.length === 0) return null;

    return refs.map((r) => ({
      file: r.getSourceFile().getFilePath(),
      line: r.getStartLineNumber(),
      column: r.getStart() - r.getStartLinePos() + 1,
    }));
  }

  async findSymbols(file: string, query?: string): Promise<SymbolInfo[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const symbols: SymbolInfo[] = [];
    const ts = await getTsMorph();

    // Functions
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: "function",
        location: {
          file: resolve(file),
          line: fn.getStartLineNumber(),
          column: 1,
          endLine: fn.getEndLineNumber(),
        },
      });
    }

    // Classes
    for (const cls of sourceFile.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: "class",
        location: {
          file: resolve(file),
          line: cls.getStartLineNumber(),
          column: 1,
          endLine: cls.getEndLineNumber(),
        },
      });
    }

    // Interfaces
    for (const iface of sourceFile.getInterfaces()) {
      const name = iface.getName();
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: "interface",
        location: {
          file: resolve(file),
          line: iface.getStartLineNumber(),
          column: 1,
          endLine: iface.getEndLineNumber(),
        },
      });
    }

    // Type aliases
    for (const ta of sourceFile.getTypeAliases()) {
      const name = ta.getName();
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: "type",
        location: {
          file: resolve(file),
          line: ta.getStartLineNumber(),
          column: 1,
          endLine: ta.getEndLineNumber(),
        },
      });
    }

    // Enums
    for (const en of sourceFile.getEnums()) {
      const name = en.getName();
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      symbols.push({
        name,
        kind: "enum",
        location: {
          file: resolve(file),
          line: en.getStartLineNumber(),
          column: 1,
          endLine: en.getEndLineNumber(),
        },
      });
    }

    // Variable declarations (const/let)
    for (const stmt of sourceFile.getVariableStatements()) {
      for (const decl of stmt.getDeclarations()) {
        const name = decl.getName();
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
        const isConst = stmt.getDeclarationKind() === ts.VariableDeclarationKind.Const;
        symbols.push({
          name,
          kind: isConst ? "constant" : "variable",
          location: {
            file: resolve(file),
            line: decl.getStartLineNumber(),
            column: 1,
            endLine: decl.getEndLineNumber(),
          },
        });
      }
    }

    return symbols;
  }

  async findImports(file: string): Promise<ImportInfo[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    return sourceFile.getImportDeclarations().map((imp) => {
      const specifiers: string[] = [];
      const defaultImport = imp.getDefaultImport();
      if (defaultImport) specifiers.push(defaultImport.getText());

      for (const named of imp.getNamedImports()) {
        specifiers.push(named.getName());
      }

      const namespaceImport = imp.getNamespaceImport();

      return {
        source: imp.getModuleSpecifierValue(),
        specifiers,
        isDefault: !!defaultImport,
        isNamespace: !!namespaceImport,
        location: {
          file: resolve(file),
          line: imp.getStartLineNumber(),
          column: 1,
        },
      };
    });
  }

  async findExports(file: string): Promise<ExportInfo[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const exports: ExportInfo[] = [];

    for (const exp of sourceFile.getExportedDeclarations()) {
      const [name, decls] = exp;
      for (const decl of decls) {
        let kind: SymbolKind = "variable";
        const ts = await getTsMorph();
        if (ts.Node.isFunctionDeclaration(decl)) kind = "function";
        else if (ts.Node.isClassDeclaration(decl)) kind = "class";
        else if (ts.Node.isInterfaceDeclaration(decl)) kind = "interface";
        else if (ts.Node.isTypeAliasDeclaration(decl)) kind = "type";
        else if (ts.Node.isEnumDeclaration(decl)) kind = "enum";

        exports.push({
          name,
          isDefault: name === "default",
          kind,
          location: {
            file: resolve(file),
            line: decl.getStartLineNumber(),
            column: 1,
          },
        });
      }
    }

    return exports;
  }

  async getDiagnostics(file: string): Promise<Diagnostic[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const project = this.getProject();
    if (!project) return null;

    const preDiags = project
      .getPreEmitDiagnostics()
      .filter((d) => d.getSourceFile()?.getFilePath() === sourceFile.getFilePath());

    const ts = await getTsMorph();

    return preDiags.map((d) => {
      const start = d.getStart();
      let line = 1;
      let column = 1;
      if (start !== undefined) {
        const lineAndCol = sourceFile.getLineAndColumnAtPos(start);
        line = lineAndCol.line;
        column = lineAndCol.column;
      }

      const catMap: Record<number, Diagnostic["severity"]> = {
        [ts.DiagnosticCategory.Error]: "error",
        [ts.DiagnosticCategory.Warning]: "warning",
        [ts.DiagnosticCategory.Suggestion]: "hint",
        [ts.DiagnosticCategory.Message]: "info",
      };

      return {
        file: resolve(file),
        line,
        column,
        severity: catMap[d.getCategory()] ?? "error",
        message: d.getMessageText().toString(),
        code: d.getCode(),
        source: "typescript",
      };
    });
  }

  async getTypeInfo(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeInfo | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const nodeType = node.getType();

    return {
      symbol,
      type: nodeType.getText(node),
      documentation: this.getNodeDocumentation(node),
    };
  }

  async getFileOutline(file: string): Promise<FileOutline | null> {
    const [symbols, imports, exports] = await Promise.all([
      this.findSymbols(file),
      this.findImports(file),
      this.findExports(file),
    ]);

    if (!symbols) return null;

    const language = this.detectLang(file);

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
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const ts = await getTsMorph();
    const language = this.detectLang(file);

    // Search through different declaration types
    const candidates: Node[] = [];

    if (!symbolKind || symbolKind === "function") {
      candidates.push(...sourceFile.getFunctions().filter((f) => f.getName() === symbolName));
    }
    if (!symbolKind || symbolKind === "class") {
      candidates.push(...sourceFile.getClasses().filter((c) => c.getName() === symbolName));
    }
    if (!symbolKind || symbolKind === "interface") {
      candidates.push(...sourceFile.getInterfaces().filter((i) => i.getName() === symbolName));
    }
    if (!symbolKind || symbolKind === "type") {
      candidates.push(...sourceFile.getTypeAliases().filter((t) => t.getName() === symbolName));
    }
    if (!symbolKind || symbolKind === "enum") {
      candidates.push(...sourceFile.getEnums().filter((e) => e.getName() === symbolName));
    }
    if (!symbolKind || symbolKind === "variable" || symbolKind === "constant") {
      for (const stmt of sourceFile.getVariableStatements()) {
        for (const decl of stmt.getDeclarations()) {
          if (decl.getName() === symbolName) {
            candidates.push(stmt);
          }
        }
      }
    }

    const target = candidates[0];
    if (!target) return null;

    let kind: SymbolKind = "unknown";
    if (ts.Node.isFunctionDeclaration(target)) kind = "function";
    else if (ts.Node.isClassDeclaration(target)) kind = "class";
    else if (ts.Node.isInterfaceDeclaration(target)) kind = "interface";
    else if (ts.Node.isTypeAliasDeclaration(target)) kind = "type";
    else if (ts.Node.isEnumDeclaration(target)) kind = "enum";
    else if (ts.Node.isVariableStatement(target)) kind = "variable";

    return {
      content: target.getFullText().trimStart(),
      location: {
        file: resolve(file),
        line: target.getStartLineNumber(),
        column: 1,
        endLine: target.getEndLineNumber(),
      },
      symbolName,
      symbolKind: kind,
      language,
    };
  }

  async readScope(file: string, startLine: number, endLine?: number): Promise<CodeBlock | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const language = this.detectLang(file);
    const fullText = sourceFile.getFullText();
    const lines = fullText.split("\n");
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

  async rename(
    file: string,
    symbol: string,
    newName: string,
    line?: number,
    column?: number,
  ): Promise<RefactorResult | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const ts = await getTsMorph();
    if (!ts.Node.isIdentifier(node)) return null;

    // Collect all files that will be affected before rename
    const refs = node.findReferencesAsNodes();
    const affectedFiles = new Set<string>();
    for (const ref of refs) {
      affectedFiles.add(ref.getSourceFile().getFilePath());
    }
    affectedFiles.add(sourceFile.getFilePath());

    // Get content before rename
    const beforeContent = new Map<string, string>();
    for (const filePath of affectedFiles) {
      const sf = this.getProject()?.getSourceFile(filePath);
      if (sf) beforeContent.set(filePath, sf.getFullText());
    }

    // Perform rename
    node.rename(newName);

    // Collect edits
    const edits: FileEdit[] = [];
    for (const filePath of affectedFiles) {
      const sf = this.getProject()?.getSourceFile(filePath);
      const before = beforeContent.get(filePath);
      if (sf && before) {
        const after = sf.getFullText();
        if (before !== after) {
          edits.push({
            file: filePath,
            oldContent: before,
            newContent: after,
          });
        }
      }
    }

    return {
      edits,
      description: `Renamed '${symbol}' to '${newName}' in ${String(edits.length)} file(s)`,
    };
  }

  async extractFunction(
    file: string,
    startLine: number,
    endLine: number,
    functionName: string,
  ): Promise<RefactorResult | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const ts = await getTsMorph();
    const fullText = sourceFile.getFullText();
    const lines = fullText.split("\n");
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(endLine - 1, lines.length - 1);

    const extractedLines = lines.slice(startIdx, endIdx + 1);
    const extractedCode = extractedLines.join("\n");
    const indent = (extractedLines[0] ?? "").match(/^(\s*)/)?.[1] ?? "";

    // Analyze the extracted range to find referenced outer-scope variables
    const startPos = sourceFile.compilerNode.getPositionOfLineAndCharacter(startIdx, 0);
    const endPos = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      endIdx,
      (lines[endIdx] ?? "").length,
    );

    const params: string[] = [];
    const paramNames = new Set<string>();

    // Walk descendants in the range and find identifiers referencing outer scope
    sourceFile.forEachDescendant((node) => {
      if (!ts.Node.isIdentifier(node)) return;
      const nodeStart = node.getStart();
      if (nodeStart < startPos || nodeStart > endPos) return;

      const name = node.getText();
      if (paramNames.has(name)) return;

      // Check if this identifier is defined outside the range
      const defs = node.getDefinitionNodes();
      for (const def of defs) {
        const defStart = def.getStartLineNumber();
        if (def.getSourceFile() === sourceFile && (defStart < startLine || defStart > endLine)) {
          // It's an outer variable — add as parameter
          const nodeType = node.getType();
          const typeText = nodeType.getText(node);
          params.push(`${name}: ${typeText}`);
          paramNames.add(name);
          break;
        }
      }
    });

    // Detect return value from last expression
    const lastLine = extractedLines[extractedLines.length - 1]?.trim() ?? "";
    const hasReturn = lastLine.startsWith("return ");
    const paramList = params.join(", ");
    const argList = [...paramNames].join(", ");

    const newFunc = `\nfunction ${functionName}(${paramList}) {\n${extractedCode}\n}\n`;
    const callExpr = hasReturn
      ? `${indent}return ${functionName}(${argList});`
      : `${indent}${functionName}(${argList});`;

    const newLines = [...lines];
    newLines.splice(startIdx, endIdx - startIdx + 1, callExpr);
    const newContent = `${newLines.join("\n")}\n${newFunc}`;

    return {
      edits: [
        {
          file: resolve(file),
          oldContent: fullText,
          newContent,
        },
      ],
      description: `Extracted lines ${String(startLine)}-${String(endLine)} into function '${functionName}(${paramList})'`,
    };
  }

  async extractVariable(
    file: string,
    startLine: number,
    endLine: number,
    variableName: string,
  ): Promise<RefactorResult | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const fullText = sourceFile.getFullText();
    const lines = fullText.split("\n");
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(endLine - 1, lines.length - 1);

    const extractedCode = lines
      .slice(startIdx, endIdx + 1)
      .join("\n")
      .trim();
    const indent = (lines[startIdx] ?? "").match(/^(\s*)/)?.[1] ?? "";

    const declaration = `${indent}const ${variableName} = ${extractedCode};`;
    const replacement = `${indent}${variableName}`;

    const newLines = [...lines];
    newLines.splice(startIdx, endIdx - startIdx + 1, declaration, replacement);

    return {
      edits: [
        {
          file: resolve(file),
          oldContent: fullText,
          newContent: newLines.join("\n"),
        },
      ],
      description: `Extracted lines ${String(startLine)}-${String(endLine)} into variable '${variableName}'`,
    };
  }

  async findImplementation(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<SourceLocation[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const ts = await getTsMorph();
    if (!ts.Node.isIdentifier(node)) return null;

    const impls = node.getImplementations();
    if (impls.length === 0) return null;

    return impls.map((impl) => {
      const sf = impl.getSourceFile();
      const pos = sf.getLineAndColumnAtPos(impl.getTextSpan().getStart());
      return {
        file: sf.getFilePath(),
        line: pos.line,
        column: pos.column,
      };
    });
  }

  async getTypeHierarchy(
    file: string,
    symbol: string,
    line?: number,
    column?: number,
  ): Promise<TypeHierarchyResult | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const node = this.findNode(sourceFile, symbol, line, column);
    if (!node) return null;

    const ts = await getTsMorph();
    const parent = ts.Node.isIdentifier(node) ? node.getParent() : node;
    if (!parent) return null;

    const item = {
      name: symbol,
      kind: "function" as SourceLocation["file"] extends string ? "class" : "unknown" as never,
      file: resolve(file),
      line: node.getStartLineNumber(),
    };

    const supertypes: TypeHierarchyResult["supertypes"] = [];
    const subtypes: TypeHierarchyResult["subtypes"] = [];

    if (ts.Node.isClassDeclaration(parent)) {
      item.kind = "class" as never;
      // Supertypes
      const baseClass = parent.getBaseClass();
      if (baseClass) {
        supertypes.push({
          name: baseClass.getName() ?? "anonymous",
          kind: "class",
          file: baseClass.getSourceFile().getFilePath(),
          line: baseClass.getStartLineNumber(),
        });
      }
      for (const impl of parent.getImplements()) {
        const typeNode = impl.getExpression();
        const defs = ts.Node.isIdentifier(typeNode) ? typeNode.getDefinitionNodes() : [];
        for (const def of defs) {
          supertypes.push({
            name: typeNode.getText(),
            kind: "interface",
            file: def.getSourceFile().getFilePath(),
            line: def.getStartLineNumber(),
          });
        }
      }
      // Subtypes — find classes that extend this one
      const refs = parent.getNameNode()?.findReferencesAsNodes() ?? [];
      for (const ref of refs) {
        const refParent = ref.getParent();
        if (refParent && ts.Node.isHeritageClause(refParent.getParent() ?? refParent)) {
          const classDecl = refParent.getParent()?.getParent();
          if (classDecl && ts.Node.isClassDeclaration(classDecl)) {
            subtypes.push({
              name: classDecl.getName() ?? "anonymous",
              kind: "class",
              file: classDecl.getSourceFile().getFilePath(),
              line: classDecl.getStartLineNumber(),
            });
          }
        }
      }
    } else if (ts.Node.isInterfaceDeclaration(parent)) {
      item.kind = "interface" as never;
      // Supertypes
      for (const ext of parent.getExtends()) {
        const typeNode = ext.getExpression();
        const defs = ts.Node.isIdentifier(typeNode) ? typeNode.getDefinitionNodes() : [];
        for (const def of defs) {
          supertypes.push({
            name: typeNode.getText(),
            kind: "interface",
            file: def.getSourceFile().getFilePath(),
            line: def.getStartLineNumber(),
          });
        }
      }
      // Subtypes — find implementors
      const refs = parent.getNameNode().findReferencesAsNodes();
      for (const ref of refs) {
        const refParent = ref.getParent();
        if (refParent && ts.Node.isHeritageClause(refParent.getParent() ?? refParent)) {
          const container = refParent.getParent()?.getParent();
          if (container && ts.Node.isClassDeclaration(container)) {
            subtypes.push({
              name: container.getName() ?? "anonymous",
              kind: "class",
              file: container.getSourceFile().getFilePath(),
              line: container.getStartLineNumber(),
            });
          }
        }
      }
    } else {
      return null;
    }

    return { item, supertypes, subtypes };
  }

  async findUnused(file: string): Promise<UnusedItem[] | null> {
    const sourceFile = await this.getSourceFile(file);
    if (!sourceFile) return null;

    const ts = await getTsMorph();
    const unused: UnusedItem[] = [];

    // Check unused imports
    for (const imp of sourceFile.getImportDeclarations()) {
      const defaultImport = imp.getDefaultImport();
      if (defaultImport) {
        const refs = defaultImport.findReferencesAsNodes();
        // Only the declaration itself = unused
        if (refs.length <= 1) {
          unused.push({
            name: defaultImport.getText(),
            kind: "import",
            file: resolve(file),
            line: imp.getStartLineNumber(),
          });
        }
      }
      for (const named of imp.getNamedImports()) {
        const nameNode = named.getAliasNode();
        const effectiveNode = nameNode ?? named.getNameNode();
        const refs =
          "findReferencesAsNodes" in effectiveNode
            ? (effectiveNode as import("ts-morph").Identifier).findReferencesAsNodes()
            : [];
        if (refs.length <= 1) {
          unused.push({
            name: named.getName(),
            kind: "import",
            file: resolve(file),
            line: imp.getStartLineNumber(),
          });
        }
      }
    }

    // Check unused exports — see if exported symbol is imported anywhere
    const project = this.getProject();
    if (project) {
      for (const [name, decls] of sourceFile.getExportedDeclarations()) {
        if (name === "default") continue;
        const decl = decls[0];
        if (!decl) continue;
        const nameNode = ts.Node.isIdentifier(decl)
          ? decl
          : "getNameNode" in decl && typeof decl.getNameNode === "function"
            ? (decl.getNameNode() as Node | undefined)
            : null;
        if (!nameNode || !ts.Node.isIdentifier(nameNode)) continue;

        const refs = nameNode.findReferencesAsNodes();
        const externalRefs = refs.filter((r) => r.getSourceFile() !== sourceFile);
        if (externalRefs.length === 0) {
          unused.push({
            name,
            kind: "export",
            file: resolve(file),
            line: decl.getStartLineNumber(),
          });
        }
      }
    }

    return unused.length > 0 ? unused : null;
  }

  private getProject(): Project | null {
    return this.project;
  }

  private async ensureProject(): Promise<Project> {
    if (this.project) return this.project;

    const ts = await getTsMorph();
    const tsconfigPath = resolve(this.cwd, "tsconfig.json");

    try {
      this.project = new ts.Project({
        tsConfigFilePath: tsconfigPath,
        skipAddingFilesFromTsConfig: false,
      });
    } catch {
      // No tsconfig — create a standalone project
      this.project = new ts.Project({
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: true,
          jsx: ts.ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          skipLibCheck: true,
          allowJs: true,
        },
      });
    }

    return this.project;
  }

  private async getSourceFile(file: string): Promise<SourceFile | null> {
    const project = await this.ensureProject();
    const absPath = resolve(file);

    let sourceFile = project.getSourceFile(absPath);
    if (!sourceFile) {
      try {
        sourceFile = project.addSourceFileAtPath(absPath);
      } catch {
        return null;
      }
    }

    return sourceFile;
  }

  private findNode(
    sourceFile: SourceFile,
    symbol: string,
    line?: number,
    column?: number,
  ): Node | null {
    if (line && column) {
      const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, column - 1);
      return sourceFile.getDescendantAtPos(pos) ?? null;
    }

    // Search by name — find first identifier matching the symbol
    const found = sourceFile.forEachDescendant((node) => {
      const ts = tsMorphModule;
      if (!ts) return undefined;
      if (ts.Node.isIdentifier(node) && node.getText() === symbol) {
        return node;
      }
      return undefined;
    });

    return found ?? null;
  }

  private getNodeDocumentation(node: Node): string | undefined {
    const ts = tsMorphModule;
    if (!ts) return undefined;

    // Check if the node or its parent has JSDoc
    const target = ts.Node.isIdentifier(node) ? node.getParent() : node;
    if (!target) return undefined;

    if ("getJsDocs" in target && typeof target.getJsDocs === "function") {
      const jsDocs = target.getJsDocs() as Array<{ getDescription(): string }>;
      if (jsDocs.length > 0) {
        return jsDocs.map((d) => d.getDescription()).join("\n");
      }
    }

    return undefined;
  }

  private detectLang(file: string): Language {
    const dot = file.lastIndexOf(".");
    if (dot === -1) return "unknown";
    const ext = file.slice(dot);
    if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
    return "unknown";
  }
}
