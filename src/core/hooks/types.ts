/**
 * Hook types — wire-compatible with Claude Code's `.claude/settings.json` hook schema.
 *
 * Users migrating from Claude Code can drop their existing hooks config into
 * `.claude/settings.json` and it works out of the box. SoulForge also reads
 * hooks from `.soulforge/config.json` under the same `hooks` key.
 */

// ── Hook events ──────────────────────────────────────────────────────

/** Events that fire during the agent lifecycle. */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "Stop"
  | "StopFailure"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification";

// ── Hook handler types ───────────────────────────────────────────────

export interface CommandHook {
  type: "command";
  command: string;
  /** Run in background without blocking the agent. */
  async?: boolean;
  /** Timeout in seconds (default: 10). */
  timeout?: number;
  /** Spinner message shown in UI while hook runs. */
  statusMessage?: string;
  /** Run only once per session. Subsequent calls are silently skipped. */
  once?: boolean;
  /**
   * Conditional execution using permission rule syntax.
   * Only spawns the hook process if the condition matches the tool input.
   *
   * Examples:
   * - `"Bash(git *)"` — only fire for git commands
   * - `"Edit(*.ts)"` — only fire for TypeScript file edits
   * - `"Bash(rm *)"` — only fire for rm commands
   *
   * Format: `ToolName(glob_pattern)` — ToolName must match, and the
   * first string argument of the tool input must match the glob.
   * Without `if`, the hook fires on every matcher match.
   */
  if?: string;
}

// We only support command hooks for now — http/prompt/agent can be added later.
export type HookHandler = CommandHook;

// ── Hook rule (matcher + handlers) ───────────────────────────────────

export interface HookRule {
  /**
   * Matcher pattern for filtering when the hook fires.
   *
   * - `"*"`, `""`, or omitted → match all
   * - Only letters/digits/`_`/`|` → exact string or pipe-separated list
   *   e.g. `"Bash"` or `"Edit|Write"`
   * - Contains other characters → treated as regex
   *   e.g. `"^mcp__.*"` or `"Notebook"`
   *
   * For PreToolUse/PostToolUse, matches against the **Claude Code tool name**
   * (e.g. `Bash`, `Edit`, `Write`, `Read`) — SoulForge maps its own tool names
   * to Claude Code names automatically for compatibility.
   */
  matcher?: string;
  hooks: HookHandler[];
}

// ── Top-level config ─────────────────────────────────────────────────

export type HooksConfig = Partial<Record<HookEventName, HookRule[]>>;

// ── Hook input (JSON sent to command via stdin) ──────────────────────

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: HookEventName;
  /** Tool name in Claude Code format (e.g. "Bash", "Edit"). Present for tool events. */
  tool_name?: string;
  /** Tool input arguments. Present for PreToolUse. */
  tool_input?: Record<string, unknown>;
  /** Tool response. Present for PostToolUse. */
  tool_response?: unknown;
  /** Tool call ID from the model. */
  tool_use_id?: string;
}

// ── Hook output (JSON returned by command via stdout) ────────────────

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PreToolUseOutput {
  hookEventName: "PreToolUse";
  /** Permission decision — deny blocks the tool call. */
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  /** Modified tool input — replaces the original if present. */
  updatedInput?: Record<string, unknown>;
  /** Additional context injected into the conversation for the model. */
  additionalContext?: string;
}

export interface PostToolUseOutput {
  hookEventName: "PostToolUse";
  additionalContext?: string;
}

export interface HookOutput {
  /** Whether to continue (default: true). */
  continue?: boolean;
  /** Block decision — "block" prevents the action. */
  decision?: "block" | "allow";
  /** Reason for blocking. */
  reason?: string;
  hookSpecificOutput?: PreToolUseOutput | PostToolUseOutput;
}

// ── Hook execution result ────────────────────────────────────────────

export interface HookResult {
  /** Whether the hook executed successfully. */
  ok: boolean;
  /** Whether the hook wants to block the action. */
  blocked: boolean;
  /** Reason for blocking (from hook output or stderr). */
  reason?: string;
  /** Modified tool input (PreToolUse only). */
  updatedInput?: Record<string, unknown>;
  /** Additional context to inject. */
  additionalContext?: string;
  /** Raw hook output. */
  output?: HookOutput;
}
