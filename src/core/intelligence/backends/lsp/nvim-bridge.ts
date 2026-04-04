import { getNvimInstance } from "../../../editor/instance.js";
import type {
  LspCallHierarchyItem,
  LspCodeAction,
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspTextEdit,
  LspTypeHierarchyItem,
  LspWorkspaceEdit,
} from "./protocol.js";

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

    -- Trigger LSP attach without edit! (which causes swap file dialogs / "Press ENTER").
    -- Setting filetype fires the FileType autocommand → mason-lspconfig starts the server.
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    if #clients == 0 then
      local ft = vim.filetype.match({ buf = bufnr, filename = filepath })
      if ft and vim.bo[bufnr].filetype ~= ft then
        vim.bo[bufnr].filetype = ft
      end
      -- Wait up to 2s for an LSP client to attach
      local deadline = vim.uv.now() + 2000
      while #vim.lsp.get_clients({ bufnr = bufnr }) == 0 do
        if vim.uv.now() >= deadline then return '__NO_LSP__' end
        vim.wait(50)
      end
    end
  `;
}

/**
 * Load a file in a hidden neovim buffer and trigger LSP attach via filetype detection.
 * Never uses vim.cmd('edit') — avoids swap file dialogs and "Press ENTER" prompts.
 */
export async function warmupBuffer(filePath: string): Promise<boolean> {
  const nvim = getNvimInstance() as NvimApi | null;
  if (!nvim) return false;

  const escaped = filePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const lua = `
    local filepath = '${escaped}'
    local bufnr = vim.fn.bufadd(filepath)
    vim.fn.bufload(bufnr)
    vim.bo[bufnr].buflisted = false

    -- Set filetype to fire FileType autocommand → mason-lspconfig starts the LSP server.
    -- This avoids edit! which can trigger swap file dialogs and block neovim.
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    if #clients == 0 then
      local ft = vim.filetype.match({ buf = bufnr, filename = filepath })
      if ft and vim.bo[bufnr].filetype ~= ft then
        vim.bo[bufnr].filetype = ft
      end
      -- Wait up to 10s for an LSP client to attach
      local deadline = vim.uv.now() + 10000
      while #vim.lsp.get_clients({ bufnr = bufnr }) == 0 do
        if vim.uv.now() >= deadline then return '__NO_LSP__' end
        vim.wait(50)
      end
    end

    -- Prove LSP is responsive
    local params = { textDocument = { uri = vim.uri_from_fname(filepath) } }
    local result = vim.lsp.buf_request_sync(bufnr, 'textDocument/documentSymbol', params, 15000)
    if result then return 'ready' end
    return 'timeout'
  `;
  const result = await executeLua(lua);
  return result === "ready";
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
    -- Diagnostics are published asynchronously; wait up to 2s for them to arrive
    local diags = vim.diagnostic.get(bufnr)
    if #diags == 0 then
      local deadline = vim.uv.now() + 2000
      while #diags == 0 and vim.uv.now() < deadline do
        vim.wait(100)
        diags = vim.diagnostic.get(bufnr)
      end
    end
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

/** Get code actions for a range */
export async function getCodeActions(
  filePath: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
  diagnosticCodes?: (string | number)[],
): Promise<LspCodeAction[] | null> {
  const escapeLua = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const codesFilter = diagnosticCodes
    ? `local filter_codes = {${diagnosticCodes.map((c) => (typeof c === "string" ? `'${escapeLua(c)}'` : String(c))).join(",")}}
       for _, d in ipairs(vim.diagnostic.get(bufnr)) do
         for _, code in ipairs(filter_codes) do
           if tostring(d.code) == tostring(code) then
             table.insert(diags, d)
             break
           end
         end
       end`
    : `diags = vim.diagnostic.get(bufnr)`;
  const lua = `
    ${bufferPreamble(filePath)}
    local diags = {}
    ${codesFilter}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      range = {
        start = { line = ${String(startLine)}, character = ${String(startCol)} },
        ['end'] = { line = ${String(endLine)}, character = ${String(endCol)} },
      },
      context = { diagnostics = diags },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/codeAction', params, 5000)
    if not results then return '[]' end
    local actions = {}
    for _, res in pairs(results) do
      if res.result then
        for _, action in ipairs(res.result) do
          table.insert(actions, {
            title = action.title,
            kind = action.kind,
            isPreferred = action.isPreferred,
          })
        end
      end
    end
    return vim.json.encode(actions)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspCodeAction[]>(result, []);
}

