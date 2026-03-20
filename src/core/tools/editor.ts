import { resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getNvimInstance, requestEditor, waitForNvim } from "../editor/instance.js";
import type { NvimInstance } from "../editor/neovim.js";
import { isForbidden } from "../security/forbidden.js";
import { emitFileEdited, emitFileRead } from "./file-events.js";
import { toolDenied, toolError } from "./tool-utils.js";

const NO_EDITOR: ToolResult = {
  success: false,
  output: "Editor is not open. Use editor_panel to open it first.",
  error: "Editor is not open",
};

export type EditorAction =
  | "read"
  | "edit"
  | "navigate"
  | "diagnostics"
  | "symbols"
  | "hover"
  | "references"
  | "definition"
  | "actions"
  | "rename"
  | "lsp_status"
  | "format"
  | "select"
  | "goto_cursor"
  | "yank"
  | "open_file"
  | "highlight"
  | "cursor_context"
  | "buffers"
  | "quickfix"
  | "terminal_output";

export interface EditorArgs {
  action: EditorAction;
  startLine?: number;
  endLine?: number;
  replacement?: string;
  file?: string;
  line?: number;
  col?: number;
  search?: string;
  newName?: string;
  apply?: number;
  jump?: boolean;
  text?: string;
  register?: string;
  count?: number;
}

export const editorTool = {
  name: "editor" as const,
  description:
    "Neovim editor integration. Actions: read, edit, navigate, diagnostics, symbols, hover, references, definition, actions, rename, lsp_status, format, select (visual select lines), goto_cursor (jump + center), yank (put text in register), open_file, highlight (ephemeral highlight), cursor_context (function/symbol at cursor), buffers (list open buffers), quickfix (read quickfix/location list), terminal_output (read last N lines from terminal buffers).",
  execute: async (args: EditorArgs): Promise<ToolResult> => {
    switch (args.action) {
      case "read":
        return editorReadTool.execute({
          startLine: args.startLine,
          endLine: args.endLine,
          file: args.file,
        });
      case "edit":
        if (args.startLine == null || args.endLine == null || args.replacement == null) {
          return {
            success: false,
            output: "startLine, endLine, and replacement required for edit",
            error: "missing params",
          };
        }
        return editorEditTool.execute({
          startLine: args.startLine,
          endLine: args.endLine,
          replacement: args.replacement,
          file: args.file,
        });
      case "navigate":
        return editorNavigateTool.execute({
          file: args.file,
          line: args.line,
          col: args.col,
          search: args.search,
        });
      case "diagnostics":
        return editorDiagnosticsTool.execute();
      case "symbols":
        return editorSymbolsTool.execute();
      case "hover":
        return editorHoverTool.execute({ line: args.line, col: args.col });
      case "references":
        return editorReferencesTool.execute({ line: args.line, col: args.col });
      case "definition":
        return editorDefinitionTool.execute({ line: args.line, col: args.col, jump: args.jump });
      case "actions":
        return editorActionsTool.execute({ line: args.line, col: args.col, apply: args.apply });
      case "rename":
        if (!args.newName) {
          return {
            success: false,
            output: "newName required for rename",
            error: "missing newName",
          };
        }
        return editorRenameTool.execute({ newName: args.newName, line: args.line, col: args.col });
      case "lsp_status":
        return editorLspStatusTool.execute();
      case "format":
        return editorFormatTool.execute({ startLine: args.startLine, endLine: args.endLine });
      case "select":
        return editorSelectTool.execute({
          startLine: args.startLine ?? 1,
          endLine: args.endLine ?? 1,
        });
      case "goto_cursor":
        return editorGotoCursorTool.execute({ line: args.line ?? 1, col: args.col });
      case "yank":
        return editorYankTool.execute({ text: args.text ?? "", register: args.register });
      case "open_file":
        return editorOpenFileTool.execute({ file: args.file ?? "" });
      case "highlight":
        return editorHighlightTool.execute({
          startLine: args.startLine ?? 1,
          endLine: args.endLine ?? 1,
        });
      case "cursor_context":
        return editorCursorContextTool.execute();
      case "buffers":
        return editorBuffersTool.execute();
      case "quickfix":
        return editorQuickfixTool.execute();
      case "terminal_output":
        return editorTerminalOutputTool.execute({ count: args.count });
      default:
        return {
          success: false,
          output: `Unknown action: ${String(args.action)}`,
          error: "bad action",
        };
    }
  },
};

