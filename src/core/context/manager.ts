import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { useRepoMapStore } from "../../stores/repomap.js";
import type { EditorIntegration, ForgeMode, TaskRouter } from "../../types/index.js";
import { buildGitContext } from "../git/status.js";
import { RepoMap, type SymbolForSummary } from "../intelligence/repo-map.js";
import { resolveModel } from "../llm/provider.js";
import { MemoryManager } from "../memory/manager.js";
import { getModeInstructions } from "../modes/prompts.js";
import { buildForbiddenContext, isForbidden } from "../security/forbidden.js";
import { onFileEdited, onFileRead } from "../tools/file-events.js";

// Static prompt sections — extracted for stable cache prefix across turns and subagents
// Each rule is a short, imperative fragment (Claude Code pattern: micro-fragments > paragraphs)
const TOOL_GUIDANCE_BASE = [
  "## Intelligence Layer",
  "",
  "Only call tools when necessary. If you already have the answer from the Repo Map, cache, or previous results, act without calling tools.",
  "",
  "**Trust hierarchy:** Repo Map → tool results → read cache. All three are always current (auto-updated on every edit). Data from these sources is authoritative — do not re-read, re-grep, or re-verify it.",
  "",
  "**Stop as soon as you can act.** Two examples confirming a pattern = confirmed. Search results converging on one area = sufficient. When you say 'I have the full picture' or 'Now I understand' — STOP READING AND ACT. If you have enough to write a plan or make edits, do it. Every additional read after that point is waste.",
  "",
  "**Workflow: Repo Map → targeted search → surgical reads.**",
  "1. Check the Repo Map for file paths, symbols, line ranges, and dependencies.",
  "2. If the Repo Map has what you need, act. No tool call required.",
  "3. If you need code content, use the right tool (see below). One read per file, one search per question.",
  "",
  "**Tool selection — use the most specific tool:**",
  "- One symbol from a file → `read_code` (extracts by name, fastest)",
  "- Multiple symbols or full file → `read_file` once (do NOT chunk into sequential reads)",
  "- Find a symbol's definition/references → `navigate`",
  "- File structure, diagnostics, unused symbols → `analyze`",
  "- Pattern frequency, identifier counts → `soul_grep` count mode / `soul_analyze`",
  "- File/symbol discovery → `soul_find` (PageRank-ranked, faster than glob)",
  "- Rename across all files → `rename_symbol` (compiler-guaranteed, auto-verifies)",
  "- Move to another file → `move_symbol` (extracts + updates all importers atomically)",
  "- Extract function/variable → `refactor`",
  "- Tests/build/lint/typecheck → `project` (auto-detects toolchain)",
  "",
  "**Compound tools** (`rename_symbol`, `move_symbol`, `project`) do the COMPLETE job. No extra verification steps.",
  "",
  "LSP-powered code intelligence with multi-tier fallback (LSP → ts-morph → tree-sitter → regex). Use it as the primary way to understand code.",
];

const TOOL_GUIDANCE_LOW_LEVEL_WITH_MAP = [
  "**Low-level tools** — use only when intelligence can't help:",
  "- `read_file` → config files (json/yaml/toml), markdown, raw text, or content after intelligence read",
  "- `grep` → string literals, log messages, non-code patterns (check Repo Map dependency counts first)",
  "- `glob` → finding files by pattern when not in the Repo Map",
  "- `shell` → only when `project` can't handle custom flags or non-standard commands",
  "",
  "**Repo Map tools** — zero-token codebase analysis (no LLM cost):",
  "- `soul_grep` → count-mode search with word boundary + symbol context (faster than grep for counts)",
  "- `soul_find` → fuzzy file/symbol discovery ranked by PageRank + cochange (faster than glob for exploration)",
  "- `soul_analyze` → identifier frequency, unused exports, file profile (deps/dependents/blast radius)",
  "- `soul_impact` → dependency graph queries: dependents, dependencies, cochanges, blast radius",
  "",
  "**Cross-cutting analysis** — audits, refactoring, architecture review:",
  "- Start broad: `soul_grep` count mode to find repeated idioms, `soul_analyze` identifier_frequency for hotspots, unused_exports for dead code",
  "- Then narrow: grep for specific multi-line patterns (error handling, guard clauses, cache setup) with occurrence counts",
  "- Compare sibling constructs: read builder/factory functions side-by-side, diff similar implementations across files",
  "- Dispatch investigation tasks for parallel scanning across directories — agents scan with soul tools, not just read files",
];

