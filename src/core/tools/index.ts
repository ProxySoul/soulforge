import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import type { EditorIntegration } from "../../types/index.js";
import { type AgentBus, normalizePath } from "../agents/agent-bus.js";
import type { RepoMap } from "../intelligence/repo-map.js";
import { MemoryManager } from "../memory/manager.js";
import {
  describeDestructiveCommand,
  isDestructiveCommand,
  isSensitiveFile,
} from "../security/approval-gates.js";
import { needsOutsideConfirm } from "../security/outside-cwd.js";
import { analyzeTool } from "./analyze.js";
import { discoverPatternTool } from "./discover-pattern.js";
import { editFileTool } from "./edit-file";
import { undoEditTool } from "./edit-stack.js";
import { editorTool } from "./editor";
import { fetchPageTool } from "./fetch-page.js";
import { gitTool } from "./git.js";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { listDirTool } from "./list-dir.js";
import { createMemoryTool } from "./memory.js";
import { moveSymbolTool } from "./move-symbol.js";
import { multiEditTool } from "./multi-edit.js";
import { navigateTool } from "./navigate.js";
import { projectTool } from "./project.js";
import { readFileTool } from "./read-file";
import { refactorTool } from "./refactor.js";
import { renameSymbolTool } from "./rename-symbol.js";
import {
  tryInterceptDiscoverPattern,
  tryInterceptGlob,
  tryInterceptGrep,
  tryInterceptNavigate,
} from "./repo-map-intercept.js";
import { shellTool } from "./shell";
import { soulAnalyzeTool } from "./soul-analyze.js";
import { soulFindTool } from "./soul-find.js";
import { soulGrepTool } from "./soul-grep.js";
import { soulImpactTool } from "./soul-impact.js";
import { taskListTool } from "./task-list.js";
import { testScaffoldTool } from "./test-scaffold.js";
import { buildWebSearchTool } from "./web-search";

export { buildInteractiveTools } from "./interactive.js";

/**
 * Yield to the event loop before tool execution so the UI can render
 * the "running" spinner before synchronous operations block the thread.
 */
function deferExecute<T, R>(fn: (args: T) => Promise<R>): (args: T) => Promise<R> {
  return async (args: T) => {
    await new Promise<void>((r) => setTimeout(r, 0));
    return fn(args);
  };
}

/**
 * Build Vercel AI SDK tool definitions.
 * AI SDK v6 uses `inputSchema` instead of `parameters`.
 *
 * @param onApproveWebSearch - If provided, called before every web_search with the query.
 *   Resolves to true = allow, false = deny. When omitted, web_search executes unguarded.
 */