async function checkCurrentBufferForbidden(
  nvim: Awaited<ReturnType<typeof requireNvim>>,
): Promise<ToolResult | null> {
  if (!nvim) return null;
  try {
    const bufName = await nvim.api.request("nvim_buf_get_name", [0]);
    if (typeof bufName === "string" && bufName) {
      const blocked = isForbidden(bufName);
      if (blocked) {
        const msg = `Access denied: current buffer "${bufName}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }
    }
  } catch {
    // Could not determine buffer name — allow
  }
  return null;
}

/** Safely parse JSON returned by executeLua. Handles nil, non-string, trailing whitespace, etc. */
function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  const str = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/** Get nvim instance, waiting briefly if it's still launching.
 *  If nvim isn't running at all, requests the editor panel to open. */
async function requireNvim(
  file?: string,
): Promise<import("../editor/neovim.js").NvimInstance | null> {
  const instant = getNvimInstance();
  if (instant) return instant;
  // Editor might be opening — wait briefly
  const waited = await waitForNvim(2000);
  if (waited) return waited;
  // Not running — request the panel to open and wait longer
  return requestEditor(file);
}

/** Shared nvim boilerplate: acquire instance → check forbidden buffer → execute → catch errors. */
async function withNvim(
  file: string | undefined,
  fn: (nvim: NvimInstance) => Promise<ToolResult>,
): Promise<ToolResult> {
  const nvim = await requireNvim(file);
  if (!nvim) return NO_EDITOR;
  try {
    const forbidden = await checkCurrentBufferForbidden(nvim);
    if (forbidden) return forbidden;
    return await fn(nvim);
  } catch (err: unknown) {
    return toolError(String(err));
  }
}

/** Like withNvim but skips the buffer forbidden check. For tools that don't read buffer content. */
async function withNvimRaw(
  fn: (nvim: NvimInstance) => Promise<ToolResult>,
  file?: string,
): Promise<ToolResult> {
  const nvim = await requireNvim(file);
  if (!nvim) return NO_EDITOR;
  try {
    return await fn(nvim);
  } catch (err: unknown) {
    return toolError(String(err));
  }
}

interface EditorReadArgs {
  startLine?: number;
  endLine?: number;
  file?: string;
}

export const editorReadTool = {
  name: "editor_read",
  description:
    "Read the live buffer from the embedded neovim editor, including unsaved changes. Optionally specify a line range (1-indexed). Requires the editor panel to be open.",
  execute: async (args: EditorReadArgs): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      if (args.file) {
        const targetPath = resolve(args.file);
        const currentBuf = await nvim.api.request("nvim_buf_get_name", [0]);
        if (typeof currentBuf === "string" && resolve(currentBuf) !== targetPath) {
          await nvim.api.executeLua("vim.cmd.edit(vim.fn.fnameescape(...))", [targetPath]);
        }
      }
      const forbidden = await checkCurrentBufferForbidden(nvim);
      if (forbidden) return forbidden;
      const buffer = await nvim.api.buffer;
      const start = args.startLine != null ? args.startLine - 1 : 0;
      const end = args.endLine ?? -1;
      const [lines, bufName] = await Promise.all([
        buffer.getLines({ start, end, strictIndexing: false }) as Promise<string[]>,
        nvim.api.request("nvim_buf_get_name", [0]),
      ]);

      if (typeof bufName === "string" && bufName) {
        emitFileRead(resolve(bufName));
      }

      return { success: true, output: lines.join("\n") };
    }, args.file),
};

interface EditorEditArgs {
  startLine: number;
  endLine: number;
  replacement: string;
  file?: string;
}

export const editorEditTool = {
  name: "editor_edit",
  description:
    "Replace lines startLine through endLine (inclusive, 1-indexed) in the neovim buffer with the replacement text. The replacement ONLY contains the new content — do NOT include the original lines. Changes are instant and undoable. Requires the editor panel to be open. Prefer edit_file for writing changes to disk.",
  execute: async (args: EditorEditArgs): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      if (args.file) {
        const targetPath = resolve(args.file);
        const currentBuf = await nvim.api.request("nvim_buf_get_name", [0]);
        if (typeof currentBuf === "string" && resolve(currentBuf) !== targetPath) {
          await nvim.api.executeLua("vim.cmd.edit(vim.fn.fnameescape(...))", [targetPath]);
        }
      }
      const forbidden = await checkCurrentBufferForbidden(nvim);
      if (forbidden) return forbidden;
      const buffer = await nvim.api.buffer;
      const replacementLines = args.replacement.split("\n");
      await buffer.setLines(replacementLines, {
        start: args.startLine - 1,
        end: args.endLine,
        strictIndexing: false,
      });
      await nvim.api.command("write");

      const [bufName, allLines] = await Promise.all([
        nvim.api.request("nvim_buf_get_name", [0]),
        buffer.getLines({ start: 0, end: -1, strictIndexing: false }) as Promise<string[]>,
      ]);
      if (typeof bufName === "string" && bufName) {
        emitFileEdited(resolve(bufName), allLines.join("\n"));
      }

      const count = replacementLines.length;
      return {
        success: true,
        output: `Replaced lines ${String(args.startLine)}-${String(args.endLine)} with ${String(count)} line(s) (saved)`,
      };
    }, args.file),
};

interface EditorNavigateArgs {
  file?: string;
  line?: number;
  col?: number;
  search?: string;
}

export const editorNavigateTool = {
  name: "editor_navigate",
  description:
    "Open a file, jump to a line:col, or search in the embedded neovim editor. At least one of file, line, or search must be provided. Requires the editor panel to be open. Use to show files to the user.",
  execute: async (args: EditorNavigateArgs): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      if (args.file) {
        const blocked = isForbidden(args.file);
        if (blocked) {
          return toolDenied(
            `Access denied: "${args.file}" matches forbidden pattern "${blocked}". This file is blocked for security.`,
          );
        }
        await nvim.api.executeLua("vim.cmd.edit(vim.fn.fnameescape(...))", [args.file]);
      }
      if (args.line != null) {
        await nvim.api.executeLua(
          "local l, c = ...; vim.api.nvim_win_set_cursor(0, {l, math.max(0, c - 1)})",
          [args.line, args.col ?? 1],
        );
      }
      if (args.search) {
        await nvim.api.executeLua("vim.fn.search(...)", [args.search]);
      }
      const bufName = await nvim.api.request("nvim_buf_get_name", [0]);
      const window = await nvim.api.window;
      const [line, col] = await window.cursor;
      return {
        success: true,
        output: `${typeof bufName === "string" ? bufName : "buffer"} line ${String(line)}, col ${String(col + 1)}`,
      };
    }, args.file),
};
export const editorDiagnosticsTool = {
  name: "editor_diagnostics",
  description:
    "Get LSP diagnostics (errors, warnings) for the current buffer in the embedded neovim editor. Requires the editor panel to be open.",
  execute: async (): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      try {
        const lua = `
          local diags = vim.diagnostic.get(0)
          if #diags == 0 then return '[]' end
          local result = {}
          local sev_map = { 'error', 'warning', 'info', 'hint' }
          for _, d in ipairs(diags) do
            table.insert(result, {
              line = d.lnum + 1,
              col = d.col + 1,
              severity = sev_map[d.severity] or 'unknown',
              message = d.message,
              source = d.source or '',
            })
          end
          return vim.json.encode(result)
        `;
        const result = await nvim.api.executeLua(lua, []);
        const parsed: unknown[] = safeJsonParse(result, []);
        if (parsed.length === 0) {
          return { success: true, output: "No diagnostics" };
        }
        const lines = parsed.map((d: unknown) => {
          const diag = d as {
            line: number;
            col: number;
            severity: string;
            message: string;
            source: string;
          };
          const src = diag.source ? ` (${diag.source})` : "";
          return `${diag.severity} line ${String(diag.line)}:${String(diag.col)}: ${diag.message}${src}`;
        });
        return { success: true, output: lines.join("\n") };
      } catch (err: unknown) {
        const msg = String(err);
        if (msg.includes("vim.diagnostic")) {
          return toolError("LSP not active");
        }
        throw err;
      }
    }),
};
export const editorSymbolsTool = {
  name: "editor_symbols",
  description:
    "Get document symbols (functions, classes, variables) from the LSP server for the current buffer. Requires the editor panel to be open.",
  execute: async (): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const lua = `
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        local params = { textDocument = vim.lsp.util.make_text_document_params(0) }
        local results = vim.lsp.buf_request_sync(0, 'textDocument/documentSymbol', params, 3000)
        if not results then return '[]' end
        local symbols = {}
        local kind_map = {
          'File','Module','Namespace','Package','Class','Method','Property',
          'Field','Constructor','Enum','Interface','Function','Variable',
          'Constant','String','Number','Boolean','Array','Object','Key',
          'Null','EnumMember','Struct','Event','Operator','TypeParameter'
        }
        for _, res in pairs(results) do
          if res.result then
            for _, sym in ipairs(res.result) do
              table.insert(symbols, {
                name = sym.name,
                kind = kind_map[sym.kind] or tostring(sym.kind),
                line = sym.range['start'].line + 1,
              })
            end
          end
        end
        return vim.json.encode(symbols)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No symbols found" };
      }
      const lines = parsed.map((s: unknown) => {
        const sym = s as { name: string; kind: string; line: number };
        return `${sym.kind} ${sym.name} (line ${String(sym.line)})`;
      });
      return { success: true, output: lines.join("\n") };
    }),
};

