import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { FileCache } from "./cache.js";
import type {
  BackendPreference,
  CodeIntelligenceConfig,
  IntelligenceBackend,
  Language,
} from "./types.js";

const EXT_TO_LANGUAGE: Record<string, Language> = {
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
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".m": "objc",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".jsonc": "json",
  ".toml": "toml",
  ".vue": "vue",
  ".res": "rescript",
  ".resi": "rescript",
  ".sol": "solidity",
  ".tla": "tlaplus",
  ".el": "elisp",
};

const PROJECT_FILE_TO_LANGUAGE: Record<string, Language> = {
  "tsconfig.json": "typescript",
  "jsconfig.json": "javascript",
  "pyproject.toml": "python",
  "setup.py": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  Gemfile: "ruby",
  "composer.json": "php",
  "Package.swift": "swift",
  "build.sbt": "scala",
  "mix.exs": "elixir",
  "pubspec.yaml": "dart",
  "build.zig": "zig",
  Makefile: "c",
  "CMakeLists.txt": "cpp",
};

/**
 * Routes intelligence operations to the best available backend.
 * Detects language from file extensions and project config,
 * then selects the highest-tier backend that supports the operation.
 */
export class CodeIntelligenceRouter {
  private backends: IntelligenceBackend[] = [];
  private initialized = new Set<string>();
  private cwd: string;
  private config: CodeIntelligenceConfig;
  readonly fileCache: FileCache;
  private detectedLanguage: Language | null = null;

  constructor(cwd: string, config: CodeIntelligenceConfig = {}) {
    this.cwd = cwd;
    this.config = config;
    this.fileCache = new FileCache();
  }

  /** Register a backend */
  registerBackend(backend: IntelligenceBackend): void {
    this.backends.push(backend);
    // Keep sorted by tier (lower = higher priority)
    this.backends.sort((a, b) => a.tier - b.tier);
  }

  /** Detect the primary language from a file or project */
  detectLanguage(file?: string): Language {
    // Config override
    if (this.config.language) {
      const lang = this.config.language as Language;
      if (lang !== "unknown") return lang;
    }

    // File extension
    if (file) {
      const ext = extname(file).toLowerCase();
      const lang = EXT_TO_LANGUAGE[ext];
      if (lang) return lang;
    }

    // Cached project detection
    if (this.detectedLanguage) return this.detectedLanguage;

    // Project config files
    for (const [configFile, lang] of Object.entries(PROJECT_FILE_TO_LANGUAGE)) {
      if (existsSync(join(this.cwd, configFile))) {
        this.detectedLanguage = lang;
        return lang;
      }
    }

    this.detectedLanguage = "unknown";
    return "unknown";
  }

  /**
   * Select the best backend for a language and operation.
   * Optionally force a specific backend via config.
   */
  selectBackend(
    language: Language,
    operation: keyof IntelligenceBackend,
  ): IntelligenceBackend | null {
    const preference = this.config.backend ?? "auto";

    if (preference !== "auto") {
      return this.findBackendByName(preference, language, operation);
    }

    // Auto: try each backend in tier order
    for (const backend of this.backends) {
      if (backend.supportsLanguage(language) && typeof backend[operation] === "function") {
        return backend;
      }
    }
    return null;
  }

  /**
   * Execute an operation with automatic fallback through backends.
   * Tries each backend in tier order until one succeeds.
   */
  async executeWithFallback<T>(
    language: Language,
    operation: keyof IntelligenceBackend,
    fn: (backend: IntelligenceBackend) => Promise<T | null>,
  ): Promise<T | null> {
    const result = await this.executeWithFallbackTracked(language, operation, fn);
    return result?.value ?? null;
  }

  /**
   * Like executeWithFallback but also returns which backend handled the call.
   */
  async executeWithFallbackTracked<T>(
    language: Language,
    operation: keyof IntelligenceBackend,
    fn: (backend: IntelligenceBackend) => Promise<T | null>,
  ): Promise<{ value: T; backend: string } | null> {
    const preference = this.config.backend ?? "auto";

    const candidates =
      preference !== "auto" ? this.backends.filter((b) => b.name === preference) : this.backends;

    for (const backend of candidates) {
      if (!backend.supportsLanguage(language) || typeof backend[operation] !== "function") {
        continue;
      }

      // Lazy initialization
      await this.ensureInitialized(backend);

      try {
        const result = await Promise.race([
          fn(backend),
          new Promise<null>((resolve) => setTimeout(resolve, 30_000, null)),
        ]);
        if (result !== null) return { value: result, backend: backend.name };
      } catch {
        // Fall through to next backend
      }
    }

    return null;
  }