const TOOL_GUIDANCE_LOW_LEVEL_NO_MAP = [
  "**Low-level tools** — use only when intelligence can't help:",
  "- `read_file` → config files (json/yaml/toml), markdown, raw text, or content after intelligence read",
  "- `grep` → string literals, log messages, non-code patterns, symbol searches",
  "- `glob` → finding files by name or pattern",
  "- `shell` → only when `project` can't handle custom flags or non-standard commands",
  "- `soul_grep`, `soul_find`, `soul_analyze`, `soul_impact` — available when Repo Map is ready",
];

const DISPATCH_GUIDANCE_BASE = [
  "## Dispatch — Parallel Agents",
  "",
  "For simple, directed searches (specific file, class, function, pattern), use read_code/read_file/grep/soul_grep directly. Dispatch is slower than direct tools — only use it when your task clearly requires more than 5 tool calls or parallel work across many files.",
  "",
  "**Decision tree:**",
  "1. Can you answer from the Repo Map alone? → Act. No tools needed.",
  "2. Do you need content from ≤6 known files? → read_code/read_file directly. Do NOT dispatch.",
  "3. Do you need to edit ≤3 files? → edit_file directly. Do NOT dispatch.",
  "4. Do you need broad analysis across many directories? → Dispatch investigate agents.",
  "5. Do you need to edit 4+ files across the codebase? → Dispatch code agents, each owning distinct files.",
  "",
  "**Before dispatching, check what you already have.** Repo Map, previous tool results, and cached files are always current. If you already have the code, skip dispatch and act.",
  "",
  "**If you dispatch, do NOT also search yourself.** Dispatched agents do the research — do not duplicate their work with your own grep/read calls. Trust and act on what they return.",
  "",
  "**Writing dispatch tasks (quality = efficiency):**",
  '- `targetFiles` must be exact file paths or specific subdirectories. `["src/"]` is rejected — narrow to `["src/core/llm/"]` or specific files.',
  "- Each task must include: exact file paths, symbol names, what to return. Vague tasks = agents wander and produce no synthesis.",
  "- Split by file ownership, not concept. One dispatch per task — a second means the first was poorly scoped.",
  "",
  "**Task examples:**",
  '  BAD: `"Find how API keys are configured"` + `targetFiles: ["src/"]`',
  '  GOOD: `"Read SecretKey type, ENV_MAP, getSecret, setSecret from src/core/secrets.ts. Read WebSearchSettings from src/components/WebSearchSettings.tsx. Return full implementations."` + `targetFiles: ["src/core/secrets.ts", "src/components/WebSearchSettings.tsx"]`',
  "",
  "**After dispatch: ACT.** Results contain full code. Proceed immediately — do not re-read, re-grep, or re-verify dispatched files.",
  "",
  "**Never delegate understanding.** If you can't write a task with specific file paths and symbol names, you haven't done enough research yet — use soul_grep/soul_analyze first, then decide if dispatch is even needed.",
  "",
  "**Web search:** ONE focused query per task with `targetFiles: ['web']`. If the user shared a URL, `fetch_page` it before searching.",
];

const DISPATCH_GUIDANCE_WITH_MAP = [
  "- Use exact file paths from the Repo Map for `targetFiles`. The system validates them.",
  "- Include line numbers when the Repo Map shows them (e.g. `read lines 181-265 of src/hooks/useChat.ts`).",
  "- If a symbol isn't in the Repo Map, give targeted search keywords for workspace_symbols.",
  "",
  "**You have the Repo Map — USE IT.** Before writing any task, look up every file and symbol you need in the Repo Map. It gives you exact paths, symbol names, line ranges, and dependency relationships. Put ALL of them in the task and `targetFiles`. Agents with precise targets from the Repo Map find what they need in 1-2 tool calls instead of wandering.",
];