interface EditorReferencesArgs {
  line?: number;
  col?: number;
}

export const editorReferencesTool = {
  name: "editor_references",
  description:
    "Find all references to the symbol at the current cursor position or a specified line:col via LSP. Requires the editor panel to be open.",
  execute: async (args: EditorReferencesArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const line = args.line ?? 0;
      const col = args.col ?? 0;
      const lua = `
        local line, col = ${String(line)}, ${String(col)}
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        if line > 0 then
          vim.api.nvim_win_set_cursor(0, {line, col > 0 and col - 1 or 0})
        end
        local pos = vim.api.nvim_win_get_cursor(0)
        local params = {
          textDocument = vim.lsp.util.make_text_document_params(0),
          position = { line = pos[1] - 1, character = pos[2] },
          context = { includeDeclaration = true },
        }
        local results = vim.lsp.buf_request_sync(0, 'textDocument/references', params, 5000)
        if not results then return '[]' end
        local refs = {}
        for _, res in pairs(results) do
          if res.result then
            for _, ref in ipairs(res.result) do
              local uri = ref.uri or ref.targetUri or ''
              local filepath = uri:gsub('^file://', '')
              local rline = (ref.range or ref.targetRange).start.line + 1
              local rcol = (ref.range or ref.targetRange).start.character + 1
              table.insert(refs, { file = filepath, line = rline, col = rcol })
            end
          end
        end
        return vim.json.encode(refs)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No references found" };
      }
      const lines = parsed.map((r: unknown) => {
        const ref = r as { file: string; line: number; col: number };
        return `${ref.file}:${String(ref.line)}:${String(ref.col)}`;
      });
      return {
        success: true,
        output: `${String(parsed.length)} reference(s):\n${lines.join("\n")}`,
      };
    }),
};

interface EditorDefinitionArgs {
  line?: number;
  col?: number;
  jump?: boolean;
}

export const editorDefinitionTool = {
  name: "editor_definition",
  description:
    "Go to the definition of the symbol at the current cursor position or a specified line:col via LSP. By default jumps the editor to the first definition. Requires the editor panel to be open.",
  execute: async (args: EditorDefinitionArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const line = args.line ?? 0;
      const col = args.col ?? 0;
      const shouldJump = args.jump !== false;
      const lua = `
        local line, col = ${String(line)}, ${String(col)}
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        if line > 0 then
          vim.api.nvim_win_set_cursor(0, {line, col > 0 and col - 1 or 0})
        end
        local pos = vim.api.nvim_win_get_cursor(0)
        local params = {
          textDocument = vim.lsp.util.make_text_document_params(0),
          position = { line = pos[1] - 1, character = pos[2] },
        }
        local results = vim.lsp.buf_request_sync(0, 'textDocument/definition', params, 5000)
        if not results then return '[]' end
        local defs = {}
        for _, res in pairs(results) do
          if res.result then
            local items = vim.islist(res.result) and res.result or { res.result }
            for _, def in ipairs(items) do
              local uri = def.uri or def.targetUri or ''
              local filepath = uri:gsub('^file://', '')
              local range = def.range or def.targetRange
              local dline = range.start.line + 1
              local dcol = range.start.character + 1
              table.insert(defs, { file = filepath, line = dline, col = dcol })
            end
          end
        end
        if #defs > 0 and ${shouldJump ? "true" : "false"} then
          local first = defs[1]
          vim.cmd('edit ' .. vim.fn.fnameescape(first.file))
          vim.api.nvim_win_set_cursor(0, {first.line, first.col - 1})
        end
        return vim.json.encode(defs)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No definition found" };
      }
      const lines = parsed.map((d: unknown) => {
        const def = d as { file: string; line: number; col: number };
        return `${def.file}:${String(def.line)}:${String(def.col)}`;
      });
      const jumpNote = shouldJump ? " (jumped to first)" : "";
      return {
        success: true,
        output: `${String(parsed.length)} definition(s)${jumpNote}:\n${lines.join("\n")}`,
      };
    }),
};