export function buildTools(
  cwd?: string,
  _editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    codeExecution?: boolean;
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    repoMap?: RepoMap;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
    onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
    onApproveDestructive?: (description: string) => Promise<boolean>;
  },
) {
  const effectiveCwd = cwd ?? process.cwd();
  const mm = opts?.memoryManager ?? new MemoryManager(effectiveCwd);
  const memoryTool = createMemoryTool(mm);

  let sequentialReads = 0;
  const READ_NUDGE_SOFT = 4;
  const READ_NUDGE_HARD = 7;
  const NUDGE_SOFT =
    "\n\n---\n[Hint: You've read several files sequentially. Consider soul_grep (count mode) to scan patterns across the codebase, or soul_analyze for structural insights — both are faster than reading files one by one.]";
  const NUDGE_HARD =
    "\n\n---\n[WARNING: You have read " +
    "many files sequentially without using search tools. STOP reading and use soul_grep/soul_analyze to find what you need. " +
    "If you already have the information from a previous dispatch, act on it instead of re-reading.]";
  const resetReadCounter = () => {
    sequentialReads = 0;
  };

  async function gateOutsideCwd(
    toolName: string,
    filePath: string,
  ): Promise<
    | { blocked: true; result: { success: false; output: string; error: string } }
    | { blocked: false }
  > {
    if (!needsOutsideConfirm(toolName, filePath, effectiveCwd)) return { blocked: false };
    if (!opts?.onApproveOutsideCwd) return { blocked: false };
    const approved = await opts.onApproveOutsideCwd(toolName, filePath);
    if (approved) return { blocked: false };
    const msg = `Denied: ${toolName} outside project directory → ${filePath}`;
    return { blocked: true, result: { success: false, output: msg, error: msg } };
  }

  return {
    read_file: tool({
      description: readFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to read"),
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
        target: z
          .enum(["function", "class", "type", "interface", "variable", "enum", "scope"])
          .optional()
          .describe("Symbol type to extract (AST-based). Omit for raw file read."),
        name: z
          .string()
          .optional()
          .describe("Symbol name (required when target is set, except scope)"),
        fresh: z.boolean().optional().describe("Set true to bypass cache and re-execute"),
      }),
      execute: deferExecute(async (args) => {
        const result = await readFileTool.execute(args);
        sequentialReads++;
        if (result.success) {
          if (sequentialReads >= READ_NUDGE_HARD) {
            return { ...result, output: result.output + NUDGE_HARD };
          }
          if (sequentialReads >= READ_NUDGE_SOFT) {
            return { ...result, output: result.output + NUDGE_SOFT };
          }
        }
        return result;
      }),
    }),

    edit_file: tool({
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Exact string to replace (empty = create new file)"),
        newString: z.string().describe("Replacement string"),
        lineStart: z
          .number()
          .optional()
          .describe(
            "1-indexed line hint from your last read — helps locate the match and shows context on error",
          ),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("edit_file", resolve(args.path));
        if (gate.blocked) return gate.result;
        if (opts?.onApproveDestructive && isSensitiveFile(args.path)) {
          const approved = await opts.onApproveDestructive(`Edit sensitive file: \`${args.path}\``);
          if (!approved) {
            const msg = `Denied: edit to sensitive file ${args.path}`;
            return { success: false, output: msg, error: msg };
          }
        }
        return editFileTool.execute(args);
      }),
    }),

    undo_edit: tool({
      description: undoEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to undo"),
        steps: z.number().optional().describe("Number of edits to undo (default 1, max 10)"),
      }),
      execute: deferExecute((args) => undoEditTool.execute(args)),
    }),

    multi_edit: tool({
      description: multiEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("Exact string to replace"),
              newString: z.string().describe("Replacement string"),
              lineStart: z.number().optional().describe("Line hint (1-indexed)"),
            }),
          )
          .describe("Array of edits to apply atomically"),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("multi_edit", resolve(args.path));
        if (gate.blocked) return gate.result;
        if (opts?.onApproveDestructive && isSensitiveFile(args.path)) {
          const approved = await opts.onApproveDestructive(`Edit sensitive file: \`${args.path}\``);
          if (!approved) {
            const msg = `Denied: edit to sensitive file ${args.path}`;
            return { success: false, output: msg, error: msg };
          }
        }
        return multiEditTool.execute(args);
      }),
    }),

    task_list: tool({
      description: taskListTool.description,
      inputSchema: z.object({
        action: z.enum(["add", "update", "remove", "list", "clear"]).describe("Task action"),
        title: z.string().optional().describe("Single task title (for add/update)"),
        titles: z.array(z.string()).optional().describe("Batch add — multiple task titles at once"),
        id: z.number().optional().describe("Task ID (for update/remove)"),
        status: z
          .enum(["pending", "in-progress", "done", "blocked"])
          .optional()
          .describe("Task status (for add/update)"),
      }),
      execute: deferExecute((args) => taskListTool.execute(args)),
    }),

    list_dir: tool({
      description: listDirTool.description,
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (defaults to cwd)"),
      }),
      execute: deferExecute((args) => listDirTool.execute(args, opts?.repoMap)),
    }),

    soul_grep: tool({
      description:
        soulGrepTool.description +
        " Use dep to search inside dependency/vendor directories (bypasses .gitignore).",
      inputSchema: z.object({
        pattern: z.string().describe("Regex or literal search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter (e.g. '*.ts')"),
        count: z
          .boolean()
          .optional()
          .describe(
            "Aggregate count mode — returns per-file match counts and total. " +
              "Use for frequency analysis, variable counting, pattern prevalence.",
          ),
        wordBoundary: z
          .boolean()
          .optional()
          .describe(
            "Whole-word matching (\\bpattern\\b). Prevents substring false positives. " +
              "Essential for counting variable/identifier occurrences.",
          ),
        dep: z
          .union([z.string(), z.boolean()])
          .optional()
          .describe(
            "Search dependency/vendor directories (bypasses .gitignore). " +
              "Pass package name (e.g. 'react') to auto-locate, or true to search all with --no-ignore.",
          ),
        fresh: z.boolean().optional().describe("Set true to bypass cache and re-execute"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulGrepTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_find: tool({
      description: soulFindTool.description,
      inputSchema: z.object({
        query: z.string().describe("Fuzzy search query — file name, symbol name, or concept"),
        type: z
          .enum(["test", "component", "config", "types", "style"])
          .optional()
          .describe("Filter by file category"),
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulFindTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_analyze: tool({
      description: soulAnalyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "identifier_frequency",
            "unused_exports",
            "file_profile",
            "duplication",
            "top_files",
            "packages",
            "symbols_by_kind",
          ])
          .describe("Analysis action"),
        file: z.string().optional().describe("File path (required for file_profile)"),
        name: z
          .string()
          .optional()
          .describe(
            "Identifier/package name (for identifier_frequency, packages, symbols_by_kind)",
          ),
        kind: z
          .string()
          .optional()
          .describe(
            "Symbol kind (for symbols_by_kind: interface, class, function, type, enum, trait, struct)",
          ),
        limit: z.number().optional().describe("Max results"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulAnalyzeTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_impact: tool({
      description: soulImpactTool.description,
      inputSchema: z.object({
        action: z
          .enum(["dependents", "dependencies", "cochanges", "blast_radius"])
          .describe("Impact action"),
        file: z.string().describe("File path to analyze"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulImpactTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    shell: tool({
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
      execute: async (args, { abortSignal }) => {
        await new Promise<void>((r) => setTimeout(r, 0));
        resetReadCounter();
        if (args.cwd) {
          const gate = await gateOutsideCwd("shell", resolve(args.cwd));
          if (gate.blocked) return gate.result;
        }
        if (opts?.onApproveDestructive && isDestructiveCommand(args.command)) {
          const desc = describeDestructiveCommand(args.command);
          const approved = await opts.onApproveDestructive(`Shell: ${desc}\n\n\`${args.command}\``);
          if (!approved) {
            const msg = `Denied: ${desc}`;
            return { success: false, output: msg, error: msg };
          }
        }
        const result = await shellTool.execute(args, abortSignal);
        if (result.success && opts?.repoMap?.isReady) {
          opts.repoMap.recheckModifiedFiles();
        }
        return result;
      },
    }),

    grep: tool({
      description: grepTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Regex search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
        fresh: z.boolean().optional().describe("Set true to bypass cache and re-execute"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = tryInterceptGrep(args, opts?.repoMap, effectiveCwd);
          if (hit) return Promise.resolve(hit);
        }
        return grepTool.execute(args);
      }),
    }),

    glob: tool({
      description: globTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern"),
        path: z.string().optional().describe("Base directory"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
        fresh: z.boolean().optional().describe("Set true to bypass cache and re-execute"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = tryInterceptGlob(args, opts?.repoMap, effectiveCwd);
          if (hit) return Promise.resolve(hit);
        }
        return globTool.execute(args);
      }),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: onApproveWebSearch,
      onApproveFetchPage: opts?.onApproveFetchPage,
    }),

    fetch_page: tool({
      description: fetchPageTool.description,
      inputSchema: z.object({
        url: z.string().describe("URL to fetch and read"),
      }),
      execute: deferExecute(async (args) => {
        if (opts?.onApproveFetchPage) {
          const approved = await opts.onApproveFetchPage(args.url);
          if (!approved) {
            return {
              success: false,
              output: "Page fetch was denied by the user.",
              error: "Fetch denied.",
            };
          }
        }
        return fetchPageTool.execute(args);
      }),
    }),

    memory: memoryTool,

    editor: tool({
      description: editorTool.description,
      inputSchema: z.object({
        action: z.enum([
          "read",
          "edit",
          "navigate",
          "diagnostics",
          "symbols",
          "hover",
          "references",
          "definition",
          "actions",
          "rename",
          "lsp_status",
          "format",
          "select",
          "goto_cursor",
          "yank",
          "open_file",
          "highlight",
          "cursor_context",
          "buffers",
          "quickfix",
          "terminal_output",
        ]),
        startLine: z
          .number()
          .optional()
          .describe("For read/edit/format/select/highlight: start line (1-indexed)"),
        endLine: z
          .number()
          .optional()
          .describe("For read/edit/format/select/highlight: end line (1-indexed)"),
        replacement: z.string().optional().describe("For edit: new content"),
        file: z.string().optional().describe("For navigate/open_file: file path"),
        line: z
          .number()
          .optional()
          .describe("For navigate/hover/references/definition/actions/rename/goto_cursor: line"),
        col: z
          .number()
          .optional()
          .describe("For navigate/hover/references/definition/actions/rename/goto_cursor: column"),
        search: z.string().optional().describe("For navigate: search pattern"),
        newName: z.string().optional().describe("For rename: new symbol name"),
        apply: z.number().optional().describe("For actions: 0-indexed action to apply"),
        jump: z.boolean().optional().describe("For definition: jump to first result"),
        text: z.string().optional().describe("For yank: text to put in register"),
        register: z
          .string()
          .optional()
          .describe('For yank: neovim register (default: "+", system clipboard)'),
        count: z
          .number()
          .optional()
          .describe("For terminal_output: max lines to read (default: 100)"),
      }),
      execute: deferExecute((args) => editorTool.execute(args)),
    }),

    navigate: tool({
      description: navigateTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "definition",
            "references",
            "symbols",
            "imports",
            "exports",
            "workspace_symbols",
            "call_hierarchy",
            "implementation",
            "type_hierarchy",
            "search_symbols",
          ])
          .describe("Navigation action"),
        symbol: z.string().optional().describe("Symbol name to look up"),
        file: z.string().optional().describe("File path to analyze"),
        scope: z.string().optional().describe("Filter symbols by name pattern"),
        query: z.string().optional().describe("Search query for workspace_symbols/search_symbols"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = tryInterceptNavigate(args, opts?.repoMap, effectiveCwd);
          if (hit) return Promise.resolve(hit);
        }
        return navigateTool.execute(args, opts?.repoMap);
      }),
    }),

    rename_symbol: tool({
      description: renameSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Current name of the symbol to rename"),
        newName: z.string().describe("New name for the symbol"),
        file: z
          .string()
          .optional()
          .describe(
            "File where the symbol is defined (optional — auto-detected via workspace search)",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (args.file) {
          const gate = await gateOutsideCwd("rename_symbol", resolve(args.file));
          if (gate.blocked) return gate.result;
        }
        return renameSymbolTool.execute(args);
      }),
    }),

    move_symbol: tool({
      description: moveSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Name of the symbol to move"),
        from: z.string().describe("Source file path"),
        to: z.string().describe("Target file path (created if it doesn't exist)"),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("move_symbol", resolve(args.to));
        if (gate.blocked) return gate.result;
        return moveSymbolTool.execute(args);
      }),
    }),

    refactor: tool({
      description: refactorTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "extract_function",
            "extract_variable",
            "format",
            "format_range",
            "organize_imports",
          ])
          .describe("Action to perform"),
        file: z.string().optional().describe("Target file"),
        newName: z.string().optional().describe("New name for extracted symbol"),
        startLine: z.number().optional().describe("Start line for extraction or range formatting"),
        endLine: z.number().optional().describe("End line for extraction or range formatting"),
        name: z
          .string()
          .optional()
          .describe(
            "Symbol name to extract (auto-resolves line range — use instead of startLine/endLine)",
          ),
        apply: z.boolean().optional().describe("Apply changes to disk (default true)"),
      }),
      execute: deferExecute(async (args) => {
        if (args.file) {
          const gate = await gateOutsideCwd("refactor", resolve(args.file));
          if (gate.blocked) return gate.result;
        }
        return refactorTool.execute(args);
      }),
    }),

    analyze: tool({
      description: analyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum(["diagnostics", "type_info", "outline", "code_actions", "unused", "symbol_diff"])
          .describe("Analysis action"),
        file: z.string().optional().describe("File path to analyze"),
        symbol: z.string().optional().describe("Symbol for type_info"),
        line: z.number().optional().describe("Line number for type_info"),
        column: z.number().optional().describe("Column number for type_info"),
        startLine: z.number().optional().describe("Start line for code_actions range"),
        endLine: z.number().optional().describe("End line for code_actions range"),
        oldContent: z
          .string()
          .optional()
          .describe("Old file content for symbol_diff (or uses git HEAD)"),
      }),
      execute: deferExecute((args) => analyzeTool.execute(args)),
    }),

    discover_pattern: tool({
      description: discoverPatternTool.description,
      inputSchema: z.object({
        query: z.string().describe("Concept to discover (e.g. 'provider', 'router', 'auth')"),
        file: z.string().optional().describe("File to scope the search to"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute((args) => {
        if (!args.force) {
          const hit = tryInterceptDiscoverPattern(args, opts?.repoMap, effectiveCwd);
          if (hit) return Promise.resolve(hit);
        }
        return discoverPatternTool.execute(args);
      }),
    }),

    test_scaffold: tool({
      description: testScaffoldTool.description,
      inputSchema: z.object({
        file: z.string().describe("Source file to generate tests for"),
        framework: z
          .enum(["vitest", "jest", "bun", "pytest", "go", "cargo"])
          .optional()
          .describe("Test framework (auto-detected from project toolchain)"),
        output: z.string().optional().describe("Output path for test file"),
      }),
      execute: deferExecute((args) => testScaffoldTool.execute(args)),
    }),

    project: tool({
      description: projectTool.description,
      inputSchema: z.object({
        action: z
          .enum(["test", "build", "lint", "typecheck", "run", "list"])
          .describe("Project action (list discovers monorepo packages)"),
        file: z.string().optional().describe("Target file (for test/lint)"),
        fix: z.boolean().optional().describe("Auto-fix lint issues"),
        script: z.string().optional().describe("Named script to run (for run action)"),
        flags: z
          .string()
          .optional()
          .describe(
            "Extra flags appended to the command (e.g. '--features async', '-k test_name')",
          ),
        raw: z
          .boolean()
          .optional()
          .describe("Skip preset fix flags — use only the flags you provide"),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables (e.g. { NODE_ENV: 'test', DEBUG: '1' })"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory relative to project root (for monorepos)"),
        timeout: z.number().optional().describe("Timeout in ms (default 120000)"),
      }),
      execute: deferExecute((args) =>
        projectTool.execute(args as Parameters<typeof projectTool.execute>[0]),
      ),
    }),

    git: tool({
      description: gitTool.description,
      inputSchema: z.object({
        action: z.enum([
          "status",
          "diff",
          "log",
          "commit",
          "push",
          "pull",
          "stash",
          "branch",
          "show",
          "unstage",
          "restore",
        ]),
        staged: z.boolean().optional().describe("For diff: staged changes"),
        count: z.number().optional().describe("For log: number of commits"),
        message: z.string().optional().describe("For commit/stash: message"),
        files: z.array(z.string()).optional().describe("For commit/unstage/restore: files"),
        sub_action: z
          .string()
          .optional()
          .describe("For stash: push|pop|list|show|drop. For branch: list|create|switch|delete"),
        name: z.string().optional().describe("For branch: branch name"),
        index: z.number().optional().describe("For stash: stash index"),
        amend: z.boolean().optional().describe("For commit: amend the last commit"),
        ref: z.string().optional().describe("For show: commit hash or ref (default: HEAD)"),
      }),
      execute: deferExecute((args) => gitTool.execute(args)),
    }),

    ...(opts?.codeExecution
      ? { code_execution: createAnthropic().tools.codeExecution_20260120() }
      : {}),
  };
}

