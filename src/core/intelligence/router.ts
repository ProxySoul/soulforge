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

  /** Restart LSP servers. Pass filter to restart specific server/language, or omit for all. */
  async restartLspServers(filter?: string): Promise<string[]> {
    const lspBackend = this.backends.find((b) => b.name === "lsp");
    if (lspBackend && "restartServers" in lspBackend) {
      const restarted = await (
        lspBackend as { restartServers: (f?: string) => Promise<string[]> }
      ).restartServers(filter);
      // Re-warmup after restart
      this.warmup().catch(() => {});
      return restarted;
    }
    return [];
  }

  /** Get neovim's active LSP clients */
  async getNvimLspClients(): Promise<Array<{
    name: string;
    language: string;
    pid: number | null;
  }> | null> {
    const lspBackend = this.backends.find((b) => b.name === "lsp");
    if (lspBackend && "getNvimClients" in lspBackend) {
      return (
        lspBackend as {
          getNvimClients: () => Promise<Array<{
            name: string;
            language: string;
            pid: number | null;
          }> | null>;
        }
      ).getNvimClients();
    }
    return null;
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
    const languages = this.detectAllLanguages();
    if (languages.length === 0) return;

    // Initialize backends for the primary language
    const primary = languages[0];
    if (!primary) return;
    for (const backend of this.backends) {
      if (backend.supportsLanguage(primary)) {
        try {
          await this.ensureInitialized(backend);
        } catch {}
      }
    }

    // Spawn standalone LSP servers for ALL detected project languages.
    // Always runs — even if Neovim is open — so there's no cold start if Neovim closes.
    const lsp = this.backends.find((b) => b.name === "lsp");
    if (lsp && "ensureStandaloneReady" in lsp) {
      const warmupLsp = lsp as { ensureStandaloneReady: (f: string) => Promise<void> };
      const warmupPromises: Promise<void>[] = [];
      for (const lang of languages) {
        if (!lsp.supportsLanguage(lang)) continue;
        const probeFile = this.findProbeFile(lang);
        if (!probeFile) continue;
        warmupPromises.push(
          Promise.race([
            warmupLsp.ensureStandaloneReady(probeFile),
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ]).catch(() => {}),
        );
      }
      await Promise.all(warmupPromises);
    }
  }

  /** Detect all languages present in the project (config files + file scan). */
  private detectAllLanguages(): Language[] {
    const found: Language[] = [];
    const seen = new Set<Language>();

    const add = (lang: Language) => {
      if (seen.has(lang) || lang === "unknown") return;
      found.push(lang);
      seen.add(lang);
    };

    // 1. Config override
    if (this.config.language) add(this.config.language as Language);

    // 2. Project config files (fast, no recursion)
    for (const [configFile, lang] of Object.entries(PROJECT_FILE_TO_LANGUAGE)) {
      if (existsSync(join(this.cwd, configFile))) add(lang);
    }

    // 3. Scan source files (BFS — shallower limits than findProbeFile; JVM gets deeper scan)
    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "out",
      "vendor",
      "__pycache__",
      ".venv",
      "venv",
      "target",
      ".next",
      ".nuxt",
      ".output",
      "coverage",
      ".turbo",
      ".cache",
    ]);
    // Use deeper scan if a JVM language was already detected via config files
    const hasJvm = found.some((l) => l === "java" || l === "kotlin" || l === "scala");
    const MAX_DEPTH = hasJvm ? 8 : 3;
    const MAX_DIRS = hasJvm ? 500 : 100;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: this.cwd, depth: 0 }];
    let visited = 0;

    while (queue.length > 0 && visited < MAX_DIRS) {
      const item = queue.shift();
      if (!item) break;
      visited++;
      try {
        const entries = readdirSync(item.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            const dot = entry.name.lastIndexOf(".");
            if (dot > 0) {
              const ext = entry.name.slice(dot).toLowerCase();
              const lang = EXT_TO_LANGUAGE[ext];
              if (lang) add(lang);
            }
          }
        }
        if (item.depth < MAX_DEPTH) {
          for (const entry of entries) {
            if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
              queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
            }
          }
        }
      } catch {}
    }

    if (found.length > 0 && !this.detectedLanguage) {
      this.detectedLanguage = found[0] ?? null;
    }

    return found;
  }

  /**
   * Find a source file for the given language via breadth-first directory scan.
   * Skips node_modules, .git, dist, build, vendor, and hidden dirs.
   * Returns the first matching file found, preferring shallower directories.
   */
  private findProbeFile(language: Language): string | null {
    const exts = Object.entries(EXT_TO_LANGUAGE)
      .filter(([_, lang]) => lang === language)
      .map(([ext]) => ext);
    if (exts.length === 0) return null;

    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "out",
      "vendor",
      "__pycache__",
      ".venv",
      "venv",
      "target",
      ".next",
      ".nuxt",
      ".output",
      "coverage",
      ".turbo",
      ".cache",
    ]);
    // JVM projects (Java/Kotlin/Scala) have deep source trees:
    // module/src/main/java/com/example/pkg/Foo.java = depth 6+
    const isJvmLanguage = language === "java" || language === "kotlin" || language === "scala";
    const MAX_DEPTH = isJvmLanguage ? 10 : 4;
    const MAX_DIRS = isJvmLanguage ? 500 : 200;

    const queue: Array<{ dir: string; depth: number }> = [{ dir: this.cwd, depth: 0 }];
    let visited = 0;

    while (queue.length > 0 && visited < MAX_DIRS) {
      const item = queue.shift();
      if (!item) break;
      visited++;
      try {
        const entries = readdirSync(item.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
            return join(item.dir, entry.name);
          }
        }
        if (item.depth < MAX_DEPTH) {
          for (const entry of entries) {
            if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
              queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
            }
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
  async runHealthCheck(
    onProgress?: (partial: HealthCheckResult) => void,
  ): Promise<HealthCheckResult> {
    const language = this.detectLanguage();
    const probeFile = this.findProbeFile(language);
    const results: BackendProbeResult[] = [];

    const INIT_TIMEOUT = 10_000;
    const OP_TIMEOUT = 5_000;

    // Discover a real symbol name from the probe file for readSymbol test
    let probeSymbolName = "main";
    if (probeFile) {
      try {
        const isValidProbeSymbol = (name: string) =>
          name.length > 0 && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);

        for (const b of this.backends) {
          if (b.supportsLanguage(language) && typeof b.findSymbols === "function") {
            if (!this.initialized.has(b.name)) {
              const initResult = await Promise.race([
                b.initialize?.(this.cwd),
                new Promise<"timeout">((r) => setTimeout(() => r("timeout"), INIT_TIMEOUT)),
              ]);
              if (initResult === "timeout") continue;
              this.initialized.add(b.name);
            }
            const syms = await Promise.race([
              b.findSymbols(probeFile),
              new Promise<null>((r) => setTimeout(() => r(null), OP_TIMEOUT)),
            ]);
            if (syms && syms.length > 0) {
              const preferred = syms.find(
                (s) => (s.kind === "function" || s.kind === "class") && isValidProbeSymbol(s.name),
              );
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
      {
        op: "findImplementation",
        label: `findImplementation(${probeSymbolName})`,
        fn: (b, f) => b.findImplementation?.(f, probeSymbolName) ?? Promise.resolve(null),
      },
    ];

    const probeOp = async (
      fn: () => Promise<unknown>,
      label: string,
      probes: ProbeResult[],
      timeout = OP_TIMEOUT,
    ): Promise<void> => {
      const start = performance.now();
      try {
        const result = await Promise.race([
          fn(),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeout)),
        ]);
        const ms = Math.round(performance.now() - start);
        if (result === "timeout") {
          probes.push({ operation: label, status: "timeout", ms: timeout });
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
    };

    // Pre-seed all backends so the UI can show them immediately with spinners
    const probeFilePath = probeFile ?? "(none)";
    for (const backend of this.backends) {
      const supports = backend.supportsLanguage(language);
      const hasStandaloneProbe =
        backend.name === "lsp" &&
        "probeStandalone" in backend &&
        typeof (backend as { probeStandalone: unknown }).probeStandalone === "function";

      if (hasStandaloneProbe && supports) {
        results.push({
          backend: "lsp:nvim",
          tier: backend.tier,
          supports: true,
          initialized: this.initialized.has(backend.name),
          probes: [],
        });
        results.push({
          backend: "lsp:standalone",
          tier: backend.tier,
          supports: true,
          initialized: false,
          probes: [],
        });
      } else {
        results.push({
          backend: backend.name,
          tier: backend.tier,
          supports,
          initialized: this.initialized.has(backend.name),
          probes: [],
        });
      }
    }
    onProgress?.({ language, probeFile: probeFilePath, backends: [...results] });

    // Helper to find and update a backend entry in the results array
    const updateBackend = (name: string, update: Partial<BackendProbeResult>) => {
      const idx = results.findIndex((r) => r.backend === name);
      const entry = results[idx];
      if (entry) Object.assign(entry, update);
      onProgress?.({ language, probeFile: probeFilePath, backends: [...results] });
    };

    for (const backend of this.backends) {
      const supports = backend.supportsLanguage(language);

      if (!supports) continue;

      // Try to initialize (with timeout to prevent hanging)
      let initMs = 0;
      let initError: string | undefined;
      if (!this.initialized.has(backend.name)) {
        const start = performance.now();
        try {
          const initResult = await Promise.race([
            backend.initialize?.(this.cwd),
            new Promise<"timeout">((r) => setTimeout(() => r("timeout"), INIT_TIMEOUT)),
          ]);
          initMs = Math.round(performance.now() - start);
          if (initResult === "timeout") {
            initError = `init timed out (${String(INIT_TIMEOUT / 1000)}s)`;
          } else {
            this.initialized.add(backend.name);
          }
        } catch (err) {
          initMs = Math.round(performance.now() - start);
          initError = err instanceof Error ? err.message : String(err);
        }
      }

      // For LSP backend: probe nvim bridge and standalone client separately
      const hasStandaloneProbe =
        backend.name === "lsp" &&
        "probeStandalone" in backend &&
        typeof (backend as { probeStandalone: unknown }).probeStandalone === "function";

      if (hasStandaloneProbe && !initError) {
        const lsp = backend as {
          probeStandalone: (f: string, op: string) => Promise<unknown>;
          warmupNvim?: (f: string) => Promise<boolean>;
          isNvimAvailable?: () => boolean;
        };

        // No probe file — LSP server can still start but we can't run file ops.
        // Mark both paths as initialized with empty probes so UI doesn't hang.
        if (!probeFile) {
          updateBackend("lsp:nvim", {
            initialized: this.initialized.has(backend.name),
            initMs,
            initError,
            probes: fileOps.map(({ label }) => ({
              operation: label,
              status: "empty" as const,
              error: "no source file found in project",
            })),
          });
          updateBackend("lsp:standalone", {
            initialized: this.initialized.has(backend.name),
            initError,
            probes: fileOps.map(({ label }) => ({
              operation: label,
              status: "empty" as const,
              error: "no source file found in project",
            })),
          });
          continue;
        }

        // Warm up nvim LSP — loads probe file in hidden buffer, waits for LSP attach.
        // Skip entirely if nvim is not running to avoid a 25s stall.
        if (lsp.warmupNvim) {
          const nvimAvailable = lsp.isNvimAvailable?.() ?? false;
          if (nvimAvailable) {
            try {
              await Promise.race([
                lsp.warmupNvim(probeFile),
                new Promise<false>((r) => setTimeout(() => r(false), 25_000)),
              ]);
            } catch {
              // Non-fatal
            }
          }
        }

        // Probe nvim bridge path (what normal usage hits).
        // findImplementation gets extra time — LSP servers (esp. jdtls) scan the whole project.
        const IMPL_TIMEOUT = 20_000;
        const nvimProbes: ProbeResult[] = [];
        for (const { op, label, fn } of fileOps) {
          if (typeof backend[op] !== "function") {
            nvimProbes.push({ operation: label, status: "unsupported" });
            continue;
          }
          const t = op === "findImplementation" ? IMPL_TIMEOUT : OP_TIMEOUT;
          await probeOp(() => fn(backend, probeFile), label, nvimProbes, t);
        }
        updateBackend("lsp:nvim", {
          initialized: this.initialized.has(backend.name),
          initMs,
          initError,
          probes: nvimProbes,
        });

        // Warmup standalone client before probing
        try {
          await Promise.race([
            lsp.probeStandalone(probeFile, "findSymbols"),
            new Promise<null>((r) => setTimeout(() => r(null), INIT_TIMEOUT)),
          ]);
        } catch {
          // Non-fatal
        }

        // Probe standalone client path (fallback when nvim unavailable)
        const standaloneProbes: ProbeResult[] = [];
        for (const { op, label } of fileOps) {
          if (typeof backend[op] !== "function") {
            standaloneProbes.push({ operation: label, status: "unsupported" });
            continue;
          }
          const t = op === "findImplementation" ? IMPL_TIMEOUT : OP_TIMEOUT;
          await probeOp(() => lsp.probeStandalone(probeFile, op), label, standaloneProbes, t);
        }
        updateBackend("lsp:standalone", {
          initialized: true,
          probes: standaloneProbes,
        });
        continue;
      }

      // Standard probe path for non-LSP backends
      const probes: ProbeResult[] = [];
      if (probeFile) {
        for (const { op, label, fn } of fileOps) {
          if (typeof backend[op] !== "function") {
            probes.push({ operation: label, status: "unsupported" });
            continue;
          }
          await probeOp(() => fn(backend, probeFile), label, probes);
        }
      }

      updateBackend(backend.name, {
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

  private static readonly INIT_RETRY_INTERVAL_MS = 60_000;
  private initFailed = new Map<string, number>();

  private async ensureInitialized(backend: IntelligenceBackend): Promise<void> {
    if (this.initialized.has(backend.name)) return;
    const failedAt = this.initFailed.get(backend.name);
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < CodeIntelligenceRouter.INIT_RETRY_INTERVAL_MS
    ) {
      throw new Error(
        `${backend.name} initialization previously failed (retryable in ${String(Math.ceil((CodeIntelligenceRouter.INIT_RETRY_INTERVAL_MS - (Date.now() - failedAt)) / 1000))}s)`,
      );
    }
    try {
      if (backend.initialize) {
        await Promise.race([
          backend.initialize(this.cwd),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${backend.name} init timeout`)), 10_000),
          ),
        ]);
      }
      this.initialized.add(backend.name);
      this.initFailed.delete(backend.name);
    } catch (err) {
      this.initFailed.set(backend.name, Date.now());
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
