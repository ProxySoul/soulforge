import { join } from "node:path";
import { useWorkerStore } from "../../stores/workers.js";
import type { RepoMapOptions, SymbolForSummary } from "../intelligence/repo-map.js";
import { WorkerClient } from "./rpc.js";

type SummaryGenerator = (
  batch: SymbolForSummary[],
) => Promise<Array<{ name: string; summary: string }>>;

interface RepoMapStats {
  files: number;
  symbols: number;
  edges: number;
  summaries: number;
  calls: number;
}

interface SummaryBreakdown {
  ast: number;
  llm: number;
  synthetic: number;
  total: number;
  eligible: number;
}

export class IntelligenceClient extends WorkerClient {
  // Cached sync values (pushed from worker via events)
  private _isReady = false;
  private _cwd: string;
  private _stats: RepoMapStats = { files: 0, symbols: 0, edges: 0, summaries: 0, calls: 0 };
  private _dbSize = 0;
  private _semanticMode: "off" | "ast" | "synthetic" | "llm" | "full" | "on" = "off";

  onProgress: ((indexed: number, total: number) => void) | null = null;
  onScanComplete: ((success: boolean) => void) | null = null;
  onStaleSymbols: ((count: number) => void) | null = null;

  private static readonly SCAN_TIMEOUT = 300_000; // 5 min for full repo scan

  constructor(cwd: string) {
    const workerPath = join(import.meta.dir, "intelligence.worker.ts");
    super(workerPath, { cwd });
    this._cwd = cwd;

    const ws = useWorkerStore.getState();
    ws.markStarted("intelligence");

    this.onStatusChange = (status) => {
      const store = useWorkerStore.getState();
      switch (status) {
        case "starting":
          store.setWorkerStatus("intelligence", "starting");
          break;
        case "ready":
          store.markStarted("intelligence");
          break;
        case "crashed":
          store.setWorkerError("intelligence", "Worker crashed unexpectedly");
          break;
        case "restarting":
          store.incrementRestarts("intelligence");
          store.setWorkerStatus("intelligence", "restarting");
          break;
      }
    };

    this.onRpcStart = () => {
      useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    };
    this.onRpcEnd = (error) => {
      const store = useWorkerStore.getState();
      store.updateRpcInFlight("intelligence", -1);
      store.incrementCalls("intelligence");
      if (error) store.incrementErrors("intelligence");
    };

    this.on("init-error", (data) => {
      const d = data as { message: string };
      useWorkerStore.getState().setWorkerError("intelligence", d.message);
    });

    this.on("progress", (data) => {
      const d = data as {
        indexed: number;
        total: number;
        stats: RepoMapStats;
        dbSize: number;
      };
      this._stats = d.stats;
      this._dbSize = d.dbSize;
      this.onProgress?.(d.indexed, d.total);
    });

    this.on("scan-complete", (data) => {
      const d = data as {
        success: boolean;
        stats: RepoMapStats;
        dbSize: number;
        isReady: boolean;
      };
      this._isReady = d.isReady;
      this._stats = d.stats;
      this._dbSize = d.dbSize;
      if (d.success) this.resetRestartCount();
      this.onScanComplete?.(d.success);
    });

    this.on("stale-symbols", (data) => {
      const d = data as { count: number };
      this.onStaleSymbols?.(d.count);
    });
  }

  // ── Cached Sync Getters ────────────────────────────────────────────

  get isReady(): boolean {
    return this._isReady;
  }

  getCwd(): string {
    return this._cwd;
  }

  // ── Core ───────────────────────────────────────────────────────────

  async scan(): Promise<void> {
    await this.callWithTimeout<void>(IntelligenceClient.SCAN_TIMEOUT, "scan");
  }

  async close(): Promise<void> {
    await this.call<void>("close");
    this.dispose();
  }

  clear(): Promise<void> {
    return this.call<void>("clear");
  }

  // ── Semantic ───────────────────────────────────────────────────────

  setSemanticMode(mode: "off" | "ast" | "synthetic" | "llm" | "full" | "on"): void {
    this._semanticMode = mode;
    this.fire("setSemanticMode", mode);
  }

  getSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    return this._semanticMode;
  }

  isSemanticEnabled(): boolean {
    return this._semanticMode !== "off";
  }

  async detectPersistedSemanticMode(): Promise<
    "off" | "ast" | "synthetic" | "llm" | "full" | "on"
  > {
    const mode = await this.call<"off" | "ast" | "synthetic" | "llm" | "full" | "on">(
      "detectPersistedSemanticMode",
    );
    this._semanticMode = mode;
    return mode;
  }

  setSummaryGenerator(generator: SummaryGenerator | null): void {
    if (generator) {
      this.registerCallback("summaryGenerator", async (data) => {
        return generator(data as SymbolForSummary[]);
      });
    }
  }

  async generateAstSummaries(): Promise<number> {
    return this.call<number>("generateAstSummaries");
  }

  async generateSyntheticSummaries(limit?: number): Promise<number> {
    return this.call<number>("generateSyntheticSummaries", limit);
  }

  async generateSemanticSummaries(maxSymbols?: number): Promise<number> {
    return this.callWithTimeout<number>(
      IntelligenceClient.SCAN_TIMEOUT,
      "generateSemanticSummaries",
      maxSymbols,
    );
  }

  clearFreeSummaries(): void {
    this.fire("clearFreeSummaries");
  }

  clearSemanticSummaries(): void {
    this.fire("clearSemanticSummaries");
  }

  async getStaleSummaryCount(): Promise<number> {
    return this.call<number>("getStaleSummaryCount");
  }

  async getSummaryBreakdown(): Promise<SummaryBreakdown> {
    return this.call<SummaryBreakdown>("getSummaryBreakdown");
  }

  // ── File Monitoring ────────────────────────────────────────────────

  onFileChanged(absPath: string): void {
    this.fire("onFileChanged", absPath);
  }

  recheckModifiedFiles(): void {
    this.fire("recheckModifiedFiles");
  }

  // ── Render ─────────────────────────────────────────────────────────

  async render(opts: RepoMapOptions = {}): Promise<string> {
    return this.call<string>("render", opts);
  }

  // ── Symbol Lookup ──────────────────────────────────────────────────

  async findSymbols(
    name: string,
  ): Promise<Array<{ path: string; kind: string; isExported: boolean; pagerank: number }>> {
    return this.call("findSymbols", name);
  }

  async findSymbol(name: string): Promise<string | null> {
    return this.call("findSymbol", name);
  }

  async searchSymbolsSubstring(
    query: string,
    limit?: number,
  ): Promise<
    Array<{ name: string; path: string; kind: string; isExported: boolean; pagerank: number }>
  > {
    return this.call("searchSymbolsSubstring", query, limit);
  }

  async getFileSymbols(
    relPath: string,
  ): Promise<Array<{ name: string; kind: string; isExported: boolean }>> {
    return this.call("getFileSymbols", relPath);
  }

  async getFileSymbolRanges(
    relPath: string,
  ): Promise<Array<{ name: string; kind: string; line: number; endLine: number | null }>> {
    return this.call("getFileSymbolRanges", relPath);
  }

  async getSymbolSignature(
    name: string,
  ): Promise<Array<{ path: string; kind: string; signature: string | null; line: number }>> {
    return this.call("getSymbolSignature", name);
  }

  async getSymbolsByKind(
    kind: string,
    limit?: number,
  ): Promise<Array<{ name: string; path: string; signature: string | null; line: number }>> {
    return this.call("getSymbolsByKind", kind, limit);
  }

  // ── File Analysis ──────────────────────────────────────────────────

  async matchFiles(pattern: string, limit?: number): Promise<string[]> {
    return this.call("matchFiles", pattern, limit);
  }

  async getFileDependents(relPath: string): Promise<Array<{ path: string; weight: number }>> {
    return this.call("getFileDependents", relPath);
  }

  async getFileDependencies(relPath: string): Promise<Array<{ path: string; weight: number }>> {
    return this.call("getFileDependencies", relPath);
  }

  async getFileCoChanges(relPath: string): Promise<Array<{ path: string; count: number }>> {
    return this.call("getFileCoChanges", relPath);
  }

  async getFileExportCount(relPath: string): Promise<number> {
    return this.call("getFileExportCount", relPath);
  }

  async getFileBlastRadius(relPath: string): Promise<number> {
    return this.call("getFileBlastRadius", relPath);
  }

  async getFilesByPackage(pkg: string): Promise<Array<{ path: string; specifiers: string }>> {
    return this.call("getFilesByPackage", pkg);
  }

  async listDirectory(dirPath: string): Promise<Array<{
    name: string;
    type: "file" | "dir";
    language?: string;
    lines?: number;
    symbols?: number;
    importance?: number;
  }> | null> {
    return this.call("listDirectory", dirPath);
  }

  // ── Code Analysis ─────────────────────────────────────────────────

  async getIdentifierFrequency(
    limit?: number,
  ): Promise<Array<{ name: string; fileCount: number }>> {
    return this.call("getIdentifierFrequency", limit);
  }

  async getUnusedExports(limit?: number): Promise<
    Array<{
      name: string;
      path: string;
      kind: string;
      lineCount: number;
      usedInternally: boolean;
    }>
  > {
    return this.call("getUnusedExports", limit);
  }

  async getTestOnlyExports(): Promise<Array<{ name: string; path: string; kind: string }>> {
    return this.call("getTestOnlyExports");
  }

  async getDeadBarrels(): Promise<Array<{ path: string; lineCount: number; language: string }>> {
    return this.call("getDeadBarrels");
  }

  async getRepeatedFragments(limit?: number): Promise<
    Array<{
      count: number;
      locations: Array<{ name: string; path: string; line: number }>;
    }>
  > {
    return this.call("getRepeatedFragments", limit);
  }

  async getDuplicateStructures(limit?: number): Promise<
    Array<{
      shapeHash: string;
      kind: string;
      nodeCount: number;
      members: Array<{ name: string; path: string; line: number; endLine: number }>;
    }>
  > {
    return this.call("getDuplicateStructures", limit);
  }

  async getNearDuplicates(
    threshold?: number,
    limit?: number,
  ): Promise<
    Array<{
      similarity: number;
      a: { name: string; path: string; line: number; endLine: number };
      b: { name: string; path: string; line: number; endLine: number };
    }>
  > {
    return this.call("getNearDuplicates", threshold, limit);
  }

  async getFileDuplicates(relPath: string): Promise<
    Array<{
      name: string;
      line: number;
      clones: Array<{ name: string; path: string; line: number }>;
    }>
  > {
    return this.call("getFileDuplicates", relPath);
  }

  async getCallees(symbolId: number): Promise<
    Array<{
      calleeName: string;
      calleeFile: string;
      calleeLine: number;
      callLine: number;
    }>
  > {
    return this.call("getCallees", symbolId);
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async getStats(): Promise<RepoMapStats> {
    const stats = await this.call<RepoMapStats>("getStats");
    this._stats = stats;
    return stats;
  }

  getStatsCached(): RepoMapStats {
    return this._stats;
  }

  async dbSizeBytes(): Promise<number> {
    const size = await this.call<number>("dbSizeBytes");
    this._dbSize = size;
    return size;
  }

  dbSizeBytesCached(): number {
    return this._dbSize;
  }

  async getTopFiles(limit?: number): Promise<
    Array<{
      path: string;
      pagerank: number;
      lines: number;
      symbols: number;
      language: string;
    }>
  > {
    return this.call("getTopFiles", limit);
  }

  async getExternalPackages(
    limit?: number,
  ): Promise<Array<{ package: string; fileCount: number; specifiers: string[] }>> {
    return this.call("getExternalPackages", limit);
  }

  // ── Shiki Highlighting ─────────────────────────────────────────────

  async codeToAnsi(code: string, lang?: string): Promise<string> {
    return this.call("codeToAnsi", code, lang);
  }

  async codeToStyledTokens(
    code: string,
    lang?: string,
  ): Promise<Array<Array<{ content: string; color?: string }>>> {
    return this.call("codeToStyledTokens", code, lang);
  }

  async isShikiLanguage(lang: string): Promise<boolean> {
    return this.call("isShikiLanguage", lang);
  }
}
