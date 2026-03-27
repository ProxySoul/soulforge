import { matchClaimsPrefix, register as registerClaims } from "./claims.js";
import { matchConfigPrefix, register as registerConfig } from "./config.js";
import { matchContextPrefix, register as registerContext } from "./context.js";
import { register as registerDebug } from "./debug.js";
import { matchGitPrefix, register as registerGit } from "./git.js";
import { matchNavPrefix, register as registerNavigation } from "./navigation.js";
import { register as registerProxy } from "./proxy.js";
import { matchSecurityPrefix, register as registerSecurity } from "./security.js";
import { matchSessionPrefix, register as registerSession } from "./session.js";
import { register as registerStorage } from "./storage.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

const commandMap = new Map<string, CommandHandler>();

registerGit(commandMap);
registerConfig(commandMap);
registerSession(commandMap);
registerContext(commandMap);
registerDebug(commandMap);
registerNavigation(commandMap);
registerProxy(commandMap);
registerStorage(commandMap);
registerSecurity(commandMap);
registerClaims(commandMap);

const prefixMatchers = [
  matchContextPrefix,
  matchGitPrefix,
  matchConfigPrefix,
  matchSessionPrefix,
  matchNavPrefix,
  matchSecurityPrefix,
  matchClaimsPrefix,
];