interface EditorActionsArgs {
  line?: number;
  col?: number;
  apply?: number;
}

export const editorActionsTool = {
  name: "editor_actions",
  description:
    "List or apply code actions (quick fixes, refactorings) at the current cursor position or a specified line:col via LSP. Pass apply (0-indexed) to apply a specific action. Requires the editor panel to be open.",
  execute: async (args: EditorActionsArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const line = args.line ?? 0;
      const col = args.col ?? 0;
      const applyIdx = args.apply ?? -1;
      const lua = `
        local line, col, apply_idx = ${String(line)}, ${String(col)}, ${String(applyIdx)}
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        if line > 0 then
          vim.api.nvim_win_set_cursor(0, {line, col > 0 and col - 1 or 0})
        end
        local pos = vim.api.nvim_win_get_cursor(0)
        local params = {
          textDocument = vim.lsp.util.make_text_document_params(0),
          range = {
            start = { line = pos[1] - 1, character = pos[2] },
            ['end'] = { line = pos[1] - 1, character = pos[2] },
          },
          context = { diagnostics = vim.diagnostic.get(0) },
        }
        local results = vim.lsp.buf_request_sync(0, 'textDocument/codeAction', params, 5000)
        if not results then return '[]' end
        local actions = {}
        for _, res in pairs(results) do
          if res.result then
            for _, action in ipairs(res.result) do
              table.insert(actions, {
                title = action.title,
                kind = action.kind or '',
                _action = action,
              })
            end
          end
        end
        if apply_idx >= 0 and apply_idx < #actions then
          local chosen = actions[apply_idx + 1]._action
          if chosen.edit then
            vim.lsp.util.apply_workspace_edit(chosen.edit, 'utf-8')
          end
          if chosen.command then
            local cmd = chosen.command
            if type(cmd) == 'table' then
              vim.lsp.buf.execute_command(cmd)
            end
          end
        end
        local out = {}
        for i, a in ipairs(actions) do
          table.insert(out, { idx = i - 1, title = a.title, kind = a.kind })
        end
        return vim.json.encode(out)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No code actions available" };
      }
      const lines = parsed.map((a: unknown) => {
        const action = a as { idx: number; title: string; kind: string };
        const kindSuffix = action.kind ? ` [${action.kind}]` : "";
        return `[${String(action.idx)}] ${action.title}${kindSuffix}`;
      });
      const appliedNote = applyIdx >= 0 ? ` (applied action ${String(applyIdx)})` : "";
      return {
        success: true,
        output: `${String(parsed.length)} action(s)${appliedNote}:\n${lines.join("\n")}`,
      };
    }),
};

interface EditorRenameArgs {
  newName: string;
  line?: number;
  col?: number;
}

export const editorRenameTool = {
  name: "editor_rename",
  description:
    "Rename a symbol across the workspace using LSP. Optionally specify line:col to target a specific symbol, otherwise uses the current cursor position. Requires LSP support in the editor.",
  execute: async (args: EditorRenameArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const line = args.line ?? 0;
      const col = args.col ?? 0;
      const newName = args.newName;
      const lua = `
        local line, col = ${String(line)}, ${String(col)}
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        if line > 0 then
          vim.api.nvim_win_set_cursor(0, {line, col > 0 and col - 1 or 0})
        end
        local pos = vim.api.nvim_win_get_cursor(0)
        local params = vim.lsp.util.make_position_params(0)
        params.newName = select(1, ...)
        local results = vim.lsp.buf_request_sync(0, 'textDocument/rename', params, 5000)
        if not results then return '__FAIL__' end
        local changed = 0
        for _, res in pairs(results) do
          if res.result then
            vim.lsp.util.apply_workspace_edit(res.result, 'utf-8')
            if res.result.changes then
              for _, edits in pairs(res.result.changes) do
                changed = changed + #edits
              end
            end
            if res.result.documentChanges then
              for _, dc in ipairs(res.result.documentChanges) do
                if dc.edits then changed = changed + #dc.edits end
              end
            end
          end
        end
        vim.cmd('wall')
        return tostring(changed)
      `;
      const result = await nvim.api.executeLua(lua, [newName]);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      if (result === "__FAIL__") {
        return {
          success: false,
          output: "Rename failed — no result from LSP",
          error: "Rename failed",
        };
      }
      return {
        success: true,
        output: `Renamed to "${newName}" — ${String(result)} edit(s) applied`,
      };
    }),
};

export const editorLspStatusTool = {
  name: "editor_lsp_status",
  description:
    "Get the status of LSP servers attached to the current buffer, including their names, root directories, and capabilities.",
  execute: async (): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const lua = `
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        local result = {}
        for _, c in ipairs(clients) do
          local caps = {}
          local sc = c.server_capabilities or {}
          if sc.completionProvider then table.insert(caps, 'completion') end
          if sc.hoverProvider then table.insert(caps, 'hover') end
          if sc.definitionProvider then table.insert(caps, 'definition') end
          if sc.referencesProvider then table.insert(caps, 'references') end
          if sc.renameProvider then table.insert(caps, 'rename') end
          if sc.documentFormattingProvider then table.insert(caps, 'formatting') end
          if sc.documentSymbolProvider then table.insert(caps, 'symbols') end
          if sc.codeActionProvider then table.insert(caps, 'codeActions') end
          if sc.diagnosticProvider then table.insert(caps, 'diagnostics') end
          table.insert(result, {
            name = c.name,
            id = c.id,
            root_dir = c.config and c.config.root_dir or '',
            capabilities = caps,
          })
        end
        return vim.json.encode(result)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: true, output: "No LSP servers attached to current buffer" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No LSP servers attached" };
      }
      const lines = parsed.map((s: unknown) => {
        const srv = s as { name: string; id: number; root_dir: string; capabilities: string[] };
        const caps = srv.capabilities.length > 0 ? srv.capabilities.join(", ") : "none";
        return `${srv.name} (id ${String(srv.id)})${srv.root_dir ? ` root: ${srv.root_dir}` : ""}\n  capabilities: ${caps}`;
      });
      return { success: true, output: lines.join("\n\n") };
    }),
};

