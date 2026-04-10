import { readFile } from "node:fs/promises";
import type { NvimInstance } from "./neovim.js";

let instance: NvimInstance | null = null;
let editorRequestCallback: ((file?: string) => void) | null = null;
let syncOnEdit = false;

/** Control whether reloadBuffer navigates the editor after agent edits. */
export function setSyncEditorOnEdit(enabled: boolean): void {
  syncOnEdit = enabled;
}

export function setNvimInstance(nvim: NvimInstance | null): void {
  instance = nvim;
}

export function getNvimInstance(): NvimInstance | null {
  return instance;
}

export function getNvimPid(): number | null {
  return instance?.pty.proc.pid ?? null;
}

/** Register a callback to open a file in the editor. Called by React side on mount. */
export function setEditorRequestCallback(cb: ((file?: string) => void) | null): void {
  editorRequestCallback = cb;
}

/** Request neovim to open a file. Nvim is always running — this just opens the buffer. */
export async function requestEditor(file?: string): Promise<NvimInstance | null> {
  if (instance) return instance;
  if (editorRequestCallback) {
    editorRequestCallback(file);
    return waitForNvim(8000);
  }
  return null;
}

const NVIM_TIMEOUT = 3000;
const NVIM_READ_TIMEOUT = NVIM_TIMEOUT;

/** Reload a file in the nvim buffer with a timeout. Silently swallows failures.
 *  When syncOnEdit is off, only refreshes the buffer if it's already the active file
 *  (so edits to the file you're reading still show up, but it won't jump away). */
export async function reloadBuffer(filePath: string, line?: number): Promise<boolean> {
  const nvim = instance;
  if (!nvim) return false;
  try {
    let lua: string;
    let args: (string | number)[];
    if (syncOnEdit) {
      // Always navigate to the edited file
      lua = line
        ? "local p, l = ...; vim.cmd({cmd='edit', args={vim.fn.fnameescape(p)}, bang=true, mods={silent=true}}); vim.api.nvim_win_set_cursor(0, {l, 0})"
        : "vim.cmd({cmd='edit', args={vim.fn.fnameescape(...)}, bang=true, mods={silent=true}})";
      args = line ? [filePath, line] : [filePath];
    } else {
      // Only refresh if this file is already the active buffer
      lua = `local p = ...; local cur = vim.api.nvim_buf_get_name(0); if cur == p then vim.cmd({cmd='edit', bang=true, mods={silent=true}}) end`;
      args = [filePath];
    }
    await Promise.race([
      nvim.api.executeLua(lua, args),
      new Promise<null>((r) => setTimeout(() => r(null), NVIM_TIMEOUT)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Files recently written by tools — skip nvim buffer, read from disk directly
const recentToolWrites = new Map<string, number>();
const TOOL_WRITE_FRESHNESS_MS = 2000;

export function markToolWrite(filePath: string): void {
  recentToolWrites.set(filePath, Date.now());
}

// Track concurrent reads — when multiple are in-flight, skip Neovim RPC
// to avoid serializing on the single RPC channel and blocking the event loop.
let inflight = 0;
const BATCH_THRESHOLD = 2; // skip nvim when 2+ reads are concurrent

export async function readBufferContent(filePath: string): Promise<string> {
  // If this file was just written by a tool, read from disk to avoid stale nvim buffer
  const toolWriteTime = recentToolWrites.get(filePath);
  if (toolWriteTime && Date.now() - toolWriteTime < TOOL_WRITE_FRESHNESS_MS) {
    return readFile(filePath, "utf-8");
  }

  inflight++;
  try {
    // When multiple reads are in-flight (parallel tool calls), go straight to disk.
    // Neovim's single RPC channel serializes requests — 6 parallel reads would
    // queue up with 3s timeouts each, blocking the UI for seconds.
    if (inflight >= BATCH_THRESHOLD) {
      return await readFile(filePath, "utf-8");
    }

    const nvim = instance as
      | (NvimInstance & {
          api: { executeLua: (code: string, args: unknown[]) => Promise<unknown> };
        })
      | null;
    if (nvim) {
      try {
        const result = await Promise.race([
          nvim.api.executeLua(
            `
          local path = select(1, ...)
          for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            if vim.api.nvim_buf_is_loaded(buf) then
              local name = vim.api.nvim_buf_get_name(buf)
              if name == path then
                local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
                return table.concat(lines, "\\n")
              end
            end
          end
          return nil
          `,
            [filePath],
          ),
          new Promise<null>((r) => setTimeout(() => r(null), NVIM_READ_TIMEOUT)),
        ]);
        if (typeof result === "string") return result;
      } catch {
        // Fall through to disk read
      }
    }
    return await readFile(filePath, "utf-8");
  } finally {
    inflight--;
  }
}

export function waitForNvim(timeoutMs = 5000): Promise<NvimInstance | null> {
  if (instance) return Promise.resolve(instance);
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (instance) {
        resolve(instance);
      } else if (Date.now() - start > timeoutMs) {
        resolve(null);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}
