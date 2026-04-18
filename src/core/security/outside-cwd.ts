import { homedir } from "node:os";
import { canonicalizePath, isInsideCwd } from "../utils/path-display.js";

export type OutsideKind = "config" | "tmp" | "outside";

const HOME = homedir();
const CONFIG_DIR = `${HOME}/.soulforge`;

const WHITELISTED_PREFIXES = [CONFIG_DIR, "/tmp", "/private/tmp"];

export function classifyPath(resolvedPath: string, cwd: string): OutsideKind | null {
  if (isInsideCwd(resolvedPath, cwd)) return null;

  const canon = canonicalizePath(resolvedPath);
  for (const prefix of WHITELISTED_PREFIXES) {
    const canonPrefix = canonicalizePath(prefix);
    if (canon === canonPrefix || canon.startsWith(`${canonPrefix}/`)) {
      const canonConfig = canonicalizePath(CONFIG_DIR);
      return canon === canonConfig || canon.startsWith(`${canonConfig}/`) ? "config" : "tmp";
    }
  }

  return "outside";
}

const WRITE_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "write_file",
  "create_file",
  "rename_symbol",
  "move_symbol",
  "refactor",
]);

export function needsOutsideConfirm(toolName: string, resolvedPath: string, cwd: string): boolean {
  const kind = classifyPath(resolvedPath, cwd);
  if (!kind || kind === "config" || kind === "tmp") return false;
  return WRITE_TOOLS.has(toolName) || toolName === "shell";
}
