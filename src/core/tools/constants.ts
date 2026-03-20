/** Tool names allowed in restricted modes (architect, socratic, challenge).
 *  Read/analysis + memory + editor read — NO edit/shell/git/refactor.
 *  Used with activeTools to restrict without rebuilding the tool set. */
export const RESTRICTED_TOOL_NAMES: string[] = [
  "read_file",
  "grep",
  "glob",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
  "list_dir",
  "web_search",
  "editor",
  "navigate",
  "analyze",
  "discover_pattern",
  "memory",
  "fetch_page",
  "test_scaffold",
  "dispatch",
  "ask_user",
  "plan",
  "update_plan_step",
];

/** Tools available during plan execution.
 *  Executor gets edit/shell/project + read_file (fallback if edit fails) + update_plan_step.
 *  No dispatch, explore, discover_pattern, web_search, test_scaffold — the plan already contains everything. */
export const PLAN_EXECUTION_TOOL_NAMES: string[] = [
  "read_file",
  "edit_file",
  "undo_edit",
  "multi_edit",
  "task_list",
  "list_dir",
  "shell",
  "project",
  "grep",
  "glob",
  "navigate",
  "analyze",
  "git",
  "editor",
  "rename_symbol",
  "move_symbol",
  "rename_file",
  "update_plan_step",
  "editor_panel",
  "memory",
  "soul_grep",
  "soul_find",
  "soul_analyze",
  "soul_impact",
];

const SUBAGENT_MAX_LINES = 750;
const SUBAGENT_MAX_OUTPUT_BYTES = 8192;

export function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= SUBAGENT_MAX_LINES) return output;
  return `${lines.slice(0, SUBAGENT_MAX_LINES).join("\n")}\n\n... [truncated: ${String(lines.length)} lines total. Use startLine/endLine for specific sections.]`;
}

export function truncateBytes(output: string): string {
  if (output.length <= SUBAGENT_MAX_OUTPUT_BYTES) return output;
  return `${output.slice(0, SUBAGENT_MAX_OUTPUT_BYTES)}\n\n... [truncated: output exceeded limit. Narrow with glob or path params.]`;
}

export function planFileName(sessionId?: string): string {
  return sessionId ? `plan-${sessionId}.md` : "plan.md";
}
