import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import type { EditorIntegration } from "../../types/index.js";
import { type AgentBus, normalizePath } from "../agents/agent-bus.js";
import type { RepoMap } from "../intelligence/repo-map.js";
import { MemoryManager } from "../memory/manager.js";
import { analyzeTool } from "./analyze.js";
import { discoverPatternTool } from "./discover-pattern.js";
import { editFileTool } from "./edit-file";
import {
  editorActionsTool,
  editorDefinitionTool,
  editorDiagnosticsTool,
  editorEditTool,
  editorFormatTool,
  editorHoverTool,
  editorLspStatusTool,
  editorNavigateTool,
  editorReadTool,
  editorReferencesTool,
  editorRenameTool,
  editorSymbolsTool,
} from "./editor";
import {
  gitBranchTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPullTool,
  gitPushTool,
  gitStashTool,
  gitStatusTool,
} from "./git.js";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { createMemoryTools } from "./memory.js";
import { moveSymbolTool } from "./move-symbol.js";
import { navigateTool } from "./navigate.js";
import { projectTool } from "./project.js";
import { readCodeTool } from "./read-code.js";
import { readFileTool } from "./read-file";
import { refactorTool } from "./refactor.js";
import { renameSymbolTool } from "./rename-symbol.js";
import { tryInterceptGrep, tryInterceptNavigate } from "./repo-map-intercept.js";
import { shellTool } from "./shell";
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
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    codeExecution?: boolean;
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    repoMap?: RepoMap;
  },
) {
  const effectiveCwd = cwd ?? process.cwd();
  const mm = opts?.memoryManager ?? new MemoryManager(effectiveCwd);
  const memoryTools = createMemoryTools(mm);
  const ei = editorSettings ?? {
    diagnostics: true,
    symbols: true,
    hover: true,
    references: true,
    definition: true,
    codeActions: true,
    editorContext: true,
    rename: true,
    lspStatus: true,
    format: true,
  };

  return {
    read_file: tool({
      description: readFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to read"),
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
      }),
      execute: deferExecute((args) => readFileTool.execute(args)),
    }),

    edit_file: tool({
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Exact string to replace (empty = create new file)"),
        newString: z.string().describe("Replacement string"),
      }),
      execute: deferExecute((args) => editFileTool.execute(args)),
    }),

    shell: tool({
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
      execute: deferExecute((args) => shellTool.execute(args)),
    }),

    grep: tool({
      description: grepTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Regex search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter"),
      }),
      execute: deferExecute((args) => {
        const hit = tryInterceptGrep(args, opts?.repoMap, effectiveCwd);
        if (hit) return Promise.resolve(hit);
        return grepTool.execute(args);
      }),
    }),

    glob: tool({
      description: globTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern"),
        path: z.string().optional().describe("Base directory"),
      }),
      execute: deferExecute((args) => globTool.execute(args)),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: onApproveWebSearch,
    }),

    ...memoryTools,

    editor_read: tool({
      description: editorReadTool.description,
      inputSchema: z.object({
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
      }),
      execute: deferExecute((args) => editorReadTool.execute(args)),
    }),

    editor_edit: tool({
      description: editorEditTool.description,
      inputSchema: z.object({
        startLine: z.number().describe("First line to replace (1-indexed, inclusive)"),
        endLine: z.number().describe("Last line to replace (1-indexed, inclusive)"),
        replacement: z
          .string()
          .describe("New content to replace those lines with — only the new text, not the old"),
      }),
      execute: deferExecute((args) => editorEditTool.execute(args)),
    }),

    editor_navigate: tool({
      description: editorNavigateTool.description,
      inputSchema: z.object({
        file: z.string().optional().describe("File path to open"),
        line: z.number().optional().describe("Line number to jump to"),
        col: z.number().optional().describe("Column number"),
        search: z.string().optional().describe("Search pattern"),
      }),
      execute: deferExecute((args) => editorNavigateTool.execute(args)),
    }),

    ...(ei.diagnostics
      ? {
          editor_diagnostics: tool({
            description: editorDiagnosticsTool.description,
            inputSchema: z.object({}),
            execute: deferExecute(() => editorDiagnosticsTool.execute()),
          }),
        }
      : {}),

    ...(ei.symbols
      ? {
          editor_symbols: tool({
            description: editorSymbolsTool.description,
            inputSchema: z.object({}),
            execute: deferExecute(() => editorSymbolsTool.execute()),
          }),
        }
      : {}),

    ...(ei.hover
      ? {
          editor_hover: tool({
            description: editorHoverTool.description,
            inputSchema: z.object({
              line: z.number().optional().describe("Line number (1-indexed, defaults to cursor)"),
              col: z.number().optional().describe("Column number (1-indexed, defaults to cursor)"),
            }),
            execute: deferExecute((args) => editorHoverTool.execute(args)),
          }),
        }
      : {}),

    ...(ei.references
      ? {
          editor_references: tool({
            description: editorReferencesTool.description,
            inputSchema: z.object({
              line: z.number().optional().describe("Line number (1-indexed, defaults to cursor)"),
              col: z.number().optional().describe("Column number (1-indexed, defaults to cursor)"),
            }),
            execute: deferExecute((args) => editorReferencesTool.execute(args)),
          }),
        }
      : {}),

    ...(ei.definition
      ? {
          editor_definition: tool({
            description: editorDefinitionTool.description,
            inputSchema: z.object({
              line: z.number().optional().describe("Line number (1-indexed, defaults to cursor)"),
              col: z.number().optional().describe("Column number (1-indexed, defaults to cursor)"),
              jump: z
                .boolean()
                .optional()
                .describe("Jump editor to first definition (default true)"),
            }),
            execute: deferExecute((args) => editorDefinitionTool.execute(args)),
          }),
        }
      : {}),

    ...(ei.codeActions
      ? {
          editor_actions: tool({
            description: editorActionsTool.description,
            inputSchema: z.object({
              line: z.number().optional().describe("Line number (1-indexed, defaults to cursor)"),
              col: z.number().optional().describe("Column number (1-indexed, defaults to cursor)"),
              apply: z.number().optional().describe("0-indexed action to apply"),
            }),
            execute: deferExecute((args) => editorActionsTool.execute(args)),
          }),
        }
      : {}),

    ...(ei.rename
      ? {
          editor_rename: tool({
            description: editorRenameTool.description,
            inputSchema: z.object({
              newName: z.string().describe("The new name for the symbol"),
              line: z.number().optional().describe("Line number (1-indexed, defaults to cursor)"),
              col: z.number().optional().describe("Column number (1-indexed, defaults to cursor)"),
            }),
            execute: deferExecute((args) => editorRenameTool.execute(args)),
          }),
        }
      : {}),

    ...(ei.lspStatus
      ? {
          editor_lsp_status: tool({
            description: editorLspStatusTool.description,
            inputSchema: z.object({}),
            execute: deferExecute(() => editorLspStatusTool.execute()),
          }),
        }
      : {}),

    ...(ei.format
      ? {
          editor_format: tool({
            description: editorFormatTool.description,
            inputSchema: z.object({
              startLine: z
                .number()
                .optional()
                .describe("Start line for range formatting (1-indexed)"),
              endLine: z.number().optional().describe("End line for range formatting (1-indexed)"),
            }),
            execute: deferExecute((args) => editorFormatTool.execute(args)),
          }),
        }
      : {}),

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
      }),
      execute: deferExecute((args) => {
        const hit = tryInterceptNavigate(args, opts?.repoMap, effectiveCwd);
        if (hit) return Promise.resolve(hit);
        return navigateTool.execute(args, opts?.repoMap);
      }),
    }),

    read_code: tool({
      description: readCodeTool.description,
      inputSchema: z.object({
        target: z
          .enum(["function", "class", "type", "interface", "variable", "enum", "scope"])
          .describe("What to read"),
        name: z.string().optional().describe("Symbol name (required unless target is scope)"),
        file: z.string().describe("File path"),
        startLine: z.number().optional().describe("Start line for scope target"),
        endLine: z.number().optional().describe("End line for scope target"),
      }),
      execute: deferExecute((args) => readCodeTool.execute(args)),
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
      execute: deferExecute((args) => renameSymbolTool.execute(args)),
    }),

    move_symbol: tool({
      description: moveSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Name of the symbol to move"),
        from: z.string().describe("Source file path"),
        to: z.string().describe("Target file path (created if it doesn't exist)"),
      }),
      execute: deferExecute((args) => moveSymbolTool.execute(args)),
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
        apply: z.boolean().optional().describe("Apply changes to disk (default true)"),
      }),
      execute: deferExecute((args) => refactorTool.execute(args)),
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
      }),
      execute: deferExecute((args) => discoverPatternTool.execute(args)),
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
        action: z.enum(["test", "build", "lint", "typecheck", "run"]).describe("Project action"),
        file: z.string().optional().describe("Target file (for test/lint)"),
        fix: z.boolean().optional().describe("Auto-fix lint issues"),
        script: z.string().optional().describe("Named script to run (for run action)"),
        flags: z
          .string()
          .optional()
          .describe(
            "Extra flags appended to the command (e.g. '--features async', '-k test_name')",
          ),
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

    git_status: tool({
      description: gitStatusTool.description,
      inputSchema: z.object({}),
      execute: deferExecute(() => gitStatusTool.execute()),
    }),

    git_diff: tool({
      description: gitDiffTool.description,
      inputSchema: z.object({
        staged: z.boolean().optional().describe("Show staged changes instead of unstaged"),
      }),
      execute: deferExecute((args) => gitDiffTool.execute(args)),
    }),

    git_log: tool({
      description: gitLogTool.description,
      inputSchema: z.object({
        count: z.number().optional().describe("Number of commits to show (default 10)"),
      }),
      execute: deferExecute((args) => gitLogTool.execute(args)),
    }),

    git_commit: tool({
      description: gitCommitTool.description,
      inputSchema: z.object({
        message: z.string().describe("Commit message"),
        files: z.array(z.string()).optional().describe("Files to stage before committing"),
      }),
      execute: deferExecute((args) => gitCommitTool.execute(args)),
    }),

    git_push: tool({
      description: gitPushTool.description,
      inputSchema: z.object({}),
      execute: deferExecute(() => gitPushTool.execute()),
    }),

    git_pull: tool({
      description: gitPullTool.description,
      inputSchema: z.object({}),
      execute: deferExecute(() => gitPullTool.execute()),
    }),

    git_stash: tool({
      description: gitStashTool.description,
      inputSchema: z.object({
        action: z
          .enum(["push", "pop", "list", "show", "drop"])
          .optional()
          .describe("Stash action (default: push)"),
        message: z.string().optional().describe("Stash message (for push)"),
        index: z.number().optional().describe("Stash index (for show/drop, default 0)"),
      }),
      execute: deferExecute((args) => gitStashTool.execute(args)),
    }),

    git_branch: tool({
      description: gitBranchTool.description,
      inputSchema: z.object({
        action: z
          .enum(["list", "create", "switch", "delete"])
          .optional()
          .describe("Branch action (default: list)"),
        name: z.string().optional().describe("Branch name (for create/switch/delete)"),
      }),
      execute: deferExecute((args) => gitBranchTool.execute(args)),
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
  "web_search",
  "editor_read",
  "editor_navigate",
  "editor_diagnostics",
  "editor_symbols",
  "editor_hover",
  "editor_references",
  "editor_definition",
  "editor_lsp_status",
  "navigate",
  "read_code",
  "analyze",
  "discover_pattern",
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_search",
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
  },
) {
  const all = buildTools(undefined, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    editor_read: all.editor_read,
    editor_navigate: all.editor_navigate,
    ...(all.editor_diagnostics ? { editor_diagnostics: all.editor_diagnostics } : {}),
    ...(all.editor_symbols ? { editor_symbols: all.editor_symbols } : {}),
    ...(all.editor_hover ? { editor_hover: all.editor_hover } : {}),
    ...(all.editor_references ? { editor_references: all.editor_references } : {}),
    ...(all.editor_definition ? { editor_definition: all.editor_definition } : {}),
    ...(all.editor_lsp_status ? { editor_lsp_status: all.editor_lsp_status } : {}),
    navigate: all.navigate,
    read_code: all.read_code,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    memory_read: all.memory_read,
    memory_write: all.memory_write,
    memory_list: all.memory_list,
    memory_search: all.memory_search,
  };
}

