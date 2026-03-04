import { existsSync } from "node:fs";
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
};

const PROJECT_FILE_TO_LANGUAGE: Record<string, Language> = {
  "tsconfig.json": "typescript",
  "jsconfig.json": "javascript",
  "pyproject.toml": "python",
  "setup.py": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
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
        const result = await fn(backend);
        if (result !== null) return result;
      } catch {
        // Fall through to next backend
      }
    }

    return null;
  }

  /** Get info about available backends for a language */
  getAvailableBackends(language: Language): string[] {
    return this.backends
      .filter((b) => b.supportsLanguage(language))
      .map((b) => `${b.name} (tier ${String(b.tier)})`);
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
