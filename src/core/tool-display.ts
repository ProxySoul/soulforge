
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
  | "execution"
  | "soul-map";

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // File tools
  read_file: "file",
  edit_file: "file",
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

  // Agent / subagent
  dispatch: "agent",

  // Interactive UI
  plan: "ui",
  update_plan_step: "ui",
  ask_user: "ui",
  task_list: "ui",

  // Code execution (sandboxed)
  code_execution: "execution",

  // Repo map powered
  soul_grep: "soul-map",
  soul_find: "soul-map",
  soul_analyze: "soul-map",
  soul_impact: "soul-map",
};

export const CATEGORY_COLORS: Record<string, string> = {
  file: "#5C9FD6",
  shell: "#c55",
  git: "#4a7",
  lsp: "#c678dd",
  "tree-sitter": "#e5c07b",
  "ts-morph": "#3178C6",
  regex: "#888",
  code: "#e5c07b",
  web: "#5CBBF6",
  memory: "#b87333",
  agent: "#c080ff",
  ui: "#00BFFF",
  editor: "#5C9FD6",
  execution: "#c55",
  "soul-map": "#2dd4bf",
  brave: "#FB542B",
  ddg: "#DE5833",
  jina: "#FFAA00",
  "jina-api": "#FFAA00",
  readability: "#888",
  fetch: "#5CBBF6",
};

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
  refactor: "wrench",
  project: "terminal",
  test_scaffold: "plan",
  discover_pattern: "search",
  editor_panel: "pencil",
  plan: "plan",
  update_plan_step: "check",
  ask_user: "question",
  task_list: "plan",
  code_execution: "code",
  _repomap: "repomap",
  soul_grep: "search",
  soul_find: "search",
  soul_analyze: "repomap",
  soul_impact: "repomap",
  _nudge: "lightning",
};

export function toolIcon(name: string): string {
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
  shell: "Running",
  grep: "Searching",
  glob: "Globbing",
  dispatch: "Dispatching",
  web_search: "Searching web",
  fetch_page: "Fetching page",
  memory: "Memory",
  editor: "Editor",
  git: "Git",
  navigate: "Navigating",
  analyze: "Analyzing",
  rename_symbol: "Renaming symbol",
  move_symbol: "Moving symbol",
  refactor: "Refactoring",
  project: "Project",
  test_scaffold: "Scaffolding tests",
  discover_pattern: "Discovering",
  editor_panel: "Opening editor",
  plan: "Planning",
  update_plan_step: "Updating plan",
  ask_user: "Asking",
  task_list: "Tasks",
  code_execution: "Executing",
  soul_grep: "Searching",
  soul_find: "Finding",
  soul_analyze: "Analyzing",
  soul_impact: "Impact analysis",
  _nudge: "Output nudge",
};


/** Resolve all display properties for a tool in one call. */
export function resolveToolDisplay(toolName: string, defaultColor = "#888") {
  return {
    icon: TOOL_ICONS[toolName] ?? "\uF0AD",
    iconColor: TOOL_ICON_COLORS[toolName] ?? defaultColor,
    label: TOOL_LABELS[toolName] ?? toolName,
    category: TOOL_CATEGORIES[toolName] as ToolCategory | undefined,
  };
}

export const TOOL_ICON_COLORS: Record<string, string> = {
  read_file: "#5C9FD6",
  edit_file: "#c89030",
  shell: "#c55",
  grep: "#c8b040",
  glob: "#5C9FD6",
  dispatch: "#9B30FF",
  web_search: "#5CBBF6",
  fetch_page: "#5CBBF6",
  memory: "#b87333",
  editor: "#5C9FD6",
  git: "#4a7",
  navigate: "#8B5CF6",
  analyze: "#8B5CF6",
  rename_symbol: "#c89030",
  move_symbol: "#c89030",
  refactor: "#c89030",
  project: "#c55",
  test_scaffold: "#8B5CF6",
  discover_pattern: "#8B5CF6",
  plan: "#00BFFF",
  update_plan_step: "#00BFFF",
  ask_user: "#c89030",
  task_list: "#00BFFF",
  editor_panel: "#5C9FD6",
  code_execution: "#c55",
  soul_grep: "#2dd4bf",
  soul_find: "#2dd4bf",
  soul_analyze: "#2dd4bf",
  soul_impact: "#2dd4bf",
  _nudge: "#d9a020",
};