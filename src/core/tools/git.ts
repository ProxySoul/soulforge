import type { ToolResult } from "../../types/index.js";
import {
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitAdd,
  gitCommit,
  gitCreateBranch,
  gitPull,
  gitPush,
  gitRestore,
  gitShow,
  gitStash,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashShow,
  gitSwitchBranch,
  gitUnstage,
  run,
} from "../git/status.js";

const cwd = process.cwd();

type GitAction =
  | "status"
  | "diff"
  | "log"
  | "commit"
  | "push"
  | "pull"
  | "stash"
  | "branch"
  | "show"
  | "unstage"
  | "restore";

interface GitArgs {
  action: GitAction;
  staged?: boolean;
  count?: number;
  message?: string;
  files?: string[];
  sub_action?: string;
  name?: string;
  index?: number;
  amend?: boolean;
  ref?: string;
}

export const gitTool = {
  name: "git" as const,
  description:
    "Git operations: status, diff, log, commit (with amend), push, pull, stash, branch, show (view commit), unstage, restore.",
  execute: async (args: GitArgs): Promise<ToolResult> => {
    switch (args.action) {
      case "status":
        return execStatus();
      case "diff":
        return execDiff(args.staged);
      case "log":
        return execLog(args.count);
      case "commit":
        return execCommit(args.message ?? "", args.files, args.amend);
      case "push":
        return execPush();
      case "pull":
        return execPull();
      case "stash":
        return execStash(args.sub_action, args.message, args.index);
      case "branch":
        return execBranch(args.sub_action, args.name);
      case "show":
        return execShow(args.ref);
      case "unstage":
        return execUnstage(args.files);
      case "restore":
        return execRestore(args.files);
      default:
        return {
          success: false,
          output: `Unknown action: ${String(args.action)}`,
          error: "bad action",
        };
    }
  },
};

async function execStatus(): Promise<ToolResult> {
  const s = await getGitStatus(cwd);
  if (!s.isRepo) return { success: false, output: "Not a git repository", error: "not a repo" };
  const lines = [`Branch: ${s.branch ?? "detached"}`];
  if (s.staged.length > 0)
    lines.push(`Staged (${String(s.staged.length)}): ${s.staged.join(", ")}`);
  if (s.modified.length > 0)
    lines.push(`Modified (${String(s.modified.length)}): ${s.modified.join(", ")}`);
  if (s.untracked.length > 0)
    lines.push(`Untracked (${String(s.untracked.length)}): ${s.untracked.join(", ")}`);
  if (s.conflicts.length > 0)
    lines.push(`Conflicts (${String(s.conflicts.length)}): ${s.conflicts.join(", ")}`);
  if (s.ahead > 0 || s.behind > 0)
    lines.push(`Ahead: ${String(s.ahead)} | Behind: ${String(s.behind)}`);
  lines.push(s.isDirty ? "Status: dirty" : "Status: clean");
  return { success: true, output: lines.join("\n") };
}

async function execDiff(staged?: boolean): Promise<ToolResult> {
  const diff = await getGitDiff(cwd, staged);
  return { success: true, output: diff || "No changes." };
}

async function execLog(count?: number): Promise<ToolResult> {
  const entries = await getGitLog(cwd, count ?? 10);
  if (entries.length === 0) return { success: true, output: "No commits found." };
  return {
    success: true,
    output: entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"),
  };
}

async function execCommit(message: string, files?: string[], amend?: boolean): Promise<ToolResult> {
  if (files && files.length > 0) {
    const ok = await gitAdd(cwd, files);
    if (!ok) return { success: false, output: "Failed to stage files", error: "staging failed" };
  }
  if (!amend) {
    const diff = await getGitDiff(cwd, true);
    if (!diff) {
      return {
        success: false,
        output: "Nothing staged to commit. Stage files first.",
        error: "nothing staged",
      };
    }
  }
  const result = await gitCommit(cwd, message, amend);
  if (!result.ok) return { success: false, output: result.output, error: "commit failed" };
  const diff = await getGitDiff(cwd, true);
  const diffLines = (diff || "").split("\n");
  const statLines = diffLines.filter((l) => l.startsWith("+++") || l.startsWith("---")).length;
  const additions = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const prefix = amend ? "Amended" : "Committed";
  return {
    success: true,
    output: `${prefix}: ${result.output}\n\nDiff summary: ~${String(statLines / 2)} files, +${String(additions)} -${String(deletions)} lines`,
  };
}

async function execPush(): Promise<ToolResult> {
  const result = await gitPush(cwd);
  return { success: result.ok, output: result.output };
}

async function execPull(): Promise<ToolResult> {
  const result = await gitPull(cwd);
  return { success: result.ok, output: result.output };
}

async function execStash(
  subAction?: string,
  message?: string,
  index?: number,
): Promise<ToolResult> {
  const action = subAction ?? "push";
  switch (action) {
    case "list": {
      const { ok, entries } = await gitStashList(cwd);
      if (!ok)
        return { success: false, output: "Failed to list stashes", error: "stash list failed" };
      return { success: true, output: entries.length > 0 ? entries.join("\n") : "No stashes." };
    }
    case "show": {
      const { ok, output } = await gitStashShow(cwd, index ?? 0);
      return { success: ok, output: output || "Empty stash." };
    }
    case "drop": {
      const { ok, output } = await gitStashDrop(cwd, index ?? 0);
      return { success: ok, output };
    }
    case "pop": {
      const result = await gitStashPop(cwd);
      return { success: result.ok, output: result.output };
    }
    default: {
      const result = await gitStash(cwd, message);
      return { success: result.ok, output: result.output };
    }
  }
}

async function execBranch(subAction?: string, name?: string): Promise<ToolResult> {
  const action = subAction ?? "list";
  switch (action) {
    case "list": {
      const { ok, stdout } = await run(["branch", "-vv"], cwd);
      return { success: ok, output: stdout || "No branches." };
    }
    case "create": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, output } = await gitCreateBranch(cwd, name);
      return { success: ok, output: output || `Created and switched to ${name}` };
    }
    case "switch": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, output } = await gitSwitchBranch(cwd, name);
      return { success: ok, output: output || `Switched to ${name}` };
    }
    case "delete": {
      if (!name) return { success: false, output: "Branch name required", error: "missing name" };
      const { ok, stdout } = await run(["branch", "-d", name], cwd);
      return { success: ok, output: stdout || `Deleted ${name}` };
    }
    default:
      return { success: false, output: `Unknown branch action: ${action}`, error: "bad action" };
  }
}

async function execShow(ref?: string): Promise<ToolResult> {
  const result = await gitShow(cwd, ref ?? "HEAD");
  return { success: result.ok, output: result.output };
}

async function execUnstage(files?: string[]): Promise<ToolResult> {
  if (!files || files.length === 0) {
    return { success: false, output: "Specify files to unstage", error: "missing files" };
  }
  const result = await gitUnstage(cwd, files);
  return { success: result.ok, output: result.output };
}

async function execRestore(files?: string[]): Promise<ToolResult> {
  if (!files || files.length === 0) {
    return { success: false, output: "Specify files to restore", error: "missing files" };
  }
  const result = await gitRestore(cwd, files);
  return { success: result.ok, output: result.output };
}
