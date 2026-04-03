<h1 align="center">SoulForge</h1>

<p align="center">
  <strong>The AI coding agent that already knows your codebase.</strong><br/>
  Graph-powered intelligence · multi-agent dispatch · terminal-native
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-BSL%201.1-blue.svg" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/version-1.7.0-brightgreen.svg" alt="Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue.svg" alt="TypeScript" /></a>
  <img src="https://img.shields.io/badge/tests-2296%20passing-brightgreen.svg" alt="Tests" />
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6.svg" alt="Bun" /></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/proxysoul">proxySoul</a></em>
</p>

<p align="center">
  <img src="assets/main-1.png" alt="SoulForge — Graph-Powered Code Intelligence" width="900" />
</p>

---

## Why SoulForge?

Every AI coding tool starts blind. The agent reads files, greps around, slowly pieces together what your codebase looks like. You're paying for the agent to figure out what you already know.

SoulForge doesn't work that way. On startup, it builds a **live dependency graph** of your entire codebase. Every file, symbol, import, and export, ranked by importance, enriched with git history, updated in real-time as files change. The agent already knows which files matter, what depends on what, and how far an edit will ripple. It doesn't need to explore. It just starts working.

### How SoulForge saves you 30-50% on API costs & in less time

| | |
|---|---|
| **[Live Soul Map](docs/repo-map.md)** | A SQLite-backed graph of every file, symbol, import, and export — ranked by PageRank, enriched with git co-change history, updated in real-time. The agent already knows where everything lives and how far an edit will ripple. No wasted tokens orienting itself. |
| **[Surgical reads](docs/architecture.md)** | Instead of reading entire files, the agent extracts exactly the function or class it needs by name via a 4-tier intelligence chain (LSP → ts-morph → tree-sitter → regex) across 30 languages. A 500-line file becomes a 20-line symbol extraction. |
| **[Zero-cost compaction](docs/compaction.md)** | State extraction runs as the conversation happens: files touched, decisions made, errors hit. When context gets long, it compacts instantly from this pre-built state. No LLM call, no latency, no cost. |
| **[Multi-agent dispatch](docs/agent-bus.md)** | Parallelize work across explore, code, and web search agents. The first agent to read a large file caches it — others get a compact stub with symbol names and line ranges. Edit coordination prevents conflicts. |
| **[Multi-tab coordination](docs/cross-tab-coordination.md)** | Run concurrent sessions with different models and modes per tab. Agents see what other tabs are editing, get warnings on contested files, and git operations coordinate automatically. |
| **[Compound tools](docs/compound-tools.md)** | `read` batches files in parallel with surgical extraction. `multi_edit` applies changes atomically. `rename_symbol`, `move_symbol`, `rename_file` are compiler-guaranteed and cross-file. `project` auto-detects lint/test/build across 23 ecosystems. |
| **Mix-and-match models** | You choose which model handles which job. Put Opus on planning, Sonnet on coding, Haiku on search and cleanup. Or use one model for everything. The task router gives you full control. |
| **Prompt caching** | The Soul Map is stable across turns, so it stays cached. On Anthropic, that means the bulk of the system prompt costs a fraction of what it would otherwise. |

### And also

- **Lock-in mode.** Hides agent narration during work, shows only tool activity and the final answer. Toggle via `/lock-in` or config.
- **Embedded Neovim.** Your actual config, plugins, and LSP servers. The AI works through the same editor you use. [Deep dive →](docs/architecture.md)
- **10 providers.** Anthropic, OpenAI, Google, xAI, Ollama, OpenRouter, LLM Gateway, Vercel AI Gateway, Proxy, and any OpenAI-compatible API. [Deep dive →](docs/provider-options.md)
- **Task router.** Assign different models to different jobs. Spark agents (explore/investigate) and ember agents (code edits) can each use different models. You pick what goes where. [Deep dive →](docs/architecture.md)
- **Code execution (Smithy).** Sandboxed code execution via Anthropic's `code_execution` tool. The agent can run Python to process data, do calculations, or batch tool calls programmatically.
- **User steering.** Type while the agent works. Messages queue up and reach the agent at the next step. [Deep dive →](docs/steering.md)
- **Skills & approval gates.** Installable skills for domain-specific work. Destructive actions require confirmation. Auto mode when you want full autonomy.
- **4-tier code intelligence.** LSP → ts-morph → tree-sitter → regex fallback across 30 languages. Dual LSP: Neovim bridge when the editor is open, standalone servers when it's not. [Deep dive →](docs/architecture.md)

<p align="center">
  <img src="assets/main-2.png" alt="SoulForge — Multi-Agent Dispatch" width="900" />
</p>

---

## How it compares

