import { getThemeTokens } from "./theme/index.js";

export type ToolCategory =
  | "file"
  | "shell"
  | "git"
  | "lsp"
  | "tree-sitter"
  | "ts-morph"
  | "regex"
  | "code"
  | "web"
  | "memory"
  | "agent"
  | "ui"
  | "editor"
  | "smithy"
  | "soul-map";

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // File tools
  read_file: "file",
  edit_file: "file",
  multi_edit: "file",
  undo_edit: "file",
  list_dir: "file",
  grep: "file",
  glob: "file",

  // Shell
  shell: "shell",

  // Git
  git: "git",

  // Code intelligence — backend resolved dynamically (ts-morph > lsp > tree-sitter > regex)
  navigate: "code",
  analyze: "code",
  rename_symbol: "code",
  move_symbol: "code",
  rename_file: "code",
  refactor: "code",
  project: "shell",
  test_scaffold: "code",
  discover_pattern: "code",

  // Editor (neovim)
  editor: "editor",
  editor_panel: "editor",

  // Web
  web_search: "web",
  fetch_page: "web",

  // Memory
  memory: "memory",

  // Skills
  skills: "agent",

  // Agent / subagent
  dispatch: "agent",

  // Interactive UI
  plan: "ui",
  update_plan_step: "ui",
  ask_user: "ui",
  task_list: "ui",

  // Code execution (sandboxed smithy)
  code_execution: "smithy",

  // Repo map powered
  soul_grep: "soul-map",
  soul_find: "soul-map",
  soul_analyze: "soul-map",
  soul_impact: "soul-map",
};

function getCategoryColors(): Record<string, string> {
  const t = getThemeTokens();
  return {
    file: t.info,
    shell: t.error,
    git: t.success,
    lsp: t.brandAlt,
    "tree-sitter": t.warning,
    "ts-morph": t.info,
    regex: t.textSecondary,
    code: t.warning,
    web: t.info,
    memory: t.amber,
    agent: t.brand,
    ui: t.info,
    editor: t.info,
    smithy: t.amber,
    "soul-map": t.success,
    brave: t.brandSecondary,
    ddg: t.brandSecondary,
    jina: t.warning,
    "jina-api": t.warning,
    readability: t.textSecondary,
    fetch: t.info,
  };
}

export const CATEGORY_COLORS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, prop: string) {
    return getCategoryColors()[prop];
  },
});

const BACKEND_LABELS_BASE: Record<string, string> = {
  jina: "jina",
  brave: "brave",
  ddg: "ddg",
  readability: "readability",
  fetch: "fetch",
};

export function getBackendLabel(tag: string): string {
  if (tag === "jina-api") return `jina ${icon("proxy")}`;
  return BACKEND_LABELS_BASE[tag] ?? tag;
}

import { icon } from "./icons.js";

const TOOL_ICON_MAP: Record<string, string> = {
  read_file: "file",
  edit_file: "pencil",
  multi_edit: "pencil",
  undo_edit: "pencil",
  list_dir: "changes",
  shell: "terminal",
  grep: "search",
  glob: "changes",
  dispatch: "explore",
  web_search: "globe",
  fetch_page: "file",
  memory: "bookmark",
  editor: "pencil",
  git: "git",
  navigate: "arrow_right",
  analyze: "search",
  rename_symbol: "rename",
  move_symbol: "arrow_right",
  rename_file: "arrow_right",
  refactor: "wrench",
  project: "terminal",
  test_scaffold: "plan",
  discover_pattern: "search",
  editor_panel: "pencil",
  plan: "plan",
  update_plan_step: "check",
  ask_user: "question",
  task_list: "plan",
  code_execution: "smithy",
  _repomap: "repomap",
  soul_grep: "search",
  soul_find: "search",
  soul_analyze: "repomap",
  soul_impact: "repomap",
  skills: "skills",
  _nudge: "lightning",
};

function toolIcon(name: string): string {
  const key = TOOL_ICON_MAP[name];
  return key ? icon(key) : icon("wrench");
}

export const TOOL_ICONS = new Proxy({} as Record<string, string>, {
  get(_, prop: string) {
    return toolIcon(prop);
  },
});

