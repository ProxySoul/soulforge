import { spawn } from "node:child_process";
import type { ToolResult } from "../../types";
import { isForbidden } from "../security/forbidden.js";
import { truncateWithTee } from "./tee.js";

const DEFAULT_TIMEOUT = 30_000;

// ─── Git Commit Interception ───
// Intercept `git commit -m "..."` to:
// 1. Auto-run lint/typecheck on staged files before committing
// 2. Append co-author trailer when enabled

const CO_AUTHOR_LINE = "Co-Authored-By: SoulForge <soulforge@proxysoul.com>";
let _shellCoAuthorEnabled = true;

export function setShellCoAuthorEnabled(enabled: boolean) {
  _shellCoAuthorEnabled = enabled;
}

const GIT_COMMIT_MSG_RE = /\bgit\s+commit\b.*?\s-m\s+/;

let _preCommitEnabled = true;

async function runPreCommitChecks(cwd: string): Promise<string | null> {
  if (!_preCommitEnabled) return null;

  let lintCmd: string | null = null;
  try {
    const { detectNativeChecks } = await import("./project.js");
    lintCmd = detectNativeChecks(cwd);
  } catch {
    return null;
  }
  if (!lintCmd) return null;

  try {
    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const chunks: string[] = [];
      const errChunks: string[] = [];
      const proc = spawn("sh", ["-c", lintCmd], { cwd, timeout: 15_000, env: { ...process.env } });
      proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on("data", (d: Buffer) => errChunks.push(d.toString()));
      proc.on("close", (code) =>
        resolve({ exitCode: code, stdout: chunks.join(""), stderr: errChunks.join("") }),
      );
      proc.on("error", () => resolve({ exitCode: 1, stdout: "", stderr: "lint process error" }));
    });

    if (exitCode !== 0) {
      const output = (stderr.trim() || stdout.trim()).split("\n");
      const truncated =
        output.length > 30
          ? `${output.slice(0, 30).join("\n")}\n... (${String(output.length - 30)} more lines)`
          : output.join("\n");
      return `Pre-commit check failed (${lintCmd}):\n${truncated}\n\nFix errors before committing. Use project(action: "lint", fix: true) to auto-fix.`;
    }
  } catch {
    return null;
  }
  return null;
}

function injectCoAuthor(command: string): string {
  if (!_shellCoAuthorEnabled) return command;
  if (!GIT_COMMIT_MSG_RE.test(command)) return command;
  if (command.includes("Co-Authored-By")) return command;
  if (command.includes("--amend")) return command;

  // Match -m "msg" or -m 'msg' and inject trailer before closing quote
  return command.replace(
    /(-m\s+)(["'])([\s\S]*?)\2/,
    (_match, flag: string, quote: string, msg: string) => {
      const trailer = `\\n\\n${CO_AUTHOR_LINE}`;
      return `${flag}${quote}${msg}${trailer}${quote}`;
    },
  );
}
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
  const tokens = argsStr.match(/(?:'([^']*)'|"([^"]*)"|(\S+))/g) ?? [];
  const re = /^'([^']*)'$|^"([^"]*)"$|^(\S+)$/;
  return tokens.flatMap((t) => {
    const m = t.match(re);
    if (!m) return [];
    const val = m[1] ?? m[2] ?? m[3] ?? "";
    return val.startsWith("-") ? [] : [val];
  });
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

const READ_CMD_REDIRECT: Record<string, string> = {
  cat: "read_file",
  head: "read_file",
  tail: "read_file",
  less: "read_file",
  more: "read_file",
  bat: "read_file",
  tac: "read_file",
  nl: "read_file",
  grep: "grep",
  rg: "grep",
  ag: "grep",
  ack: "grep",
  find: "glob",
};

const PROJECT_CMD_RE =
  /^(?:bun run|bunx|npm run|npx|pnpm|yarn|deno|cargo|go |mix |dotnet |flutter |dart |swift |zig )\s*(lint|test|typecheck|build|check|clippy|vet|fmt|format)\b/;

function detectReadCommand(command: string): string | null {
  const trimmed = command.trim();
  const first = trimmed.split(/[\s|;&]/)[0]?.replace(/^.*\//, "") ?? "";
  const target = READ_CMD_REDIRECT[first];
  if (!target) return null;
  if (trimmed.includes("|") || trimmed.includes("&&") || trimmed.includes(";")) return null;
  return `Command succeeded, but ${target} is faster, gets cached, and is visible to dispatch dedup. Use ${target} instead of shell for this.`;
}

function detectProjectCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.includes("|") || trimmed.includes("&&") || trimmed.includes(";")) return null;
  const m = trimmed.match(PROJECT_CMD_RE);
  if (!m) return null;
  const action = m[1] ?? "";
  const mapped =
    action === "check" ||
    action === "clippy" ||
    action === "vet" ||
    action === "fmt" ||
    action === "format"
      ? "lint"
      : action;
  if (["lint", "test", "typecheck", "build"].includes(mapped)) {
    return `Command succeeded. Next time use project(action: "${mapped}") — it auto-detects the toolchain, results are structured, and output is visible in the UI.`;
  }
  return null;
}

export const shellTool = {
  name: "shell",
  description: "Run a shell command.",
  execute: async (args: ShellArgs, abortSignal?: AbortSignal): Promise<ToolResult> => {
    const command = injectCoAuthor(args.command);
    const cwd = args.cwd ?? process.cwd();

    const blocked = checkShellForbidden(command);
    if (blocked) {
      const msg = `Access denied: command references a file matching forbidden pattern "${blocked}".`;
      return { success: false, output: msg, error: msg };
    }

    if (GIT_COMMIT_MSG_RE.test(args.command)) {
      const lintErr = await runPreCommitChecks(cwd);
      if (lintErr) return { success: false, output: lintErr, error: lintErr };
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

      if (abortSignal) {
        const onAbort = () => {
          try {
            proc.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, 500);
        };
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      proc.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
      proc.stderr.on("data", (data: Buffer) => errChunks.push(data.toString()));

      proc.on("close", (code: number | null) => {
        let stdout = chunks.join("");
        const stderr = errChunks.join("");

        if (stdout.length > MAX_OUTPUT_BYTES) {
          const { text } = truncateWithTee(stdout, MAX_OUTPUT_BYTES, 4000, 10000, "shell");
          stdout = text;
        }

        if (code === 0) {
          const hint = detectReadCommand(command) ?? detectProjectCommand(command);
          const output = hint ? `${stdout || stderr}\n\n${hint}` : stdout || stderr;
          resolve({ success: true, output });
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
