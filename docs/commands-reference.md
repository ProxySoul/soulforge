# Command Reference

100 slash commands available. Type `/` in chat or press `Ctrl+K` to open the command palette.

Sub-commands (like `/proxy login`) work when typed directly but are grouped under their parent in the palette.

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+K` | Command palette — search all commands |
| `Ctrl+L` | Switch LLM model |
| `Ctrl+E` | Toggle editor panel |
| `Ctrl+G` | Git menu |
| `Ctrl+P` | Browse sessions |
| `Ctrl+S` | Browse skills |
| `Ctrl+N` | New session (saves current, starts fresh) |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+D` | Cycle forge mode |
| `Ctrl+X` | Abort generation |
| `Ctrl+C` | Copy selection / exit |
| `Ctrl+O` | Expand/collapse all (code, reasoning) |
| `Ctrl+H` | Command palette (alias) |
| `Ctrl+[` / `]` | Prev / next tab |
| `Ctrl+1-9` | Switch to tab N |
| `Tab` / `Shift+Tab` | Cycle between tabs (from input box) |
| `Meta+R` | Error log (Alt+R on Linux) |

## Session

| Command | Description |
|---------|-------------|
| `/session` | Session — history, clear, export, compact |
| `/session clear` | Clear chat history |
| `/session compact` | Compact conversation context |
| `/session continue` | Continue interrupted generation |
| `/session export` | Export chat — markdown, json, clipboard, all |
| `/session export all` | Full diagnostic export (system prompt, messages, tools) |
| `/session export api` | Toggle per-step API request dump |
| `/session export clipboard` | Copy chat to clipboard (markdown) |
| `/session export json` | Export chat as JSON |
| `/session history` | Browse & restore sessions (Ctrl+P) |
| `/session new` | Start a new session (saves current) |
| `/session rename` | Rename current session |
| `/session plan` | Toggle plan mode (research & plan only) |
| `/compact` | Compact — run, settings, logs |
| `/compact logs` | View compaction events |
| `/compact settings` | Compaction strategy & pruning settings |

## Git

| Command | Description |
|---------|-------------|
| `/git` | Git menu (Ctrl+G) |
| `/git branch` | Show/create branch |
| `/git co-author` | Toggle co-author trailer |
| `/git commit` | Git commit with message |
| `/git diff` | Open diff in editor |
| `/git init` | Initialize git repo |
| `/git lazygit` | Launch lazygit |
| `/git log` | Show recent commits |
| `/git pull` | Pull from remote |
| `/git push` | Push to remote |
| `/git stash` | Stash changes — pop to restore |
| `/git stash pop` | Pop latest stash |
| `/git status` | Git status |

## Models & Providers

| Command | Description |
|---------|-------------|
| `/keys` | Manage LLM provider API keys |
| `/codex login` | Log in to Codex with your ChatGPT subscription |
| `/model-scope` | Set model scope (project/global) |
| `/models` | Switch LLM model (Ctrl+L) |
| `/provider-settings` | Provider options — thinking, effort, speed, context |
| `/proxy` | Proxy — status, install, start, stop, restart, login, upgrade |
| `/proxy install` | Reinstall CLIProxyAPI |
| `/proxy login` | Add a provider account |
| `/proxy logout` | Remove a provider account |
| `/proxy restart` | Restart the proxy |
| `/proxy start` | Start the proxy |
| `/proxy status` | Proxy status & accounts |
| `/proxy stop` | Stop the proxy |
| `/proxy upgrade` | Upgrade to latest version |
| `/router` | Route models per task (code, explore, plan, verify) |
| `/web-search` | Web search keys & settings |
| `/mcp` | MCP servers — status, tools, reconnect |

## Intelligence

| Command | Description |
|---------|-------------|
| `/context` | Context & system dashboard |
| `/diagnose` | Health check — LSP, tree-sitter, semantic indexing |
| `/lsp` | Manage LSP servers — install, disable, enable |
| `/lsp install` | Install & manage LSP servers (Mason registry) |
| `/lsp restart` | Restart LSP servers (all or specific) |
| `/lsp status` | LSP status dashboard |
| `/memory` | Manage memory scopes, view & clear |
| `/repo-map` | Soul map settings (AST index) |
| `/skills` | Browse & install skills (Ctrl+S) |
| `/tools` | Enable/disable tools for the agent |

## Settings

| Command | Description |
|---------|-------------|
| `/agent-features` | Toggle agent features (de-sloppify, tier routing) |
| `/chat-style` | Toggle chat layout style |
| `/diff-style` | Change diff display style |
| `/font` | Terminal font — show, set, nerd |
| `/font nerd` | Toggle Nerd Font icons |
| `/font set` | Set terminal font |
| `/instructions` | Toggle instruction files (SOULFORGE.md, CLAUDE.md, etc.) |
| `/lock-in` | Toggle lock-in mode — hide narration, show tools + final answer |
| `/mode` | Switch forge mode |
| `/nvim-config` | Switch neovim config mode |
| `/reasoning` | Show or hide reasoning content |
| `/settings` | Settings hub — all options in one place |
| `/theme` | Switch color theme (live preview) |
| `/verbose` | Toggle verbose tool output |
| `/vim-hints` | Toggle vim keybinding hints |

## Editor

| Command | Description |
|---------|-------------|
| `/editor` | Editor — toggle, open, settings, split |
| `/editor open` | Open file in editor |
| `/editor settings` | Toggle editor/LSP integrations |
| `/editor split` | Cycle editor/chat split (40/50/60/70) |

## Tabs & Terminals

| Command | Description |
|---------|-------------|
| `/changes` | Toggle files changed this session |
| `/claim` | Show active file claims across tabs |
| `/claim force` | Steal a file claim from another tab |
| `/claim release` | Release a file claim from current tab |
| `/claim release-all` | Release all claims from current tab |
| `/tab` | Tabs — switch, new, close, rename |
| `/tab close` | Close current tab (Ctrl+W) |
| `/tab new` | Open new tab (Ctrl+T) |
| `/tab rename` | Rename current tab |
| `/terminals` | Terminal manager — new, close, show, hide, rename |
| `/terminals close` | Close a terminal |
| `/terminals hide` | Hide terminal panel |
| `/terminals new` | Spawn a new terminal |
| `/terminals rename` | Rename a terminal |
| `/terminals show` | Show terminal panel |

## System

| Command | Description |
|---------|-------------|
| `/errors` | Browse error log |
| `/help` | Command palette (Ctrl+K) |
| `/hooks` | View active hooks (PreToolUse, PostToolUse, etc.) |
| `/privacy` | Manage forbidden file patterns |
| `/quit` | Exit SoulForge |
| `/restart` | Full restart |
| `/setup` | Check & install prerequisites |
| `/status` | System status dashboard |
| `/storage` | View & manage storage usage |
| `/update` | Check for SoulForge updates |
| `/wizard` | Re-run the first-run setup wizard |