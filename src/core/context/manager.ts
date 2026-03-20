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
import { getModeInstructions } from "../modes/prompts.js";
import { buildForbiddenContext, isForbidden } from "../security/forbidden.js";
import { emitFileEdited, onFileEdited, onFileRead } from "../tools/file-events.js";
import { extractConversationTerms } from "./conversation-terms.js";
import { walkDir } from "./file-tree.js";
import { detectToolchain } from "./toolchain.js";

// System prompt: question-driven tool routing + prohibition enforcement
// Pattern: map the QUESTION the agent would ask → the tool that answers it
// Sources: Claude Code (fragments), ECC (schema > prompt), omo (prohibition + clearance)
const TOOL_GUIDANCE_BASE = [
  // Core discipline
  "Only call tools when necessary. If the Soul Map, cache, or previous results already answer your question, act without calling tools.",
  "Soul Map, tool results, and read cache are always current (auto-updated on every edit). This data is authoritative. FORBIDDEN: re-reading, re-grepping, or re-verifying data you already have.",
  "Stop as soon as you can act. Two examples confirming a pattern = confirmed. If you have enough to plan or edit, do it now. Every additional read is token waste.",
  "Workflow: 1) Check Soul Map for paths, symbols, line ranges, dependencies. 2) If it answers your question, act — no tool call. 3) If you need code, one read per file, one search per question.",
  // Question → tool routing (intelligence tools FIRST, low-level as FALLBACK)
  "BEFORE reaching for grep or read_file, ask which question you're answering:",
  "Where is this symbol defined? → navigate(action: definition) — gives exact file + line. Not grep.",
  "Who calls this function? What references it? → navigate(action: references) — gives all call sites. Not grep.",
  "What does this function do? Read its code. → read_file(path, target, name) — extracts by name via AST.",
  "What's the structure of this file? → analyze(action: outline) — symbols without reading content. Not read_file.",
  "Are there type errors after my edit? → analyze(action: diagnostics) — instant LSP check. Not project(typecheck).",
  "How widespread is this pattern? → soul_grep(count: true) — per-file counts from index. Not grep.",
  "Where does this file/symbol live? → soul_find — PageRank-ranked fuzzy search. Not glob. Use specific names (RepoMap, useTabs, AgentBus), not generic words (index, utils, store) that match many files.",
  "What breaks if I change this file? → soul_impact(action: blast_radius) — from dependency graph. Not grep.",
  "What depends on this / what does this depend on? → soul_impact(action: dependents/dependencies).",
  "Is this export used anywhere? → soul_analyze(action: unused_exports) — dead code detection.",
  "Rename this symbol across all files? → rename_symbol — compiler-guaranteed atomic rename. FORBIDDEN: grep + manual edit_file for renames.",
  "Move this to another file? → move_symbol — extracts + updates all importers. FORBIDDEN: manual copy + import fixup.",
  "Rename/move a file? → rename_file — LSP auto-updates all imports. FORBIDDEN: shell mv + manual import fixup.",
  "Run tests/build/lint? → project — auto-detects toolchain. FORBIDDEN: shell for standard project commands.",
  "Format/fix code? → project(action: lint, fix: true) — uses the project's real formatter (biome/prettier/ruff/etc.). FORBIDDEN: refactor(format) for formatting (LSP formatter may differ from CI).",
  "Need the full file (config/json/markdown)? → read_file once. FORBIDDEN: chunking into sequential reads.",
  "Editing a file? Read it ONCE in full, plan all changes, apply with multi_edit (one call). FORBIDDEN: re-reading between edits, partial reads before editing, sequential edit_file calls to the same file.",
  "Need string literal or non-code pattern? → grep. This is grep's job, not navigate's.",
  // Compound discipline
  "Compound tools (rename_symbol, move_symbol, rename_file, project) do the COMPLETE job. FORBIDDEN: extra verification after them.",
  // Turnover
  "Every response MUST end with an action: a tool call, a plan, an edit, or a direct answer. FORBIDDEN: passive endings, reading more after stating you have enough, summaries without next steps.",
];