/** Tool names allowed in restricted modes (architect, socratic, challenge).
 *  Read/analysis + memory + editor read — NO edit/shell/git/refactor.
 *  Used with activeTools to restrict without rebuilding the tool set. */
export const RESTRICTED_TOOL_NAMES: string[] = [
  "read_file",
  "grep",
  "glob",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
  "list_dir",
  "web_search",
  "editor",
  "navigate",
  "analyze",
  "discover_pattern",
  "memory",
  "fetch_page",
  "test_scaffold",
  "dispatch",
  "ask_user",
  "plan",
  "update_plan_step",
];

/** Read-only tools for restricted modes (architect, socratic, challenge).
 *  Includes all read/analysis + memory + editor read, but NO edit/shell/git/refactor.
 *  The LLM physically cannot bypass the mode — these tools don't exist on the agent. */
export function buildRestrictedModeTools(
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    repoMap?: RepoMap;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
  },
) {
  const all = buildTools(undefined, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    fetch_page: all.fetch_page,
    editor: all.editor,
    navigate: all.navigate,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    memory: all.memory,
    ...(all.soul_grep ? { soul_grep: all.soul_grep } : {}),
    ...(all.soul_find ? { soul_find: all.soul_find } : {}),
    ...(all.soul_analyze ? { soul_analyze: all.soul_analyze } : {}),
    ...(all.soul_impact ? { soul_impact: all.soul_impact } : {}),
  };
}

