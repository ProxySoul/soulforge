import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOOL_ICON_COLORS, TOOL_ICONS, TOOL_LABELS } from "../core/tool-display.js";
import type { PlanOutput } from "../types/index.js";
import { DiffView } from "./DiffView.js";
import { StructuredPlanView } from "./StructuredPlanView.js";
import { SPINNER_FRAMES } from "./shared.js";

export interface LiveToolCall {
  id: string;
  toolName: string;
  state: "running" | "done" | "error";
  args?: string;
  result?: string;
  error?: string;
}

// ─── Subagent names ───
const SUBAGENT_NAMES = new Set(["explore", "code"]);

// ─── Colors ───
const COLORS = {
  spinnerActive: "#FF0040",
  toolNameActive: "#9B30FF",
  argsActive: "#aaa",
  checkDone: "#2d5",
  textDone: "#555",
  error: "#f44",
} as const;

function formatArgs(toolName: string, args?: string): string {
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
    if (toolName === "memory_write" && parsed.summary) {
      const s = String(parsed.summary);
      return s.length > 50 ? `${s.slice(0, 47)}...` : s;
    }
    if ((toolName === "explore" || toolName === "code") && parsed.task) {
      const task = String(parsed.task);
      return task.length > 50 ? `${task.slice(0, 47)}...` : task;
    }
    if (toolName === "editor_read" && parsed.startLine) {
      return `lines ${String(parsed.startLine)}-${String(parsed.endLine ?? "end")}`;
    }
    if (toolName === "editor_edit" && parsed.startLine) {
      return `lines ${String(parsed.startLine)}-${String(parsed.endLine)}`;
    }
    if (toolName === "editor_navigate") {
      if (parsed.file) return String(parsed.file);
      if (parsed.search) return `/${String(parsed.search)}/`;
      if (parsed.line) return `line ${String(parsed.line)}`;
    }
    if (toolName === "editor_hover" && parsed.line) {
      return `line ${String(parsed.line)}:${String(parsed.col ?? "")}`;
    }
    if (toolName === "plan" && parsed.title) {
      return String(parsed.title);
    }
    if (toolName === "update_plan_step" && parsed.stepId) {
      return `${String(parsed.stepId)} → ${String(parsed.status ?? "")}`;
    }
    if (toolName === "ask_user" && parsed.question) {
      const q = String(parsed.question);
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    if (toolName === "read_code" && parsed.file) {
      const label = parsed.name
        ? `${String(parsed.name)} in ${String(parsed.file)}`
        : String(parsed.file);
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
    if (toolName === "refactor") {
      const parts = [parsed.action, parsed.symbol].filter(Boolean).map(String);
      const label = parts.join(" ");
      return label.length > 50 ? `${label.slice(0, 47)}...` : label;
    }
    if (toolName === "write_plan") return ".soulforge/plan.md";
    if (toolName === "git_commit" && parsed.message) {
      const m = String(parsed.message);
      return m.length > 50 ? `${m.slice(0, 47)}...` : m;
    }
    if (toolName === "git_log" && parsed.count) return `last ${String(parsed.count)}`;
    if (toolName === "git_diff") return parsed.staged ? "staged" : "unstaged";
    if (toolName === "git_stash") return parsed.pop ? "pop" : "push";
  } catch {
    // partial JSON during streaming
  }
  return args.length > 50 ? `${args.slice(0, 47)}...` : args;
}

function formatResult(toolName: string, result?: string): string {
  if (!result) return "";
  // Subagent results are plain text summaries — show truncated
  if (SUBAGENT_NAMES.has(toolName)) {
    const lines = result.split("\n").length;
    if (lines > 1) return `${String(lines)} lines`;
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
  } catch {
    // fallback
  }
  return result.length > 40 ? `${result.slice(0, 37)}...` : result;
}

// ─── Spinner ───
function Spinner({ color }: { color?: string }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return <Text color={color ?? COLORS.spinnerActive}>{SPINNER_FRAMES[idx]}</Text>;
}

// ─── Elapsed Timer ───
function useElapsedTimers(calls: LiveToolCall[]) {
  const startTimes = useRef(new Map<string, number>());
  const [elapsed, setElapsed] = useState(new Map<string, number>());

  useEffect(() => {
    for (const call of calls) {
      if (call.state === "running" && !startTimes.current.has(call.id)) {
        startTimes.current.set(call.id, Date.now());
      }
    }
  }, [calls]);

  useEffect(() => {
    const hasRunning = calls.some((c) => c.state === "running");
    if (!hasRunning) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const next = new Map<string, number>();
      for (const call of calls) {
        const start = startTimes.current.get(call.id);
        if (start) {
          next.set(call.id, Math.floor((now - start) / 1000));
        }
      }
      setElapsed(next);
    }, 1000);
    return () => clearInterval(interval);
  }, [calls]);

  return elapsed;
}