/** Search workspace symbols */
export async function workspaceSymbols(
  filePath: string,
  query: string,
): Promise<LspLocation[] | null> {
  const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const lua = `
    ${bufferPreamble(filePath)}
    local params = { query = '${escapedQuery}' }
    local results = vim.lsp.buf_request_sync(bufnr, 'workspace/symbol', params, 10000)
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
  return safeParseJson<LspLocation[]>(result, []);
}

/** Format a document */
export async function formatDocument(filePath: string): Promise<LspTextEdit[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      options = { tabSize = 2, insertSpaces = true },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/formatting', params, 5000)
    if not results then return '[]' end
    local edits = {}
    for _, res in pairs(results) do
      if res.result then
        for _, edit in ipairs(res.result) do
          table.insert(edits, edit)
        end
      end
    end
    return vim.json.encode(edits)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspTextEdit[]>(result, []);
}

/** Format a range */
export async function formatRange(
  filePath: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): Promise<LspTextEdit[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      range = {
        start = { line = ${String(startLine)}, character = ${String(startCol)} },
        ['end'] = { line = ${String(endLine)}, character = ${String(endCol)} },
      },
      options = { tabSize = 2, insertSpaces = true },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/rangeFormatting', params, 5000)
    if not results then return '[]' end
    local edits = {}
    for _, res in pairs(results) do
      if res.result then
        for _, edit in ipairs(res.result) do
          table.insert(edits, edit)
        end
      end
    end
    return vim.json.encode(edits)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspTextEdit[]>(result, []);
}

/** Get call hierarchy (prepare + incoming + outgoing) */
export async function callHierarchy(
  filePath: string,
  line: number,
  col: number,
): Promise<{
  item: LspCallHierarchyItem;
  incoming: LspCallHierarchyItem[];
  outgoing: LspCallHierarchyItem[];
} | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
    }

    local prep = vim.lsp.buf_request_sync(bufnr, 'textDocument/prepareCallHierarchy', params, 5000)
    if not prep then return 'null' end
    local item = nil
    for _, res in pairs(prep) do
      if res.result and #res.result > 0 then
        item = res.result[1]
        break
      end
    end
    if not item then return 'null' end

    local inc_results = vim.lsp.buf_request_sync(bufnr, 'callHierarchy/incomingCalls', { item = item }, 5000)
    local incoming = {}
    if inc_results then
      for _, res in pairs(inc_results) do
        if res.result then
          for _, call in ipairs(res.result) do
            table.insert(incoming, call.from)
          end
        end
      end
    end

    local out_results = vim.lsp.buf_request_sync(bufnr, 'callHierarchy/outgoingCalls', { item = item }, 5000)
    local outgoing = {}
    if out_results then
      for _, res in pairs(out_results) do
        if res.result then
          for _, call in ipairs(res.result) do
            table.insert(outgoing, call.to)
          end
        end
      end
    end

    return vim.json.encode({ item = item, incoming = incoming, outgoing = outgoing })
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null || result === "null") return null;
  return safeParseJson<{
    item: LspCallHierarchyItem;
    incoming: LspCallHierarchyItem[];
    outgoing: LspCallHierarchyItem[];
  } | null>(result, null);
}

/** Find implementations */
export async function findImplementation(
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
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/implementation', params, 15000)
    if not results then return '[]' end
    local impls = {}
    for _, res in pairs(results) do
      if res.result then
        local items = vim.islist(res.result) and res.result or { res.result }
        for _, impl in ipairs(items) do
          local uri = impl.uri or impl.targetUri or ''
          local range = impl.range or impl.targetRange
          table.insert(impls, {
            uri = uri,
            range = { start = range.start, ['end'] = range['end'] },
          })
        end
      end
    end
    return vim.json.encode(impls)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspLocation[]>(result, []);
}

/** Get type hierarchy (prepare + supertypes + subtypes) */
export async function typeHierarchy(
  filePath: string,
  line: number,
  col: number,
): Promise<{
  item: LspTypeHierarchyItem;
  supertypes: LspTypeHierarchyItem[];
  subtypes: LspTypeHierarchyItem[];
} | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      position = { line = ${String(line)}, character = ${String(col)} },
    }

    local prep = vim.lsp.buf_request_sync(bufnr, 'textDocument/prepareTypeHierarchy', params, 5000)
    if not prep then return 'null' end
    local item = nil
    for _, res in pairs(prep) do
      if res.result and #res.result > 0 then
        item = res.result[1]
        break
      end
    end
    if not item then return 'null' end

    local sup_results = vim.lsp.buf_request_sync(bufnr, 'typeHierarchy/supertypes', { item = item }, 5000)
    local supertypes = {}
    if sup_results then
      for _, res in pairs(sup_results) do
        if res.result then
          for _, t in ipairs(res.result) do
            table.insert(supertypes, t)
          end
        end
      end
    end

    local sub_results = vim.lsp.buf_request_sync(bufnr, 'typeHierarchy/subtypes', { item = item }, 5000)
    local subtypes = {}
    if sub_results then
      for _, res in pairs(sub_results) do
        if res.result then
          for _, t in ipairs(res.result) do
            table.insert(subtypes, t)
          end
        end
      end
    end

    return vim.json.encode({ item = item, supertypes = supertypes, subtypes = subtypes })
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null || result === "null") return null;
  return safeParseJson<{
    item: LspTypeHierarchyItem;
    supertypes: LspTypeHierarchyItem[];
    subtypes: LspTypeHierarchyItem[];
  } | null>(result, null);
}

/** Get organize imports code action */
export async function organizeImports(filePath: string): Promise<LspCodeAction[] | null> {
  const lua = `
    ${bufferPreamble(filePath)}
    local params = {
      textDocument = { uri = vim.uri_from_fname(filepath) },
      range = {
        start = { line = 0, character = 0 },
        ['end'] = { line = 0, character = 0 },
      },
      context = {
        diagnostics = {},
        only = { 'source.organizeImports' },
      },
    }
    local results = vim.lsp.buf_request_sync(bufnr, 'textDocument/codeAction', params, 5000)
    if not results then return '[]' end
    local actions = {}
    for _, res in pairs(results) do
      if res.result then
        for _, action in ipairs(res.result) do
          table.insert(actions, action)
        end
      end
    end
    return vim.json.encode(actions)
  `;
  const result = await executeLua(lua);
  if (result === "__NO_LSP__" || result === null) return null;
  return safeParseJson<LspCodeAction[]>(result, []);
}

/** Get active LSP clients from neovim */
export async function getActiveClients(): Promise<Array<{
  name: string;
  language: string;
  pid: number | null;
}> | null> {
  const result = await executeLua(`
    local clients = vim.lsp.get_clients()
    local out = {}
    for _, c in ipairs(clients) do
      local ft = "unknown"
      if c.config and c.config.filetypes and #c.config.filetypes > 0 then
        ft = c.config.filetypes[1]
      end
      table.insert(out, {
        name = c.name,
        language = ft,
        pid = c.rpc and c.rpc.pid or nil,
      })
    end
    return vim.json.encode(out)
  `);
  return safeParseJson<Array<{ name: string; language: string; pid: number | null }> | null>(
    result,
    null,
  );
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