/** Read-only tools for explore subagent */
export function buildReadOnlyTools(
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: { memoryManager?: MemoryManager; webSearchModel?: import("ai").LanguageModel },
) {
  const all = buildTools(undefined, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    editor_read: all.editor_read,
    ...(all.editor_diagnostics ? { editor_diagnostics: all.editor_diagnostics } : {}),
    ...(all.editor_symbols ? { editor_symbols: all.editor_symbols } : {}),
    ...(all.editor_hover ? { editor_hover: all.editor_hover } : {}),
    ...(all.editor_references ? { editor_references: all.editor_references } : {}),
    ...(all.editor_definition ? { editor_definition: all.editor_definition } : {}),
    ...(all.editor_lsp_status ? { editor_lsp_status: all.editor_lsp_status } : {}),
    navigate: all.navigate,
    read_code: all.read_code,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    memory_read: all.memory_read,
    memory_list: all.memory_list,
    memory_search: all.memory_search,
  };
}

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
  },
) {
  const all = buildTools(cwd, editorSettings, onApproveWebSearch, opts);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    editor_read: all.editor_read,
    editor_navigate: all.editor_navigate,
    ...(all.editor_diagnostics ? { editor_diagnostics: all.editor_diagnostics } : {}),
    ...(all.editor_symbols ? { editor_symbols: all.editor_symbols } : {}),
    ...(all.editor_hover ? { editor_hover: all.editor_hover } : {}),
    ...(all.editor_references ? { editor_references: all.editor_references } : {}),
    ...(all.editor_definition ? { editor_definition: all.editor_definition } : {}),
    ...(all.editor_lsp_status ? { editor_lsp_status: all.editor_lsp_status } : {}),
    navigate: all.navigate,
    read_code: all.read_code,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    test_scaffold: all.test_scaffold,
    memory_read: all.memory_read,
    memory_list: all.memory_list,
    memory_search: all.memory_search,
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
  },
) {
  return buildTools(cwd, editorSettings, onApproveWebSearch, opts);
}

