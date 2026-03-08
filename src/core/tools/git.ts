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
  gitStash,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashShow,
  gitSwitchBranch,
  run,
} from "../git/status.js";

const cwd = process.cwd();

export const gitStatusTool = {
  name: "git_status" as const,
  description:
    "Get repository status: branch name, staged/modified/untracked files, ahead/behind counts.",
  execute: async (): Promise<ToolResult> => {
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
      lines.push(`⚠ Conflicts (${String(s.conflicts.length)}): ${s.conflicts.join(", ")}`);
    if (s.ahead > 0 || s.behind > 0)
      lines.push(`Ahead: ${String(s.ahead)} | Behind: ${String(s.behind)}`);
    lines.push(s.isDirty ? "Status: dirty" : "Status: clean");
    return { success: true, output: lines.join("\n") };
  },
};

export const gitDiffTool = {
  name: "git_diff" as const,
  description: "Get git diff output. Use staged=true for staged changes, false for unstaged.",
  execute: async (args: { staged?: boolean }): Promise<ToolResult> => {
    const diff = await getGitDiff(cwd, args.staged);
    return { success: true, output: diff || "No changes." };
  },
};

export const gitLogTool = {
  name: "git_log" as const,
  description: "View recent commit history.",
  execute: async (args: { count?: number }): Promise<ToolResult> => {
    const entries = await getGitLog(cwd, args.count ?? 10);
    if (entries.length === 0) return { success: true, output: "No commits found." };
    return {
      success: true,
      output: entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n"),
    };
  },
};

export const gitCommitTool = {
  name: "git_commit" as const,
  description:
    "Stage files and commit. Returns the staged diff summary and commit result. If files is omitted, commits currently staged files.",
  execute: async (args: { message: string; files?: string[] }): Promise<ToolResult> => {
    if (args.files && args.files.length > 0) {
      const ok = await gitAdd(cwd, args.files);
      if (!ok) return { success: false, output: "Failed to stage files", error: "staging failed" };
    }
    const diff = await getGitDiff(cwd, true);
    if (!diff) {
      return {
        success: false,
        output: "Nothing staged to commit. Stage files first.",
        error: "nothing staged",
      };
    }
    const result = await gitCommit(cwd, args.message);
    if (!result.ok) return { success: false, output: result.output, error: "commit failed" };
    const diffLines = diff.split("\n");
    const statLines = diffLines.filter((l) => l.startsWith("+++") || l.startsWith("---")).length;
    const additions = diffLines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = diffLines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    return {
      success: true,
      output: `${result.output}\n\nDiff summary: ~${String(statLines / 2)} files, +${String(additions)} -${String(deletions)} lines`,
    };
  },
};

export const gitPushTool = {
  name: "git_push" as const,
  description: "Push commits to the remote repository.",
  execute: async (): Promise<ToolResult> => {
    const result = await gitPush(cwd);
    return { success: result.ok, output: result.output };
  },
};

export const gitPullTool = {
  name: "git_pull" as const,
  description: "Pull latest changes from the remote repository.",
  execute: async (): Promise<ToolResult> => {
    const result = await gitPull(cwd);
    return { success: result.ok, output: result.output };
  },
};

export const gitStashTool = {
  name: "git_stash" as const,
  description:
    "Manage stashes. Actions: 'push' (default), 'pop', 'list', 'show', 'drop'. Index selects which stash (default 0).",
  execute: async (args: {
    action?: "push" | "pop" | "list" | "show" | "drop";
    message?: string;
    index?: number;
  }): Promise<ToolResult> => {
    const action = args.action ?? "push";
    switch (action) {
      case "list": {
        const { ok, entries } = await gitStashList(cwd);
        if (!ok)
          return { success: false, output: "Failed to list stashes", error: "stash list failed" };
        return { success: true, output: entries.length > 0 ? entries.join("\n") : "No stashes." };
      }
      case "show": {
        const { ok, output } = await gitStashShow(cwd, args.index ?? 0);
        return { success: ok, output: output || "Empty stash." };
      }
      case "drop": {
        const { ok, output } = await gitStashDrop(cwd, args.index ?? 0);
        return { success: ok, output };
      }
      case "pop": {
        const result = await gitStashPop(cwd);
        return { success: result.ok, output: result.output };
      }
      default: {
        const result = await gitStash(cwd, args.message);
        return { success: result.ok, output: result.output };
      }
    }
  },
};

export const gitBranchTool = {
  name: "git_branch" as const,
  description:
    "Branch operations: 'list' (default), 'create', 'switch', 'delete'. Creates and switches in one step by default.",
  execute: async (args: {
    action?: "list" | "create" | "switch" | "delete";
    name?: string;
  }): Promise<ToolResult> => {
    const action = args.action ?? "list";
    switch (action) {
      case "list": {
        const { ok, stdout } = await run(["branch", "-vv"], cwd);
        return { success: ok, output: stdout || "No branches." };
      }
      case "create": {
        if (!args.name)
          return { success: false, output: "Branch name required", error: "missing name" };
        const { ok, output } = await gitCreateBranch(cwd, args.name);
        return { success: ok, output: output || `Created and switched to ${args.name}` };
      }
      case "switch": {
        if (!args.name)
          return { success: false, output: "Branch name required", error: "missing name" };
        const { ok, output } = await gitSwitchBranch(cwd, args.name);
        return { success: ok, output: output || `Switched to ${args.name}` };
      }
      case "delete": {
        if (!args.name)
          return { success: false, output: "Branch name required", error: "missing name" };
        const { ok, stdout } = await run(["branch", "-d", args.name], cwd);
        return { success: ok, output: stdout || `Deleted ${args.name}` };
      }
      default:
        return { success: false, output: `Unknown action: ${action}`, error: "bad action" };
    }
  },
};