interface EditorFormatArgs {
  startLine?: number;
  endLine?: number;
}

export const editorFormatTool = {
  name: "editor_format",
  description:
    "Format the current buffer (or a line range) using the LSP formatter. Requires a language server with formatting capability.",
  execute: async (args: EditorFormatArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const hasRange = args.startLine != null && args.endLine != null;
      const startIdx = hasRange ? (args.startLine as number) - 1 : 0;
      const endIdx = hasRange ? (args.endLine as number) : 0;
      const rangeStr = hasRange
        ? `{ start = {${String(startIdx)}, 0}, ['end'] = {${String(endIdx)}, 0} }`
        : "nil";
      const lua = `
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        local has_format = false
        for _, c in ipairs(clients) do
          if c.server_capabilities and c.server_capabilities.documentFormattingProvider then
            has_format = true
            break
          end
        end
        if not has_format then return '__NO_FORMAT__' end
        local range = ${rangeStr}
        vim.lsp.buf.format({ async = false, range = range, timeout_ms = 5000 })
        return 'ok'
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      if (result === "__NO_FORMAT__") {
        return {
          success: false,
          output: "No LSP server with formatting capability is attached",
          error: "No formatting capability",
        };
      }
      const rangeNote = hasRange
        ? ` (lines ${String(args.startLine)}-${String(args.endLine)})`
        : "";
      return { success: true, output: `Buffer formatted${rangeNote}` };
    }),
};

interface EditorHoverArgs {
  line?: number;
  col?: number;
}

export const editorHoverTool = {
  name: "editor_hover",
  description:
    "Get hover/type information from the LSP server at the current cursor position or a specified line:col. Requires the editor panel to be open.",
  execute: async (args: EditorHoverArgs): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const line = args.line ?? 0;
      const col = args.col ?? 0;
      const lua = `
        local line, col = ${String(line)}, ${String(col)}
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then return '__NO_LSP__' end
        if line > 0 then
          vim.api.nvim_win_set_cursor(0, {line, col > 0 and col - 1 or 0})
        end
        local pos = vim.api.nvim_win_get_cursor(0)
        local params = {
          textDocument = vim.lsp.util.make_text_document_params(0),
          position = { line = pos[1] - 1, character = pos[2] },
        }
        local results = vim.lsp.buf_request_sync(0, 'textDocument/hover', params, 3000)
        if not results then return '' end
        for _, res in pairs(results) do
          if res.result and res.result.contents then
            local c = res.result.contents
            if type(c) == 'string' then return c end
            if type(c) == 'table' then
              if c.value then return c.value end
              if c.kind then return c.value or '' end
              local parts = {}
              for _, item in ipairs(c) do
                if type(item) == 'string' then table.insert(parts, item)
                elseif item.value then table.insert(parts, item.value) end
              end
              return table.concat(parts, '\\n')
            end
          end
        end
        return ''
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_LSP__") {
        return { success: false, output: "LSP not active", error: "LSP not active" };
      }
      const text = typeof result === "string" ? result : "";
      if (!text) {
        return { success: true, output: "No hover information available" };
      }
      return { success: true, output: text };
    }),
};