const SUBAGENT_MAX_LINES = 300;
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
  repoMap?: RepoMap;
}) {
  const subagentCwd = process.cwd();
  return {
    read_file: tool({
      description: `${readFileTool.description} Capped at 300 lines — use startLine/endLine for large files.`,
      inputSchema: z.object({
        path: z.string().describe("File path to read"),
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
      }),
      execute: deferExecute(async (args) => {
        const result = await readFileTool.execute(args);
        if (!result.success) return result;
        return { ...result, output: truncateLines(result.output) };
      }),
    }),

    grep: tool({
      description: grepTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Regex search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter"),
      }),
      execute: deferExecute(async (args) => {
        const hit = tryInterceptGrep(args, opts?.repoMap, subagentCwd);
        if (hit) return hit;
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
      }),
      execute: deferExecute((args) => globTool.execute(args)),
    }),

    read_code: tool({
      description: readCodeTool.description,
      inputSchema: z.object({
        target: z
          .enum(["function", "class", "type", "interface", "variable", "enum", "scope"])
          .describe("What to read"),
        name: z.string().optional().describe("Symbol name (required unless target is scope)"),
        file: z.string().describe("File path"),
        startLine: z.number().optional().describe("Start line for scope target"),
        endLine: z.number().optional().describe("End line for scope target"),
      }),
      execute: deferExecute((args) => readCodeTool.execute(args)),
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
      }),
      execute: deferExecute((args) => {
        const hit = tryInterceptNavigate(args, opts?.repoMap, subagentCwd);
        if (hit) return Promise.resolve(hit);
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
      }),
      execute: deferExecute((args) => discoverPatternTool.execute(args)),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: opts?.onApproveWebSearch,
    }),
  };
}

