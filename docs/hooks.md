# Hooks

Hooks let you run shell commands at key points in the agent lifecycle - before/after tool calls, on session start/end, around compaction, and more. They're wire-compatible with Claude Code's hook system, so existing `.claude/settings.json` hooks work out of the box.

## Quick start

Add a hook that logs every shell command the agent runs:

```json
// .soulforge/config.json (or .claude/settings.json)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"$(date): $HOOK_TOOL_NAME\" >> /tmp/soulforge-hooks.log",
            "async": true
          }
        ]
      }
    ]
  }
}
```

## Config sources

Hooks are loaded from 5 config files, **merged in order** (all matching hooks fire - later sources don't override earlier ones):

| Priority | Path | Scope |
|----------|------|-------|
| 1 | `~/.claude/settings.json` | User-level Claude Code |
| 2 | `.claude/settings.json` | Project-level Claude Code |
| 3 | `.claude/settings.local.json` | Project-level local Claude Code |
| 4 | `~/.soulforge/config.json` | User-level SoulForge |
| 5 | `.soulforge/config.json` | Project-level SoulForge |

All sources are merged - if you have hooks in both `.claude/settings.json` and `.soulforge/config.json`, both fire.

<Note>
Setting `"disableAllHooks": true` in **any** config file disables all hooks globally.
</Note>

## Hook events

| Event | When it fires | Matcher target |
|-------|--------------|----------------|
| `PreToolUse` | Before a tool call executes | Tool name (e.g. `Bash`, `Edit`) |
| `PostToolUse` | After a tool call succeeds | Tool name |
| `PostToolUseFailure` | After a tool call fails | Tool name |
| `UserPromptSubmit` | When the user sends a message | - |
| `Stop` | When the agent finishes normally | - |
| `StopFailure` | When the agent fails/errors | - |
| `SessionStart` | When a session begins | - |
| `SessionEnd` | When a session ends | - |
| `PreCompact` | Before context compaction | - |
| `PostCompact` | After context compaction | - |
| `SubagentStart` | When a subagent (spark/ember) spawns | - |
| `SubagentStop` | When a subagent finishes | - |
| `Notification` | On system notifications | - |

## Hook rule schema

Each event maps to an array of rules. Each rule has an optional matcher and an array of hook handlers:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "my-hook-script.sh",
            "async": false,
            "timeout": 10,
            "once": false,
            "if": "Bash(git *)"
          }
        ]
      }
    ]
  }
}
```

### Matcher patterns

The `matcher` field filters when the hook fires. For `PreToolUse`/`PostToolUse`/`PostToolUseFailure`, it matches against the tool name:

| Pattern | Behavior |
|---------|----------|
| `"*"`, `""`, or omitted | Match all tools |
| `"Bash"` | Exact match - only shell commands |
| `"Bash\|Edit"` | Pipe-separated - shell or edit |
| `"^mcp__.*"` | Regex - all MCP tools |

Tool names use **Claude Code conventions** (`Bash`, `Edit`, `Write`, `Read`, `MultiEdit`, `Grep`, `Glob`, `ListDirectory`, `WebSearch`, `Agent`, etc.). SoulForge maps its internal tool names automatically.

### CommandHook fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"command"` | required | Only command hooks are supported |
| `command` | string | required | Shell command to execute |
| `async` | boolean | `false` | Run in background without blocking the agent |
| `timeout` | number | `10` | Timeout in seconds |
| `statusMessage` | string | - | Spinner message shown in UI while hook runs |
| `once` | boolean | `false` | Run only once per session (subsequent calls silently skipped) |
| `if` | string | - | Conditional execution - `ToolName(glob_pattern)` format |

### Conditional execution (`if`)

The `if` field enables fine-grained filtering using `ToolName(glob_pattern)` syntax:

```json
{
  "type": "command",
  "command": "notify-git-op.sh",
  "if": "Bash(git *)"
}
```

| Example | Matches |
|---------|---------|
| `Bash(git *)` | Only git commands in shell |
| `Edit(*.ts)` | Only TypeScript file edits |
| `Bash(rm *)` | Only rm commands |
| `Bash(docker *)` | Only docker commands |