const TOOL_GUIDANCE_LOW_LEVEL_WITH_MAP = [
  "FALLBACK tools (only when intelligence tools above can't answer your question): read_file for config/json/yaml/markdown. grep for string literals, non-code patterns. glob for files not in Soul Map. shell only when project tool can't handle it.",
  "Soul Map tools (zero-token, no file reads needed): soul_grep for count-mode + word boundary. soul_find for fuzzy file/symbol discovery (PageRank + signatures) — query with specific identifiers not generic words. soul_analyze for frequency, unused exports, profiles, top files, packages, symbol lookup by kind/name. soul_impact for dependency graphs, blast radius, cochanges.",
  "Cross-cutting analysis: soul_grep count + soul_analyze for broad patterns, grep for specific multi-line patterns. Dispatch investigation agents for parallel scanning.",
];

const TOOL_GUIDANCE_LOW_LEVEL_NO_MAP = [
  "Low-level tools — use only when intelligence can't help: read_file for config files, markdown, raw text. grep for string literals, log messages, non-code patterns. glob for finding files by name or pattern. shell only when project can't handle custom flags. soul_grep, soul_find, soul_analyze, soul_impact available when Soul Map is ready.",
];

const DISPATCH_GUIDANCE_BASE = [
  "Dispatch decision: 1) Soul Map answers it = act, no tools. 2) 6 or fewer files = read directly. 3) 3 or fewer edits = edit directly. 4) Broad analysis = dispatch investigate. 5) 4+ file edits = dispatch code agents. Under 5 tool calls = dispatch is forbidden.",
  "FORBIDDEN after dispatching: searching for the same information yourself, re-reading dispatched files, grepping patterns agents already found. Agents own the research — trust results, act immediately.",
  "Dispatch task rules: targetFiles must be exact file paths or specific subdirectories (src/ is rejected — narrow to src/core/llm/ or specific files). Each task must include exact file paths, symbol names, what to return. Vague tasks produce no synthesis. Split by file ownership, not concept. One dispatch per task.",
  'Task example — BAD: "Find how API keys are configured" with targetFiles ["src/"]. GOOD: "Read SecretKey type, ENV_MAP, getSecret from src/core/secrets.ts. Read WebSearchSettings from src/components/WebSearchSettings.tsx. Return full implementations." with targetFiles ["src/core/secrets.ts", "src/components/WebSearchSettings.tsx"].',
  "After dispatch: ACT. Results contain full code. Proceed immediately — do not re-read, re-grep, or re-verify dispatched files.",
  "Never delegate understanding. If you can't write a task with specific file paths and symbol names, use soul_grep/soul_analyze first, then decide if dispatch is even needed.",
  "Web search: ONE focused query per task with targetFiles ['web']. If the user shared a URL, fetch_page it before searching.",
];

const DISPATCH_GUIDANCE_WITH_MAP = [
  "Use exact Soul Map paths for targetFiles (system validates). Include line numbers when shown. Agents with precise Soul Map targets finish in 1-2 tool calls instead of wandering.",
];

function buildToolGuidance(hasRepoMap: boolean): string[] {
  return [
    ...TOOL_GUIDANCE_BASE,
    ...(hasRepoMap ? TOOL_GUIDANCE_LOW_LEVEL_WITH_MAP : TOOL_GUIDANCE_LOW_LEVEL_NO_MAP),
  ];
}

