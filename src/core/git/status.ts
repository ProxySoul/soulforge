import { spawn } from "node:child_process";

const encoder = new TextEncoder();

interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  isDirty: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicts: string[];
  ahead: number;
  behind: number;
}

interface GitLogEntry {
  hash: string;
  subject: string;
  date: string;
}

export function run(
  args: string[],
  cwd: string,
  timeout = 5_000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = spawn("git", args, { cwd, timeout, env: { ...process.env } });
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: chunks.join("") }));
    proc.on("error", () => resolve({ ok: false, stdout: "" }));
  });
}

export function parseGitLogLine(line: string): GitLogEntry {
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return { hash: line, subject: "", date: "" };
  const hash = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);
  const parenIdx = rest.lastIndexOf("(");
  const subject = parenIdx >= 0 ? rest.slice(0, parenIdx).trim() : rest;
  const date = parenIdx >= 0 ? rest.slice(parenIdx + 1, -1) : "";
  return { hash, subject, date };
}

const NAMED_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  a: "\x07",
  b: "\b",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner.charAt(i + 1);
      if (next >= "0" && next <= "7") {
        let octal = next;
        const c2 = inner.charAt(i + 2);
        if (c2 >= "0" && c2 <= "7") {
          octal += c2;
          const c3 = inner.charAt(i + 3);
          if (c3 >= "0" && c3 <= "7") {
            octal += c3;
          }
        }
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length;
        continue;
      }
      const named = NAMED_ESCAPES[next];
      if (named !== undefined) {
        for (let j = 0; j < named.length; j++) {
          bytes.push(named.charCodeAt(j));
        }
        i++;
        continue;
      }
    }
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else {
      const encoded = encoder.encode(ch);
      for (const b of encoded) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseStatusLine(line: string): {
  x: string;
  y: string;
  file: string;
  category: "untracked" | "staged" | "modified" | "none";
} {
  const x = line[0] ?? "";
  const y = line[1] ?? "";
  const raw = line.slice(3);
  const arrowIdx = raw.indexOf(" -> ");
  const file = unquoteGitPath(arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw);
  let category: "untracked" | "staged" | "modified" | "none" = "none";
  if (x === "?") {
    category = "untracked";
  } else {
    if (x && x !== " " && x !== "?") category = "staged";
    if (y && y !== " " && y !== "?") category = "modified";
  }
  return { x, y, file, category };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { ok } = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  return ok;
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  const { ok, stdout } = await run(["branch", "--show-current"], cwd);
  return ok ? stdout.trim() || null : null;
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const repoCheck = await isGitRepo(cwd);
  if (!repoCheck) {
    return {
      isRepo: false,
      branch: null,
      isDirty: false,
      staged: [],
      modified: [],
      untracked: [],
      conflicts: [],
      ahead: 0,
      behind: 0,
    };
  }

  const [branchResult, statusResult, aheadBehindResult] = await Promise.all([
    getGitBranch(cwd),
    run(["status", "--porcelain=v1"], cwd),
    run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd),
  ]);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];

  if (statusResult.ok) {
    for (const raw of statusResult.stdout.split("\n")) {
      if (!raw) continue;
      const parsed = parseStatusLine(raw);
      const x = raw[0];
      const y = raw[1];
      if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) {
        conflicts.push(parsed.file);
      } else if (parsed.category === "untracked") {
        untracked.push(parsed.file);
      } else {
        if (x && x !== " " && x !== "?") staged.push(parsed.file);
        if (y && y !== " " && y !== "?") modified.push(parsed.file);
      }
    }
  }

  let ahead = 0;
  let behind = 0;
  if (aheadBehindResult.ok) {
    const parts = aheadBehindResult.stdout.trim().split(/\s+/);
    ahead = Number.parseInt(parts[0] ?? "0", 10) || 0;
    behind = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  return {
    isRepo: true,
    branch: branchResult,
    isDirty: staged.length > 0 || modified.length > 0 || untracked.length > 0,
    staged,
    modified,
    untracked,
    conflicts,
    ahead,
    behind,
  };
}

export async function getGitDiff(cwd: string, staged?: boolean): Promise<string> {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  const { stdout } = await run(args, cwd);
  return stdout;
}

export async function getGitLog(cwd: string, count = 10): Promise<GitLogEntry[]> {
  const { ok, stdout } = await run(
    ["log", `--oneline`, `-n`, String(count), "--format=%h %s (%cr)"],
    cwd,
  );
  if (!ok) return [];
  const lines = stdout.trim().split("\n").filter(Boolean);
  try {
    const { getIOClient } = await import("../workers/io-client.js");
    return await getIOClient().parseGitLogBatch(lines);
  } catch {
    return lines.map(parseGitLogLine);
  }
}

export async function gitInit(cwd: string): Promise<boolean> {
  const { ok } = await run(["init"], cwd);
  return ok;
}