/** Read-only tools for explore subagent */
export function buildReadOnlyTools(
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
  },
) {
  const all = buildTools(undefined, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    fetch_page: all.fetch_page,
    editor: all.editor,
    navigate: all.navigate,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    memory: all.memory,
    ...(all.soul_grep ? { soul_grep: all.soul_grep } : {}),
    ...(all.soul_find ? { soul_find: all.soul_find } : {}),
    ...(all.soul_analyze ? { soul_analyze: all.soul_analyze } : {}),
    ...(all.soul_impact ? { soul_impact: all.soul_impact } : {}),
  };
}

/** Tools available during plan execution.
 *  Executor gets edit/shell/project + read_file (fallback if edit fails) + update_plan_step.
 *  No dispatch, explore, discover_pattern, web_search, test_scaffold — the plan already contains everything. */
export const PLAN_EXECUTION_TOOL_NAMES: string[] = [
  "read_file",
  "edit_file",
  "undo_edit",
  "multi_edit",
  "task_list",
  "list_dir",
  "shell",
  "project",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "git",
  "editor",
  "rename_symbol",
  "move_symbol",
  "update_plan_step",
  "editor_panel",
  "memory",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
];

export function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}

/** Read-only tools for plan mode (plan tool is provided by buildInteractiveTools) */
export function buildPlanModeTools(
  cwd: string,
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    sessionId?: string;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
  },
) {
  const all = buildTools(cwd, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    fetch_page: all.fetch_page,
    editor: all.editor,
    navigate: all.navigate,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    test_scaffold: all.test_scaffold,
    memory: all.memory,
    ...(all.soul_grep ? { soul_grep: all.soul_grep } : {}),
    ...(all.soul_find ? { soul_find: all.soul_find } : {}),
    ...(all.soul_analyze ? { soul_analyze: all.soul_analyze } : {}),
    ...(all.soul_impact ? { soul_impact: all.soul_impact } : {}),
  };
}

