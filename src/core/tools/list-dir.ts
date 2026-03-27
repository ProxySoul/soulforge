import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { isForbidden } from "../security/forbidden.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";

interface ListDirArgs {
  path?: string;
  depth?: number;
}

/**
 * Repo-map-aware directory listing. When the repo map is available,
 * returns file metadata (language, lines, symbols, importance).
 * Falls back to filesystem readdirSync for non-indexed directories.
 */
export const listDirTool = {
  name: "list_dir",
  description: "List directory contents with file metadata.",
  execute: async (args: ListDirArgs, repoMap?: IntelligenceClient): Promise<ToolResult> => {
    try {
      const cwd = process.cwd();
      const targetPath = args.path ? resolve(args.path) : cwd;
      const relPath = relative(cwd, targetPath);

      const blocked = isForbidden(targetPath);
      if (blocked) {
        const msg = `Access denied: "${args.path}" matches forbidden pattern "${blocked}".`;
        return { success: false, output: msg, error: msg };
      }

      // Try repo map first
      if (repoMap) {
        const dirKey = relPath === "" ? "." : relPath;
        const entries = await repoMap.listDirectory(dirKey);
        if (entries && entries.length > 0) {
          const lines: string[] = [];
          for (const e of entries) {
            if (e.type === "dir") {
              lines.push(`📁 ${e.name}/`);
            } else {
              const meta: string[] = [];
              if (e.language && e.language !== "unknown") meta.push(e.language);
              if (e.lines) meta.push(`${String(e.lines)}L`);
              if (e.symbols) meta.push(`${String(e.symbols)} syms`);
              if (e.importance && e.importance > 0.001) meta.push(`★${String(e.importance)}`);
              const suffix = meta.length > 0 ? `  (${meta.join(", ")})` : "";
              lines.push(`   ${e.name}${suffix}`);
            }
          }
          const header = relPath === "" ? "." : relPath;
          return {
            success: true,
            output: `${header}/ — ${String(entries.length)} entries (soul map)\n\n${lines.join("\n")}`,
          };
        }
      }

      // Fallback: filesystem (async)
      let rawEntries: string[];
      try {
        rawEntries = await readdir(targetPath);
      } catch {
        const msg = `Cannot read directory: ${targetPath}`;
        return { success: false, output: msg, error: msg };
      }

      const visible = rawEntries.filter(
        (name) =>
          (!name.startsWith(".") || name === ".gitignore") && !isForbidden(join(targetPath, name)),
      );

      const classified = await Promise.all(
        visible.map(async (name) => {
          try {
            const s = await stat(join(targetPath, name));
            return { name, isDir: s.isDirectory() };
          } catch {
            return { name, isDir: false };
          }
        }),
      );

      const dirs: string[] = [];
      const files: string[] = [];
      for (const { name, isDir } of classified) {
        if (isDir) dirs.push(name);
        else files.push(name);
      }

      const lines: string[] = [];
      for (const d of dirs.sort()) {
        lines.push(`📁 ${d}/`);
      }
      for (const f of files.sort()) {
        lines.push(`   ${f}`);
      }

      const total = dirs.length + files.length;
      const header = relPath === "" ? "." : relPath;
      return {
        success: true,
        output: `${header}/ — ${String(total)} entries\n\n${lines.join("\n")}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: msg, error: msg };
    }
  },
};