const CO_AUTHOR_LINE = "Co-Authored-By: SoulForge <soulforge@proxysoul.com>";
let _coAuthorEnabled = true;

export function setCoAuthorEnabled(enabled: boolean) {
  _coAuthorEnabled = enabled;
}

export async function gitCommit(
  cwd: string,
  message: string,
  amend?: boolean,
): Promise<{ ok: boolean; output: string }> {
  const fullMessage = _coAuthorEnabled ? `${message}\n\n${CO_AUTHOR_LINE}` : message;
  const args = amend ? ["commit", "--amend", "-m", fullMessage] : ["commit", "-m", fullMessage];
  const { ok, stdout } = await run(args, cwd);
  return { ok, output: stdout };
}

export async function gitShow(cwd: string, ref: string): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["show", "--stat", "--format=%H %s%n%an <%ae>%n%ai", ref], cwd);
  return { ok, output: stdout };
}

export async function gitUnstage(
  cwd: string,
  files: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["reset", "HEAD", ...files], cwd);
  return { ok, output: stdout || `Unstaged ${String(files.length)} file(s)` };
}

export async function gitRestore(
  cwd: string,
  files: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["restore", ...files], cwd);
  return { ok, output: stdout || `Restored ${String(files.length)} file(s)` };
}

export async function gitAdd(cwd: string, files: string[]): Promise<boolean> {
  const { ok } = await run(["add", ...files], cwd);
  return ok;
}

export async function gitPush(
  cwd: string,
  args?: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["push", ...(args ?? [])], cwd, 30_000);
  return { ok, output: stdout };
}

export async function gitPull(
  cwd: string,
  args?: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["pull", ...(args ?? [])], cwd, 30_000);
  return { ok, output: stdout };
}

export async function gitStash(
  cwd: string,
  message?: string,
): Promise<{ ok: boolean; output: string }> {
  const args = message ? ["stash", "push", "-m", message] : ["stash"];
  const { ok, stdout } = await run(args, cwd);
  return { ok, output: stdout };
}

export async function gitStashPop(cwd: string): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "pop"], cwd);
  return { ok, output: stdout };
}

export async function gitStashList(cwd: string): Promise<{ ok: boolean; entries: string[] }> {
  const { ok, stdout } = await run(["stash", "list"], cwd);
  if (!ok) return { ok: false, entries: [] };
  return { ok: true, entries: stdout.trim().split("\n").filter(Boolean) };
}

export async function gitStashShow(
  cwd: string,
  index = 0,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "show", "-p", `stash@{${String(index)}}`], cwd);
  return { ok, output: stdout };
}

export async function gitStashDrop(
  cwd: string,
  index = 0,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "drop", `stash@{${String(index)}}`], cwd);
  return { ok, output: stdout };
}

export async function gitCreateBranch(
  cwd: string,
  name: string,
  checkout = true,
): Promise<{ ok: boolean; output: string }> {
  if (checkout) {
    const { ok, stdout } = await run(["checkout", "-b", name], cwd);
    return { ok, output: stdout };
  }
  const { ok, stdout } = await run(["branch", name], cwd);
  return { ok, output: stdout };
}

export async function gitSwitchBranch(
  cwd: string,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["checkout", name], cwd);
  return { ok, output: stdout };
}

export async function buildGitContext(cwd: string): Promise<string | null> {
  const status = await getGitStatus(cwd);
  if (!status.isRepo) return null;

  const { ok: upOk, stdout: upOut } = await run(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  const upstream = upOk ? upOut.trim() : null;

  const lines: string[] = [];
  const branchLine = `Branch: ${status.branch ?? "(detached)"}`;
  lines.push(upstream ? `${branchLine} → ${upstream}` : branchLine);
  if (status.conflicts.length > 0) {
    lines.push(
      `⚠ Merge conflicts (${String(status.conflicts.length)}): ${status.conflicts.join(", ")}`,
    );
  }
  if (status.isDirty) {
    const parts: string[] = [];
    if (status.staged.length > 0) parts.push(`${String(status.staged.length)} staged`);
    if (status.modified.length > 0) parts.push(`${String(status.modified.length)} modified`);
    if (status.untracked.length > 0) parts.push(`${String(status.untracked.length)} untracked`);
    lines.push(`Status: dirty (${parts.join(", ")})`);
  } else {
    lines.push("Status: clean");
  }
  if (status.ahead > 0) lines.push(`Ahead: ${String(status.ahead)} commit(s)`);
  if (status.behind > 0) lines.push(`Behind: ${String(status.behind)} commit(s)`);

  const log = await getGitLog(cwd, 5);
  if (log.length > 0) {
    lines.push("", "Recent commits:");
    for (const entry of log) {
      lines.push(`  ${entry.hash} ${entry.subject} (${entry.date})`);
    }
  }

  return lines.join("\n");
}