const editorSelectTool = {
  execute: async (args: { startLine: number; endLine: number }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      await nvim.api.executeLua(
        `
        local s, e = ...
        vim.api.nvim_win_set_cursor(0, {s, 0})
        vim.cmd('normal! V')
        if e > s then vim.cmd('normal! ' .. tostring(e - s) .. 'j') end
        `,
        [args.startLine, args.endLine],
      );
      return {
        success: true,
        output: `Selected lines ${String(args.startLine)}-${String(args.endLine)}`,
      };
    }),
};

const editorGotoCursorTool = {
  execute: async (args: { line: number; col?: number }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const col = Math.max(0, (args.col ?? 1) - 1);
      await nvim.api.executeLua(
        "vim.api.nvim_win_set_cursor(0, {select(1, ...), select(2, ...)}); vim.cmd('normal! zz')",
        [args.line, col],
      );
      return { success: true, output: `Cursor at line ${String(args.line)}` };
    }),
};

const editorYankTool = {
  execute: async (args: { text: string; register?: string }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const reg = args.register ?? "+";
      await nvim.api.executeLua("vim.fn.setreg(select(1, ...), select(2, ...))", [reg, args.text]);
      const lines = args.text.split("\n").length;
      return {
        success: true,
        output: `${String(lines)} line(s) yanked to register "${reg}" — paste with "${reg}p"`,
      };
    }),
};