export const TOOL_LABELS: Record<string, string> = {
  read_file: "Reading",
  edit_file: "Editing",
  multi_edit: "Editing",
  undo_edit: "Undoing",
  list_dir: "Listing",
  shell: "Running",
  grep: "Searching",
  glob: "Globbing",
  dispatch: "Dispatching",
  web_search: "Searching web",
  fetch_page: "Fetching page",
  memory: "Memory",
  skills: "Skills",
  editor: "Editor",
  git: "Git",
  navigate: "Navigating",
  analyze: "Analyzing",
  rename_symbol: "Renaming symbol",
  move_symbol: "Moving symbol",
  rename_file: "Moving file",
  refactor: "Refactoring",
  project: "Project",
  test_scaffold: "Scaffolding tests",
  discover_pattern: "Discovering",
  editor_panel: "Opening editor",
  plan: "Planning",
  update_plan_step: "Updating plan",
  ask_user: "Asking",
  task_list: "Tasks",
  code_execution: "Forging",
  soul_grep: "Searching",
  soul_find: "Finding",
  soul_analyze: "Analyzing",
  soul_impact: "Impact analysis",
  _nudge: "Output nudge",
};

/** Past-tense labels for completed tool calls */
export const TOOL_LABELS_DONE: Record<string, string> = {
  read_file: "Read",
  edit_file: "Edited",
  multi_edit: "Edited",
  undo_edit: "Undid",
  list_dir: "Listed",
  shell: "Ran",
  grep: "Searched",
  glob: "Globbed",
  dispatch: "Dispatched",
  web_search: "Searched web",
  fetch_page: "Fetched page",
  memory: "Memory",
  skills: "Skills",
  editor: "Editor",
  git: "Git",
  navigate: "Navigated",
  analyze: "Analyzed",
  rename_symbol: "Renamed symbol",
  move_symbol: "Moved symbol",
  rename_file: "Moved file",
  refactor: "Refactored",
  project: "Project",
  test_scaffold: "Scaffolded tests",
  discover_pattern: "Discovered",
  editor_panel: "Opened editor",
  plan: "Planned",
  update_plan_step: "Updated plan",
  ask_user: "Asked",
  task_list: "Tasks",
  code_execution: "Forged",
  soul_grep: "Searched",
  soul_find: "Found",
  soul_analyze: "Analyzed",
  soul_impact: "Impact analysis",
  _nudge: "Output nudge",
};

/** Resolve all display properties for a tool in one call. */
export function resolveToolDisplay(toolName: string, defaultColor?: string) {
  const fallback = defaultColor ?? getThemeTokens().textSecondary;
  return {
    icon: TOOL_ICONS[toolName] ?? "\uF0AD",
    iconColor: getToolIconColors()[toolName] ?? fallback,
    label: TOOL_LABELS[toolName] ?? toolName,
    category: TOOL_CATEGORIES[toolName] as ToolCategory | undefined,
  };
}

function getToolIconColors(): Record<string, string> {
  const t = getThemeTokens();
  return {
    read_file: t.info,
    edit_file: t.amber,
    multi_edit: t.amber,
    undo_edit: t.amber,
    list_dir: t.info,
    shell: t.error,
    grep: t.warning,
    glob: t.info,
    dispatch: t.brand,
    web_search: t.info,
    fetch_page: t.info,
    memory: t.amber,
    editor: t.info,
    git: t.success,
    navigate: t.brandAlt,
    analyze: t.brandAlt,
    rename_symbol: t.amber,
    move_symbol: t.amber,
    rename_file: t.amber,
    refactor: t.amber,
    project: t.error,
    test_scaffold: t.brandAlt,
    discover_pattern: t.brandAlt,
    plan: t.info,
    update_plan_step: t.info,
    ask_user: t.amber,
    task_list: t.info,
    editor_panel: t.info,
    skills: t.brand,
    code_execution: t.amber,
    soul_grep: t.success,
    soul_find: t.success,
    soul_analyze: t.success,
    soul_impact: t.success,
    _nudge: t.warning,
  };
}