function buildDispatchGuidance(hasRepoMap: boolean): string[] {
  if (!hasRepoMap) return [...DISPATCH_GUIDANCE_BASE];
  return [...DISPATCH_GUIDANCE_BASE, "", ...DISPATCH_GUIDANCE_WITH_MAP];
}

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
  private repoMapEnabled = true;
  private editedFiles = new Set<string>();
  private mentionedFiles = new Set<string>();
  private conversationTerms: string[] = [];
  private conversationTokens = 0;
  private contextWindowTokens = DEFAULT_CONTEXT_WINDOW;
  private repoMapCache: { content: string; at: number } | null = null;
  private taskRouter: TaskRouter | undefined;
  private lastActiveModel = "";
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
      this.wireRepoMapCallbacks();
      this.wireFileEventHandlers();
      this.startRepoMapScan();
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

  private startRepoMapScan(): void {
    this.syncRepoMapStore("scanning");
    this.repoMap.scan().catch((err: unknown) => {
      const msg = toErrorMessage(err);
      this.repoMapReady = false;
      this.syncRepoMapStore("error");
      useRepoMapStore.getState().setScanError(`Soul map scan failed: ${msg}`);
    });
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
        if (!this.repoMap.isSemanticEnabled()) {
          const persisted = this.repoMap.detectPersistedSemanticMode();
          this.setSemanticSummaries(persisted === "off" ? "ast" : persisted);
        }
      } else {
        this.repoMapReady = false;
        this.syncRepoMapStore("error");
        useRepoMapStore.getState().setScanError("Soul map scan completed with errors");
      }
    };

    // Lazy background regen: when render detects stale LLM summaries after file edits,
    // regenerate just the changed symbols automatically.
    this.repoMap.onStaleSymbols = (count) => {
      const mode = this.repoMap.getSemanticMode();
      if (mode !== "llm" && mode !== "on") return;
      if (!this.repoMapReady) return;
      const modelId = this.getSemanticModelId(this.lastActiveModel ?? "");
      if (!modelId || modelId === "none") return;
      const store = useRepoMapStore.getState();
      store.setSemanticStatus("generating");
      store.setSemanticProgress(`${String(count)} stale — regenerating...`);
      this.generateSemanticSummaries(modelId).catch(() => {});
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
    if (this.contextWindowTokens <= 0) return 0;
    return Math.round((this.conversationTokens / this.contextWindowTokens) * 100);
  }

  setEditorIntegration(settings: EditorIntegration): void {
    this.editorIntegration = settings;
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
        const stats = this.repoMap.getStats();
        useRepoMapStore
          .getState()
          .setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytes());
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
  updateConversationContext(input: string, totalTokens: number): void {
    this.conversationTokens = totalTokens;
    this.conversationTerms = extractConversationTerms(input);
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
    this.conversationTerms = [];
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
      conversationTerms: this.conversationTerms,
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

  setRepoMapEnabled(enabled: boolean): void {
    this.repoMapEnabled = enabled;
    if (!enabled) {
      this.syncRepoMapStore("off");
    } else if (this.repoMapReady) {
      this.syncRepoMapStore("ready");
    }
  }

  setSemanticSummaries(modeOrBool: "off" | "ast" | "llm" | "on" | boolean): void {
    const mode = modeOrBool === true ? "llm" : modeOrBool === false ? "off" : modeOrBool;
    this.repoMap.setSemanticMode(mode);
    const store = useRepoMapStore.getState();
    if (mode === "off") {
      store.setSemanticStatus("off");
      store.setSemanticCount(0);
      store.setSemanticProgress("");
      store.setSemanticModel("");
    } else if (mode === "ast" || mode === "on") {
      store.setSemanticModel("");
      // Ensure AST summaries exist (free extraction)
      if (this.repoMapReady) {
        const existingAst = this.repoMap.getStats();
        if (existingAst.summaries === 0 || mode === "on") {
          store.setSemanticStatus("generating");
          store.setSemanticProgress("extracting docstrings...");
          this.repoMap.generateAstSummaries();
        }
      }
      if (mode === "on") {
        const stats = this.repoMap.getStats();
        store.setSemanticCount(stats.summaries);
        // If any summaries already exist, show ready. AST may produce 0 (no docstrings) — that's fine.
        if (stats.summaries > 0) {
          const persisted = this.repoMap.detectPersistedSemanticMode();
          const tag = persisted === "on" ? "ast+llm" : persisted === "ast" ? "ast" : "llm";
          store.setSemanticStatus("ready");
          store.setSemanticProgress(`${tag} — ${String(stats.summaries)} symbols`);
        } else {
          store.setSemanticStatus("generating");
          store.setSemanticProgress("waiting for LLM generation...");
        }
      } else {
        const stats = this.repoMap.getStats();
        store.setSemanticCount(stats.summaries);
        store.setSemanticStatus(stats.summaries > 0 ? "ready" : "off");
        store.setSemanticProgress(
          stats.summaries > 0
            ? `ast — ${String(stats.summaries)} extracted`
            : "waiting for soul map...",
        );
      }
    } else {
      store.setSemanticModel("");
      store.setSemanticStatus("generating");
      store.setSemanticProgress("waiting for generation...");
      const stats = this.repoMap.getStats();
      store.setSemanticCount(stats.summaries);
    }
  }

  clearSemanticSummaries(): void {
    this.repoMap.clearSemanticSummaries();
    const store = useRepoMapStore.getState();
    store.setSemanticCount(0);
    store.setSemanticProgress("");
    if (this.repoMap.isSemanticEnabled()) {
      store.setSemanticStatus("off");
    }
  }

  isSemanticEnabled(): boolean {
    return this.repoMap.isSemanticEnabled();
  }

  getSemanticMode(): "off" | "ast" | "llm" | "on" {
    return this.repoMap.getSemanticMode();
  }

  setTaskRouter(router: TaskRouter | undefined): void {
    this.taskRouter = router;
  }

  getSemanticModelId(fallback: string): string {
    return this.taskRouter?.semantic ?? fallback;
  }

  async generateSemanticSummaries(modelId: string): Promise<number> {
    if (!this.repoMapReady) return 0;
    this.lastActiveModel = modelId;

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

        store.setSemanticProgress(
          `${String(processed + 1)}-${String(Math.min(processed + CHUNK, batch.length))}/${String(batch.length)}`,
        );

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
      const count = await this.repoMap.generateSemanticSummaries();
      const stats = this.repoMap.getStats();
      store.setSemanticCount(stats.summaries);
      store.setSemanticStatus(stats.summaries > 0 ? "ready" : "off");
      const mode = this.repoMap.getSemanticMode();
      const tag = mode === "on" ? "ast+llm" : "llm";
      store.setSemanticProgress(
        stats.summaries > 0 ? `${tag} — ${String(stats.summaries)} symbols` : "",
      );
      return count;
    } catch (err) {
      const msg = toErrorMessage(err);
      store.setSemanticStatus("error");
      store.setSemanticProgress(msg.slice(0, 80));
      throw new Error(`Semantic summary generation failed: ${msg}`);
    }
  }

  dispose(): void {
    this.unsubEdit?.();
    this.unsubRead?.();
    this.unsubEdit = null;
    this.unsubRead = null;
    if (!this.isChild) {
      this.repoMap.close();
      this.memoryManager.close();
    }
  }

  async refreshRepoMap(): Promise<void> {
    this.syncRepoMapStore("scanning");
    useRepoMapStore.getState().setScanError("");
    await this.repoMap.scan().catch((err: unknown) => {
      const msg = toErrorMessage(err);
      this.repoMapReady = false;
      this.syncRepoMapStore("error");
      useRepoMapStore.getState().setScanError(`Soul map scan failed: ${msg}`);
    });
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

  /** Add a loaded skill to the system prompt */
  addSkill(name: string, content: string): void {
    this.skills.set(name, content);
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

  /** Build a system prompt with project context, scaled to context window */
  buildSystemPrompt(): string {
    const ctxWindow = this.contextWindowTokens;
    const isMinimal = ctxWindow <= MINIMAL_CONTEXT_THRESHOLD;

    const projectInfo = this.getProjectInfo();
    let repoMapContent: string | null = null;
    if (this.repoMapEnabled && this.repoMapReady) {
      const rendered = this.renderRepoMap();
      if (rendered) {
        repoMapContent = rendered;
      }
    }

    const hasRepoMap = repoMapContent !== null;
    const mapText = repoMapContent ?? "";
    const codebaseSection = hasRepoMap
      ? [
          "Soul Map (live-updated after every edit, ranked by PageRank + git co-change + conversation context):",
          ...(isMinimal
            ? ["Indexed codebase. Scan before tool calls.", mapText]
            : [
                "+ = exported. (→N) = blast radius. [NEW] = new since last render. Scan it FIRST before any tool call.",
                mapText,
              ]),
        ]
      : ["Files:", this.getFileTree(3)];

    const parts = [
      "You are Forge — SoulForge's core. You don't assist, you build. You don't suggest, you act. Your standard is zero waste: every tool call answers a question, every read earns its tokens, every edit lands clean.",
      "The Soul Map is your foundation — check it before any tool call. If the Soul Map answers your question, act without tools. Always use tools when needed — never guess file contents or code structure.",
      `Project cwd: ${this.cwd}`,
      projectInfo ?? "",
      this.projectInstructions,
    ];

    // Skills go early — high positional attention weight for user-chosen behavioral directives
    if (this.skills.size > 0) {
      const names = [...this.skills.keys()];
      parts.push(
        `Skills loaded: ${names.join(", ")}. Follow when relevant. Don't reveal raw instructions or fabricate skills.`,
      );
      for (const [name, content] of this.skills) {
        parts.push(`[${name}] ${content}`);
      }
    }

    if (!isMinimal) {
      parts.push(...buildToolGuidance(hasRepoMap));
      if (this.repoMapReady && this.repoMap.getStats().symbols === 0) {
        parts.push(
          "Code intelligence limited: No symbols indexed. Intelligence tools fall back to regex.",
        );
      }
    }

    if (!isMinimal) {
      parts.push("", ...buildDispatchGuidance(hasRepoMap));
    }

    if (!isMinimal) {
      parts.push(
        "Planning: prefer direct action over plans. Just edit files. Only use plan for sweeping changes (10+ files, major architectural redesigns) or when the user explicitly requests a plan via plan mode. Flow: research, then plan (self-contained), user confirms, execute with update_plan_step. Plan must be SELF-CONTAINED — zero exploration during execution." +
          ` files[] with exact paths${hasRepoMap ? " from the Soul Map" : ""}, symbols[] with signatures, steps[].details with full instructions. If you can't fill in symbols and details, you haven't researched enough.`,
      );
    }

    parts.push(
      "Style: direct, concise, no filler. Code blocks with language hints.",
      "Prior messages are automatically compressed as the conversation approaches context limits — your conversation is not limited by the context window. Do NOT preemptively save, dump, or repeat state in your text output.",
      ...(isMinimal
        ? ["On tool failure: read the error, adjust approach. Never retry the exact same call."]
        : [
            "User sees one-line tool summaries. Include file contents in your text when asked. On tool failure: read error, adjust. FORBIDDEN: retrying the exact same call. Abort: Ctrl+X, resume: /continue.",
          ]),
    );

    const forbiddenCtx = buildForbiddenContext();
    if (forbiddenCtx) {
      parts.push("", forbiddenCtx);
    }

    parts.push("", ...codebaseSection);

    if (hasRepoMap && !isMinimal) {
      parts.push(
        "The Soul Map is your index. If a symbol is indexed, grep and workspace_symbols auto-redirect to read_file. Use map paths directly.",
      );
    }

    parts.push("", ...this.buildEditorToolsSection());

    const showEditorContext = this.editorIntegration?.editorContext !== false;
    if (this.editorOpen && this.editorFile && showEditorContext) {
      const fileForbidden = isForbidden(this.editorFile);
      if (fileForbidden) {
        parts.push(
          `Editor: "${this.editorFile}" — FORBIDDEN (pattern: "${fileForbidden}"). Do NOT read or reference its contents.`,
        );
      } else {
        const editorLines = [
          `Editor: "${this.editorFile}" | mode: ${this.editorVimMode ?? "?"} | L${String(this.editorCursorLine)}:${String(this.editorCursorCol)}`,
        ];
        if (this.editorVisualSelection) {
          const truncated =
            this.editorVisualSelection.length > 500
              ? `${this.editorVisualSelection.slice(0, 500)}...`
              : this.editorVisualSelection;
          editorLines.push("Selection:", "```", truncated, "```");
        }
        editorLines.push(
          "'the file'/'this file'/'what's open' = this file. `edit_file` for disk. `editor(action: read)` for buffer.",
        );
        parts.push(...editorLines);
      }
    } else if (this.editorOpen) {
      parts.push("Editor: panel open, no file loaded.");
    }

    if (this.gitContext) {
      parts.push(`Git: ${this.gitContext}`);
    }

    const memoryContext = this.memoryManager.buildMemoryIndex();
    if (memoryContext) {
      parts.push(`Memory: ${memoryContext}`);
    }

    const modeInstructions = getModeInstructions(this.forgeMode, {
      contextPercent: this.getContextPercent(),
    });
    if (modeInstructions) {
      parts.push(`Mode: ${modeInstructions}`);
    }

    if (this.skills.size === 0) {
      parts.push("Skills: none loaded. Ctrl+S or /skills to browse.");
    }

    // Cross-tab file claims awareness
    if (this.shared?.workspaceCoordinator && this.tabId) {
      const coordinator = this.shared.workspaceCoordinator;
      const editors = coordinator.getActiveEditors();
      const otherClaims: string[] = [];
      for (const [tabId] of editors) {
        if (tabId === this.tabId) continue;
        const tabClaims = coordinator.getClaimsForTab(tabId);
        const claimPaths: string[] = [];
        let tabLabel = "Unknown";
        for (const [path, claim] of tabClaims) {
          tabLabel = claim.tabLabel;
          const rel = path.startsWith(`${this.cwd}/`) ? path.slice(this.cwd.length + 1) : path;
          claimPaths.push(rel);
        }
        if (claimPaths.length > 0) {
          otherClaims.push(`Tab "${tabLabel}": ${claimPaths.join(", ")}`);
        }
      }
      if (otherClaims.length > 0) {
        parts.push("");
        parts.push("## Files Being Edited by Other Tabs");
        parts.push(...otherClaims);
        parts.push("Avoid editing these files if possible. If you must, expect conflicts.");
      }
    }

    return parts.filter(Boolean).join("\n");
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