const editorOpenFileTool = {
  execute: async (args: { file: string }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const blocked = isForbidden(args.file);
      if (blocked) {
        return toolDenied(`Access denied: "${args.file}" matches forbidden pattern "${blocked}".`);
      }
      await nvim.api.executeLua("vim.cmd.edit(vim.fn.fnameescape(...))", [args.file]);
      return { success: true, output: `Opened ${args.file} in editor` };
    }, args.file),
};

const HIGHLIGHT_NS = "soulforge_highlight";

const editorHighlightTool = {
  execute: async (args: { startLine: number; endLine: number }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      await nvim.api.executeLua(
        `
        local s, e = ...
        local ns = vim.api.nvim_create_namespace('${HIGHLIGHT_NS}')
        vim.api.nvim_buf_clear_namespace(0, ns, 0, -1)

        -- Create a visible highlight group if it doesn't exist
        vim.api.nvim_set_hl(0, 'SoulForgeHL', { bg = '#3d2266', fg = '#e0d0ff', bold = true })

        for line = s - 1, e - 1 do
          vim.api.nvim_buf_add_highlight(0, ns, 'SoulForgeHL', line, 0, -1)
        end
        vim.api.nvim_win_set_cursor(0, {s, 0})
        vim.cmd('normal! zz')
        vim.cmd('redraw')
        vim.defer_fn(function()
          vim.api.nvim_buf_clear_namespace(0, ns, 0, -1)
          vim.cmd('redraw')
        end, 5000)
        `,
        [args.startLine, args.endLine],
      );
      return {
        success: true,
        output: `Highlighted lines ${String(args.startLine)}-${String(args.endLine)} (clears in 5s)`,
      };
    }),
};

const editorCursorContextTool = {
  execute: async (): Promise<ToolResult> =>
    withNvim(undefined, async (nvim) => {
      const lua = `
        local cursor = vim.api.nvim_win_get_cursor(0)
        local row = cursor[1] - 1
        local bufnr = vim.api.nvim_get_current_buf()
        local fname = vim.api.nvim_buf_get_name(bufnr)

        -- Try tree-sitter first
        local ok, ts = pcall(function()
          local node = vim.treesitter.get_node({ bufnr = bufnr, pos = { row, cursor[2] } })
          if not node then return nil end

          -- Walk up to find the enclosing function/method/class
          local container_types = {
            function_declaration = true, method_definition = true,
            function_definition = true, arrow_function = true,
            class_declaration = true, class_definition = true,
            impl_item = true, fn_item = true,
          }

          local current = node
          while current do
            local type = current:type()
            if container_types[type] then
              local start_row, _, end_row, _ = current:range()
              -- Get the name: usually the first named child or identifier child
              local name_node = current:field('name')[1]
              local name = name_node and vim.treesitter.get_node_text(name_node, bufnr) or type
              return {
                symbol = name,
                kind = type,
                startLine = start_row + 1,
                endLine = end_row + 1,
                file = fname,
              }
            end
            current = current:parent()
          end
          return nil
        end)

        if ok and ts then
          return vim.json.encode(ts)
        end

        -- Fallback: just return cursor position and file
        return vim.json.encode({
          file = fname,
          cursorLine = cursor[1],
          cursorCol = cursor[2] + 1,
        })
      `;
      const result = await nvim.api.executeLua(lua, []);
      const parsed = safeJsonParse<Record<string, unknown>>(result, {});
      if (parsed.symbol) {
        return {
          success: true,
          output: `Cursor is inside ${String(parsed.kind)} "${String(parsed.symbol)}" (lines ${String(parsed.startLine)}-${String(parsed.endLine)}) in ${String(parsed.file)}`,
        };
      }
      return {
        success: true,
        output: `Cursor at ${String(parsed.file ?? "buffer")} line ${String(parsed.cursorLine)}:${String(parsed.cursorCol)}`,
      };
    }),
};

