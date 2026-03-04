import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { EditorIntegration } from "../../types/index.js";
import { analyzeTool } from "./analyze.js";
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
import { createMemoryWriteTool } from "./memory-write";
import { navigateTool } from "./navigate.js";
import { readCodeTool } from "./read-code.js";
import { readFileTool } from "./read-file";
import { refactorTool } from "./refactor.js";
import { shellTool } from "./shell";
import { webSearchTool } from "./web-search";

export { buildInteractiveTools } from "./interactive.js";

/**
 * Build Vercel AI SDK tool definitions.
 * AI SDK v6 uses `inputSchema` instead of `parameters`.
 */
export function buildTools(cwd?: string, editorSettings?: EditorIntegration) {
  const memoryTool = createMemoryWriteTool(cwd ?? process.cwd());
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
      execute: (args) => readFileTool.execute(args),
    }),

    edit_file: tool({
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Exact string to replace (empty = create new file)"),
        newString: z.string().describe("Replacement string"),
      }),
      execute: (args) => editFileTool.execute(args),
    }),

    shell: tool({
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory"),
        timeout: z.number().optional().describe("Timeout in ms"),
      }),
      execute: (args) => shellTool.execute(args),
    }),

    grep: tool({
      description: grepTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Regex search pattern"),
        path: z.string().optional().describe("Directory to search"),
        glob: z.string().optional().describe("File glob filter"),
      }),
      execute: (args) => grepTool.execute(args),
    }),

    glob: tool({
      description: globTool.description,
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern"),
        path: z.string().optional().describe("Base directory"),
      }),
      execute: (args) => globTool.execute(args),
    }),

    web_search: tool({
      description: webSearchTool.description,
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        count: z.number().optional().describe("Number of results (default 5)"),
      }),
      execute: (args) => webSearchTool.execute(args),
    }),

    memory_write: tool({
      description: memoryTool.description,
      inputSchema: z.object({
        summary: z.string().describe("Brief summary of the architectural decision"),
        rationale: z.string().describe("Why this decision was made"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      }),
      execute: (args) => memoryTool.execute(args),
    }),

    editor_read: tool({
      description: editorReadTool.description,
      inputSchema: z.object({
        startLine: z.number().optional().describe("Start line (1-indexed)"),
        endLine: z.number().optional().describe("End line (1-indexed)"),
      }),
      execute: (args) => editorReadTool.execute(args),
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
      execute: (args) => editorEditTool.execute(args),
    }),

    editor_navigate: tool({
      description: editorNavigateTool.description,
      inputSchema: z.object({
        file: z.string().optional().describe("File path to open"),
        line: z.number().optional().describe("Line number to jump to"),
        col: z.number().optional().describe("Column number"),
        search: z.string().optional().describe("Search pattern"),
      }),
      execute: (args) => editorNavigateTool.execute(args),
    }),

    ...(ei.diagnostics
      ? {
          editor_diagnostics: tool({
            description: editorDiagnosticsTool.description,
            inputSchema: z.object({}),
            execute: () => editorDiagnosticsTool.execute(),
          }),
        }
      : {}),

    ...(ei.symbols
      ? {
          editor_symbols: tool({
            description: editorSymbolsTool.description,
            inputSchema: z.object({}),
            execute: () => editorSymbolsTool.execute(),
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
            execute: (args) => editorHoverTool.execute(args),
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
            execute: (args) => editorReferencesTool.execute(args),
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
            execute: (args) => editorDefinitionTool.execute(args),
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
            execute: (args) => editorActionsTool.execute(args),
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
            execute: (args) => editorRenameTool.execute(args),
          }),
        }
      : {}),

    ...(ei.lspStatus
      ? {
          editor_lsp_status: tool({
            description: editorLspStatusTool.description,
            inputSchema: z.object({}),
            execute: () => editorLspStatusTool.execute(),
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
            execute: (args) => editorFormatTool.execute(args),
          }),
        }
      : {}),

    navigate: tool({
      description: navigateTool.description,
      inputSchema: z.object({
        action: z
          .enum(["definition", "references", "symbols", "imports", "exports"])
          .describe("Navigation action"),
        symbol: z.string().optional().describe("Symbol name to look up"),
        file: z.string().optional().describe("File path to analyze"),
        scope: z.string().optional().describe("Filter symbols by name pattern"),
      }),
      execute: (args) => navigateTool.execute(args),
    }),

    read_code: tool({
      description: readCodeTool.description,
      inputSchema: z.object({
        target: z
          .enum(["function", "class", "type", "interface", "scope"])
          .describe("What to read"),
        name: z.string().optional().describe("Symbol name (required unless target is scope)"),
        file: z.string().describe("File path"),
        startLine: z.number().optional().describe("Start line for scope target"),
        endLine: z.number().optional().describe("End line for scope target"),
      }),
      execute: (args) => readCodeTool.execute(args),
    }),

    refactor: tool({
      description: refactorTool.description,
      inputSchema: z.object({
        action: z
          .enum(["rename", "extract_function", "extract_variable"])
          .describe("Refactoring action"),
        file: z.string().optional().describe("File path"),
        symbol: z.string().optional().describe("Symbol to rename"),
        newName: z.string().optional().describe("New name for rename or extracted symbol"),
        startLine: z.number().optional().describe("Start line for extraction"),
        endLine: z.number().optional().describe("End line for extraction"),
        apply: z.boolean().optional().describe("Apply changes to disk (default true)"),
      }),
      execute: (args) => refactorTool.execute(args),
    }),

    analyze: tool({
      description: analyzeTool.description,
      inputSchema: z.object({
        action: z.enum(["diagnostics", "type_info", "outline"]).describe("Analysis action"),
        file: z.string().optional().describe("File path to analyze"),
        symbol: z.string().optional().describe("Symbol for type_info"),
        line: z.number().optional().describe("Line number for type_info"),
        column: z.number().optional().describe("Column number for type_info"),
      }),
      execute: (args) => analyzeTool.execute(args),
    }),

    git_status: tool({
      description: gitStatusTool.description,
      inputSchema: z.object({}),
      execute: () => gitStatusTool.execute(),
    }),

    git_diff: tool({
      description: gitDiffTool.description,
      inputSchema: z.object({
        staged: z.boolean().optional().describe("Show staged changes instead of unstaged"),
      }),
      execute: (args) => gitDiffTool.execute(args),
    }),

    git_log: tool({
      description: gitLogTool.description,
      inputSchema: z.object({
        count: z.number().optional().describe("Number of commits to show (default 10)"),
      }),
      execute: (args) => gitLogTool.execute(args),
    }),

    git_commit: tool({
      description: gitCommitTool.description,
      inputSchema: z.object({
        message: z.string().describe("Commit message"),
        files: z.array(z.string()).optional().describe("Files to stage before committing"),
      }),
      execute: (args) => gitCommitTool.execute(args),
    }),

    git_push: tool({
      description: gitPushTool.description,
      inputSchema: z.object({}),
      execute: () => gitPushTool.execute(),
    }),

    git_pull: tool({
      description: gitPullTool.description,
      inputSchema: z.object({}),
      execute: () => gitPullTool.execute(),
    }),

    git_stash: tool({
      description: gitStashTool.description,
      inputSchema: z.object({
        pop: z.boolean().optional().describe("Pop the latest stash instead of stashing"),
        message: z.string().optional().describe("Stash message"),
      }),
      execute: (args) => gitStashTool.execute(args),
    }),
  };
}

