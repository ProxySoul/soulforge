import { spawn } from "node:child_process";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT_BYTES = 16_384;

// Commands that read file content
const FILE_READ_RE =
  /\b(cat|head|tail|less|more|bat|xxd|hexdump|strings|base64|tac|nl|od|file)\s+(.+)/;
// Commands that search file content
const FILE_SEARCH_RE = /\b(grep|rg|ag|ack|sed|awk)\s+(.+)/;
// Input redirection: command < file
const INPUT_REDIR_RE = /<\s*([^\s|&;]+)/g;
// Output redirection to a file: > file, >> file
const OUTPUT_REDIR_RE = />{1,2}\s*([^\s|&;]+)/g;

function extractPathArgs(argsStr: string): string[] {
  return argsStr
    .split(/\s+/)
    .filter((a) => !a.startsWith("-"))
    .map((a) => a.replace(/['"]/g, ""));
}

// Subshell / variable expansion patterns that could bypass direct path checks
const SUBSHELL_RE = /\$\(|`[^`]*`|\$\{/;

function extractAllPathLikeArgs(command: string): string[] {
  const paths: string[] = [];
  const words = command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  for (const w of words) {
    const cleaned = w.replace(/^['"]|['"]$/g, "");
    if (cleaned.startsWith("-") || cleaned.includes("=")) continue;
    if (/^[a-z_/~.][\w./~*?-]*$/i.test(cleaned)) {
      paths.push(cleaned);
    }
  }
  return paths;
}

function checkShellForbidden(command: string): string | null {
  // Check ALL path-like arguments in the command against forbidden patterns
  for (const arg of extractAllPathLikeArgs(command)) {
    const blocked = isForbidden(arg);
    if (blocked) return blocked;
  }

  // Check direct file-reading commands
  const readMatch = command.match(FILE_READ_RE);
  if (readMatch) {
    for (const arg of extractPathArgs(readMatch[2] ?? "")) {
      const blocked = isForbidden(arg);
      if (blocked) return blocked;
    }
  }

  // Check search commands (last non-flag arg is often the path)
  const searchMatch = command.match(FILE_SEARCH_RE);
  if (searchMatch) {
    for (const arg of extractPathArgs(searchMatch[2] ?? "")) {
      const blocked = isForbidden(arg);
      if (blocked) return blocked;
    }
  }

  // Check input redirection (< file)
  for (const m of command.matchAll(INPUT_REDIR_RE)) {
    if (m[1]) {
      const blocked = isForbidden(m[1].replace(/['"]/g, ""));
      if (blocked) return blocked;
    }
  }

  // Check output redirection (> file, >> file)
  for (const m of command.matchAll(OUTPUT_REDIR_RE)) {
    if (m[1]) {
      const blocked = isForbidden(m[1].replace(/['"]/g, ""));
      if (blocked) return blocked;
    }
  }

  // Block subshell / variable expansion — extract inner content and check paths
  if (SUBSHELL_RE.test(command)) {
    const SENSITIVE_KW = [
      "env",
      "pem",
      "key",
      "credentials",
      "secrets",
      "npmrc",
      "netrc",
      "htpasswd",
      "ssh",
      "token",
      "passwd",
      "shadow",
      "aws",
    ];
    const lower = command.toLowerCase();
    for (const kw of SENSITIVE_KW) {
      if (lower.includes(kw)) return `suspicious subshell referencing "${kw}"`;
    }
    for (const m of command.matchAll(/\$\(([^)]+)\)/g)) {
      const inner = m[1] ?? "";
      for (const arg of extractAllPathLikeArgs(inner)) {
        const blocked = isForbidden(arg);
        if (blocked) return blocked;
      }
    }
    for (const m of command.matchAll(/`([^`]+)`/g)) {
      const inner = m[1] ?? "";
      for (const arg of extractAllPathLikeArgs(inner)) {
        const blocked = isForbidden(arg);
        if (blocked) return blocked;
      }
    }
  }

  return null;
}

interface ShellArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

export const shellTool = {
  name: "shell",
  description:
    "Run a shell command (build, test, lint, install, git, etc). " +
    "For type-checking, prefer analyze diagnostics. For file search, prefer grep/glob.",
  execute: async (args: ShellArgs): Promise<ToolResult> => {
    const command = args.command;
    const cwd = args.cwd ?? process.cwd();

    // Check if the command tries to read forbidden files
    const blocked = checkShellForbidden(command);
    if (blocked) {
      const msg = `Access denied: command references a file matching forbidden pattern "${blocked}".`;
      return { success: false, output: msg, error: msg };
    }
    const timeout = args.timeout ?? DEFAULT_TIMEOUT;

    return new Promise((resolve) => {
      const chunks: string[] = [];
      const errChunks: string[] = [];

      const proc = spawn("sh", ["-c", command], {
        cwd,
        timeout,
        env: { ...process.env },
      });

      proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
      proc.stderr.on("data", (data: Buffer) => errChunks.push(data.toString()));

      proc.on("close", (code: number | null) => {
        let stdout = chunks.join("");
        const stderr = errChunks.join("");

        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = `${stdout.slice(0, MAX_OUTPUT_BYTES)}\n\n... [truncated: output exceeded ${String(MAX_OUTPUT_BYTES)} bytes]`;
        }

        if (code === 0) {
          resolve({ success: true, output: stdout || stderr });
        } else if (code === null) {
          resolve({
            success: false,
            output: stdout || stderr,
            error: `Command timed out after ${String(timeout / 1000)}s`,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Exit code: ${code}`,
          });
        }
      });

      proc.on("error", (err: Error) => {
        resolve({ success: false, output: err.message, error: err.message });
      });
    });
  },
};
