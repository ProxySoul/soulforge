import { homedir } from "node:os";
import { relative } from "node:path";

export type OutsideKind = "config" | "tmp" | "outside";

const HOME = homedir();
const CONFIG_DIR = `${HOME}/.soulforge`;

const WHITELISTED_PREFIXES = [CONFIG_DIR, "/tmp", "/private/tmp"];

export function classifyPath(resolvedPath: string, cwd: string): OutsideKind | null {
  const rel = relative(cwd, resolvedPath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) return null;

  for (const prefix of WHITELISTED_PREFIXES) {
    if (resolvedPath.startsWith(prefix)) {
      return resolvedPath.startsWith(CONFIG_DIR) ? "config" : "tmp";
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
