// ─── Neovim LSP Bridge ───
//
// Bridges to Neovim's built-in LSP via executeLua().
// Works on any file (not just buffer 0) by loading hidden buffers.

import { getNvimInstance } from "../../../editor/instance.js";
import type { LspDiagnostic, LspHover, LspLocation, LspWorkspaceEdit } from "./protocol.js";

type NvimApi = ReturnType<typeof getNvimInstance> & {
  api: { executeLua: (code: string, args: unknown[]) => Promise<unknown> };
};

/** Check if Neovim is available and has LSP clients */
export function isNvimAvailable(): boolean {
  return getNvimInstance() !== null;
}

/** Execute a Lua snippet via Neovim, return the result or null on failure */
async function executeLua(lua: string): Promise<unknown> {
  const nvim = getNvimInstance() as NvimApi | null;
  if (!nvim) return null;
  try {
    return await nvim.api.executeLua(lua, []);
  } catch {
    return null;
  }
}

/**
 * Lua helper that opens a file in a hidden buffer and waits for an LSP client.
 * Returns the preamble code + bufnr variable name.
 */
function bufferPreamble(filePath: string): string {
  // Escape backslashes first, then single quotes for Lua string literal
  const escaped = filePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `
    local filepath = '${escaped}'
    local bufnr = vim.fn.bufadd(filepath)
    vim.fn.bufload(bufnr)
    vim.bo[bufnr].buflisted = false

    -- Wait up to 2s for an LSP client to attach
    local deadline = vim.uv.now() + 2000
    while #vim.lsp.get_clients({ bufnr = bufnr }) == 0 do
      if vim.uv.now() >= deadline then return '__NO_LSP__' end
      vim.wait(50)
    end
  `;
}

/** Find definition of symbol at line:col in file */
export async function findDefinition(
  filePath: string,
  line: number,
  col: number,
): Promise<LspLocation[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/definition', params, 5000)
    if not results then return '[]' end
    local defs = {}
    for _, res in pairs(results) do
      if res.result then
        local items = vim.islist(res.result) and res.result or { res.result }
        for _, def in ipairs(items) do
          local uri = def.uri or def.targetUri or ''
          local range = def.range or def.targetRange
          table.insert(defs, {
            uri = uri,
            range = { start = range.start, ['end'] = range['end'] },
          })
        end
      end
    end
    return vim.json.encode(defs)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspLocation[]>(result, []);
}

/** Find references to symbol at line:col in file */
export async function findReferences(
  filePath: string,
  line: number,
  col: number,
): Promise<LspLocation[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
      context = { includeDeclaration = true },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/references', params, 5000)
    if not results then return '[]' end
    local refs = {}
    for _, res in pairs(results) do
      if res.result then
        for _, ref in ipairs(res.result) do
          local uri = ref.uri or ref.targetUri or ''
          local range = ref.range or ref.targetRange
          table.insert(refs, {
            uri = uri,
            range = { start = range.start, ['end'] = range['end'] },
          })
        end
      end
    end
    return vim.json.encode(refs)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspLocation[]>(result, []);
}

/** Get document symbols for a file */
export async function documentSymbols(filePath: string): Promise<unknown[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/documentSymbol', params, 5000)
    if not results then return '[]' end
    local symbols = {}
    for _, res in pairs(results) do
      if res.result then
        for _, sym in ipairs(res.result) do
          table.insert(symbols, sym)
        end
      end
    end
    return vim.json.encode(symbols)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<unknown[]>(result, []);
}

/** Get diagnostics for a file using vim.diagnostic.get */
export async function getDiagnostics(filePath: string): Promise<LspDiagnostic[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local diags = vim.diagnostic.get(bufnr)
    local result = {}
    for _, d in ipairs(diags) do
      table.insert(result, {
        range = {
          start = { line = d.lnum, character = d.col },
          ['end'] = { line = d.end_lnum or d.lnum, character = d.end_col or d.col },
        },
        severity = d.severity,
        message = d.message,
        source = d.source,
        code = d.code,
      })
    end
    return vim.json.encode(result)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspDiagnostic[]>(result, []);
}

/** Get hover info for symbol at line:col */
export async function getHover(
  filePath: string,
  line: number,
  col: number,
): Promise<LspHover | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/hover', params, 5000)
    if not results then return 'null' end
    for _, res in pairs(results) do
      if res.result then
        return vim.json.encode(res.result)
      end
    end
    return 'null'
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null || result === "null") return null;
  return safeParseJson<LspHover | null>(result, null);
}

/** Rename symbol at line:col and apply edits */
export async function rename(
  filePath: string,
  line: number,
  col: number,
  newName: string,
): Promise<LspWorkspaceEdit | null> {
  const escapedName = newName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
      newName = '${escapedName}',
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/rename', params, 5000)
    if not results then return 'null' end
    for _, res in pairs(results) do
      if res.result then
        -- Apply the workspace edit
        local client = vim.lsp.get_clients({ bufnr = bufnr })[1]
        if client then
          vim.lsp.util.apply_workspace_edit(res.result, client.offset_encoding or 'utf-16')
        end
        return vim.json.encode(res.result)
      end
    end
    return 'null'
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null || result === "null") return null;
  return safeParseJson<LspWorkspaceEdit | null>(result, null);
}

// ─── Helpers ───

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
