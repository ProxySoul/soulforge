import { resolve } from "node:path";
import { classifyPath, type OutsideKind } from "../../core/security/outside-cwd.js";
import { SUBAGENT_NAMES } from "./ToolCallDisplay.js";

const CWD = process.cwd();

const ABS_PATH_RE = /(?:^|\s)(\/[\w./-]+)/g;

export function formatArgs(toolName: string, args?: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args);
    if (toolName === "read_file" && parsed.path) return parsed.path;
    if (toolName === "edit_file" && parsed.path) return parsed.path;
    if (toolName === "shell" && parsed.command) {
      const cmd = String(parsed.command);
      return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
    }
    if (toolName === "grep" && parsed.pattern) return `/${parsed.pattern}/`;
    if (toolName === "glob" && parsed.pattern) return parsed.pattern;
    if (toolName === "web_search" && parsed.query) {
      const q = String(parsed.query);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    if (toolName === "memory" && parsed.action === "write" && parsed.title) {
      const s = String(parsed.title);
      return s.length > 50 ? `${s.slice(0, 47)}...` : s;
    }
    if (toolName === "memory" && parsed.action) {
      if (parsed.action === "search" && parsed.query) return `search: ${String(parsed.query)}`;
      return String(parsed.action);
    }
    if (toolName === "dispatch" && parsed.tasks) {
      const tasks = parsed.tasks as Array<{ task: string; role?: string }>;
      const roles = new Set(tasks.map((t) => t.role ?? "explore"));
      const roleTags = [...roles].map((r) => `[${r}]`).join("");
      if (tasks.length === 1 && tasks[0]) {
        const t = String(tasks[0].task);
        const trimmed = t.length > 45 ? `${t.slice(0, 42)}...` : t;
        return `${roleTags} ${trimmed}`;
      }
      const obj = parsed.objective ? String(parsed.objective) : `${String(tasks.length)} agents`;
      const label = parsed.objective ? `${String(tasks.length)} agents — ${obj}` : obj;
      const trimmed = label.length > 55 ? `${label.slice(0, 52)}...` : label;
      return `${roleTags} ${trimmed}`;
    }
    if (toolName === "editor" && parsed.action) {
      if (parsed.action === "read" && parsed.startLine)
        return `read lines ${String(parsed.startLine)}-${String(parsed.endLine ?? "end")}`;
      if (parsed.action === "edit" && parsed.startLine)
        return `edit lines ${String(parsed.startLine)}-${String(parsed.endLine)}`;
      if (parsed.action === "navigate") {
        if (parsed.file) return String(parsed.file);
        if (parsed.search) return `/${String(parsed.search)}/`;
        if (parsed.line) return `line ${String(parsed.line)}`;
      }
      if (parsed.action === "rename" && parsed.newName) return `rename → ${String(parsed.newName)}`;
      return String(parsed.action);
    }
    if (toolName === "update_plan_step" && parsed.stepId) {
      return `${String(parsed.stepId)} → ${String(parsed.status ?? "")}`;
    }
    if (toolName === "ask_user" && parsed.question) {
      const q = String(parsed.question);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    if (toolName === "read_file" && parsed.target && parsed.path) {
      const label = parsed.name
        ? `${String(parsed.name)} in ${String(parsed.path)}`
        : String(parsed.path);
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "navigate") {
      const parts = [parsed.action, parsed.symbol, parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "analyze") {
      const parts = [parsed.action, parsed.symbol ?? parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "rename_symbol") {
      const label = `${String(parsed.symbol ?? "")} → ${String(parsed.newName ?? "")}`;
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "refactor") {
      const parts = [parsed.action, parsed.symbol].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "project") {
      const parts = [parsed.action, parsed.file].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "move_symbol") {
      const label = `${String(parsed.symbol ?? "")} → ${String(parsed.to ?? "")}`;
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "discover_pattern" && parsed.query) {
      return String(parsed.query);
    }
    if (toolName === "test_scaffold" && parsed.file) {
      return String(parsed.file);
    }
    if (toolName === "write_plan" || toolName === "plan") {
      if (parsed.title) return String(parsed.title);
      return "plan";
    }
    if (toolName === "git" && parsed.action) {
      if (parsed.action === "commit" && parsed.message) {
        const m = String(parsed.message);
        return m.length > 50 ? `${m.slice(0, 47)}...` : m;
      }
      if (parsed.action === "log" && parsed.count) return `log last ${String(parsed.count)}`;
      if (parsed.action === "diff") return parsed.staged ? "diff staged" : "diff";
      if (parsed.action === "stash") return `stash ${String(parsed.sub_action ?? "push")}`;
      if (parsed.action === "branch") return `branch ${String(parsed.sub_action ?? "list")}`;
      return String(parsed.action);
    }
    if (toolName === "code_execution") {
      if (parsed.code) {
        const code = String(parsed.code);
        return code.length > 60 ? `${code.slice(0, 57)}...` : code;
      }
      if (parsed.command) {
        const cmd = String(parsed.command);
        return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
      }
    }
  } catch {}
  return "";
}

export function formatResult(toolName: string, result?: string): string {
  if (!result) return "";
  try {
    const p = JSON.parse(result);
    if (p.repoMapHit && p.output) {
      const out = String(p.output);
      const match = out.match(/indexed at ([^\s]+)/);
      return match ? `→ ${match[1]}` : out.slice(0, 40);
    }
    if (p.output && typeof p.output === "string" && p.output.startsWith("[from dispatch cache]")) {
      const lines = p.output.split("\n").length - 1;
      return `${String(lines)} lines [cached]`;
    }
  } catch {}
  if (SUBAGENT_NAMES.has(toolName)) {
    try {
      const p = JSON.parse(result);
      if (p.success === false && p.error) return String(p.error).slice(0, 50);
      if (Array.isArray(p.reads)) {
        const paths = new Set((p.reads as Array<{ path: string }>).map((r) => r.path));
        const parts: string[] = [];
        if (paths.size > 0) parts.push(`${String(paths.size)} files read`);
        if (Array.isArray(p.filesEdited) && p.filesEdited.length > 0)
          parts.push(`${String(p.filesEdited.length)} edited`);
        return parts.join(", ") || "done";
      }
      if (p.output) {
        const out = String(p.output);
        const lines = out.split("\n").length;
        if (lines > 1) return `${String(lines)} lines`;
        return out.length > 40 ? `${out.slice(0, 37)}...` : out;
      }
    } catch {}
    const lines = result.split("\n").length;
    if (lines > 1) return `${String(lines)} lines`;
    return result.length > 40 ? `${result.slice(0, 37)}...` : result;
  }
  if (toolName === "code_execution") {
    const lines = result.split("\n").length;
    if (lines > 1) return `${String(lines)} lines output`;
    return result.length > 40 ? `${result.slice(0, 37)}...` : result;
  }
  try {
    const parsed = JSON.parse(result);
    if (parsed.output) {
      const out = String(parsed.output);
      const lines = out.split("\n").length;
      if (lines > 1) return `${String(lines)} lines`;
      return out.length > 40 ? `${out.slice(0, 37)}...` : out;
    }
    if (parsed.error) return String(parsed.error).slice(0, 50);
    if (parsed.branch !== undefined) {
      const parts = [parsed.branch as string];
      const counts: string[] = [];
      if (Array.isArray(parsed.staged) && parsed.staged.length > 0)
        counts.push(`${String(parsed.staged.length)} staged`);
      if (Array.isArray(parsed.modified) && parsed.modified.length > 0)
        counts.push(`${String(parsed.modified.length)} modified`);
      if (Array.isArray(parsed.untracked) && parsed.untracked.length > 0)
        counts.push(`${String(parsed.untracked.length)} untracked`);
      if (counts.length > 0) parts.push(counts.join(", "));
      else if (parsed.isDirty === false) parts.push("clean");
      return parts.join(" · ");
    }
    if (parsed.ok !== undefined) {
      const label = parsed.ok ? "ok" : "failed";
      if (parsed.output) {
        const firstLine = String(parsed.output).split("\n")[0] ?? "";
        const out = firstLine.length > 30 ? `${firstLine.slice(0, 27)}...` : firstLine;
        return out ? `${label} · ${out}` : label;
      }
      return label;
    }
  } catch {
    // fallback
  }
  const lines = result.split("\n").length;
  if (lines > 3) return `${String(lines)} lines`;
  return result.length > 40 ? `${result.slice(0, 37)}...` : result;
}

export function detectOutsideCwd(toolName: string, args?: string): OutsideKind | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    for (const val of Object.values(parsed)) {
      if (typeof val === "string" && (val.startsWith("/") || val.startsWith("~"))) {
        const resolved = resolve(val);
        const kind = classifyPath(resolved, CWD);
        if (kind) return kind;
      }
    }
    if (toolName === "shell" && typeof parsed.command === "string") {
      for (const match of parsed.command.matchAll(ABS_PATH_RE)) {
        const p = match[1];
        if (p) {
          const kind = classifyPath(p, CWD);
          if (kind) return kind;
        }
      }
    }
  } catch {}
  return null;
}

export const OUTSIDE_BADGE: Record<OutsideKind, { label: string; color: string }> = {
  outside: { label: "outside", color: "#e5c07b" },
  config: { label: "config", color: "#888" },
  tmp: { label: "tmp", color: "#888" },
};
