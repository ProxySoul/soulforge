# Getting Started

This guide walks you through setting up SoulForge for the first time. For a quick overview of what SoulForge does, see the [README](README.md).

## Prerequisites

> If you're using the **prebuilt binary** or **Homebrew**, skip to [Neovim](#neovim) — Bun is not required.

### Bun (npm/source installs only)

SoulForge runs on [Bun](https://bun.sh), not Node.js.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS via Homebrew
brew install bun
```

Verify: `bun --version` (need >= 1.0)

### Neovim

SoulForge embeds a real Neovim instance — your config, plugins, and LSP all work inside it.

```bash
# macOS
brew install neovim

# Ubuntu / Debian
sudo apt install neovim

# Arch
sudo pacman -S neovim
```

Verify: `nvim --version` (need >= 0.11)

### A Nerd Font

SoulForge uses [Nerd Font](https://www.nerdfonts.com/) icons throughout the UI. Without one, you'll see blank squares instead of icons. Any Nerd Font works — popular choices:

- [JetBrains Mono Nerd Font](https://github.com/ryanoasis/nerd-fonts/releases)
- [FiraCode Nerd Font](https://github.com/ryanoasis/nerd-fonts/releases)

After installing, set it as your terminal's font. Or run `/setup` inside SoulForge to check and install fonts automatically.

### An API Key

You need at least one LLM provider key:

| Provider | Env Variable | Models                                 |
|----------|-------------|----------------------------------------|
| Anthropic | `ANTHROPIC_API_KEY` | Claude Opus 4.5, Sonnet 4.6, Haiku 4.5 |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o3, o4-mini                    |
| xAI | `XAI_API_KEY` | Grok                                   |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini 3 Flash, Gemini 3.1 Pro         |
| OpenRouter | `OPENROUTER_API_KEY` | 300+ models from all providers         |
| Ollama | *(none — runs locally)* | Llama, Mistral, Qwen, DeepSeek, etc.   |

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Alternatively, a single [AI Gateway](https://sdk.vercel.ai/docs/ai-sdk-core/provider-management) key gives you access to all providers:

```bash
export AI_GATEWAY_API_KEY=...
```

Or use the built-in **Proxy provider** to relay through a local CLIProxyAPI instance (no API key needed — uses your Claude web session). Set up with `/proxy install` and `/proxy login` after launching SoulForge.

## Install

### Option 1: Prebuilt binary (recommended)

Download the latest release from [GitHub Releases](https://github.com/ProxySoul/soulforge/releases/latest), extract, and run the installer:

```bash
tar xzf soulforge-*.tar.gz
cd soulforge-*/
./install.sh
```

Installs to `~/.soulforge/` and adds it to your PATH.

### Option 2: Homebrew

```bash
brew tap proxysoul/tap
brew install soulforge
```

### Option 3: Bun (global install)

Requires [Bun](https://bun.sh) >= 1.2 — SoulForge uses Bun-specific APIs.

```bash
curl -fsSL https://bun.sh/install | bash   # install Bun if needed
bun install -g @proxysoul/soulforge
```

### Option 4: Build from source

```bash
git clone https://github.com/ProxySoul/soulforge.git
cd soulforge
bun install
bun run dev          # development mode
# or: bun run build && bun link   # install globally
```

### First run

On first launch, SoulForge creates a config at `~/.soulforge/config.json` with sensible defaults. It will check for Neovim and Nerd Fonts and offer to install them if missing.

## The Interface

When SoulForge starts you'll see:

```
┌─────────────────────────────────────────────────┐
│  󰊠 SoulForge │ tokens │ context │ git │ model   │  ← header
│                                                 │
│  Chat messages appear here                      │  ← chat area
│  Tool calls show in real time                   │
│                                                 │
│  > type here...                                 │  ← input
│  ^X Stop  ^D Mode  ^E Editor  ^G Git  ^L LLM   │  ← footer
└─────────────────────────────────────────────────┘
```

**Header** shows token usage, context budget, git branch, and active model.

**Chat area** renders messages with markdown, syntax-highlighted code blocks, and live tool call progress.

**Input box** accepts natural language or slash commands (type `/` to see them). Pasting multi-line content collapses to show the first line + a line count badge — press up/down to expand.

**Footer** shows keybinding shortcuts.

## Editor Panel

Press `Ctrl+E` to open the embedded Neovim editor. The screen splits — editor on the left, chat on the right.

Focus cycles with `Ctrl+E`:

1. **Editor closed** → `Ctrl+E` → editor opens, Neovim focused
2. **Neovim focused** → `Ctrl+E` → chat focused (editor stays open)
3. **Chat focused** → `Ctrl+E` → editor closes

When Neovim is focused, all keystrokes go directly to it — use it exactly like normal Neovim. Click the chat side or press `Ctrl+E` to switch back.

Open a specific file: `/open src/index.tsx`

### Neovim Config Modes

SoulForge ships its own `init.lua` (includes Mason for auto-installing LSP servers). You can switch modes:

```
/nvim-config auto      use shipped config if no user config exists (default)
/nvim-config user      always use your own nvim config
/nvim-config default   always use the shipped config
/nvim-config none      bare neovim, no config
```

## Switching Models

Press `Ctrl+L` to open the model picker. Pick a provider, then a model. The switch takes effect on the next message — you can change models mid-conversation.

## Task Router

Use `/router` to assign different models to different task types:

| Slot | Section | Use Case |
|------|---------|----------|
| `spark` | Dispatch | Read-only explore/investigate agents — searches, reads, analyzes |
| `ember` | Dispatch | Code agents — reads files and makes edits |
| `webSearch` | Dispatch | Web search and page fetching agent |
| `desloppify` | Post-Dispatch | Cleanup pass after code agents finish |
| `verify` | Post-Dispatch | Adversarial review pass after code agents |
| `compact` | Background | Context compaction summarizer |
| `semantic` | Background | Repo map LLM symbol summaries |
| `default` | — | Fallback when no specific slot matches |

For example: Sonnet for `ember` (code quality matters), a fast cheap model for `spark` and `desloppify`.

> **Legacy fields** `coding`, `exploration`, `trivial`, and `planning` are still accepted for backwards compatibility but map to `spark`/`ember` internally and are hidden from the `/router` UI.

## Agent Features

Use `/agent-features` to toggle agent behavior. All features default to **on** (when the relevant router model is configured).

| Feature | What it does |
|---------|-------------|
| **De-sloppify** | Runs a cleanup agent after code agents to remove sloppy patterns (console.log, commented-out code, redundant checks). Requires a model in the `desloppify` router slot. |
| **Tier Routing** | Auto-classifies tasks as trivial (single-file, short prompt) and routes them to the `spark` model for faster, cheaper execution. |
| **Dispatch Cache** | Caches file reads across dispatch boundaries so the parent agent doesn't re-read files that subagents already returned. |
| **Target File Validation** | Requires file paths on dispatch tasks — rejects vague instructions before any subagent runs. |

Settings are scoped (project or global) and saved to `.soulforge/config.json`:

```json
{
  "agentFeatures": {
    "desloppify": false,
    "tierRouting": true
  }
}
```

## Modes

`Ctrl+D` cycles through Forge's personas:

| Mode | Behavior |
|------|----------|
| **default** | Standard — investigates then implements |
| **architect** | Design only — outlines and tradeoffs, no code |
| **socratic** | Asks probing questions before doing anything |
| **challenge** | Devil's advocate — challenges every assumption |
| **plan** | Research only — reads and plans, no file edits |

Or switch directly: `/mode architect`

## Plan Mode

`/plan refactor the auth system` enters plan mode. Forge researches the codebase, writes a structured plan, then asks you to approve, revise, or cancel before executing anything.

The plan sidebar shows step-by-step progress during execution.

## Skills

Skills are markdown files that extend what Forge knows. Press `Ctrl+S` to browse.

Three tabs:

- **Search** — find and install from the [skills.sh](https://skills.sh) community registry
- **Installed** — skills on your machine (`~/.agents/skills/`, `~/.claude/skills/`)
- **Active** — skills loaded in the current session

## Web Search

Forge can search the web and read pages. Two search backends (Brave API → DuckDuckGo fallback) and two page fetchers (Jina Reader → Mozilla Readability fallback).

When a web search model is configured via `/router`, searches spawn a dedicated agent that can run multiple queries, follow links, and synthesize a structured summary — all within a single tool call.

Configure API keys via `/web-search`.

## Git

`Ctrl+G` opens the git menu with shortcuts for common operations:

| Key | Action |
|-----|--------|
| `c` | Commit (AI-generated message) |
| `p` | Push |
| `u` | Pull |
| `s` | Stash |
| `o` | Stash pop |
| `l` | Log |
| `g` | Launch lazygit |

Or use slash commands: `/git commit`, `/git push`, `/git pull`, `/git status`, `/git diff`, `/git log`, `/git branch`.

Toggle co-author commit trailers with `/git co-author`.

## Context Management

SoulForge auto-summarizes when context exceeds 80% of the model's window. You can also:

- `/summarize` or `/compact` — manually compact the conversation
- `/context` — view the context budget inspector (shows per-section token breakdown, cache hit rate)
- `/context clear` — reset conversation context

## Repo Map

On startup, SoulForge builds a live graph of your codebase — files, symbols, and import edges. PageRank ranks the most important files, which appear in the system prompt so the AI understands your codebase's shape.

Configure via `/repo-map`. See [docs/repo-map.md](docs/repo-map.md) for the full technical reference.

## Memory

Forge can store decisions, patterns, and preferences that persist across conversations via a SQLite-backed memory system.

- `/memory` — configure write scope (session/project/global), view and clear memories
- Memory appears in the system prompt automatically

## Scoped Configuration

Every setting can be saved to one of three scopes:

- **Session** — lost on exit (default)
- **Project** — saved to `.soulforge/config.json` in the project root
- **Global** — saved to `~/.soulforge/config.json` for all projects

Project settings override global; session overrides both.

## Privacy

Block files from AI access with `/privacy add <pattern>`:

```
/privacy add .env
/privacy add secrets/**
```

Forge will refuse to read, display, or access files matching these patterns — even via shell commands.

## Storage

`/storage` shows per-component disk usage across project and global storage — repo map index, sessions, plans, memory, history, config, binaries, fonts. One-click cleanup for each component.

## Troubleshooting

**"Neovim not found"**
Make sure `nvim` is on your `PATH`. You can set an explicit path in `~/.soulforge/config.json` under `nvimPath`.

**No models in `Ctrl+L`**
Your API key isn't set or isn't exported. Add `export ANTHROPIC_API_KEY=...` to your shell profile and restart your terminal.

**Icons show as boxes or question marks**
Install a [Nerd Font](https://www.nerdfonts.com/) and set it as your terminal font. Run `/font` inside SoulForge to check, or `/setup` to install one.

**Editor panel looks garbled**
Make sure your terminal supports true color. Most modern terminals do, but you may need `export COLORTERM=truecolor` in your shell profile.

**Forge seems slow**
Switch to a faster model with `Ctrl+L` (e.g. Haiku 4.5 or a local Ollama model). Use `/router` to assign fast/cheap models to `spark`, `desloppify`, and `compact` slots, and reserve a strong model for `ember`.

**Context getting large**
Run `/summarize` or `/compact` to condense the conversation. `/context` shows exactly where tokens are going.

## What's Next

- Type `/help` for the full command reference
- Press `Ctrl+S` to browse community skills
- Use `/router` to optimize model assignment per task
- Read [CONTRIBUTING.md](CONTRIBUTING.md) to hack on SoulForge itself
- See [docs/](docs/) for deep dives on architecture, repo map, compound tools, and the agent bus
