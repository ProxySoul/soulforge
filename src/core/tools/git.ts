import { relative } from "node:path";
import type { ToolResult } from "../../types/index.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
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
import { truncateWithTee } from "./tee.js";

const cwd = process.cwd();
const MAX_GIT_OUTPUT = 32_000;

function capGitOutput(output: string, label: string): string {
  if (output.length <= MAX_GIT_OUTPUT) return output;
  const { text } = truncateWithTee(output, MAX_GIT_OUTPUT, 10_000, 10_000, `git-${label}`);
  return text;
}

function getOtherTabClaimWarning(tabId?: string): string | null {
  if (!tabId) return null;
  const coordinator = getWorkspaceCoordinator();
  const editors = coordinator.getActiveEditors();
  const lines: string[] = [];
  for (const [tid] of editors) {
    if (tid === tabId) continue;
    const tabClaims = coordinator.getClaimsForTab(tid);
    if (tabClaims.size === 0) continue;
    let tabLabel = "Unknown";
    const paths: string[] = [];
    for (const [absPath, claim] of tabClaims) {
      tabLabel = claim.tabLabel;
      paths.push(relative(cwd, absPath) || absPath);
    }
    const shown = paths.slice(0, 5);
    const extra = paths.length > 5 ? ` (+${String(paths.length - 5)} more)` : "";
    lines.push(`  Tab "${tabLabel}": ${shown.join(", ")}${extra}`);
  }
  if (lines.length === 0) return null;
  return `⚠️ Other tabs have active file claims:\n${lines.join("\n")}`;
}

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
  execute: async (args: GitArgs, tabId?: string): Promise<ToolResult> => {
    const destructive =
      args.action === "commit" ||
      args.action === "stash" ||
      args.action === "restore" ||
      (args.action === "branch" && args.sub_action === "switch");

    if (destructive && tabId) {
      const coordinator = getWorkspaceCoordinator();
      const activeTabs = coordinator.getTabsWithActiveAgents(tabId);
      if (activeTabs.length > 0) {
        const tabNames = activeTabs.map((t) => `"${t}"`).join(", ");
        return {
          success: false,
          output: `BLOCKED: Tab ${tabNames} has dispatch agents actively editing files. Your edits are saved to disk. Inform the user the ${args.action} is pending — do not attempt again.`,
          error: "active dispatch",
        };
      }
    }

    const claimWarning = destructive ? getOtherTabClaimWarning(tabId) : null;

    let result: ToolResult;
    switch (args.action) {
      case "status":
        result = await execStatus();
        break;
      case "diff":
        result = await execDiff(args.staged);
        break;
      case "log":
        result = await execLog(args.count);
        break;
      case "commit":
        result = await execCommit(args.message ?? "", args.files, args.amend);
        break;
      case "push":
        result = await execPush();
        break;
      case "pull":
        result = await execPull();
        break;
      case "stash":
        result = await execStash(args.sub_action, args.message, args.index);
        break;
      case "branch":
        result = await execBranch(args.sub_action, args.name);
        break;
      case "show":
        result = await execShow(args.ref);
        break;
      case "unstage":
        result = await execUnstage(args.files);
        break;
      case "restore":
        result = await execRestore(args.files);
        break;
      default:
        result = {
          success: false,
          output: `Unknown action: ${String(args.action)}`,
          error: "bad action",
        };
    }

    // Reset diff cache after any action that changes the working tree
    if (
      result.success &&
      args.action !== "status" &&
      args.action !== "diff" &&
      args.action !== "log" &&
      args.action !== "show"
    ) {
      resetDiffCache();
    }

    if (claimWarning && result.success) {
      result = { ...result, output: `${claimWarning}\n\n${result.output}` };
    }

    if (args.action === "commit" && result.success && tabId) {
      const coordinator = getWorkspaceCoordinator();
      const myClaims = coordinator.getClaimsForTab(tabId);
      if (myClaims.size > 0) {
        const paths = [...myClaims.keys()].map((p) => relative(cwd, p) || p);
        result = {
          ...result,
          output: `${result.output}\n\nFiles you edited this session: ${paths.join(", ")}`,
        };
      }
    }

    return result;
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

let lastDiffOutput: string | null = null;
let lastDiffStaged: boolean | undefined;

async function execDiff(staged?: boolean): Promise<ToolResult> {
  const diff = await getGitDiff(cwd, staged);
  const output = diff || "No changes.";
  if (output === lastDiffOutput && staged === lastDiffStaged) {
    return { success: true, output: "No changes since last diff." };
  }
  lastDiffOutput = output;
  lastDiffStaged = staged;
  return { success: true, output: capGitOutput(output, "diff") };
}

export function resetDiffCache(): void {
  lastDiffOutput = null;
  lastDiffStaged = undefined;
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
      return { success: ok, output: capGitOutput(output || "Empty stash.", "stash-show") };
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
  return { success: result.ok, output: capGitOutput(result.output, "show") };
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
