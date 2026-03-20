import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { FileCache } from "./cache.js";
import {
  type BackendPreference,
  type CodeIntelligenceConfig,
  EXT_TO_LANGUAGE,
  type IntelligenceBackend,
  type Language,
} from "./types.js";

export interface ProbeResult {
  operation: string;
  status: "pass" | "empty" | "error" | "timeout" | "unsupported";
  ms?: number;
  error?: string;
}

export interface BackendProbeResult {
  backend: string;
  tier: number;
  supports: boolean;
  initialized: boolean;
  initMs?: number;
  initError?: string;
  probes: ProbeResult[];
}

export interface HealthCheckResult {
  language: string;
  probeFile: string;
  backends: BackendProbeResult[];
}

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

      try {
        // Lazy initialization — inside try so init failures fall through to next backend
        await this.ensureInitialized(backend);

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

  /** Get detailed LSP server info for the status popup */
  getDetailedLspServers(): Array<{
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
    const lspBackend = this.backends.find((b) => b.name === "lsp");
    if (lspBackend && "getDetailedServers" in lspBackend) {
      return (
        lspBackend as {
          getDetailedServers: () => ReturnType<CodeIntelligenceRouter["getDetailedLspServers"]>;
        }
      ).getDetailedServers();
    }
    return [];
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
        try {
          await this.ensureInitialized(backend);
        } catch {
          // Skip backends that fail to initialize
        }
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
    // Build extensions list from the canonical EXT_TO_LANGUAGE map
    const exts = Object.entries(EXT_TO_LANGUAGE)
      .filter(([_, lang]) => lang === language)
      .map(([ext]) => ext);
    if (exts.length === 0) return null;

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

  /**
   * Run a health check — probe every backend with key operations against a real file.
   * Returns timing and pass/fail for each backend × operation combination.
   */
  async runHealthCheck(): Promise<HealthCheckResult> {
    const language = this.detectLanguage();
    const probeFile = this.findProbeFile(language);
    const results: BackendProbeResult[] = [];

    // Discover a real symbol name from the probe file for readSymbol test
    let probeSymbolName = "main";
    if (probeFile) {
      try {
        // Use the first backend that can find symbols to get a real name
        // Prefer function/class names, skip anything with <, empty, or weird chars
        const isValidProbeSymbol = (name: string) =>
          name.length > 0 && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);

        for (const b of this.backends) {
          if (b.supportsLanguage(language) && typeof b.findSymbols === "function") {
            if (!this.initialized.has(b.name)) {
              await b.initialize?.(this.cwd);
              this.initialized.add(b.name);
            }
            const syms = await b.findSymbols(probeFile);
            if (syms && syms.length > 0) {
              // First try to find a function or class with a clean name
              const preferred = syms.find(
                (s) => (s.kind === "function" || s.kind === "class") && isValidProbeSymbol(s.name),
              );
              // Fall back to any symbol with a clean name
              const fallback = syms.find((s) => isValidProbeSymbol(s.name));
              const chosen = preferred ?? fallback;
              if (chosen) {
                probeSymbolName = chosen.name;
                break;
              }
            }
          }
        }
      } catch {
        /* use fallback */
      }
    }

    // Key operations to test, grouped by what they need
    const fileOps: Array<{
      op: keyof IntelligenceBackend;
      label: string;
      fn: (b: IntelligenceBackend, f: string) => Promise<unknown>;
    }> = [
      {
        op: "findSymbols",
        label: "findSymbols",
        fn: (b, f) => b.findSymbols?.(f) ?? Promise.resolve(null),
      },
      {
        op: "findImports",
        label: "findImports",
        fn: (b, f) => b.findImports?.(f) ?? Promise.resolve(null),
      },
      {
        op: "findExports",
        label: "findExports",
        fn: (b, f) => b.findExports?.(f) ?? Promise.resolve(null),
      },
      {
        op: "getFileOutline",
        label: "getFileOutline",
        fn: (b, f) => b.getFileOutline?.(f) ?? Promise.resolve(null),
      },
      {
        op: "getDiagnostics",
        label: "getDiagnostics",
        fn: (b, f) => b.getDiagnostics?.(f) ?? Promise.resolve(null),
      },
      {
        op: "readSymbol",
        label: `readSymbol(${probeSymbolName})`,
        fn: (b, f) => b.readSymbol?.(f, probeSymbolName) ?? Promise.resolve(null),
      },
    ];

    for (const backend of this.backends) {
      const supports = backend.supportsLanguage(language);
      const probes: ProbeResult[] = [];

      if (!supports) {
        results.push({
          backend: backend.name,
          tier: backend.tier,
          supports: false,
          initialized: this.initialized.has(backend.name),
          probes: [],
        });
        continue;
      }

      // Try to initialize
      let initMs = 0;
      let initError: string | undefined;
      if (!this.initialized.has(backend.name)) {
        const start = performance.now();
        try {
          await backend.initialize?.(this.cwd);
          this.initialized.add(backend.name);
          initMs = Math.round(performance.now() - start);
        } catch (err) {
          initMs = Math.round(performance.now() - start);
          initError = err instanceof Error ? err.message : String(err);
        }
      }

      // Probe each operation
      if (probeFile) {
        for (const { op, label, fn } of fileOps) {
          if (typeof backend[op] !== "function") {
            probes.push({ operation: label, status: "unsupported" });
            continue;
          }
          const start = performance.now();
          try {
            const result = await Promise.race([
              fn(backend, probeFile),
              new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
            ]);
            const ms = Math.round(performance.now() - start);
            if (result === "timeout") {
              probes.push({ operation: label, status: "timeout", ms: 10_000 });
            } else if (result === null || result === undefined) {
              probes.push({ operation: label, status: "empty", ms });
            } else {
              probes.push({ operation: label, status: "pass", ms });
            }
          } catch (err) {
            const ms = Math.round(performance.now() - start);
            probes.push({
              operation: label,
              status: "error",
              ms,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      results.push({
        backend: backend.name,
        tier: backend.tier,
        supports: true,
        initialized: this.initialized.has(backend.name),
        initMs,
        initError,
        probes,
      });
    }

    return {
      language,
      probeFile: probeFile ?? "(none)",
      backends: results,
    };
  }

  private initFailed = new Set<string>();

  private async ensureInitialized(backend: IntelligenceBackend): Promise<void> {
    if (this.initialized.has(backend.name)) return;
    if (this.initFailed.has(backend.name)) {
      throw new Error(`${backend.name} initialization previously failed`);
    }
    try {
      if (backend.initialize) {
        await backend.initialize(this.cwd);
      }
      this.initialized.add(backend.name);
    } catch (err) {
      this.initFailed.add(backend.name);
      throw err;
    }
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
