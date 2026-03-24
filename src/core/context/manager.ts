import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { useRepoMapStore } from "../../stores/repomap.js";
import type { EditorIntegration, ForgeMode, TaskRouter } from "../../types/index.js";
import { toErrorMessage } from "../../utils/errors.js";
import { setNeovimFileWrittenHandler } from "../editor/neovim.js";
import { buildGitContext } from "../git/status.js";
import { RepoMap, type SymbolForSummary } from "../intelligence/repo-map.js";
import { resolveModel } from "../llm/provider.js";
import { MemoryManager } from "../memory/manager.js";
import {
  buildDirectoryTree,
  buildSystemPrompt as buildPrompt,
  buildSoulMapAck,
  buildSoulMapUserMessage as buildSoulMapContent,
  getModeInstructions,
  type PromptBuilderOptions,
} from "../prompts/index.js";
import { buildForbiddenContext, isForbidden } from "../security/forbidden.js";
import { emitFileEdited, onFileEdited, onFileRead } from "../tools/file-events.js";
// extractConversationTerms removed — FTS boosting was noisy
import { walkDir } from "./file-tree.js";
import { detectToolchain } from "./toolchain.js";

// System prompt assembly is handled by src/core/prompts/builder.ts
// Tool guidance is in src/core/prompts/shared/tool-guidance.ts
// Mode instructions are in src/core/prompts/modes/index.ts

export interface SharedContextResources {
  repoMap: RepoMap;
  memoryManager: MemoryManager;
  workspaceCoordinator?: import("../coordination/WorkspaceCoordinator.js").WorkspaceCoordinator;
}