function buildToolGuidance(hasRepoMap: boolean): string[] {
  return [
    ...TOOL_GUIDANCE_BASE,
    "",
    ...(hasRepoMap ? TOOL_GUIDANCE_LOW_LEVEL_WITH_MAP : TOOL_GUIDANCE_LOW_LEVEL_NO_MAP),
  ];
}

function buildDispatchGuidance(hasRepoMap: boolean): string[] {
  if (!hasRepoMap) return [...DISPATCH_GUIDANCE_BASE];
  return [...DISPATCH_GUIDANCE_BASE, "", ...DISPATCH_GUIDANCE_WITH_MAP];
}

export { buildDispatchGuidance, buildToolGuidance };

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".cache",
  "coverage",
]);

export interface SharedContextResources {
  repoMap: RepoMap;
  memoryManager: MemoryManager;
}

/**
 * Context Manager — gathers relevant context from the codebase
 * to include in LLM prompts for better responses.
 *
 * When constructed with `shared`, uses existing RepoMap/MemoryManager
 * instead of creating new ones. Per-tab instances use this to share
 * expensive resources while maintaining independent conversation tracking.
 */
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
  private contextWindowTokens = 200_000;
  private repoMapCache: { content: string; at: number } | null = null;
  private taskRouter: TaskRouter | undefined;
  private isChild = false;
  private static readonly REPO_MAP_TTL = 5_000; // 5s — covers getContextBreakdown + buildSystemPrompt in same prompt

  private static readonly FILE_TREE_TTL = 30_000; // 30s
  private static readonly PROJECT_INFO_TTL = 300_000; // 5min

  constructor(cwd: string, shared?: SharedContextResources) {
    this.cwd = cwd;
    if (shared) {
      this.repoMap = shared.repoMap;
      this.memoryManager = shared.memoryManager;
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
    return { repoMap: this.repoMap, memoryManager: this.memoryManager };
  }

  private unsubEdit: (() => void) | null = null;
  private unsubRead: (() => void) | null = null;

  private wireFileEventHandlers(): void {
    this.unsubEdit = onFileEdited((absPath) => this.onFileChanged(absPath));
    this.unsubRead = onFileRead((absPath) => this.trackMentionedFile(absPath));
  }

  private startRepoMapScan(): void {
    this.syncRepoMapStore("scanning");
    this.repoMap.scan().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.repoMapReady = false;
      this.syncRepoMapStore("error");
      useRepoMapStore.getState().setScanError(`Repo map scan failed: ${msg}`);
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
          if (persisted !== "off") {
            this.setSemanticSummaries(persisted);
          }
        }
      } else {
        this.repoMapReady = false;
        this.syncRepoMapStore("error");
        useRepoMapStore.getState().setScanError("Repo map scan completed with errors");
      }
    };
  }

  private syncRepoMapStore(status: "off" | "scanning" | "ready" | "error"): void {
    const store = useRepoMapStore.getState();
    store.setStatus(status);
    const stats = this.repoMap.getStats();
    store.setStats(stats.files, stats.symbols, stats.edges, this.repoMap.dbSizeBytes());
    if (status !== "scanning") store.setScanProgress("");
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  /** Get the current forge mode */
  getForgeMode(): ForgeMode {
    return this.forgeMode;
  }

  /** Set the current forge mode */
  setForgeMode(mode: ForgeMode): void {
    this.forgeMode = mode;
  }

  /** Set the context window size (in tokens) for the active model */
  setContextWindow(tokens: number): void {
    this.contextWindowTokens = tokens;
  }

  /** Get approximate context fill percentage */
  getContextPercent(): number {
    if (this.contextWindowTokens <= 0) return 0;
    return Math.round((this.conversationTokens / this.contextWindowTokens) * 100);
  }

  /** Set which editor/LSP integrations are active */
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

  /** Get the repo map instance for direct access */
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

  setSemanticSummaries(modeOrBool: "off" | "ast" | "llm" | boolean): void {
    const mode = modeOrBool === true ? "llm" : modeOrBool === false ? "off" : modeOrBool;
    this.repoMap.setSemanticMode(mode);
    const store = useRepoMapStore.getState();
    if (mode === "off") {
      store.setSemanticStatus("off");
      store.setSemanticCount(0);
      store.setSemanticProgress("");
      store.setSemanticModel("");
    } else if (mode === "ast") {
      store.setSemanticModel("");
      const stats = this.repoMap.getStats();
      if (stats.summaries > 0) {
        store.setSemanticCount(stats.summaries);
        store.setSemanticStatus("ready");
        store.setSemanticProgress(`ast — ${String(stats.summaries)} extracted`);
      } else if (this.repoMapReady) {
        store.setSemanticStatus("generating");
        store.setSemanticProgress("extracting docstrings...");
        store.setSemanticCount(0);
        const count = this.repoMap.generateAstSummaries();
        store.setSemanticCount(count);
        store.setSemanticStatus("ready");
        store.setSemanticProgress(`ast — ${String(count)} extracted`);
      } else {
        store.setSemanticStatus("off");
        store.setSemanticCount(0);
        store.setSemanticProgress("waiting for repo map...");
      }
    } else {
      store.setSemanticModel("");
      store.setSemanticProgress("");
      const stats = this.repoMap.getStats();
      store.setSemanticCount(stats.summaries);
      store.setSemanticStatus(stats.summaries > 0 ? "ready" : "off");
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

  getSemanticMode(): "off" | "ast" | "llm" {
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

    const store = useRepoMapStore.getState();
    store.setSemanticStatus("generating");
    store.setSemanticProgress("preparing...");
    store.setSemanticModel(modelId);

    const model = resolveModel(modelId);
    const CHUNK = 10;
    let processed = 0;

    const generator = async (batch: SymbolForSummary[]) => {
      const all: Array<{ name: string; summary: string }> = [];

      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK);
        const prompt = chunk
          .map(
            (s, j) =>
              `[${String(j + 1)}] ${s.kind} \`${s.name}\` in ${s.filePath}:\n${s.signature ? `${s.signature}\n` : ""}${s.code}`,
          )
          .join("\n\n");

        store.setSemanticProgress(
          `${String(processed + 1)}-${String(Math.min(processed + CHUNK, batch.length))}/${String(batch.length)}`,
        );

        const { text } = await generateText({
          model,
          system:
            "Generate a one-line summary (max 80 chars) for each code symbol below. Output ONLY lines in the format:\nSymbolName: one-line summary\nNo numbering, no backticks, no extra text.",
          prompt,
        });

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
      store.setSemanticProgress("");
      return count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    this.repoMap.clear();
    await this.repoMap.scan().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.repoMapReady = false;
      this.syncRepoMapStore("error");
      useRepoMapStore.getState().setScanError(`Repo map scan failed: ${msg}`);
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
        sections.push({ section: "Repo map", chars: map.length, active: true });
      } else {
        const fileTree = this.getFileTree(3);
        sections.push({
          section: "File tree (repo map empty)",
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
    const isMinimal = ctxWindow <= 32_000;

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
          "## Repo Map",
          ...(isMinimal
            ? ["Indexed codebase. Scan before tool calls.", "```", mapText, "```"]
            : [
                "Live-updated after every edit. Ranked by PageRank + git co-change + conversation context.",
                "`+` = exported. `(→N)` = blast radius. `[NEW]` = new since last render.",
                "Scan it FIRST before any tool call — if a file or symbol is here, you already know its exact path.",
                "```",
                mapText,
                "```",
              ]),
        ]
      : ["## Files", "```", this.getFileTree(3), "```"];

    // ── STATIC sections first (stable prefix → maximizes cache hits) ──

    const parts = [
      "You are Forge, the AI inside SoulForge (terminal IDE). Always call yourself Forge.",
      "Always use tools — never guess file contents or code structure.",
      "",
      "## Project",
      `cwd: ${this.cwd}`,
      projectInfo ? `\n${projectInfo}` : "",
    ];

    if (!isMinimal) {
      parts.push(
        "",
        "Context compaction is automatic and preserves your plan, tasks, and working state. Do NOT save to memory before compaction — memory is for long-term knowledge (decisions, conventions), not session checkpoints. Just keep working.",
        "",
        ...buildToolGuidance(hasRepoMap),
      );
      if (this.repoMapReady && this.repoMap.getStats().symbols === 0) {
        parts.push(
          "",
          "**Code intelligence limited**: No symbols indexed. Intelligence tools fall back to regex.",
        );
      }
    }

    if (!isMinimal) {
      parts.push("", ...buildDispatchGuidance(hasRepoMap));
    }

    if (!isMinimal) {
      parts.push(
        "",
        "## Planning",
        "Plan when: 3+ steps, multi-file, or architectural. Skip for: simple edits, lookups, 'just do it'.",
        "1. Research → 2. `plan` (self-contained) → 3. User confirms → 4. Execute with `update_plan_step`.",
        "**Plan must be SELF-CONTAINED — zero exploration during execution.**",
        `- \`files[]\` with exact paths${hasRepoMap ? " from the Repo Map" : ""}, \`symbols[]\` with signatures, \`steps[].details\` with full instructions.`,
        "- If you can't fill in symbols and details, you haven't researched enough.",
      );
    }

    parts.push(
      "",
      "## Style",
      "Direct, concise, no filler. Markdown code blocks with language hints.",
      "",
      "## Rules",
      ...(isMinimal
        ? ["- On tool failure: read the error, adjust approach. Never retry the exact same call."]
        : [
            "- Compound tools (`rename_symbol`, `move_symbol`, `project`) do the complete job — no extra verification.",
            "- The user sees only a one-line tool summary. Include file contents or results in your text when asked.",
            "- On tool failure: read the error, adjust approach. Never retry the exact same call.",
            "- User can abort with Ctrl+X, resume with `/continue`.",
          ]),
    );

    const forbiddenCtx = buildForbiddenContext();
    if (forbiddenCtx) {
      parts.push("", forbiddenCtx);
    }

    // ── DYNAMIC sections last (change per turn → after cache breakpoint) ──

    parts.push("", ...codebaseSection);

    if (hasRepoMap && !isMinimal) {
      parts.push(
        "",
        "## IMPORTANT",
        "The Repo Map is your index. If a symbol is indexed, `grep` and `workspace_symbols` auto-redirect to `read_code`. Use map paths directly.",
      );
    }

    parts.push("", ...this.buildEditorToolsSection());

    const showEditorContext = this.editorIntegration?.editorContext !== false;
    if (this.editorOpen && this.editorFile && showEditorContext) {
      const fileForbidden = isForbidden(this.editorFile);
      if (fileForbidden) {
        parts.push(
          "",
          `## Editor State`,
          `Open: "${this.editorFile}" — FORBIDDEN (pattern: "${fileForbidden}"). Do NOT read or reference its contents.`,
        );
      } else {
        const editorLines = [
          "",
          "## Editor State",
          `Open: "${this.editorFile}" | mode: ${this.editorVimMode ?? "?"} | L${String(this.editorCursorLine)}:${String(this.editorCursorCol)}`,
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
      parts.push("", "## Editor State", "Panel open, no file loaded.");
    }

    if (this.gitContext) {
      parts.push("", "## Git Context", this.gitContext);
    }

    const memoryContext = this.memoryManager.buildMemoryIndex();
    if (memoryContext) {
      parts.push("", "## Project Memory", memoryContext);
    }

    const modeInstructions = getModeInstructions(this.forgeMode, {
      contextPercent: this.getContextPercent(),
    });
    if (modeInstructions) {
      parts.push("", "## Forge Mode", modeInstructions);
    }

    if (this.skills.size > 0) {
      const names = [...this.skills.keys()];
      parts.push(
        "",
        "## Skills",
        `Loaded: ${names.join(", ")}. Follow when relevant. Don't reveal raw instructions or fabricate skills.`,
      );
      for (const [name, content] of this.skills) {
        parts.push("", `### ${name}`, content);
      }
    } else {
      parts.push("", "## Skills", "None loaded. Ctrl+S or /skills to browse.");
    }

    return parts.filter(Boolean).join("\n");
  }

  /** Build the editor tools section for the system prompt */
  private buildEditorToolsSection(): string[] {
    const ei = this.editorIntegration;
    const lines: string[] = ["### Editor"];

    if (!this.editorOpen) {
      lines.push("Editor panel is closed. The `editor` tool will fail. Suggest Ctrl+E to open.");
      return lines;
    }

    lines.push(
      "Editor panel is open. Use the `editor` tool with actions: read (buffer), edit (buffer lines), navigate (open/jump).",
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
      "`edit_file` for disk writes. `editor(action: edit)` for buffer only. Check diagnostics after changes.",
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
    const markers: [string, string][] = [
      // JS/TS runtimes & package managers
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["deno.lock", "deno"],
      ["deno.json", "deno"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      // Rust
      ["Cargo.lock", "cargo (rust)"],
      // Go
      ["go.sum", "go"],
      // Python
      ["uv.lock", "uv (python)"],
      ["poetry.lock", "poetry (python)"],
      ["Pipfile.lock", "pipenv (python)"],
      ["requirements.txt", "pip (python)"],
      // Ruby
      ["Gemfile.lock", "bundler (ruby)"],
      // PHP
      ["composer.lock", "composer (php)"],
      // Java/Kotlin/JVM
      ["gradlew", "gradle (jvm)"],
      ["mvnw", "maven (jvm)"],
      ["pom.xml", "maven (jvm)"],
      ["build.gradle", "gradle (jvm)"],
      ["build.gradle.kts", "gradle (jvm)"],
      // .NET / C#
      ["global.json", "dotnet"],
      // Elixir
      ["mix.lock", "mix (elixir)"],
      // Swift
      ["Package.resolved", "swift package manager"],
      // C/C++
      ["CMakeLists.txt", "cmake (c/c++)"],
      ["Makefile", "make"],
      ["meson.build", "meson (c/c++)"],
      ["conanfile.txt", "conan (c/c++)"],
      ["vcpkg.json", "vcpkg (c/c++)"],
      // Zig
      ["build.zig.zon", "zig"],
      // Dart/Flutter
      ["pubspec.lock", "dart/flutter"],
      // Haskell
      ["stack.yaml", "stack (haskell)"],
      ["cabal.project", "cabal (haskell)"],
      // Scala
      ["build.sbt", "sbt (scala)"],
      // Clojure
      ["deps.edn", "clojure"],
      ["project.clj", "leiningen (clojure)"],
    ];
    for (const [file, tool] of markers) {
      if (existsSync(join(this.cwd, file))) return tool;
    }
    return null;
  }

  /** Generate a simple file tree (cached with 30s TTL) */
  private getFileTree(maxDepth: number): string {
    const now = Date.now();
    if (this.fileTreeCache && now - this.fileTreeCache.at < ContextManager.FILE_TREE_TTL) {
      return this.fileTreeCache.tree;
    }
    const lines: string[] = [];
    this.walkDir(this.cwd, "", maxDepth, lines);
    const tree = lines.slice(0, 50).join("\n");
    this.fileTreeCache = { tree, at: now };
    return tree;
  }

  private walkDir(dir: string, prefix: string, depth: number, lines: string[]): void {
    if (depth <= 0) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (const entry of entries) {
        const isLast = entry === entries[entries.length - 1];
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";

        lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`);

        if (entry.isDirectory()) {
          this.walkDir(join(dir, entry.name), prefix + childPrefix, depth - 1, lines);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "about",
  "that",
  "this",
  "it",
  "its",
  "and",
  "or",
  "but",
  "not",
  "no",
  "if",
  "then",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "some",
  "any",
  "other",
  "new",
  "old",
  "make",
  "like",
  "use",
  "get",
  "add",
  "fix",
  "change",
  "update",
  "create",
  "delete",
  "remove",
  "move",
  "set",
  "let",
  "please",
  "want",
  "look",
  "file",
  "code",
  "function",
  "method",
  "class",
  "type",
  "we",
  "me",
  "my",
  "you",
  "your",
  "they",
  "them",
  "i",
]);

export function extractConversationTerms(input: string): string[] {
  const words = input.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    terms.push(word);
    if (terms.length >= 15) break;
  }

  return terms;
}