/** Read-only tools for explore subagent */
export function buildReadOnlyTools(editorSettings?: EditorIntegration) {
  const all = buildTools(undefined, editorSettings);
  return {
    read_file: all.read_file,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    editor_read: all.editor_read,
    navigate: all.navigate,
    read_code: all.read_code,
    analyze: all.analyze,
  };
}

/** Read-only tools + write_plan for plan mode */
export function buildPlanModeTools(cwd: string, editorSettings?: EditorIntegration) {
  const all = buildTools(cwd, editorSettings);
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
    write_plan: tool({
      description:
        "Submit a structured implementation plan. Call this when your research is complete and you have a concrete plan ready.",
      inputSchema: z.object({
        title: z.string().describe("Short plan title (2-6 words)"),
        context: z.string().describe("What problem this solves and why these changes are needed"),
        files: z
          .array(
            z.object({
              path: z.string().describe("File path relative to project root"),
              action: z.enum(["create", "modify", "delete"]).describe("Type of change"),
              description: z.string().describe("What changes to make in this file"),
            }),
          )
          .describe("Files to change"),
        steps: z
          .array(
            z.object({
              id: z.string().describe("Step ID (step-1, step-2, etc.)"),
              label: z.string().describe("Short step description"),
            }),
          )
          .describe("Ordered implementation steps"),
        verification: z.array(z.string()).describe("How to verify the changes work"),
      }),
      execute: async (args) => {
        // Write formatted markdown
        const lines = [`# ${args.title}`, "", `## Context`, "", args.context, "", `## Files`];
        for (const f of args.files) {
          lines.push(`- **${f.action}** \`${f.path}\` — ${f.description}`);
        }
        lines.push("", "## Steps");
        for (const s of args.steps) {
          lines.push(`${s.id}. ${s.label}`);
        }
        lines.push("", "## Verification");
        for (const v of args.verification) {
          lines.push(`- ${v}`);
        }
        const dir = join(cwd, ".soulforge");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plan.md"), lines.join("\n"));
        return { success: true, output: "Plan written to .soulforge/plan.md" };
      },
    }),
  };
}

/** Full code tools for code subagent */
export function buildCodeTools(cwd?: string, editorSettings?: EditorIntegration) {
  return buildTools(cwd, editorSettings);
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
    navigateTool.name,
    readCodeTool.name,
    refactorTool.name,
    analyzeTool.name,
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