The glob pattern matches against the first string argument of the tool input (typically `command` for Bash, `path` for Edit). `*` matches any sequence, `?` matches one character.

## Protocol

Hooks communicate via stdin/stdout JSON:

### Input (stdin)

The hook process receives a JSON object on stdin:

```json
{
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git status" },
  "tool_use_id": "toolu_01abc"
}
```

| Field | Present | Description |
|-------|---------|-------------|
| `session_id` | Always | Current session ID |
| `cwd` | Always | Working directory |
| `hook_event_name` | Always | Event that triggered the hook |
| `tool_name` | Tool events | Claude Code tool name (e.g. `Bash`, `Edit`) |
| `tool_input` | `PreToolUse` | Tool input arguments |
| `tool_response` | `PostToolUse` | Tool response |
| `tool_use_id` | Tool events | Model's tool call ID |

### Output (stdout)

The hook process can return JSON on stdout to influence the agent:

```json
{
  "decision": "allow",
  "reason": "Looks safe",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "This file was recently refactored"
  }
}
```

### Exit codes

| Code | Meaning | Agent behavior |
|------|---------|---------------|
| `0` | Success | Parse stdout JSON for decisions |
| `2` | Block | Tool call is denied - agent sees the block reason |
| Other | Non-blocking error | Continue, log warning |

### PreToolUse capabilities

`PreToolUse` hooks can:

- **Block** the tool call - return `permissionDecision: "deny"` or exit with code 2
- **Modify input** - return `updatedInput` to replace the tool's arguments
- **Inject context** - return `additionalContext` to add information for the model

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Editing production config is not allowed",
    "updatedInput": { "command": "git status --short" },
    "additionalContext": "Note: this repo uses trunk-based development"
  }
}
```

### PostToolUse capabilities

`PostToolUse` hooks can inject additional context:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Reminder: run tests after editing this file"
  }
}
```

## Runtime management

Use the `/hooks` command to view and toggle hooks during a session:

- Lists all configured hook events with rule counts
- Toggle individual events on/off (session-scoped - resets on restart)
- Shows status tags: blocking, filtered, once

## Claude Code migration

SoulForge hooks are **drop-in compatible** with Claude Code. If you already have hooks in `.claude/settings.json`, they work automatically:

1. SoulForge reads `.claude/settings.json` (both `~/` and project-level)
2. Tool name matchers use Claude Code names (`Bash`, `Edit`, `Write`, `Read`, etc.)
3. The stdin/stdout JSON protocol is identical
4. Exit code semantics are identical (0 = success, 2 = block)

The only addition is SoulForge-specific events (`PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`) that Claude Code doesn't have.

### Tool name mapping

| Claude Code name | SoulForge tool(s) |
|-----------------|-------------------|
| `Bash` | `shell` |
| `Edit` | `edit_file`, `multi_edit` |
| `Write` | `edit_file` (empty oldString = create) |
| `Read` | `read` |
| `MultiEdit` | `multi_edit` |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `ListDirectory` | `list_dir` |
| `WebSearch` | `web_search` |
| `WebFetch` | `fetch_page` |
| `Agent` | `dispatch` |
| `AskFollowupQuestion` | `ask_user` |

## Examples

### Block dangerous commands

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"decision\":\"block\",\"reason\":\"rm -rf is not allowed\"}' && exit 2",
            "if": "Bash(rm -rf *)"
          }
        ]
      }
    ]
  }
}
```

### Log all tool calls

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_name' >> /tmp/tool-log.txt",
            "async": true
          }
        ]
      }
    ]
  }
}
```

### Notify on session end

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"SoulForge finished\" with title \"Done\"'",
            "async": true,
            "once": true
          }
        ]
      }
    ]
  }
}
```

### Auto-format after edits

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write $(echo $HOOK_TOOL_INPUT | jq -r '.path // .file // empty')",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

## Safety

- **Timeout**: Default 10 seconds per hook - hooks should be fast
- **Abort propagation**: Hook processes are killed on Ctrl+X
- **Non-blocking errors**: Non-zero exit codes (except 2) log a warning but don't block the agent