| | SoulForge | Claude Code | Copilot CLI | Codex CLI | Aider |
|---|---|---|---|---|---|
| **Codebase awareness** | Live SQLite graph: PageRank, blast radius, cochange, clone detection, FTS5, unused exports | None (file reads + grep) | None | None (MCP plugins) | Tree-sitter repo map + PageRank |
| **Cost optimization** | Soul Map + surgical reads + zero-cost compaction + shared agent cache + mix-and-match models + prompt caching | Auto-compaction | Context window management | Server-side compaction | — |
| **Code intelligence** | 4-tier fallback: LSP → ts-morph → tree-sitter → regex. Dual LSP. 30 languages | LSP via plugins (no fallback chain) | LSP (VS Code) | MCP-based LSP | Tree-sitter AST |
| **Multi-agent** | Parallel dispatch with shared file/tool cache and edit coordination | Subagents + Agent Teams | Subagents + Fleet | Multi-agent v2 | Single agent |
| **Multi-tab** | Concurrent tabs with per-tab models, file claim awareness, cross-tab git coordination | — | — | — | — |
| **Task routing** | Per-task model assignment (spark, ember, web search, verify, desloppify, compact) | Single model | Single model | Per-agent model | Single model |
| **Compound tools** | `read` (batch + surgical), `multi_edit` (atomic), `rename_symbol`, `move_symbol`, `rename_file`, `refactor`, `project` | Rename via LSP | — | — | — |
| **Editor** | Embedded Neovim (your config, your plugins) | No editor | No editor | No editor | No editor |
| **Providers** | 10 + custom OpenAI-compatible | Anthropic only | Multi-model | OpenAI only | 100+ LLMs |
| **License** | BSL 1.1 (source-available) | Proprietary | Proprietary | Apache 2.0 | Apache 2.0 |