const editorBuffersTool = {
  execute: async (): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const lua = `
        local bufs = {}
        local current = vim.api.nvim_get_current_buf()
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(buf) then
            local name = vim.api.nvim_buf_get_name(buf)
            if name ~= '' then
              local modified = vim.bo[buf].modified
              local buftype = vim.bo[buf].buftype
              table.insert(bufs, {
                id = buf,
                name = name,
                current = buf == current,
                modified = modified,
                type = buftype ~= '' and buftype or nil,
              })
            end
          end
        end
        return vim.json.encode(bufs)
      `;
      const result = await nvim.api.executeLua(lua, []);
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No buffers open" };
      }
      const lines = parsed.map((b: unknown) => {
        const buf = b as {
          id: number;
          name: string;
          current: boolean;
          modified: boolean;
          type?: string;
        };
        const flags = [
          buf.current ? "active" : "",
          buf.modified ? "modified" : "",
          buf.type ? buf.type : "",
        ]
          .filter(Boolean)
          .join(", ");
        return `${buf.current ? ">" : " "} ${buf.name}${flags ? ` (${flags})` : ""}`;
      });
      return { success: true, output: `${String(parsed.length)} buffer(s):\n${lines.join("\n")}` };
    }),
};

const editorQuickfixTool = {
  execute: async (): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const lua = `
        local qf = vim.fn.getqflist()
        if #qf == 0 then return '__EMPTY__' end
        local items = {}
        local sev_map = { E = 'error', W = 'warning', I = 'info', N = 'note' }
        for _, entry in ipairs(qf) do
          local fname = ''
          if entry.bufnr > 0 then
            fname = vim.api.nvim_buf_get_name(entry.bufnr)
          end
          table.insert(items, {
            file = fname,
            line = entry.lnum,
            col = entry.col,
            severity = sev_map[entry.type] or entry.type or '',
            text = entry.text or '',
          })
        end
        return vim.json.encode(items)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__EMPTY__") {
        return { success: true, output: "Quickfix list is empty" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "Quickfix list is empty" };
      }
      const lines = parsed.map((q: unknown) => {
        const item = q as {
          file: string;
          line: number;
          col: number;
          severity: string;
          text: string;
        };
        const loc = item.file
          ? `${item.file}:${String(item.line)}:${String(item.col)}`
          : `line ${String(item.line)}`;
        const sev = item.severity ? `[${item.severity}] ` : "";
        return `${sev}${loc}: ${item.text}`;
      });
      return {
        success: true,
        output: `${String(parsed.length)} quickfix item(s):\n${lines.join("\n")}`,
      };
    }),
};

const editorTerminalOutputTool = {
  execute: async (args: { count?: number }): Promise<ToolResult> =>
    withNvimRaw(async (nvim) => {
      const maxLines = args.count ?? 100;
      const lua = `
        local max_lines = ${String(maxLines)}
        local term_bufs = {}
        for _, buf in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == 'terminal' then
            table.insert(term_bufs, buf)
          end
        end
        if #term_bufs == 0 then return '__NO_TERMINAL__' end

        local results = {}
        for _, buf in ipairs(term_bufs) do
          local name = vim.api.nvim_buf_get_name(buf)
          local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)

          -- Trim trailing empty lines
          while #lines > 0 and lines[#lines]:match('^%s*$') do
            table.remove(lines)
          end

          -- Take last N lines
          local start = math.max(1, #lines - max_lines + 1)
          local slice = {}
          for i = start, #lines do
            table.insert(slice, lines[i])
          end

          table.insert(results, {
            name = name,
            total_lines = #lines,
            content = table.concat(slice, '\\n'),
          })
        end
        return vim.json.encode(results)
      `;
      const result = await nvim.api.executeLua(lua, []);
      if (result === "__NO_TERMINAL__") {
        return { success: true, output: "No terminal buffers open" };
      }
      const parsed: unknown[] = safeJsonParse(result, []);
      if (parsed.length === 0) {
        return { success: true, output: "No terminal buffers open" };
      }
      const sections = parsed.map((t: unknown) => {
        const term = t as { name: string; total_lines: number; content: string };
        const label = term.name.replace(/^term:\/\/.*\/\/\d+:/, "") || "terminal";
        return `── ${label} (${String(term.total_lines)} lines, showing last ${String(maxLines)}) ──\n${term.content}`;
      });
      return { success: true, output: sections.join("\n\n") };
    }),
};