  /** Get status of all initialized backends, including active LSP servers */
  getStatus(): {
    initialized: string[];
    lspServers: Array<{ language: string; command: string }>;
  } {
    const lspBackend = this.backends.find((b) => b.name === "lsp");
    const lspServers =
      lspBackend && "getActiveServers" in lspBackend
        ? (
            lspBackend as { getActiveServers: () => Array<{ language: string; command: string }> }
          ).getActiveServers()
        : [];
    return {
      initialized: [...this.initialized],
      lspServers,
    };
  }

  /** Get PIDs of all child processes (LSP servers) managed by backends */
  getChildPids(): number[] {
    const lspBackend = this.backends.find((b) => b.name === "lsp");
    if (lspBackend && "getChildPids" in lspBackend) {
      return (lspBackend as { getChildPids: () => number[] }).getChildPids();
    }
    return [];
  }

  /** Get info about available backends for a language */
  getAvailableBackends(language: Language): string[] {
    return this.backends
      .filter((b) => b.supportsLanguage(language))
      .map((b) => `${b.name} (tier ${String(b.tier)})`);
  }

  /**
   * Eagerly initialize all backends for the detected project language.
   * Call at startup so LSP servers are warm before the first tool call.
   */
  async warmup(): Promise<void> {
    const language = this.detectLanguage();
    if (language === "unknown") return;

    for (const backend of this.backends) {
      if (backend.supportsLanguage(language)) {
        await this.ensureInitialized(backend);
      }
    }

    // Ensure a standalone LSP server is running — always, even if Neovim is open.
    // This keeps the server warm so there's no cold start if Neovim closes mid-session.
    const lsp = this.backends.find((b) => b.name === "lsp");
    if (lsp?.supportsLanguage(language) && "ensureStandaloneReady" in lsp) {
      const probeFile = this.findProbeFile(language);
      if (probeFile) {
        try {
          await Promise.race([
            (lsp as { ensureStandaloneReady: (f: string) => Promise<void> }).ensureStandaloneReady(
              probeFile,
            ),
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ]);
        } catch {
          // Warmup failure is non-fatal
        }
      }
    }
  }

  /** Find a file to use for LSP warmup probing */
  private findProbeFile(language: Language): string | null {
    const extMap: Partial<Record<Language, string[]>> = {
      typescript: [".ts", ".tsx"],
      javascript: [".js", ".jsx"],
      python: [".py"],
      go: [".go"],
      rust: [".rs"],
    };
    const exts = extMap[language];
    if (!exts) return null;

    // Check src/ first, then root
    for (const dir of ["src", "."]) {
      const full = join(this.cwd, dir);
      try {
        if (!existsSync(full)) continue;
        const entries = readdirSync(full);
        for (const entry of entries) {
          if (exts.some((ext) => entry.endsWith(ext))) {
            return join(full, entry);
          }
        }
      } catch {}
    }
    return null;
  }

  /** Dispose all backends */
  dispose(): void {
    for (const backend of this.backends) {
      backend.dispose?.();
    }
    this.backends = [];
    this.initialized.clear();
    this.fileCache.clear();
  }

  private async ensureInitialized(backend: IntelligenceBackend): Promise<void> {
    if (this.initialized.has(backend.name)) return;
    if (backend.initialize) {
      await backend.initialize(this.cwd);
    }
    this.initialized.add(backend.name);
  }

  private findBackendByName(
    name: BackendPreference,
    language: Language,
    operation: keyof IntelligenceBackend,
  ): IntelligenceBackend | null {
    for (const backend of this.backends) {
      if (
        backend.name === name &&
        backend.supportsLanguage(language) &&
        typeof backend[operation] === "function"
      ) {
        return backend;
      }
    }
    return null;
  }
}