/** Full code tools for code subagent */
export function buildCodeTools(
  cwd?: string,
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    codeExecution?: boolean;
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
  },
) {
  return buildTools(cwd, editorSettings, onApproveWebSearch, opts);
}

const SUBAGENT_MAX_LINES = 750;
const SUBAGENT_MAX_OUTPUT_BYTES = 8192;

function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= SUBAGENT_MAX_LINES) return output;
  return `${lines.slice(0, SUBAGENT_MAX_LINES).join("\n")}\n\n... [truncated: ${String(lines.length)} lines total. Use startLine/endLine for specific sections.]`;
}

function truncateBytes(output: string): string {
  if (output.length <= SUBAGENT_MAX_OUTPUT_BYTES) return output;
  return `${output.slice(0, SUBAGENT_MAX_OUTPUT_BYTES)}\n\n... [truncated: output exceeded limit. Narrow with glob or path params.]`;
}

/** Lean read-only tools for explore subagents — no editor, memory, git.
 *  When webSearchModel is provided, includes an agent-powered web_search tool. */
export function buildSubagentExploreTools(opts?: {
  webSearchModel?: import("ai").LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: RepoMap;
}) {
  const subagentCwd = process.cwd();
  return {
    read_file: tool({
      description: `${readFileTool.description} Output capped at 750 lines.`,
      inputSchema: z.object({
        path: z.string().describe("File path to read"),
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
        target: z
          .enum(["function", "class", "type", "interface", "variable", "enum", "scope"])
          .optional()
          .describe("Symbol type to extract (AST-based). Omit for raw file read."),
        name: z
          .string()
          .optional()
          .describe("Symbol name (required when target is set, except scope)"),
      }),
      execute: deferExecute(async (args) => {
        const result = await readFileTool.execute(args);
        if (!result.success) return result;
        if (args.target || result.outlineOnly) return result;
        return { ...result, output: truncateLines(result.output) };
      }),
    }),

    grep: tool({
      description: grepTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Regex search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = tryInterceptGrep(args, opts?.repoMap, subagentCwd);
          if (hit) return hit;
        }
        const result = await grepTool.execute({ ...args, maxCount: 10 });
        if (!result.success) return result;
        return { ...result, output: truncateBytes(result.output) };
      }),
    }),

    glob: tool({
      description: globTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern"),
        path: z.string().optional().describe("Base directory"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute((args) => {
        if (!args.force) {
          const hit = tryInterceptGlob(args, opts?.repoMap, subagentCwd);
          if (hit) return Promise.resolve(hit);
        }
        return globTool.execute(args);
      }),
    }),

    navigate: tool({
      description: navigateTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "definition",
            "references",
            "symbols",
            "imports",
            "exports",
            "workspace_symbols",
            "call_hierarchy",
            "implementation",
            "type_hierarchy",
            "search_symbols",
          ])
          .describe("Navigation action"),
        symbol: z.string().optional().describe("Symbol name to look up"),
        file: z.string().optional().describe("File path to analyze"),
        scope: z.string().optional().describe("Filter symbols by name pattern"),
        query: z.string().optional().describe("Search query for workspace_symbols/search_symbols"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute((args) => {
        if (!args.force) {
          const hit = tryInterceptNavigate(args, opts?.repoMap, subagentCwd);
          if (hit) return Promise.resolve(hit);
        }
        return navigateTool.execute(args, opts?.repoMap);
      }),
    }),

    analyze: tool({
      description: analyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum(["diagnostics", "type_info", "outline", "code_actions", "unused", "symbol_diff"])
          .describe("Analysis action"),
        file: z.string().optional().describe("File path to analyze"),
        symbol: z.string().optional().describe("Symbol for type_info"),
        line: z.number().optional().describe("Line number for type_info"),
        column: z.number().optional().describe("Column number for type_info"),
        startLine: z.number().optional().describe("Start line for code_actions range"),
        endLine: z.number().optional().describe("End line for code_actions range"),
        oldContent: z
          .string()
          .optional()
          .describe("Old file content for symbol_diff (or uses git HEAD)"),
      }),
      execute: deferExecute((args) => analyzeTool.execute(args)),
    }),

    discover_pattern: tool({
      description: discoverPatternTool.description,
      inputSchema: z.object({
        query: z.string().describe("Concept to discover (e.g. 'provider', 'router', 'auth')"),
        file: z.string().optional().describe("File to scope the search to"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute((args) => {
        if (!args.force) {
          const hit = tryInterceptDiscoverPattern(args, opts?.repoMap, subagentCwd);
          if (hit) return Promise.resolve(hit);
        }
        return discoverPatternTool.execute(args);
      }),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: opts?.onApproveWebSearch,
      onApproveFetchPage: opts?.onApproveFetchPage,
    }),

    fetch_page: tool({
      description: fetchPageTool.description,
      inputSchema: z.object({
        url: z.string().describe("URL to fetch and read"),
      }),
      execute: deferExecute(async (args) => {
        if (opts?.onApproveFetchPage) {
          const approved = await opts.onApproveFetchPage(args.url);
          if (!approved) {
            return {
              success: false,
              output: "Page fetch was denied by the user.",
              error: "Fetch denied.",
            };
          }
        }
        return fetchPageTool.execute(args);
      }),
    }),

    task_list: tool({
      description: taskListTool.description,
      inputSchema: z.object({
        action: z.enum(["add", "update", "remove", "list", "clear"]).describe("Task action"),
        title: z.string().optional().describe("Single task title (for add/update)"),
        titles: z.array(z.string()).optional().describe("Batch add — multiple task titles at once"),
        id: z.number().optional().describe("Task ID (for update/remove)"),
        status: z
          .enum(["pending", "in-progress", "done", "blocked"])
          .optional()
          .describe("Task status (for add/update)"),
      }),
      execute: deferExecute((args) => taskListTool.execute(args)),
    }),

    list_dir: tool({
      description: listDirTool.description,
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path (defaults to cwd)"),
      }),
      execute: deferExecute((args) => listDirTool.execute(args, opts?.repoMap)),
    }),

    ...(opts?.repoMap
      ? {
          soul_grep: tool({
            description: soulGrepTool.description,
            inputSchema: z.object({
              pattern: z.string().describe("Search pattern"),
              path: z.string().optional().describe("Directory to search"),
              count: z.boolean().optional().describe("Count mode — returns match counts per file"),
              wordBoundary: z.boolean().optional().describe("Match whole words only"),
            }),
            execute: deferExecute((args) => {
              const exec = soulGrepTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_find: tool({
            description: soulFindTool.description,
            inputSchema: z.object({
              query: z.string().describe("Fuzzy search query"),
              type: z.string().optional().describe("File type filter"),
              limit: z.number().optional().describe("Max results (default 20)"),
            }),
            execute: deferExecute((args) => {
              const exec = soulFindTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_analyze: tool({
            description: soulAnalyzeTool.description,
            inputSchema: z.object({
              action: z
                .enum([
                  "identifier_frequency",
                  "unused_exports",
                  "file_profile",
                  "duplication",
                  "top_files",
                  "packages",
                  "symbols_by_kind",
                ])
                .describe("Analysis action"),
              file: z.string().optional().describe("File path (for file_profile)"),
              name: z.string().optional().describe("Identifier/package name"),
              kind: z.string().optional().describe("Symbol kind (for symbols_by_kind)"),
              limit: z.number().optional().describe("Max results"),
            }),
            execute: deferExecute((args) => {
              const exec = soulAnalyzeTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_impact: tool({
            description: soulImpactTool.description,
            inputSchema: z.object({
              action: z
                .enum(["dependents", "dependencies", "cochanges", "blast_radius"])
                .describe("Impact action"),
              file: z.string().describe("File path to analyze"),
              limit: z.number().optional().describe("Max results"),
            }),
            execute: deferExecute((args) => {
              const exec = soulImpactTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
        }
      : {}),

    project: tool({
      description: `${projectTool.description} Read-only actions only: test, build, lint, typecheck.`,
      inputSchema: z.object({
        action: z.enum(["test", "build", "lint", "typecheck"]).describe("Read-only project action"),
        file: z.string().optional().describe("Target file or directory"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
      execute: deferExecute((args) =>
        projectTool.execute(args as Parameters<typeof projectTool.execute>[0]),
      ),
    }),
  };
}

/** Lean tools for code subagents — explore tools + edit_file, shell */
export function buildSubagentCodeTools(opts?: {
  webSearchModel?: import("ai").LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: RepoMap;
}) {
  return {
    ...buildSubagentExploreTools(opts),

    edit_file: tool({
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Exact string to replace (empty = create new file)"),
        newString: z.string().describe("Replacement string"),
        lineStart: z
          .number()
          .optional()
          .describe(
            "1-indexed line hint from your last read — helps locate the match and shows context on error",
          ),
      }),
      execute: deferExecute((args) => editFileTool.execute(args)),
    }),

    multi_edit: tool({
      description: multiEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("Exact string to replace"),
              newString: z.string().describe("Replacement string"),
              lineStart: z.number().optional().describe("Line hint (1-indexed)"),
            }),
          )
          .describe("Array of edits to apply atomically"),
      }),
      execute: deferExecute((args) => multiEditTool.execute(args)),
    }),

    rename_symbol: tool({
      description: renameSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Current name of the symbol to rename"),
        newName: z.string().describe("New name for the symbol"),
        file: z.string().optional().describe("File where the symbol is defined (optional)"),
      }),
      execute: deferExecute((args) => renameSymbolTool.execute(args)),
    }),

    move_symbol: tool({
      description: moveSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Name of the symbol to move"),
        from: z.string().describe("Source file path"),
        to: z.string().describe("Target file path"),
      }),
      execute: deferExecute((args) => moveSymbolTool.execute(args)),
    }),

    shell: tool({
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
      execute: async (args, { abortSignal }) => {
        await new Promise<void>((r) => setTimeout(r, 0));
        const result = await shellTool.execute(args, abortSignal);
        if (result.success && opts?.repoMap?.isReady) {
          opts.repoMap.recheckModifiedFiles();
        }
        if (!result.success) return result;
        return { ...result, output: truncateBytes(result.output) };
      },
    }),
  };
}

/** Get tool names for display */
export function getToolNames(): string[] {
  return [
    readFileTool.name,
    editFileTool.name,
    shellTool.name,
    grepTool.name,
    globTool.name,
    "web_search",
    "memory",
    navigateTool.name,
    renameSymbolTool.name,
    moveSymbolTool.name,
    refactorTool.name,
    analyzeTool.name,
    discoverPatternTool.name,
    testScaffoldTool.name,
    editorTool.name,
    gitTool.name,
  ];
}

interface WrappableTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (args: never, opts: never) => unknown;
}

export function wrapWithBusCache(
  tools: Record<string, WrappableTool>,
  bus: AgentBus,
  agentId: string,
  repoMap?: RepoMap,
): Record<string, WrappableTool> {
  const wrapped = { ...tools };

  const CACHE_HIT_LINES_THRESHOLD = 80;

  function tagCacheHit(result: unknown, path: string): unknown {
    const text =
      typeof result === "string"
        ? result
        : String((result as Record<string, unknown>)?.output ?? "");
    const lineCount = text.split("\n").length;
    if (lineCount < CACHE_HIT_LINES_THRESHOLD) return result;

    let symbols: Array<{ name: string; kind: string; line: number }> = [];
    if (repoMap) {
      try {
        symbols = repoMap.getFileSymbolRanges(path);
      } catch {}
    }

    if (symbols.length === 0) {
      const tag = "[Cached]";
      if (typeof result === "string") return `${tag}\n${result}`;
      if (result && typeof result === "object" && "output" in result) {
        return { ...(result as Record<string, unknown>), output: `${tag}\n${text}` };
      }
      return result;
    }

    const top = symbols.slice(0, 12);
    const symbolHint = `Exported symbols: ${top.map((s) => `${s.name} (${s.kind}, line ${String(s.line)})`).join(", ")}${symbols.length > 12 ? `, +${String(symbols.length - 12)} more` : ""}`;

    const stub = [
      `[Cached — ${String(lineCount)} lines, already read by another agent]`,
      symbolHint,
      `Use read_code(target, name, "${path}") for specific symbols, or read_file with startLine/endLine for a range.`,
      `Use check_findings to see what peer agents found in this file.`,
    ].join("\n");

    if (result && typeof result === "object") {
      return { ...(result as Record<string, unknown>), output: stub };
    }
    return { success: true, output: stub };
  }

  function makeCachedExecute(
    origExecute: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
    keyFn: (args: Record<string, unknown>) => string | null,
    onExecute?: (args: Record<string, unknown>, cached: boolean) => void,
  ): WrappableTool["execute"] {
    return (async (args: Record<string, unknown>, opts: unknown) => {
      const key = keyFn(args);
      if (key) {
        const acquired = bus.acquireToolResult(agentId, key);
        if (acquired.hit === true) {
          onExecute?.(args, true);
          return acquired.result;
        }
        if (acquired.hit === "waiting") {
          const waited = await acquired.result;
          if (waited != null) {
            onExecute?.(args, true);
            return waited;
          }
        }
      }
      const result = await origExecute(args, opts);
      if (key) {
        const content =
          typeof result === "string"
            ? result
            : typeof (result as Record<string, unknown>)?.output === "string"
              ? String((result as Record<string, unknown>).output)
              : JSON.stringify(result);
        bus.cacheToolResult(agentId, key, content);
      }
      onExecute?.(args, false);
      return result;
    }) as WrappableTool["execute"];
  }

  const readFile = tools.read_file;
  if (readFile?.execute) {
    const origExecute = readFile.execute as (
      args: { path: string; startLine?: number; endLine?: number },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.read_file = {
      ...readFile,
      execute: (async (
        args: { path: string; startLine?: number; endLine?: number },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);

        if (args.startLine != null || args.endLine != null) {
          const result = await origExecute(args, opts);
          bus.recordFileRead(agentId, normalized, {
            tool: "read_file",
            startLine: args.startLine,
            endLine: args.endLine,
            cached: false,
          });
          return result;
        }

        const acquired = bus.acquireFileRead(agentId, normalized);

        if (acquired.cached === true) {
          const cached = acquired.content ?? (await origExecute(args, opts));
          bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
          return tagCacheHit(cached, normalized);
        }

        if (acquired.cached === "waiting") {
          const content = await acquired.content;
          if (content != null) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
            return tagCacheHit(content, normalized);
          }
          const reAcquired = bus.acquireFileRead(agentId, normalized);
          if (reAcquired.cached === true && reAcquired.content != null) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: true });
            return tagCacheHit(reAcquired.content, normalized);
          }
          const fallbackGen = reAcquired.cached === false ? reAcquired.gen : -1;
          const result = await origExecute(args, opts);
          const isOutline =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).outlineOnly === true;
          if (!isOutline && fallbackGen >= 0) {
            const rawText =
              typeof result === "string"
                ? result
                : typeof (result as Record<string, unknown>)?.output === "string"
                  ? String((result as Record<string, unknown>).output)
                  : JSON.stringify(result);
            bus.releaseFileRead(normalized, rawText, fallbackGen);
          } else if (isOutline && fallbackGen >= 0) {
            bus.failFileRead(normalized, fallbackGen);
          }
          if (!isOutline) {
            bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: false });
          }
          return result;
        }

        const { gen } = acquired;
        try {
          const result = await origExecute(args, opts);
          const isOutline =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).outlineOnly === true;
          if (isOutline) {
            bus.failFileRead(normalized, gen);
            return result;
          }
          const rawText =
            typeof result === "string"
              ? result
              : typeof (result as Record<string, unknown>)?.output === "string"
                ? String((result as Record<string, unknown>).output)
                : JSON.stringify(result);
          bus.releaseFileRead(normalized, rawText, gen);
          bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: false });
          return result;
        } catch (error) {
          bus.failFileRead(normalized, gen);
          throw error;
        }
      }) as WrappableTool["execute"],
    };
  }

  const editFile = tools.edit_file;
  if (editFile?.execute) {
    const origEdit = editFile.execute as (
      args: { path: string; oldString: string; newString: string },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.edit_file = {
      ...editFile,
      execute: (async (
        args: { path: string; oldString: string; newString: string },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            try {
              const fresh = readFileSync(resolve(normalized), "utf-8");
              bus.updateFile(normalized, fresh, agentId);
            } catch {
              bus.invalidateFile(normalized);
            }
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your edit succeeded (different region). Verify with read_file if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edit.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    };
  }

  // Wrap multi_edit with the same bus coordination as edit_file
  const multiEdit = tools.multi_edit;
  if (multiEdit?.execute) {
    const origMultiEdit = multiEdit.execute as (
      args: {
        path: string;
        edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
      },
      opts?: unknown,
    ) => Promise<unknown>;

    wrapped.multi_edit = {
      ...multiEdit,
      execute: (async (
        args: {
          path: string;
          edits: Array<{ oldString: string; newString: string; lineStart?: number }>;
        },
        opts: unknown,
      ) => {
        const normalized = normalizePath(args.path);
        const { release, owner } = await bus.acquireEditLock(agentId, normalized);
        try {
          const result = await origMultiEdit(args, opts);
          const isOk =
            result &&
            typeof result === "object" &&
            (result as Record<string, unknown>).success === true;
          if (isOk) {
            try {
              const fresh = readFileSync(resolve(normalized), "utf-8");
              bus.updateFile(normalized, fresh, agentId);
            } catch {
              bus.invalidateFile(normalized);
            }
          } else {
            bus.invalidateFile(normalized);
          }
          bus.recordFileEdit(agentId, normalized);

          if (owner && owner !== agentId && isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Note: ${owner} also edited ${normalized}. Your multi_edit succeeded (different region). Verify with read_file if needed.\n\n${text}`;
          }
          if (owner && owner !== agentId && !isOk) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            return `⚠ Multi-edit failed — ${owner} modified ${normalized} before you. Re-read the file to see current content and adapt your edits.\n\n${text}`;
          }
          return result;
        } finally {
          release();
        }
      }) as WrappableTool["execute"],
    };
  }

  const NAVIGATE_CACHEABLE = new Set([
    "definition",
    "references",
    "symbols",
    "imports",
    "exports",
    "workspace_symbols",
    "call_hierarchy",
    "implementation",
    "type_hierarchy",
    "search_symbols",
  ]);
  const ANALYZE_CACHEABLE = new Set(["diagnostics", "outline", "type_info"]);

  const cacheSpecs: Array<{
    name: string;
    keyFn: (args: Record<string, unknown>) => string | null;
    onExecute?: (args: Record<string, unknown>, cached: boolean) => void;
  }> = [
    {
      name: "grep",
      keyFn: (a) =>
        JSON.stringify([
          "grep",
          String(a.pattern ?? ""),
          normalizePath(String(a.path ?? ".")),
          String(a.glob ?? ""),
        ]),
    },
    {
      name: "glob",
      keyFn: (a) =>
        JSON.stringify(["glob", String(a.pattern ?? ""), normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "navigate",
      keyFn: (a) => {
        if (!NAVIGATE_CACHEABLE.has(String(a.action ?? ""))) return null;
        return JSON.stringify([
          "navigate",
          String(a.action),
          normalizePath(String(a.file ?? "")),
          String(a.symbol ?? ""),
        ]);
      },
    },
    {
      name: "analyze",
      keyFn: (a) => {
        const action = String(a.action ?? "");
        if (!ANALYZE_CACHEABLE.has(action) || !a.file) return null;
        return JSON.stringify(["analyze", action, normalizePath(String(a.file))]);
      },
    },
    {
      name: "web_search",
      keyFn: (a) => JSON.stringify(["web_search", String(a.query ?? "")]),
    },
    {
      name: "list_dir",
      keyFn: (a) => JSON.stringify(["list_dir", normalizePath(String(a.path ?? "."))]),
    },
    {
      name: "soul_grep",
      keyFn: (a) =>
        JSON.stringify([
          "soul_grep",
          String(a.pattern ?? ""),
          String(a.path ?? "."),
          String(a.count ?? ""),
          String(a.wordBoundary ?? ""),
        ]),
    },
    {
      name: "soul_find",
      keyFn: (a) => JSON.stringify(["soul_find", String(a.query ?? ""), String(a.type ?? "")]),
    },
    {
      name: "soul_analyze",
      keyFn: (a) =>
        JSON.stringify([
          "soul_analyze",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
    {
      name: "soul_impact",
      keyFn: (a) =>
        JSON.stringify([
          "soul_impact",
          String(a.action ?? ""),
          normalizePath(String(a.file ?? "")),
        ]),
    },
  ];

  for (const spec of cacheSpecs) {
    const t = tools[spec.name];
    if (t?.execute) {
      wrapped[spec.name] = {
        ...t,
        execute: makeCachedExecute(
          t.execute as (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>,
          spec.keyFn,
          spec.onExecute,
        ),
      };
    }
  }

  return wrapped;
}
