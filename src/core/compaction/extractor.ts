import type { ModelMessage } from "ai";
import type { WorkingStateManager } from "./working-state.js";

/**
 * Rule-based extractor that processes tool calls and messages to update
 * the working state incrementally. This covers ~90% of extraction with
 * zero LLM cost. The remaining ~10% (decisions from AI reasoning) can
 * optionally use a cheap LLM pass.
 */

// ─── Tool Call Extraction (deterministic) ───

const READ_TOOLS = new Set(["read_file", "navigate", "grep", "glob", "analyze"]);
const EDIT_TOOLS = new Set(["edit_file", "replace_file", "write_file"]);
const SHELL_TOOL = "shell";
const PROJECT_TOOL = "project";

export function extractFromToolCall(
  wsm: WorkingStateManager,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const filePath = extractFilePath(args);

  if (READ_TOOLS.has(toolName) && filePath) {
    wsm.trackFile(filePath, {
      type: "read",
      summary:
        toolName === "grep"
          ? `grep for "${truncate(String(args.pattern ?? ""), 80)}"`
          : toolName === "glob"
            ? `glob "${truncate(String(args.pattern ?? ""), 80)}"`
            : toolName === "analyze"
              ? `analyzed${args.symbols ? ` symbols: ${truncate(String(args.symbols), 100)}` : ""}`
              : "read",
    });
  }

  if (EDIT_TOOLS.has(toolName) && filePath) {
    const detail =
      toolName === "edit_file"
        ? buildEditDetail(args)
        : toolName === "write_file"
          ? "full write"
          : "replaced";
    wsm.trackFile(filePath, {
      type: filePath && toolName === "write_file" ? "create" : "edit",
      detail,
    });
  }

  if (toolName === SHELL_TOOL) {
    const cmd = truncate(String(args.command ?? ""), 120);
    wsm.addToolResult("shell", `ran: ${cmd}`);
  }

  if (toolName === PROJECT_TOOL) {
    const action = String(args.action ?? "");
    wsm.addToolResult(
      "project",
      `${action}${args.command ? `: ${truncate(String(args.command), 80)}` : ""}`,
    );
  }
}

export function extractFromToolResult(
  wsm: WorkingStateManager,
  toolName: string,
  result: unknown,
  _args?: Record<string, unknown>,
): void {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);

  if (isErrorResult(resultStr)) {
    const errorSummary = extractErrorSummary(resultStr);
    wsm.addFailure(`${toolName}: ${errorSummary}`);
  }

  if (toolName === "shell" || toolName === "project") {
    const summary = truncate(resultStr, 300);
    const existing = wsm.getState().toolResults;
    const last = existing[existing.length - 1];
    if (last && last.tool === toolName) {
      last.summary += ` → ${summary}`;
    } else {
      wsm.addToolResult(toolName, summary);
    }
  }

  if (toolName === "grep") {
    const matchCount = (resultStr.match(/\n/g) || []).length;
    wsm.addToolResult(
      "grep",
      `${matchCount} matches${matchCount > 0 ? `: ${truncate(resultStr, 200)}` : ""}`,
    );
  }
}

// ─── Message-level Extraction (deterministic) ───

export function extractFromUserMessage(wsm: WorkingStateManager, message: ModelMessage): void {
  const text = messageText(message);
  if (!text) return;

  if (!wsm.getState().task) {
    wsm.setTask(truncate(text, 300));
  }
}

/**
 * Extract decisions from assistant text. This is the "fuzzy 10%" —
 * can be done rule-based (pattern matching) or with a cheap LLM.
 * This function handles the rule-based version.
 */
export function extractFromAssistantMessage(wsm: WorkingStateManager, message: ModelMessage): void {
  const text = messageText(message);
  if (!text) return;

  const decisionPatterns = [
    /(?:I'll|let's|we should|I'm going to|the approach is|decided to|choosing|using|switching to)\s+(.{10,120}?)(?:\.|$)/gi,
    /(?:because|since|the reason is)\s+(.{10,120}?)(?:\.|$)/gi,
  ];

  for (const pattern of decisionPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        const decision = truncate(match[1].trim(), 150);
        if (decision.length > 15) {
          wsm.addDecision(decision);
        }
      }
    }
  }

  const discoveryPatterns = [
    /(?:found that|discovered|it turns out|interestingly|the issue (?:is|was))\s+(.{10,150}?)(?:\.|$)/gi,
  ];

  for (const pattern of discoveryPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        wsm.addDiscovery(truncate(match[1].trim(), 150));
      }
    }
  }
}

// ─── Helpers ───

function extractFilePath(args: Record<string, unknown>): string | undefined {
  const keys = ["file", "path", "filePath", "file_path", "target_file", "source_file", "target"];
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function buildEditDetail(args: Record<string, unknown>): string {
  const old = truncate(String(args.old_string ?? args.search ?? ""), 60);
  const new_ = truncate(String(args.new_string ?? args.replace ?? ""), 60);
  if (old && new_) return `"${old}" → "${new_}"`;
  if (args.line != null) return `line ${args.line}`;
  return "edited";
}

function isErrorResult(result: string): boolean {
  return /(?:error|Error|ERROR|failed|FAILED|exception|EXCEPTION|not found|ENOENT|EACCES|panic)/i.test(
    result.slice(0, 500),
  );
}

function extractErrorSummary(result: string): string {
  const lines = result.split("\n").filter((l) => l.trim().length > 0);
  const errorLine = lines.find((l) => /(?:error|Error|failed|exception|not found)/i.test(l));
  return truncate(errorLine || lines[0] || "unknown error", 200);
}

function messageText(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null && "text" in part) {
        texts.push(String((part as { text: string }).text));
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}