// ─── Status Icon ───
function StatusIcon({ state }: { state: LiveToolCall["state"] }) {
  if (state === "running") return <Spinner />;
  if (state === "done") return <Text color={COLORS.checkDone}>✓</Text>;
  return <Text color={COLORS.error}>✗</Text>;
}

// ─── Regular Tool Call Row ───
function ToolRow({ tc, seconds }: { tc: LiveToolCall; seconds?: number }) {
  const icon = TOOL_ICONS[tc.toolName] ?? "\uF0AD"; // wrench fallback
  const label = TOOL_LABELS[tc.toolName] ?? tc.toolName;
  const argStr = formatArgs(tc.toolName, tc.args);
  const isDone = tc.state !== "running";

  // Parse edit_file args for DiffView when done
  const editDiff = useMemo(() => {
    if (tc.toolName !== "edit_file" || tc.state !== "done" || !tc.args) return null;
    try {
      const parsed = JSON.parse(tc.args);
      if (
        typeof parsed.path === "string" &&
        typeof parsed.oldString === "string" &&
        typeof parsed.newString === "string"
      ) {
        return {
          path: parsed.path as string,
          oldString: parsed.oldString as string,
          newString: parsed.newString as string,
        };
      }
    } catch {
      // partial or invalid JSON
    }
    return null;
  }, [tc.toolName, tc.state, tc.args]);

  // Build suffix
  let suffix = "";
  if (tc.state === "running" && seconds != null && seconds > 0) {
    suffix = ` ${seconds}s`;
  } else if (tc.state === "done" && tc.result && !editDiff) {
    suffix = ` → ${formatResult(tc.toolName, tc.result)}`;
  } else if (tc.state === "error" && tc.error) {
    suffix = ` → ${tc.error.slice(0, 50)}`;
  }

  // Check if result indicates success (for DiffView)
  const editSuccess = useMemo(() => {
    if (!editDiff || !tc.result) return false;
    try {
      const parsed = JSON.parse(tc.result);
      return parsed.success === true;
    } catch {
      return false;
    }
  }, [editDiff, tc.result]);

  const editError = useMemo(() => {
    if (!editDiff || !tc.result) return undefined;
    try {
      const parsed = JSON.parse(tc.result);
      if (!parsed.success && parsed.error) return parsed.error as string;
    } catch {
      // ignore
    }
    return undefined;
  }, [editDiff, tc.result]);

  const iconColor = TOOL_ICON_COLORS[tc.toolName] ?? "#888";

  return (
    <Box flexDirection="column">
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate">
          <StatusIcon state={tc.state} />
          <Text color={isDone ? COLORS.textDone : iconColor}> {icon} </Text>
          <Text color={isDone ? COLORS.textDone : COLORS.toolNameActive} bold={!isDone}>
            {label}
          </Text>
          {argStr ? (
            <Text color={isDone ? COLORS.textDone : COLORS.argsActive}> {argStr}</Text>
          ) : null}
          {suffix ? (
            <Text color={tc.state === "error" ? COLORS.error : COLORS.textDone}>{suffix}</Text>
          ) : null}
        </Text>
      </Box>
      {editDiff ? (
        <Box marginLeft={2}>
          <DiffView
            filePath={editDiff.path}
            oldString={editDiff.oldString}
            newString={editDiff.newString}
            success={editSuccess}
            errorMessage={editError}
          />
        </Box>
      ) : null}
    </Box>
  );
}

// ─── Main Display ───
interface Props {
  calls: LiveToolCall[];
}

export function ToolCallDisplay({ calls }: Props) {
  const elapsed = useElapsedTimers(calls);

  if (calls.length === 0) return null;

  return (
    <Box flexDirection="column">
      {calls.map((tc) => {
        const seconds = elapsed.get(tc.id);
        // Render structured plan view when write_plan completes
        if (tc.toolName === "write_plan" && tc.state === "done" && tc.args) {
          try {
            const plan = JSON.parse(tc.args) as PlanOutput;
            if (plan.title && plan.steps) {
              return <StructuredPlanView key={tc.id} plan={plan} />;
            }
          } catch {
            // Fall through to normal row
          }
        }
        return <ToolRow key={tc.id} tc={tc} seconds={seconds} />;
      })}
    </Box>
  );
}
