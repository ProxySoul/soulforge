/**
 * Tool name mapping: SoulForge ↔ Claude Code.
 *
 * Claude Code uses PascalCase tool names (Bash, Edit, Write, Read, etc.).
 * SoulForge uses snake_case (shell, edit_file, multi_edit, read, etc.).
 *
 * For hooks compatibility, we map in both directions so users can write
 * matchers using either convention.
 */

/**
 * Map from SoulForge tool name → Claude Code tool name.
 *
 * Claude Code canonical names sourced from their docs:
 *   Bash, Read, Write, Edit, MultiEdit, Glob, Grep, ListDirectory,
 *   WebFetch, WebSearch, Agent, TodoRead, TodoWrite, AskFollowupQuestion
 *
 * We map every SoulForge tool to the closest Claude Code equivalent so
 * that matchers written for Claude Code hooks fire correctly here.
 */
const SOULFORGE_TO_CLAUDE: Record<string, string> = {
  shell: "Bash",
  edit_file: "Edit",
  multi_edit: "MultiEdit",
  read: "Read",
  list_dir: "ListDirectory",
  grep: "Grep",
  glob: "Glob",
  git: "Git",
  web_search: "WebSearch",
  fetch_page: "WebFetch",
  dispatch: "Agent",
  ask_user: "AskFollowupQuestion",
  plan: "Plan",
  update_plan_step: "UpdatePlanStep",
  navigate: "Navigate",
  analyze: "Analyze",
  refactor: "Refactor",
  rename_symbol: "RenameSymbol",
  move_symbol: "MoveSymbol",
  rename_file: "RenameFile",
  project: "Project",
  memory: "Memory",
  task_list: "TaskList",
  undo_edit: "UndoEdit",
  soul_grep: "SoulGrep",
  soul_find: "SoulFind",
  soul_analyze: "SoulAnalyze",
  soul_impact: "SoulImpact",
  discover_pattern: "DiscoverPattern",
  test_scaffold: "TestScaffold",
  editor: "Editor",
  skills: "Skills",
  request_tools: "RequestTools",
  release_tools: "ReleaseTools",
  // Anthropic native tools
  code_execution: "CodeExecution",
  computer: "Computer",
  str_replace_based_edit_tool: "TextEditor",
};

/** Map from Claude Code tool name → SoulForge tool name(s). */
const CLAUDE_TO_SOULFORGE: Record<string, string[]> = {};
for (const [sf, cc] of Object.entries(SOULFORGE_TO_CLAUDE)) {
  if (!CLAUDE_TO_SOULFORGE[cc]) CLAUDE_TO_SOULFORGE[cc] = [];
  CLAUDE_TO_SOULFORGE[cc].push(sf);
}

// Claude Code aliases that map to our tools:
// - "Write" (file creation) → edit_file (empty oldString = create)
// - "Edit" also matches edit_file + multi_edit (Claude Code users write Edit|Write)
// - "ListDir" is a common shorthand people might use instead of ListDirectory
// - "AskUserQuestion" is the old Claude Code name, "AskFollowupQuestion" is current
// - "TodoRead"/"TodoWrite" map to our unified task_list tool
CLAUDE_TO_SOULFORGE.Write = [...(CLAUDE_TO_SOULFORGE.Write ?? []), "edit_file"];
CLAUDE_TO_SOULFORGE.Edit = [...(CLAUDE_TO_SOULFORGE.Edit ?? []), "edit_file", "multi_edit"];
CLAUDE_TO_SOULFORGE.ListDir = [...(CLAUDE_TO_SOULFORGE.ListDir ?? []), "list_dir"];
CLAUDE_TO_SOULFORGE.AskUserQuestion = [...(CLAUDE_TO_SOULFORGE.AskUserQuestion ?? []), "ask_user"];
CLAUDE_TO_SOULFORGE.TodoRead = [...(CLAUDE_TO_SOULFORGE.TodoRead ?? []), "task_list"];
CLAUDE_TO_SOULFORGE.TodoWrite = [...(CLAUDE_TO_SOULFORGE.TodoWrite ?? []), "task_list"];

/**
 * Get the Claude Code tool name for a SoulForge tool name.
 * Falls back to PascalCase conversion if no explicit mapping exists.
 */
export function toClaudeToolName(soulforgeToolName: string): string {
  return SOULFORGE_TO_CLAUDE[soulforgeToolName] ?? soulforgeToolName;
}

/**
 * Check if a tool name matches a Claude Code hook matcher pattern.
 *
 * Matcher rules (matching Claude Code behavior):
 * - `"*"`, `""`, or undefined → match all
 * - Only letters/digits/`_`/`|` → exact string or pipe-separated list
 * - Contains other characters → regex
 */
export function matchesToolName(matcher: string | undefined, soulforgeToolName: string): boolean {
  if (!matcher || matcher === "*") return true;

  const claudeName = toClaudeToolName(soulforgeToolName);

  // Check if matcher is a simple exact/pipe-separated pattern
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    const names = matcher.split("|");
    // Match against both Claude Code name AND SoulForge name
    return names.some(
      (n) =>
        n === claudeName ||
        n === soulforgeToolName ||
        // Also check if the matcher is a Claude name that maps to our tool
        CLAUDE_TO_SOULFORGE[n]?.includes(soulforgeToolName),
    );
  }

  // Regex matcher — test against both names
  try {
    const re = new RegExp(matcher);
    return re.test(claudeName) || re.test(soulforgeToolName);
  } catch {
    // Invalid regex — treat as literal
    return matcher === claudeName || matcher === soulforgeToolName;
  }
}