/** Lean tools for code subagents — explore tools + edit_file, shell */
export function buildSubagentCodeTools(opts?: {
  webSearchModel?: import("ai").LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
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
      }),
      execute: deferExecute((args) => editFileTool.execute(args)),
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
      execute: deferExecute(async (args) => {
        const result = await shellTool.execute(args);
        if (!result.success) return result;
        return { ...result, output: truncateBytes(result.output) };
      }),
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
    "memory_write",
    "memory_read",
    "memory_list",
    "memory_search",
    "memory_delete",
    navigateTool.name,
    readCodeTool.name,
    renameSymbolTool.name,
    moveSymbolTool.name,
    refactorTool.name,
    analyzeTool.name,
    discoverPatternTool.name,
    testScaffoldTool.name,
    editorReadTool.name,
    editorEditTool.name,
    editorNavigateTool.name,
    editorDiagnosticsTool.name,
    editorSymbolsTool.name,
    editorHoverTool.name,
    editorReferencesTool.name,
    editorDefinitionTool.name,
    editorActionsTool.name,
    editorRenameTool.name,
    editorLspStatusTool.name,
    editorFormatTool.name,
    gitStatusTool.name,
    gitDiffTool.name,
    gitLogTool.name,
    gitCommitTool.name,
    gitPushTool.name,
    gitPullTool.name,
    gitStashTool.name,
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
): Record<string, WrappableTool> {
  const wrapped = { ...tools };

  const CACHE_HIT_LINES_THRESHOLD = 80;

  const CONFIG_EXTENSIONS = new Set([
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".css",
    ".scss",
    ".html",
    ".env",
    ".conf",
    ".ini",
    ".cfg",
    ".lock",
  ]);

  function tagCacheHit(result: unknown, path: string): unknown {
    const text =
      typeof result === "string"
        ? result
        : String((result as Record<string, unknown>)?.output ?? "");
    const lineCount = text.split("\n").length;
    if (lineCount < CACHE_HIT_LINES_THRESHOLD) return result;
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    const hint = CONFIG_EXTENSIONS.has(ext)
      ? `[Cached]`
      : `[Cached — use read_code(target, name, "${path}") for specific symbols instead of re-reading.]`;
    if (typeof result === "string") return `${hint}\n${result}`;
    if (result && typeof result === "object" && "output" in result) {
      const r = result as Record<string, unknown>;
      return { ...r, output: `${hint}\n${String(r.output ?? "")}` };
    }
    return result;
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
        const content = typeof result === "string" ? result : JSON.stringify(result);
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
          if (fallbackGen >= 0) {
            const text = typeof result === "string" ? result : JSON.stringify(result);
            bus.releaseFileRead(normalized, text, fallbackGen);
          }
          bus.recordFileRead(agentId, normalized, { tool: "read_file", cached: false });
          return result;
        }

        const { gen } = acquired;
        try {
          const result = await origExecute(args, opts);
          const content = typeof result === "string" ? result : JSON.stringify(result);
          bus.releaseFileRead(normalized, content, gen);
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
      name: "read_code",
      keyFn: (a) => {
        const file = normalizePath(String(a.file ?? ""));
        const target = String(a.target ?? "");
        if (target === "scope") {
          return JSON.stringify(["read_code", file, "scope", a.startLine ?? "", a.endLine ?? ""]);
        }
        return JSON.stringify(["read_code", file, target, a.name ?? ""]);
      },
      onExecute: (a, cached) => {
        bus.recordFileRead(agentId, normalizePath(String(a.file ?? "")), {
          tool: "read_code",
          target: String(a.target ?? ""),
          name: a.name ? String(a.name) : undefined,
          startLine: typeof a.startLine === "number" ? a.startLine : undefined,
          endLine: typeof a.endLine === "number" ? a.endLine : undefined,
          cached,
        });
      },
    },
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