> *Competitor features verified as of March 29, 2026. [Let us know](https://github.com/ProxySoul/soulforge/issues) if something's changed.*

---

## Installation

macOS and Linux. SoulForge checks for prerequisites on first launch and offers to install Neovim and Nerd Fonts if missing.

### Homebrew (recommended)

```bash
brew tap proxysoul/tap
brew install soulforge
```

<details>
<summary><strong>Bun (global install)</strong></summary>

```bash
curl -fsSL https://bun.sh/install | bash
bun install -g @proxysoul/soulforge
soulforge
```

</details>

<details>
<summary><strong>Prebuilt binary</strong></summary>

Download from [GitHub Releases](https://github.com/ProxySoul/soulforge/releases/latest), extract, and run the installer:

```bash
tar xzf soulforge-*.tar.gz && cd soulforge-*/ && ./install.sh
```

Installs to `~/.soulforge/`, adds to PATH.

</details>

<details>
<summary><strong>Self-contained bundle</strong></summary>

Ships everything: Neovim 0.11, ripgrep, fd, lazygit, tree-sitter grammars, Nerd Font symbols. No system dependencies.

```bash
git clone https://github.com/ProxySoul/soulforge.git && cd soulforge && bun install
./scripts/bundle.sh              # macOS ARM64
./scripts/bundle.sh x64          # Intel Mac
./scripts/bundle.sh x64 linux    # Linux x64
./scripts/bundle.sh arm64 linux  # Linux ARM64
cd dist/bundle/soulforge-*/ && ./install.sh
```

</details>

<details>
<summary><strong>Build from source</strong></summary>

Requires [Bun](https://bun.sh) >= 1.0 and [Neovim](https://neovim.io) >= 0.11.

```bash
git clone https://github.com/ProxySoul/soulforge.git && cd soulforge && bun install
bun run dev          # development mode
# or
bun run build && bun link && soulforge
```

</details>

### Quick start

```bash
soulforge                                  # Launch, pick a model with Ctrl+L
soulforge --set-key anthropic sk-ant-...   # Save a key
soulforge --headless "your prompt here"    # Non-interactive mode
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for a full walkthrough.

---

## Usage

```bash
soulforge                                    # Launch TUI
soulforge --headless "prompt"               # Stream to stdout
soulforge --headless --json "prompt"        # Structured JSON output
soulforge --headless --chat                 # Interactive multi-turn
soulforge --headless --model provider/model # Override model
soulforge --headless --mode architect       # Read-only analysis
soulforge --headless --diff "fix the bug"   # Show changed files
```

**Modes:** default (full agent), auto (no questions), architect (read-only), socratic, challenge, plan

[Full CLI reference →](docs/headless.md) · [All 86 slash commands →](docs/commands-reference.md)

---

## Providers

| Provider | Setup |
|----------|-------|
| [**LLM Gateway**](https://llmgateway.io/?ref=6tjJR2H3X4E9RmVQiQwK) | `LLM_GATEWAY_API_KEY` |
| [**Anthropic**](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` |
| [**OpenAI**](https://platform.openai.com/) | `OPENAI_API_KEY` |
| [**Google**](https://aistudio.google.com/) | `GOOGLE_GENERATIVE_AI_API_KEY` |
| [**xAI**](https://console.x.ai/) | `XAI_API_KEY` |
| [**Ollama**](https://ollama.ai) | Auto-detected |
| [**OpenRouter**](https://openrouter.ai) | `OPENROUTER_API_KEY` |
| [**Vercel AI Gateway**](https://vercel.com/ai-gateway) | `AI_GATEWAY_API_KEY` |
| [**Proxy**](https://github.com/router-for-me/CLIProxyAPI) | `PROXY_API_KEY` |
| **Custom** | Any OpenAI-compatible API |

Add custom providers in config, no code changes:

```json
{
  "providers": [{
    "id": "deepseek",
    "name": "DeepSeek",
    "baseURL": "https://api.deepseek.com/v1",
    "envVar": "DEEPSEEK_API_KEY",
    "models": ["deepseek-chat", "deepseek-coder"]
  }]
}
```

[Provider options →](docs/provider-options.md) · [Custom providers →](docs/headless.md#custom-providers)

---

## Configuration

Layered: global (`~/.soulforge/config.json`) + project (`.soulforge/config.json`).

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-6",
  "thinking": { "mode": "adaptive" },
  "repoMap": true,
  "taskRouter": {
    "spark": "anthropic/claude-sonnet-4-6",
    "ember": "anthropic/claude-opus-4-6",
    "webSearch": "anthropic/claude-haiku-4-5",
    "desloppify": "anthropic/claude-haiku-4-5",
    "compact": "google/gemini-2.0-flash"
  },
  "instructionFiles": ["soulforge", "claude", "cursorrules"]
}
```

**Project instructions:** Drop a `SOULFORGE.md` in your project root with conventions, architecture notes, preferences. Also supports `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, and others. Toggle via `/instructions`.

See [GETTING_STARTED.md](GETTING_STARTED.md) for the full config reference.

---

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | System overview, intelligence router, agent system, tool design |
| [Repo Map](docs/repo-map.md) | PageRank, cochange, blast radius, clone detection, language support |
| [Agent Bus](docs/agent-bus.md) | Multi-agent coordination, shared cache, edit ownership |
| [Compaction](docs/compaction.md) | V1/V2 context management, working state extraction |
| [Compound Tools](docs/compound-tools.md) | read, multi_edit, rename_symbol, move_symbol, refactor, project |
| [Project Tool](docs/project-tool.md) | 23 ecosystems, pre-commit checks, monorepo discovery |
| [Headless Mode](docs/headless.md) | CLI flags, JSON/JSONL output, CI/CD integration |
| [Commands](docs/commands-reference.md) | All 86 slash commands |
| [Steering](docs/steering.md) | Mid-stream user input |
| [Provider Options](docs/provider-options.md) | Thinking modes, context management |
| [Prompt System](docs/prompt-system.md) | Per-family prompts, mode overlays |
| [Getting Started](GETTING_STARTED.md) | First launch walkthrough |
| [Contributing](CONTRIBUTING.md) | Dev setup, PR guidelines |

---

## Roadmap

The intelligence layer is being extracted into reusable packages:

- **`@soulforge/intelligence`**: graph intelligence, tools, and agent orchestration as an importable library
- **`@soulforge/mcp`**: expose Soul Map tools as MCP servers for Claude Code, Cursor, Copilot, or any MCP client
- **`sf --headless`**: shipped. Non-interactive mode for CI/CD, automation, and scripting. [Docs →](docs/headless.md)

**In progress:** MCP support · repo map visualization · GitHub CLI integration · dispatch worktrees · [ACP support](https://agentclientprotocol.com/)

**Planned:** monorepo graph support · benchmarks · orchestrated workflows (planner → TDD → reviewer → security)

---

## Inspirations

- **[Aider](https://github.com/Aider-AI/aider)**: tree-sitter repo maps with PageRank. SoulForge adds cochange analysis, blast radius, clone detection, and live updates.
- **[Everything Claude Code](https://github.com/affaan-m/everything-claude-code)**: enforce behavior with code, not prompts. Our schema validation, pre-commit gates, and auto-enrichment patterns come from this thinking.
- **[Vercel AI SDK](https://sdk.vercel.ai)**: the multi-provider abstraction that makes 10 providers possible.
- **[Neovim](https://neovim.io)**: embedded via msgpack-RPC. Your config and muscle memory shouldn't be a compromise.

---

## License

[Business Source License 1.1](LICENSE). Free for personal and internal use. Commercial use requires a [commercial license](COMMERCIAL_LICENSE.md). Converts to Apache 2.0 on March 15, 2030.

<p align="center">
  <sub>Built with care by <a href="https://github.com/proxysoul">proxySoul</a></sub>
</p>