/**
 * Context Manager — gathers relevant context from the codebase
 * to include in LLM prompts for better responses.
 *
 * When constructed with `shared`, uses existing RepoMap/MemoryManager
 * instead of creating new ones. Per-tab instances use this to share
 * expensive resources while maintaining independent conversation tracking.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const MINIMAL_CONTEXT_THRESHOLD = 32_000;

export class ContextManager {
  private cwd: string;
  private skills = new Map<string, string>();
  private gitContext: string | null = null;
  private gitContextStale = true;
  private memoryManager: MemoryManager;
  private forgeMode: ForgeMode = "default";
  private editorFile: string | null = null;
  private editorOpen = false;
  private editorVimMode: string | null = null;
  private editorCursorLine = 1;
  private editorCursorCol = 0;
  private editorVisualSelection: string | null = null;
  private editorIntegration: EditorIntegration | null = null;
  private fileTreeCache: { tree: string; at: number } | null = null;
  private projectInfoCache: { info: string | null; at: number } | null = null;
  private repoMap: RepoMap;
  private repoMapReady = false;
  /** Repo map is always enabled unless SOULFORGE_NO_REPOMAP=1 env var is set (debug only). */
  private repoMapEnabled = process.env.SOULFORGE_NO_REPOMAP !== "1";
  private editedFiles = new Set<string>();
  private mentionedFiles = new Set<string>();
  // conversationTerms removed — FTS boosting was noisy, PageRank handles ranking
  private conversationTokens = 0;
  private contextWindowTokens = DEFAULT_CONTEXT_WINDOW;
  private repoMapCache: { content: string; at: number } | null = null;
  private taskRouter: TaskRouter | undefined;
  private semanticSummaryLimit = 300;
  private semanticAutoRegen = false;
  private lastActiveModel = "";
  private semanticGenId = 0;
  private isChild = false;
  private projectInstructions = "";
  private static readonly REPO_MAP_TTL = 5_000; // 5s — covers getContextBreakdown + buildSystemPrompt in same prompt

  private static readonly FILE_TREE_TTL = 30_000; // 30s
  private static readonly PROJECT_INFO_TTL = 300_000; // 5min
  private shared: SharedContextResources | null = null;
  private tabId: string | null = null;
  private tabLabel: string | null = null;

  constructor(cwd: string, shared?: SharedContextResources) {
    this.cwd = cwd;
    if (shared) {
      this.repoMap = shared.repoMap;
      this.memoryManager = shared.memoryManager;
      this.shared = shared;
      this.isChild = true;
      this.wireFileEventHandlers();
    } else {
      this.memoryManager = new MemoryManager(cwd);
      this.repoMap = new RepoMap(cwd);
      this.wireFileEventHandlers();
      if (this.repoMapEnabled) {
        this.wireRepoMapCallbacks();
        this.startRepoMapScan();
      }
    }
  }

  /**
   * Async factory that yields to the event loop between heavy sync steps.
   * Use this from boot to keep the spinner alive during DB init.
   */
  static async createAsync(cwd: string, onStep?: (label: string) => void): Promise<ContextManager> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    onStep?.("Opening the memory vaults…");
    const memoryManager = new MemoryManager(cwd);
    await tick();

    onStep?.("Mapping the codebase…");
    const repoMap = new RepoMap(cwd);
    await tick();

    onStep?.("Wiring up the forge…");
    const cm = new ContextManager(cwd, { repoMap, memoryManager });
    cm.isChild = false;
    cm.wireRepoMapCallbacks();
    cm.startRepoMapScan();
    return cm;
  }

  getSharedResources(): SharedContextResources {
    return {
      repoMap: this.repoMap,
      memoryManager: this.memoryManager,
      workspaceCoordinator: this.shared?.workspaceCoordinator,
    };
  }

  setTabId(tabId: string): void {
    this.tabId = tabId;
  }

  setTabLabel(tabLabel: string): void {
    this.tabLabel = tabLabel;
  }

  getTabId(): string | null {
    return this.tabId;
  }

  getTabLabel(): string | null {
    return this.tabLabel;
  }

  private unsubEdit: (() => void) | null = null;
  private unsubRead: (() => void) | null = null;

  private wireFileEventHandlers(): void {
    this.unsubEdit = onFileEdited((absPath) => this.onFileChanged(absPath));
    this.unsubRead = onFileRead((absPath) => this.trackMentionedFile(absPath));
    setNeovimFileWrittenHandler((absPath) => {
      emitFileEdited(absPath, "");
    });
  }

  private handleScanError(err: unknown): void {
    const msg = toErrorMessage(err);
    this.repoMapReady = false;
    this.syncRepoMapStore("error");
    useRepoMapStore.getState().setScanError(`Soul map scan failed: ${msg}`);
  }

  private startRepoMapScan(): void {
    this.syncRepoMapStore("scanning");
    this.repoMap.scan().catch((err: unknown) => this.handleScanError(err));
  }

  private wireRepoMapCallbacks(): void {
    this.repoMap.onProgress = (indexed, total) => {
      const store = useRepoMapStore.getState();
      const phaseLabels: Record<number, string> = {
        [-1]: "building edges",
        [-2]: "computing pagerank",
        [-3]: "analyzing git history",
      };
      const label = phaseLabels[indexed] ?? `${String(indexed)}/${String(total)}`;
      store.setScanProgress(label);
      const stats = this.repoMap.getStats();
      store.setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytes());
    };
    this.repoMap.onScanComplete = (success) => {
      if (success) {
        this.repoMapReady = true;
        this.syncRepoMapStore("ready");
        useRepoMapStore.getState().setScanError("");
        // Re-apply semantic mode now that repo map is ready (may have been set before scan finished)
        const current = this.repoMap.getSemanticMode();
        if (current === "off") {
          const persisted = this.repoMap.detectPersistedSemanticMode();
          this.setSemanticSummaries(persisted === "off" ? "synthetic" : persisted);
        } else {
          this.setSemanticSummaries(current);
        }
      } else {
        this.repoMapReady = false;
        this.syncRepoMapStore("error");
        useRepoMapStore.getState().setScanError("Soul map scan completed with errors");
      }
    };

    // On stale symbols: always regen free summaries (ast/synthetic), optionally regen LLM
    this.repoMap.onStaleSymbols = (count) => {
      const mode = this.repoMap.getSemanticMode();
      if (mode === "off" || !this.repoMapReady) return;

      // AST + synthetic regen is always free and instant
      this.repoMap.generateAstSummaries();
      if (mode === "synthetic" || mode === "full") {
        this.repoMap.generateSyntheticSummaries();
      }

      // LLM regen only when auto-regen is enabled (costs tokens)
      if ((mode === "llm" || mode === "full" || mode === "on") && this.semanticAutoRegen) {
        const modelId = this.getSemanticModelId(this.lastActiveModel ?? "");
        if (!modelId || modelId === "none") return;
        const store = useRepoMapStore.getState();
        store.setSemanticStatus("generating");
        store.setSemanticProgress(`${String(count)} stale — regenerating...`);
        this.generateSemanticSummaries(modelId).catch(() => {});
      } else {
        // Just update counts from free regen
        const stats = this.repoMap.getStats();
        useRepoMapStore.getState().setSemanticCount(stats.summaries);
      }
    };
  }

  private syncRepoMapStore(status: "off" | "scanning" | "ready" | "error"): void {
    const store = useRepoMapStore.getState();
    store.setStatus(status);
    // Don't reset stats to 0 during scanning — keep last-known values visible
    if (status !== "scanning") {
      const stats = this.repoMap.getStats();
      store.setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytes());
      store.setScanProgress("");
    }
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  getForgeMode(): ForgeMode {
    return this.forgeMode;
  }

  setProjectInstructions(content: string): void {
    this.projectInstructions = content;
  }

  setForgeMode(mode: ForgeMode): void {
    this.forgeMode = mode;
  }

  setContextWindow(tokens: number): void {
    this.contextWindowTokens = tokens;
  }

  getContextPercent(): number {
    const window = this.contextWindowTokens > 0 ? this.contextWindowTokens : DEFAULT_CONTEXT_WINDOW;
    if (this.conversationTokens <= 0) return 0;
    return Math.round((this.conversationTokens / window) * 100);
  }

  setEditorIntegration(settings: EditorIntegration): void {
    this.editorIntegration = settings;
  }

  getEditorIntegration(): EditorIntegration | undefined {
    return this.editorIntegration ?? undefined;
  }

  isEditorOpen(): boolean {
    return this.editorOpen;
  }

  /** Update editor state so Forge knows what's open in neovim */
  setEditorState(
    open: boolean,
    file: string | null,
    vimMode?: string,
    cursorLine?: number,
    cursorCol?: number,
    visualSelection?: string | null,
  ): void {
    this.editorOpen = open;
    this.editorFile = file;
    this.editorVimMode = vimMode ?? null;
    this.editorCursorLine = cursorLine ?? 1;
    this.editorCursorCol = cursorCol ?? 0;
    this.editorVisualSelection = visualSelection ?? null;
  }

  /** Invalidate cached file tree (call after agent edits files) */
  invalidateFileTree(): void {
    this.fileTreeCache = null;
  }

  /** Notify repo map that a file changed (call after edits) */
  onFileChanged(absPath: string): void {
    if (!this.isChild) {
      this.repoMap.onFileChanged(absPath);
      if (this.repoMapReady) {
        setTimeout(() => {
          const stats = this.repoMap.getStats();
          useRepoMapStore
            .getState()
            .setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytes());
        }, 200);
      }
    }
    this.editedFiles.add(absPath);
    this.repoMapCache = null;
    this.gitContextStale = true;
  }

  /** Track a file mentioned in conversation (tool reads, grep hits, etc.) */
  trackMentionedFile(absPath: string): void {
    this.mentionedFiles.add(absPath);
  }

  /** Update conversation context for repo map ranking */
  updateConversationContext(_input: string, totalTokens: number): void {
    this.conversationTokens = totalTokens;
    // conversationTerms removed — FTS boosting from user input was noisy.
    // Personalized PageRank (edits/reads/editor boosts) handles ranking better.
  }

  /** Get a snapshot of tracked files (for preserving across compaction) */
  getTrackedFiles(): { edited: string[]; mentioned: string[] } {
    return {
      edited: [...this.editedFiles],
      mentioned: [...this.mentionedFiles],
    };
  }

  /** Reset per-conversation tracking (call on new session / context clear) */
  resetConversationTracking(): void {
    this.editedFiles.clear();
    this.mentionedFiles.clear();

    this.conversationTokens = 0;
    this.repoMapCache = null;
  }

  /** Render repo map with full tracked context (cached within TTL) */
  renderRepoMap(): string {
    if (!this.repoMapReady) return "";
    const now = Date.now();
    if (this.repoMapCache && now - this.repoMapCache.at < ContextManager.REPO_MAP_TTL) {
      return this.repoMapCache.content;
    }
    const content = this.repoMap.render({
      editorFile: this.editorFile,
      editedFiles: [...this.editedFiles],
      mentionedFiles: [...this.mentionedFiles],
      conversationTokens: this.conversationTokens,
    });
    this.repoMapCache = { content, at: now };
    return content;
  }

  getRepoMap(): RepoMap {
    return this.repoMap;
  }

  isRepoMapEnabled(): boolean {
    return this.repoMapEnabled;
  }

  isRepoMapReady(): boolean {
    if (this.isChild) return this.repoMap.getStats().files > 0;
    return this.repoMapReady;
  }

  /** @deprecated Repo map is always enabled. Use SOULFORGE_NO_REPOMAP=1 env var to disable (debug only). */
  setRepoMapEnabled(_enabled: boolean): void {
    // No-op — repo map is always enabled at runtime.
    // Kept for backward compat with callers that haven't been updated yet.
  }

  setSemanticSummaries(
    modeOrBool: "off" | "ast" | "synthetic" | "llm" | "full" | "on" | boolean,
  ): void {
    const mode =
      modeOrBool === true
        ? "synthetic"
        : modeOrBool === false
          ? "off"
          : modeOrBool === "on"
            ? "full"
            : modeOrBool;
    this.repoMap.setSemanticMode(mode);
    const store = useRepoMapStore.getState();
    if (mode === "off") {
      store.setSemanticStatus("off");
      store.setSemanticCount(0);
      store.setSemanticProgress("");
      store.setSemanticModel("");
      return;
    }
    store.setSemanticModel("");

    if (!this.repoMapReady) {
      store.setSemanticStatus("generating");
      store.setSemanticProgress(`${mode} — waiting for soul map...`);
      return;
    }

    // AST extraction (free) — runs for all non-off modes
    store.setSemanticStatus("generating");
    store.setSemanticProgress("extracting docstrings...");
    this.repoMap.generateAstSummaries();

    // Synthetic generation (free, instant) — runs for synthetic/full modes
    if (mode === "synthetic" || mode === "full") {
      store.setSemanticProgress("generating synthetic summaries...");
      this.repoMap.generateSyntheticSummaries();
    }

    // Update stats from actual DB state
    const bd = this.repoMap.getSummaryBreakdown();
    store.setSemanticCount(bd.total);

    if (mode === "llm" || mode === "full") {
      // Auto-trigger LLM generation in background if model available
      const modelId = this.getSemanticModelId(this.lastActiveModel);
      if (modelId && modelId !== "none") {
        const genId = ++this.semanticGenId;
        store.setSemanticModel(modelId);
        store.setSemanticStatus("generating"); // never "ready" before LLM finishes
        store.setSemanticProgress(
          bd.total > 0
            ? `${this.formatBreakdown(bd)} (generating LLM...)`
            : "generating LLM summaries...",
        );
        this.generateSemanticSummaries(modelId).catch(() => {
          if (this.semanticGenId !== genId) return;
          const current = this.repoMap.getSummaryBreakdown();
          store.setSemanticCount(current.total);
          store.setSemanticStatus(current.total > 0 ? "ready" : "off");
          store.setSemanticProgress(
            current.total > 0 ? this.formatBreakdown(current) : "LLM generation failed",
          );
        });
      } else {
        store.setSemanticStatus(bd.total > 0 ? "ready" : "off");
        store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "waiting for model...");
      }
    } else {
      store.setSemanticStatus(bd.total > 0 ? "ready" : "off");
      store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "no summaries");
    }
  }

  /** Clear only free summaries (ast/synthetic). LLM summaries are preserved. */
  clearFreeSummaries(): void {
    this.repoMap.clearFreeSummaries();
    const bd = this.repoMap.getSummaryBreakdown();
    const store = useRepoMapStore.getState();
    store.setSemanticCount(bd.total);
    store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "");
  }

  /** Clear ALL summaries including paid LLM ones. Use only for explicit user "clear" action. */
  clearSemanticSummaries(): void {
    ++this.semanticGenId;
    this.repoMap.clearSemanticSummaries();
    const store = useRepoMapStore.getState();
    store.setSemanticCount(0);
    store.setSemanticProgress("");
    store.setSemanticModel("");
    store.resetSemanticTokens();
    store.setSemanticStatus("off");
  }

  isSemanticEnabled(): boolean {
    return this.repoMap.isSemanticEnabled();
  }

  getSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    return this.repoMap.getSemanticMode();
  }

  setSemanticSummaryLimit(limit: number | undefined): void {
    this.semanticSummaryLimit = limit ?? 300;
  }

  setSemanticAutoRegen(enabled: boolean | undefined): void {
    this.semanticAutoRegen = enabled ?? false;
  }

  setTaskRouter(router: TaskRouter | undefined): void {
    this.taskRouter = router;
  }

  setActiveModel(modelId: string): void {
    if (!modelId || modelId === "none") return;
    const hadModel = !!this.lastActiveModel;
    this.lastActiveModel = modelId;
    // If mode needs LLM and we just got a model for the first time, trigger generation
    if (!hadModel && this.repoMapReady) {
      const mode = this.repoMap.getSemanticMode();
      if (mode === "llm" || mode === "full" || mode === "on") {
        this.setSemanticSummaries(mode);
      }
    }
  }

  private formatBreakdown(bd: {
    ast: number;
    llm: number;
    synthetic: number;
    total: number;
    eligible: number;
  }): string {
    const parts: string[] = [];
    if (bd.ast > 0) parts.push(`${String(bd.ast)} ast`);
    if (bd.llm > 0) {
      const pct = bd.eligible > 0 ? Math.round((bd.llm / bd.eligible) * 100) : 0;
      parts.push(`${String(bd.llm)} llm (${String(pct)}%)`);
    }
    if (bd.synthetic > 0) parts.push(`${String(bd.synthetic)} syn`);
    return `${parts.join(" + ")} — ${String(bd.total)} symbols`;
  }

  getSemanticModelId(fallback: string): string {
    return this.taskRouter?.semantic ?? fallback;
  }

  async generateSemanticSummaries(modelId: string): Promise<number> {
    if (!this.repoMapReady) return 0;
    this.lastActiveModel = modelId;
    const myGenId = this.semanticGenId;

    const store = useRepoMapStore.getState();
    store.setSemanticStatus("generating");
    store.setSemanticProgress("preparing...");
    store.setSemanticModel(modelId);
    store.resetSemanticTokens();

    const model = resolveModel(modelId);
    const CHUNK = 10;
    let processed = 0;

    const generator = async (batch: SymbolForSummary[]) => {
      const all: Array<{ name: string; summary: string }> = [];

      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK);
        const prompt = chunk
          .map((s, j) => {
            const meta: string[] = [];
            if (s.lineSpan) meta.push(`${String(s.lineSpan)}L`);
            if (s.dependents) meta.push(`${String(s.dependents)} dependents`);
            const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
            return `[${String(j + 1)}] ${s.kind} \`${s.name}\` in ${s.filePath}${metaStr}:\n${s.signature ? `${s.signature}\n` : ""}${s.code}`;
          })
          .join("\n\n");

        if (this.semanticGenId === myGenId) {
          store.setSemanticProgress(
            `${String(processed + 1)}-${String(Math.min(processed + CHUNK, batch.length))}/${String(batch.length)}`,
          );
        }

        const { text, usage } = await generateText({
          model,
          system: [
            "Summarize each code symbol in ONE line (max 80 chars). Focus on BEHAVIOR: what it does, key side effects, non-obvious logic.",
            "BAD: 'Checks if Neovim is available' (restates name)",
            "GOOD: 'Pings nvim RPC, returns false on timeout or socket error'",
            "BAD: 'Renders a widget component' (generic)",
            "GOOD: 'Memoized tree-view with virtual scroll, collapses on blur'",
            "Output ONLY lines: SymbolName: summary",
            "No numbering, no backticks, no extra text.",
          ].join("\n"),
          prompt,
        });

        store.addSemanticTokens(usage.inputTokens ?? 0, usage.outputTokens ?? 0);

        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const colonIdx = trimmed.indexOf(":");
          if (colonIdx < 1) continue;
          const name = trimmed
            .slice(0, colonIdx)
            .replace(/^[`*\d.)\]]+\s*/, "")
            .trim();
          const summary = trimmed.slice(colonIdx + 1).trim();
          if (name && summary && /^\w+$/.test(name)) {
            all.push({ name, summary });
          }
        }

        processed += chunk.length;
      }

      return all;
    };

    this.repoMap.setSummaryGenerator(generator);

    try {
      const count = await this.repoMap.generateSemanticSummaries(this.semanticSummaryLimit);
      // Only update store if this is still the active generation (not superseded)
      if (this.semanticGenId === myGenId) {
        const bd = this.repoMap.getSummaryBreakdown();
        store.setSemanticCount(bd.total);
        store.setSemanticStatus(bd.total > 0 ? "ready" : "off");
        store.setSemanticProgress(bd.total > 0 ? this.formatBreakdown(bd) : "");
      }
      return count;
    } catch (err) {
      if (this.semanticGenId === myGenId) {
        const msg = toErrorMessage(err);
        store.setSemanticStatus("error");
        store.setSemanticProgress(msg.slice(0, 80));
        store.setSemanticModel("");
        store.resetSemanticTokens();
        const fallbackStats = this.repoMap.getStats();
        store.setSemanticCount(fallbackStats.summaries);
      }
      throw err;
    }
  }

  dispose(): void {
    this.unsubEdit?.();
    this.unsubRead?.();
    this.unsubEdit = null;
    this.unsubRead = null;
    if (!this.isChild) {
      this.repoMap.close().catch(() => {});
      this.memoryManager.close();
    }
  }

  async refreshRepoMap(): Promise<void> {
    this.syncRepoMapStore("scanning");
    useRepoMapStore.getState().setScanError("");
    await this.repoMap.scan().catch((err: unknown) => this.handleScanError(err));
  }

  clearRepoMap(): void {
    this.repoMap.clear();
    this.repoMapReady = false;
    this.syncRepoMapStore("off");
  }

  /** Pre-fetch git context (call before buildSystemPrompt) */
  async refreshGitContext(): Promise<void> {
    this.gitContext = await buildGitContext(this.cwd);
    this.gitContextStale = false;
  }

  /** Refresh git context only if stale (files changed since last refresh) */
  async ensureGitContext(): Promise<void> {
    if (!this.gitContextStale) return;
    await this.refreshGitContext();
  }

  /** Add a loaded skill to the system prompt. Content capped at 16k chars. */
  addSkill(name: string, content: string): void {
    if (!content.trim()) return;
    const MAX_SKILL_CHARS = 16_000;
    this.skills.set(
      name,
      content.length > MAX_SKILL_CHARS
        ? `${content.slice(0, MAX_SKILL_CHARS)}\n[... truncated]`
        : content,
    );
  }

  /** Remove a loaded skill from the system prompt */
  removeSkill(name: string): void {
    this.skills.delete(name);
  }

  /** Get the names of all currently loaded skills */
  getActiveSkills(): string[] {
    return [...this.skills.keys()];
  }

  getActiveSkillEntries(): Array<{ name: string; content: string }> {
    return [...this.skills.entries()].map(([name, content]) => ({ name, content }));
  }

  /** Get a breakdown of what's in the context and how much space each section uses */
  getContextBreakdown(): { section: string; chars: number; active: boolean }[] {
    const sections: { section: string; chars: number; active: boolean }[] = [];

    // Core + tools reference (always present)
    sections.push({
      section: "Core + tool reference",
      chars: 1800, // approximate: identity + all tool docs + guidelines
      active: true,
    });

    const projectInfo = this.getProjectInfo();
    sections.push({
      section: "Project info",
      chars: projectInfo?.length ?? 0,
      active: projectInfo !== null,
    });

    if (this.repoMapEnabled && this.repoMapReady) {
      const cached = this.repoMapCache?.content;
      const map = cached ?? this.renderRepoMap();
      if (map) {
        sections.push({ section: "Soul map", chars: map.length, active: true });
      } else {
        const fileTree = this.getFileTree(3);
        sections.push({
          section: "File tree (soul map empty)",
          chars: fileTree.length,
          active: true,
        });
      }
    } else {
      const fileTree = this.getFileTree(3);
      sections.push({ section: "File tree", chars: fileTree.length, active: true });
    }

    sections.push({
      section: "Editor",
      chars: this.editorOpen && this.editorFile ? 200 : 0,
      active: this.editorOpen && this.editorFile !== null,
    });

    sections.push({
      section: "Git context",
      chars: this.gitContext?.length ?? 0,
      active: this.gitContext !== null,
    });

    const memoryContext = this.memoryManager.buildMemoryIndex();
    sections.push({
      section: "Project memory",
      chars: memoryContext?.length ?? 0,
      active: memoryContext !== null,
    });

    const modeInstructions = getModeInstructions(this.forgeMode, {
      contextPercent: this.getContextPercent(),
    });
    sections.push({
      section: `Mode (${this.forgeMode})`,
      chars: modeInstructions?.length ?? 0,
      active: modeInstructions !== null,
    });

    let skillChars = 0;
    for (const [, content] of this.skills) {
      skillChars += content.length;
    }
    sections.push({
      section: `Skills (${String(this.skills.size)})`,
      chars: skillChars,
      active: this.skills.size > 0,
    });

    return sections;
  }

  /** Clear optional context sections */
  clearContext(what: "git" | "memory" | "skills" | "all"): string[] {
    const cleared: string[] = [];
    if (what === "git" || what === "all") {
      if (this.gitContext) {
        this.gitContext = null;
        cleared.push("git");
      }
    }
    if (what === "skills" || what === "all") {
      if (this.skills.size > 0) {
        const names = [...this.skills.keys()];
        for (const n of names) this.skills.delete(n);
        cleared.push(`skills (${names.join(", ")})`);
      }
    }
    // Memory can't be "cleared" from context without deleting files,
    // but we can note it. Memory is read fresh each prompt anyway.
    if (what === "memory" || what === "all") {
      cleared.push("memory (will reload next prompt if .soulforge/ exists)");
    }
    return cleared;
  }

  /** Build a system prompt with project context, scaled to context window. */
  buildSystemPrompt(modelIdOverride?: string): string {
    const opts: PromptBuilderOptions = {
      modelId: modelIdOverride || this.lastActiveModel,
      cwd: this.cwd,
      hasRepoMap: this.repoMapReady,
      hasSymbols: this.repoMapReady && this.repoMap.getStats().symbols > 0,
      forgeMode: this.forgeMode,
      contextPercent: this.getContextPercent(),
      isMinimalContext: this.contextWindowTokens <= MINIMAL_CONTEXT_THRESHOLD,
      projectInfo: this.getProjectInfo(),
      projectInstructions: this.projectInstructions,
      forbiddenContext: buildForbiddenContext(),
      editorSection: this.buildEditorContextSection(),
      gitContext: this.gitContext,
      memoryContext: this.memoryManager.buildMemoryIndex(),
    };
    return buildPrompt(opts);
  }

  /** Build editor context lines for the system prompt. */
  private buildEditorContextSection(): string[] {
    const lines = [...this.buildEditorToolsSection()];
    const showEditorContext = this.editorIntegration?.editorContext !== false;
    if (this.editorOpen && this.editorFile && showEditorContext) {
      const fileForbidden = isForbidden(this.editorFile);
      if (fileForbidden) {
        lines.push(
          `Editor: "${this.editorFile}" — FORBIDDEN (pattern: "${fileForbidden}"). Do NOT read or reference its contents.`,
        );
      } else {
        lines.push(
          `Editor: "${this.editorFile}" | mode: ${this.editorVimMode ?? "?"} | L${String(this.editorCursorLine)}:${String(this.editorCursorCol)}`,
        );
        if (this.editorVisualSelection) {
          const truncated =
            this.editorVisualSelection.length > 500
              ? `${this.editorVisualSelection.slice(0, 500)}...`
              : this.editorVisualSelection;
          lines.push("Selection:", "```", truncated, "```");
        }
        lines.push(
          "'the file'/'this file'/'what's open' = this file. `edit_file` for disk. `editor(action: read)` for buffer.",
        );
      }
    } else if (this.editorOpen) {
      lines.push("Editor: panel open, no file loaded.");
    }
    return lines;
  }

  /**
   * Build the Soul Map as a user→assistant message pair (aider pattern).
   * Models treat user content as context to reference, keeping it separate
   * from system instructions. This also means it can update after edits
   * without invalidating the cached system prompt.
   * Returns null if the repo map isn't ready.
   */
  buildSoulMapMessages():
    | [{ role: "user"; content: string }, { role: "assistant"; content: string }]
    | null {
    if (!this.repoMapEnabled || !this.repoMapReady) return null;
    const rendered = this.renderRepoMap();
    if (!rendered) return null;

    const isMinimal = this.contextWindowTokens <= MINIMAL_CONTEXT_THRESHOLD;
    const dirTree = buildDirectoryTree(this.cwd);
    return [
      { role: "user" as const, content: buildSoulMapContent(rendered, isMinimal, dirTree) },
      { role: "assistant" as const, content: buildSoulMapAck() },
    ];
  }

  /**
   * @deprecated Use buildSoulMapMessages() instead. Kept for backwards compatibility.
   */
  buildSoulMapSystemBlock(): string | null {
    if (!this.repoMapEnabled || !this.repoMapReady) return null;
    const rendered = this.renderRepoMap();
    if (!rendered) return null;
    const isMinimal = this.contextWindowTokens <= MINIMAL_CONTEXT_THRESHOLD;
    return buildSoulMapContent(rendered, isMinimal);
  }

  /**
   * Build skills as a user→assistant message pair.
   * Keeps the system prompt stable when skills are loaded/unloaded.
   * Returns null if no skills are loaded.
   */
  buildSkillsMessages():
    | [{ role: "user"; content: string }, { role: "assistant"; content: string }]
    | null {
    if (this.skills.size === 0) return null;

    const names = [...this.skills.keys()];
    const skillBlocks = [...this.skills.entries()]
      .map(([name, content]) => `<skill name="${name}">\n${content}\n</skill>`)
      .join("\n\n");

    const userMessage =
      `<loaded_skills>\n` +
      `The following ${String(names.length)} skill(s) are loaded: ${names.join(", ")}.\n` +
      `Apply them when the task matches their domain.\n\n` +
      `${skillBlocks}\n` +
      `</loaded_skills>`;

    const assistantAck =
      `Noted — ${String(names.length)} skill(s) loaded: ${names.join(", ")}. ` +
      `I'll apply them when relevant to the task.`;

    return [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantAck },
    ];
  }

  /** Build the editor tools section for the system prompt */
  private buildEditorToolsSection(): string[] {
    const ei = this.editorIntegration;
    const lines: string[] = [];

    if (!this.editorOpen) {
      lines.push("Editor panel is closed. The editor tool will fail. Suggest Ctrl+E to open.");
      return lines;
    }

    lines.push(
      "Editor panel is open. Use the editor tool with actions: read (buffer), edit (buffer lines), navigate (open/jump).",
    );

    const lspActions: string[] = [];
    if (!ei || ei.diagnostics) lspActions.push("diagnostics");
    if (!ei || ei.symbols) lspActions.push("symbols");
    if (!ei || ei.hover) lspActions.push("hover");
    if (!ei || ei.references) lspActions.push("references");
    if (!ei || ei.definition) lspActions.push("definition");
    if (!ei || ei.codeActions) lspActions.push("actions");
    if (!ei || ei.rename) lspActions.push("rename");
    if (!ei || ei.lspStatus) lspActions.push("lsp_status");
    if (!ei || ei.format) lspActions.push("format");
    if (lspActions.length > 0) lines.push(`LSP actions: ${lspActions.join(", ")}.`);

    lines.push(
      "edit_file for disk writes. editor(action: edit) for buffer only. Check diagnostics after changes.",
    );

    return lines;
  }

  /**
   * Build the cross-tab coordination section for system prompt or prepareStep injection.
   * Returns null when no other tabs have claims.
   */
  buildCrossTabSection(): string | null {
    if (!this.shared?.workspaceCoordinator || !this.tabId) return null;
    const coordinator = this.shared.workspaceCoordinator;
    // Single pass, zero allocations for the common case (no other tabs)
    const byTab = new Map<string, { label: string; paths: string[]; total: number }>();
    coordinator.forEachClaim((path, claim) => {
      if (claim.tabId === this.tabId) return;
      let entry = byTab.get(claim.tabId);
      if (!entry) {
        entry = { label: claim.tabLabel, paths: [], total: 0 };
        byTab.set(claim.tabId, entry);
      }
      entry.total++;
      if (entry.paths.length < 10) {
        const rel = path.startsWith(`${this.cwd}/`) ? path.slice(this.cwd.length + 1) : path;
        entry.paths.push(rel);
      }
    });
    if (byTab.size === 0) return null;

    const otherClaims: string[] = [];
    for (const [, { label, paths, total }] of byTab) {
      const extra = total > 10 ? ` (+${String(total - 10)} more)` : "";
      otherClaims.push(`  Tab "${label}": ${paths.join(", ")}${extra}`);
    }
    if (otherClaims.length === 0) return null;

    return [
      "",
      "## Cross-Tab File Coordination",
      "Files being edited by other tabs:",
      ...otherClaims,
      "When your edit_file/multi_edit returns a ⚠️ conflict warning:",
      "1. Tell the user which file conflicts and which tab owns it",
      "2. Proceed with the edit (edits are never blocked)",
      "3. If multiple files conflict, ask the user whether to continue or wait",
      "Do NOT silently wait, retry, or skip edits without informing the user.",
    ].join("\n");
  }

  /** Try to detect project type and read key config files (cached with 5min TTL) */
  private getProjectInfo(): string | null {
    const now = Date.now();
    if (this.projectInfoCache && now - this.projectInfoCache.at < ContextManager.PROJECT_INFO_TTL) {
      return this.projectInfoCache.info;
    }

    const checks = [
      { file: "package.json", label: "Node.js project" },
      { file: "Cargo.toml", label: "Rust project" },
      { file: "go.mod", label: "Go project" },
      { file: "pyproject.toml", label: "Python project" },
      { file: "pom.xml", label: "Java/Maven project" },
    ];

    for (const check of checks) {
      try {
        const content = readFileSync(join(this.cwd, check.file), "utf-8");
        const truncated = content.length > 500 ? `${content.slice(0, 500)}\n...` : content;
        const toolchain = this.detectToolchain();
        const profileStr = this.buildProfileString();
        const info = `${check.label} (${check.file}):\n${truncated}${toolchain ? `\nToolchain: ${toolchain}` : ""}${profileStr}`;
        this.projectInfoCache = { info, at: now };
        return info;
      } catch {}
    }

    this.projectInfoCache = { info: null, at: now };
    return null;
  }

  private projectProfileCache: string | null = null;

  private buildProfileString(): string {
    if (this.projectProfileCache !== null) return this.projectProfileCache;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("../tools/project.js") as {
        detectProfile: (cwd: string) => Record<string, string | null>;
      };
      const profile = mod.detectProfile(this.cwd);
      const parts: string[] = [];
      for (const action of ["lint", "typecheck", "test", "build"] as const) {
        if (profile[action]) parts.push(`${action}: \`${profile[action]}\``);
      }
      this.projectProfileCache = parts.length > 0 ? `\nProject commands: ${parts.join(" · ")}` : "";
    } catch {
      this.projectProfileCache = "";
    }
    return this.projectProfileCache;
  }

  private detectToolchain(): string | null {
    return detectToolchain(this.cwd);
  }

  /** Generate a simple file tree (cached with 30s TTL) */
  private getFileTree(maxDepth: number): string {
    const now = Date.now();
    if (this.fileTreeCache && now - this.fileTreeCache.at < ContextManager.FILE_TREE_TTL) {
      return this.fileTreeCache.tree;
    }
    const lines: string[] = [];
    walkDir(this.cwd, "", maxDepth, lines);
    const tree = lines.slice(0, 50).join("\n");
    this.fileTreeCache = { tree, at: now };
    return tree;
  }
}

export { extractConversationTerms } from "./conversation-terms.js";