function resolveHandler(cmd: string): CommandHandler | null {
  const exact = commandMap.get(cmd);
  if (exact) return exact;

  for (const matcher of prefixMatchers) {
    const handler = matcher(cmd);
    if (handler) return handler;
  }

  return null;
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const cmd = trimmed.split(" ")[0]?.toLowerCase() ?? "";

  // Multi-word exact matches (e.g. "/proxy status", "/stash pop", "/git init")
  const twoWord = trimmed.toLowerCase().split(" ").slice(0, 2).join(" ");
  const threeWord = trimmed.toLowerCase().split(" ").slice(0, 3).join(" ");

  const handler =
    resolveHandler(threeWord) ??
    resolveHandler(twoWord) ??
    resolveHandler(trimmed.toLowerCase()) ??
    resolveHandler(cmd);

  if (handler) {
    try {
      await handler(input, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(ctx, `Command error: ${msg}`);
    }
    return;
  }

  sysMsg(ctx, `Unknown command: ${cmd}. Type /help for available commands.`);
}

/** Command definitions for autocomplete — single source of truth */
export interface CommandDef {
  cmd: string;
  ic: string;
  desc: string;
  category: string;
  tags?: string[];
  hidden?: boolean;
}

export const CATEGORIES = [
  "Git",
  "Session",
  "Models",
  "Settings",
  "Editor",
  "Intelligence",
  "Tabs",
  "System",
] as const;

export type CommandCategory = (typeof CATEGORIES)[number];

const COMMAND_DEFS: CommandDef[] = [
  {
    cmd: "/agent-features",
    ic: "cog",
    desc: "Toggle agent features (de-sloppify, tier routing)",
    category: "Settings",
    tags: ["config", "desloppify", "routing", "verify"],
  },
  { cmd: "/branch", ic: "git", desc: "Show/create branch", category: "Git", tags: ["checkout"] },
  {
    cmd: "/changes",
    ic: "changes",
    desc: "Toggle files changed this session",
    category: "Tabs",
    tags: ["files", "diff", "modified"],
  },
  {
    cmd: "/chat-style",
    ic: "chat",
    desc: "Toggle chat layout style",
    category: "Settings",
    tags: ["accent", "bubble", "ui"],
  },
  { cmd: "/clear", ic: "clear", desc: "Clear chat history", category: "Session", tags: ["reset"] },
  {
    cmd: "/claims",
    ic: "lock",
    desc: "Show active file claims across tabs",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/close-tab",
    ic: "tabs",
    desc: "Close current tab (Ctrl+W)",
    category: "Tabs",
    tags: ["remove"],
  },
  {
    cmd: "/co-author-commits",
    ic: "git",
    desc: "Toggle co-author trailer",
    category: "Settings",
    tags: ["git", "commit"],
  },
  { cmd: "/commit", ic: "git", desc: "Git commit with message", category: "Git", tags: ["save"] },
  {
    cmd: "/compact",
    ic: "compress",
    desc: "Compact conversation context",
    category: "Session",
    tags: ["context", "summarize"],
  },
  {
    cmd: "/compact-v2-logs",
    ic: "plan",
    desc: "View compaction events",
    category: "Session",
    tags: ["debug", "logs"],
  },
  {
    cmd: "/compaction",
    ic: "compress",
    desc: "Compaction strategy & pruning settings",
    category: "Session",
    tags: ["v1", "v2", "pruning"],
  },
  {
    cmd: "/context",
    ic: "context",
    desc: "Context & system dashboard",
    category: "Intelligence",
    tags: ["tokens", "budget", "status"],
  },
  {
    cmd: "/continue",
    ic: "play",
    desc: "Continue interrupted generation",
    category: "Session",
    tags: ["resume"],
  },
  {
    cmd: "/diagnose",
    ic: "brain",
    desc: "Health check — LSP, tree-sitter, semantic indexing",
    category: "Intelligence",
    tags: ["health", "debug", "probe"],
  },
  { cmd: "/diff", ic: "git", desc: "Open diff in editor", category: "Git", tags: ["changes"] },
  {
    cmd: "/diff-style",
    ic: "git",
    desc: "Change diff display style",
    category: "Settings",
    tags: ["sidebyside", "compact"],
  },
  {
    cmd: "/editor",
    ic: "pencil",
    desc: "Toggle editor panel",
    category: "Editor",
    tags: ["neovim", "toggle"],
  },
  {
    cmd: "/editor-settings",
    ic: "cog",
    desc: "Toggle editor/LSP integrations",
    category: "Editor",
    tags: ["config", "lsp"],
  },
  {
    cmd: "/errors",
    ic: "error",
    desc: "Browse error log",
    category: "System",
    tags: ["debug", "log"],
  },
  {
    cmd: "/export",
    ic: "changes",
    desc: "Export chat — markdown, json, clipboard, all",
    category: "Session",
    tags: ["save", "markdown", "json", "clipboard", "diagnostic"],
  },
  {
    cmd: "/export api",
    ic: "search",
    desc: "Toggle per-step API request dump (messages, tools, usage per step)",
    category: "Session",
    tags: ["debug", "tokens", "cost"],
    hidden: true,
  },
  {
    cmd: "/export json",
    ic: "changes",
    desc: "Export chat as JSON",
    category: "Session",
    tags: ["save"],
    hidden: true,
  },
  {
    cmd: "/export clipboard",
    ic: "changes",
    desc: "Copy chat to clipboard (markdown)",
    category: "Session",
    tags: ["copy"],
    hidden: true,
  },
  {
    cmd: "/export all",
    ic: "search",
    desc: "Full diagnostic export (system prompt, messages, tools)",
    category: "Session",
    tags: ["debug"],
    hidden: true,
  },
  {
    cmd: "/force-claim",
    ic: "lock",
    desc: "Steal a file claim from another tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/font",
    ic: "pencil",
    desc: "Show/set terminal font",
    category: "Settings",
    tags: ["nerd", "terminal"],
  },
  { cmd: "/git", ic: "git", desc: "Git menu", category: "Git", tags: ["menu"] },
  { cmd: "/git-status", ic: "git", desc: "Git status", category: "Git", tags: ["info"] },
  {
    cmd: "/help",
    ic: "help",
    desc: "Command palette (Ctrl+K)",
    category: "System",
    tags: ["commands", "search"],
  },
  { cmd: "/init", ic: "git", desc: "Initialize git repo", category: "Git", tags: ["create"] },
  {
    cmd: "/instructions",
    ic: "system",
    desc: "Toggle instruction files (SOULFORGE.md, CLAUDE.md, etc.)",
    category: "Settings",
    tags: ["prompt", "config"],
  },
  {
    cmd: "/keys",
    ic: "cog",
    desc: "Manage LLM provider API keys",
    category: "Models",
    tags: ["api", "auth"],
  },
  { cmd: "/lazygit", ic: "git", desc: "Launch lazygit", category: "Git", tags: ["tui"] },
  { cmd: "/log", ic: "git", desc: "Show recent commits", category: "Git", tags: ["history"] },
  {
    cmd: "/lsp",
    ic: "brain",
    desc: "LSP status dashboard",
    category: "Intelligence",
    tags: ["language", "server", "mason"],
  },
  {
    cmd: "/lsp install",
    ic: "brain",
    desc: "Install & manage LSP servers (Mason registry)",
    category: "Intelligence",
    tags: ["mason", "install", "search"],
  },
  {
    cmd: "/lsp restart",
    ic: "brain",
    desc: "Restart LSP servers (all or specific)",
    category: "Intelligence",
    tags: ["restart"],
  },
  {
    cmd: "/memory",
    ic: "memory",
    desc: "Manage memory scopes, view & clear",
    category: "Intelligence",
    tags: ["recall", "knowledge"],
  },
  {
    cmd: "/mode",
    ic: "cog",
    desc: "Switch forge mode",
    category: "Settings",
    tags: ["architect", "socratic", "challenge", "plan", "auto"],
  },
  {
    cmd: "/model-scope",
    ic: "cog",
    desc: "Set model scope (project/global)",
    category: "Models",
    tags: ["config"],
  },
  {
    cmd: "/models",
    ic: "system",
    desc: "Switch LLM model (Ctrl+L)",
    category: "Models",
    tags: ["provider", "llm", "switch"],
  },
  {
    cmd: "/nerd-font",
    ic: "ghost",
    desc: "Toggle Nerd Font icons",
    category: "Settings",
    tags: ["icons", "terminal"],
  },
  {
    cmd: "/new-tab",
    ic: "tabs",
    desc: "Open new tab (Ctrl+T)",
    category: "Tabs",
    tags: ["create"],
  },
  {
    cmd: "/nvim-config",
    ic: "pencil",
    desc: "Switch neovim config mode",
    category: "Settings",
    tags: ["editor", "neovim"],
  },
  { cmd: "/open", ic: "changes", desc: "Open file in editor", category: "Editor", tags: ["file"] },
  {
    cmd: "/plan",
    ic: "plan",
    desc: "Toggle plan mode (research & plan only)",
    category: "Session",
    tags: ["architect", "research"],
  },
  {
    cmd: "/privacy",
    ic: "lock",
    desc: "Manage forbidden file patterns",
    category: "System",
    tags: ["security", "forbidden"],
  },
  {
    cmd: "/provider-settings",
    ic: "system",
    desc: "Provider options — thinking, effort, speed, context",
    category: "Models",
    tags: ["thinking", "effort", "speed", "config"],
  },
  {
    cmd: "/tools",
    ic: "search",
    desc: "Enable/disable tools for the agent",
    category: "Intelligence",
    tags: ["tools", "enable", "disable", "toggle"],
  },
  {
    cmd: "/providers",
    ic: "system",
    desc: "Provider & Models",
    category: "Models",
    tags: ["llm", "switch"],
    hidden: true,
  },
  {
    cmd: "/proxy",
    ic: "proxy",
    desc: "Proxy — status, start, stop, restart, login, upgrade",
    category: "Models",
    tags: ["account", "login", "logout", "install", "upgrade", "start", "stop", "restart"],
  },
  {
    cmd: "/proxy install",
    ic: "proxy",
    desc: "Reinstall CLIProxyAPI",
    category: "Models",
    tags: ["setup"],
    hidden: true,
  },
  {
    cmd: "/proxy login",
    ic: "proxy",
    desc: "Add a provider account",
    category: "Models",
    tags: ["auth", "oauth"],
    hidden: true,
  },
  {
    cmd: "/proxy logout",
    ic: "proxy",
    desc: "Remove a provider account",
    category: "Models",
    tags: ["auth"],
    hidden: true,
  },
  {
    cmd: "/proxy start",
    ic: "proxy",
    desc: "Start the proxy",
    category: "Models",
    tags: ["launch"],
    hidden: true,
  },
  {
    cmd: "/proxy stop",
    ic: "proxy",
    desc: "Stop the proxy",
    category: "Models",
    tags: ["kill"],
    hidden: true,
  },
  {
    cmd: "/proxy restart",
    ic: "proxy",
    desc: "Restart the proxy",
    category: "Models",
    tags: ["reboot"],
    hidden: true,
  },
  {
    cmd: "/proxy upgrade",
    ic: "proxy",
    desc: "Upgrade to latest version",
    category: "Models",
    tags: ["update"],
    hidden: true,
  },
  { cmd: "/pull", ic: "git", desc: "Pull from remote", category: "Git", tags: ["fetch", "sync"] },
  { cmd: "/push", ic: "git", desc: "Push to remote", category: "Git", tags: ["sync", "upload"] },
  { cmd: "/quit", ic: "quit", desc: "Exit SoulForge", category: "System", tags: ["exit", "close"] },
  {
    cmd: "/reasoning",
    ic: "brain",
    desc: "Show or hide reasoning content",
    category: "Settings",
    tags: ["thinking", "display"],
  },
  { cmd: "/rename", ic: "pencil", desc: "Rename current tab", category: "Tabs", tags: ["label"] },
  {
    cmd: "/repo-map",
    ic: "tree",
    desc: "Soul map settings (AST index)",
    category: "Intelligence",
    tags: ["semantic", "treesitter"],
  },
  { cmd: "/restart", ic: "ghost", desc: "Full restart", category: "System", tags: ["reboot"] },
  {
    cmd: "/router",
    ic: "router",
    desc: "Route models per task (code, explore, plan, verify)",
    category: "Models",
    tags: ["dispatch", "routing"],
  },
  {
    cmd: "/sessions",
    ic: "clock_alt",
    desc: "Browse & restore sessions",
    category: "Session",
    tags: ["history", "restore"],
  },
  {
    cmd: "/settings",
    ic: "cog",
    desc: "Settings hub — all options in one place",
    category: "Settings",
    tags: ["config", "preferences", "hub"],
  },
  {
    cmd: "/setup",
    ic: "ghost",
    desc: "Check & install prerequisites",
    category: "System",
    tags: ["install", "check"],
  },
  {
    cmd: "/skills",
    ic: "skills",
    desc: "Browse & install skills",
    category: "Intelligence",
    tags: ["plugins", "extensions"],
  },
  {
    cmd: "/split",
    ic: "pencil",
    desc: "Cycle editor/chat split (40/50/60/70)",
    category: "Editor",
    tags: ["layout", "resize"],
  },
  {
    cmd: "/stash",
    ic: "git",
    desc: "Stash changes — pop to restore",
    category: "Git",
    tags: ["save", "pop", "restore"],
  },
  {
    cmd: "/stash pop",
    ic: "git",
    desc: "Pop latest stash",
    category: "Git",
    tags: ["restore"],
    hidden: true,
  },
  {
    cmd: "/status",
    ic: "info",
    desc: "System status dashboard",
    category: "System",
    tags: ["info", "health", "context", "tokens"],
  },
  {
    cmd: "/storage",
    ic: "system",
    desc: "View & manage storage usage",
    category: "System",
    tags: ["disk", "cleanup"],
  },
  { cmd: "/tabs", ic: "tabs", desc: "List open tabs", category: "Tabs", tags: ["switch"] },
  {
    cmd: "/unclaim",
    ic: "lock",
    desc: "Release a file claim from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/unclaim-all",
    ic: "lock",
    desc: "Release all claims from current tab",
    category: "Tabs",
    tags: ["lock"],
  },
  {
    cmd: "/verbose",
    ic: "cog",
    desc: "Toggle verbose tool output",
    category: "Settings",
    tags: ["debug", "output"],
  },
  {
    cmd: "/vim-hints",
    ic: "pencil",
    desc: "Toggle vim keybinding hints",
    category: "Settings",
    tags: ["editor", "keybindings"],
  },
  {
    cmd: "/web-search",
    ic: "cog",
    desc: "Web search keys & settings",
    category: "Models",
    tags: ["search", "api"],
  },
];

export function getCommandDefs(): CommandDef[] {
  return COMMAND_DEFS;
}

export type { CommandContext, CommandHandler };
