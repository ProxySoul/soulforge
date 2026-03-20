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

const prefixMatchers = [
  matchContextPrefix,
  matchGitPrefix,
  matchConfigPrefix,
  matchSessionPrefix,
  matchNavPrefix,
  matchSecurityPrefix,
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
interface CommandDef {
  cmd: string;
  ic: string;
  desc: string;
}

const COMMAND_DEFS: CommandDef[] = [
  { cmd: "/agent-features", ic: "cog", desc: "Toggle agent features (de-sloppify, tier routing)" },
  { cmd: "/branch", ic: "git", desc: "Show/create branch" },
  { cmd: "/changes", ic: "changes", desc: "Toggle changed files tree" },
  { cmd: "/chat-style", ic: "chat", desc: "Toggle chat layout style" },
  { cmd: "/clear", ic: "clear", desc: "Clear chat history" },
  { cmd: "/close-tab", ic: "tabs", desc: "Close current tab (Alt+W)" },
  { cmd: "/co-author-commits", ic: "git", desc: "Toggle co-author trailer" },
  { cmd: "/commit", ic: "git", desc: "Git commit with message" },
  { cmd: "/compact", ic: "compress", desc: "Compact conversation context" },
  { cmd: "/compact-v2-logs", ic: "plan", desc: "View compaction events" },
  { cmd: "/compaction", ic: "compress", desc: "Switch compaction strategy (v1/v2)" },
  { cmd: "/context", ic: "context", desc: "Show/clear context budget" },
  { cmd: "/continue", ic: "play", desc: "Continue interrupted generation" },
  { cmd: "/diagnose", ic: "brain", desc: "Intelligence health check — probe all backends" },
  { cmd: "/diff", ic: "git", desc: "Open diff in editor" },
  { cmd: "/diff-style", ic: "git", desc: "Change diff display style" },
  { cmd: "/editor", ic: "pencil", desc: "Toggle editor panel" },
  { cmd: "/editor-settings", ic: "cog", desc: "Toggle editor/LSP integrations" },
  { cmd: "/errors", ic: "error", desc: "Browse error log" },
  { cmd: "/export", ic: "changes", desc: "Export chat to markdown" },
  { cmd: "/export json", ic: "changes", desc: "Export chat as JSON" },
  { cmd: "/font", ic: "pencil", desc: "Show/set terminal font" },
  { cmd: "/git", ic: "git", desc: "Git menu" },
  { cmd: "/git-status", ic: "git", desc: "Git status" },
  { cmd: "/help", ic: "help", desc: "Show available commands" },
  { cmd: "/init", ic: "git", desc: "Initialize git repo" },
  {
    cmd: "/instructions",
    ic: "system",
    desc: "Toggle instruction files (SOULFORGE.md, CLAUDE.md, etc.)",
  },
  { cmd: "/keys", ic: "cog", desc: "Manage LLM provider API keys" },
  { cmd: "/lazygit", ic: "git", desc: "Launch lazygit" },
  { cmd: "/log", ic: "git", desc: "Show recent commits" },
  { cmd: "/lsp", ic: "brain", desc: "Language server status & diagnostics" },
  { cmd: "/lsp-install", ic: "brain", desc: "Install & manage LSP servers (Mason registry)" },
  { cmd: "/memory", ic: "memory", desc: "Manage memory scopes, view & clear" },
  { cmd: "/mode", ic: "cog", desc: "Switch forge mode" },
  { cmd: "/model-scope", ic: "cog", desc: "Set model scope (project/global)" },
  { cmd: "/models", ic: "system", desc: "Switch LLM model (Ctrl+L)" },
  { cmd: "/nerd-font", ic: "ghost", desc: "Toggle Nerd Font icons" },
  { cmd: "/new-tab", ic: "tabs", desc: "Open new tab (Alt+T)" },
  { cmd: "/nvim-config", ic: "pencil", desc: "Switch neovim config mode" },
  { cmd: "/open", ic: "changes", desc: "Open file in editor" },
  { cmd: "/plan", ic: "plan", desc: "Toggle plan mode (research & plan only)" },
  { cmd: "/privacy", ic: "lock", desc: "Manage forbidden file patterns" },
  { cmd: "/provider-settings", ic: "system", desc: "Thinking, effort, speed, context mgmt" },
  { cmd: "/providers", ic: "system", desc: "Provider & Models" },
  { cmd: "/proxy", ic: "proxy", desc: "Proxy status" },
  { cmd: "/proxy install", ic: "proxy", desc: "Install CLIProxyAPI" },
  { cmd: "/proxy login", ic: "proxy", desc: "Authenticate with Claude" },
  { cmd: "/pull", ic: "git", desc: "Pull from remote" },
  { cmd: "/push", ic: "git", desc: "Push to remote" },
  { cmd: "/quit", ic: "quit", desc: "Exit SoulForge" },
  { cmd: "/reasoning", ic: "brain", desc: "Show or hide reasoning content" },
  { cmd: "/rename", ic: "pencil", desc: "Rename current tab" },
  { cmd: "/repo-map", ic: "tree", desc: "Soul map settings (AST index)" },
  { cmd: "/restart", ic: "ghost", desc: "Full restart" },
  { cmd: "/router", ic: "router", desc: "Assign models per task type" },
  { cmd: "/sessions", ic: "clock_alt", desc: "Browse & restore sessions" },
  { cmd: "/setup", ic: "ghost", desc: "Check & install prerequisites" },
  { cmd: "/skills", ic: "skills", desc: "Browse & install skills" },
  { cmd: "/split", ic: "pencil", desc: "Cycle editor/chat split (40/50/60/70)" },
  { cmd: "/stash", ic: "git", desc: "Stash changes" },
  { cmd: "/stash pop", ic: "git", desc: "Pop latest stash" },
  { cmd: "/status", ic: "info", desc: "System status" },
  { cmd: "/storage", ic: "system", desc: "View & manage storage usage" },
  { cmd: "/tabs", ic: "tabs", desc: "List open tabs" },
  { cmd: "/verbose", ic: "cog", desc: "Toggle verbose tool output" },
  { cmd: "/vim-hints", ic: "pencil", desc: "Toggle vim keybinding hints" },
  { cmd: "/web-search", ic: "cog", desc: "Web search keys & settings" },
];

export function getCommandDefs(): CommandDef[] {
  return COMMAND_DEFS;
}

export type { CommandContext, CommandHandler };
