<h1 align="center">SoulForge</h1>

<p align="center">
  <strong>AI-Powered Terminal IDE</strong><br/>
  Embedded Neovim + Multi-Agent System + Graph-Powered Code Intelligence
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-BSL%201.1-blue.svg" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/version-1.0.0-brightgreen.svg" alt="Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue.svg" alt="TypeScript" /></a>
  <a href="#testing"><img src="https://img.shields.io/badge/tests-1942%20passing-brightgreen.svg" alt="Tests" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6.svg" alt="Bun" /></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/proxysoul">proxySoul</a></em>
</p>

---

## What is SoulForge?

Your real Neovim — config, plugins, LSP — embedded in an AI agent that understands your codebase structurally. Graph-powered intelligence, multi-agent dispatch, 10 providers. Works over SSH.

<p align="center">
  <img src="assets/soulforge-hero.png" alt="SoulForge in action" width="900" />
</p>

### How it compares

| | SoulForge | Claude Code | Copilot CLI | Aider |
|---|---|---|---|---|
| **Editor** | Embedded Neovim (LazyVim, your config) | No editor | No editor | No editor |
| **Code intelligence** | Graph + PageRank + blast radius + cochange + clone detection | File reads + grep + LSP (experimental) | LSP (optional) | Tree-sitter repo map + PageRank |
| **Multi-agent** | Parallel dispatch (8 agents, shared cache) | Subagents + Agent Teams | Subagents + Fleet | Single agent |
| **Providers** | 10 (Anthropic, OpenAI, Google, xAI, Ollama, +5) | Anthropic models (API, Bedrock, Vertex) | Multi-model | 100+ LLMs |
| **Cost visibility** | Per task, per agent, per model | `/cost` per session | Request counts | Per message |
| **MCP** | Roadmap | Yes | Yes | No |
| **License** | BSL 1.1 (source-available) | Proprietary | Proprietary | Apache 2.0 |

---

## Highlights

<table>
<tr>
<td width="50%">

### Embedded Neovim + LazyVim
Your actual Neovim — LazyVim distribution with 30+ plugins, LSP servers auto-installed via Mason, Catppuccin theme, bufferline, noice, treesitter highlighting. The AI reads, navigates, and edits through the same editor you use. Your config, your muscle memory.

</td>
<td width="50%">

### Multi-Agent Dispatch
Parallelize work across explore, code, and web search agents. Shared file cache prevents redundant reads. Edit coordination prevents conflicts. Up to 8 agents, 3 concurrent slots. [Deep dive →](docs/agent-bus.md)

</td>
</tr>
<tr>
<td>

### Graph-Powered Repo Map
SQLite-backed codebase graph with PageRank ranking, cochange analysis, blast radius estimation, and clone detection. The agent understands which files matter, what changes together, and how far edits ripple — before reading a single line. [Deep dive →](docs/repo-map.md)

</td>
<td>

### 4-Tier Code Intelligence
LSP → ts-morph → tree-sitter → regex fallback chain. 30+ languages with convention-based visibility detection. Dual LSP backend: bridges to Neovim's LSP when the editor is open, spawns standalone servers when it's not. [Deep dive →](docs/architecture.md)

</td>
</tr>
<tr>
<td>

### Compound Tools
`rename_symbol`, `move_symbol`, `refactor`, `project` do the complete job in one call. Compiler-guaranteed renames. Atomic moves with import updates across all importers. [Deep dive →](docs/compound-tools.md)

</td>
<td>

### Task Router + Cost Transparency
Assign models per task: Opus for planning, Sonnet for coding, Haiku for search. Token usage visible per task, per agent, per model — you see exactly what you're spending and the router optimizes it automatically.

</td>
</tr>
<tr>
<td>

### Context Management
Two-layer compaction keeps long sessions productive: rolling tool-result pruning per step, plus V1 (LLM summary) or V2 (deterministic extraction) compaction on threshold. [Deep dive →](docs/compaction.md)

</td>
<td>

### User Steering
Type messages while the agent is working — they queue up and inject into the next agent step. Steer without interrupting. Abort cleanly with Ctrl+X. [Deep dive →](docs/steering.md)

</td>
</tr>
<tr>
<td>

### 10 Providers, Any Model
Anthropic, OpenAI, Google, xAI, Ollama (local), OpenRouter, LLM Gateway, Vercel AI Gateway, Proxy, and custom OpenAI-compatible APIs. You own the API keys. No vendor lock-in. [Deep dive →](docs/provider-options.md)

</td>
<td>

### Cross-Tab Coordination
Up to 5 concurrent tabs with advisory file claims. Agents see what other tabs are editing, get warnings on contested files, and git operations are blocked during active dispatch. [Deep dive →](docs/cross-tab-coordination.md)

</td>
</tr>
<tr>
<td>

### Project Toolchain
Auto-detects lint, typecheck, test, and build commands across 22 ecosystems from config files. Pre-commit gate blocks `git commit` on lint/type errors. Monorepo package discovery. [Deep dive →](docs/project-tool.md)

</td>
<td>

### Skills & Approval Gates
Installable skill system for domain-specific capabilities. Destructive action approval — `rm -rf`, `git push --force`, sensitive file edits individually prompted. Auto mode for full autonomy when you want it.

</td>
</tr>
</table>

---

## Architecture

The Forge Agent is the orchestrator. It holds 30+ tools including the `dispatch` tool, which creates an AgentBus and launches parallel subagents. Subagents share file/tool caches through the bus and coordinate edits via ownership tracking.

```mermaid
graph TB
    User([User Input]) --> Chat[useChat Hook]
    Chat --> Forge[Forge Agent]

    subgraph Forge Tools
        Tools[30+ Direct Tools]
        Dispatch[dispatch tool]
    end

    Forge --> Tools
    Forge --> Dispatch

    Dispatch --> |creates| Bus[AgentBus<br/>file cache · tool cache<br/>findings · edit ownership]

    Bus --> |spawns with bus| E1[Explore Agent]
    Bus --> |spawns with bus| E2[Explore Agent]
    Bus --> |spawns with bus| C[Code Agent]

    E1 & E2 & C --> |read/write cache| Bus

    Tools --> Intel[Intelligence Router]
    Tools --> Nvim[Neovim<br/>msgpack-RPC]
    Tools --> RepoMap[(Repo Map<br/>SQLite · PageRank)]
    Tools --> Mem[(Memory<br/>SQLite · FTS5)]

    Intel --> LSP[LSP]
    Intel --> TSM[ts-morph]
    Intel --> TS[tree-sitter]
    Intel --> Regex[regex]

    style Forge fill:#9B30FF,color:#fff
    style Bus fill:#336,color:#fff
    style Dispatch fill:#663,color:#fff
    style RepoMap fill:#1a3,color:#fff
    style Mem fill:#1a3,color:#fff
    style Nvim fill:#57A143,color:#fff
```

### Intelligence Fallback Chain

Queries route through backends by tier. Each backend reports what it supports; the router picks the highest-tier backend available for the operation.

```mermaid
graph LR
    Query([Symbol Query]) --> LSP{LSP<br/>available?}
    LSP -->|yes| LSPResult[Precise<br/>types · refs · diagnostics]
    LSP -->|no| TSMorph{ts-morph<br/>available?}
    TSMorph -->|yes| TSMResult[AST<br/>signatures · exports]
    TSMorph -->|no| TreeSitter{tree-sitter<br/>grammar?}
    TreeSitter -->|yes| TSResult[Structural<br/>outlines · imports]
    TreeSitter -->|no| RegexResult[Best-effort<br/>pattern matching]

    style LSPResult fill:#4a7,color:#fff
    style TSMResult fill:#47a,color:#fff
    style TSResult fill:#a74,color:#fff
    style RegexResult fill:#a47,color:#fff
```

### Multi-Agent Dispatch

Up to 8 agents run concurrently (3 parallel slots) with staggered starts. All agents share a file cache through AgentBus — when one agent reads a file, others get it for free. Agents with `dependsOn` wait for their dependencies before starting.

```mermaid
sequenceDiagram
    participant U as User
    participant F as Forge Agent
    participant D as dispatch tool
    participant B as AgentBus
    participant E1 as Explore 1
    participant E2 as Explore 2
    participant C as Code Agent

    U->>F: "Audit auth and refactor middleware"
    F->>D: dispatch(3 tasks)
    D->>B: new AgentBus()
    par Concurrent (3 slots, staggered)
        D->>E1: launch (t=0ms)
        D->>E2: launch (t=150ms)
        D->>C: launch (dependsOn: E1, E2)
    end
    E1->>B: cache file reads + findings
    E2->>B: cache file reads + findings
    Note over B: Code agent reads<br/>hit cache instantly
    B-->>C: dependencies resolved
    C->>C: Edit with full context
    C->>B: done (edits applied)
    D->>F: All agents complete → merged result
```

---

## Installation

**Requirements:** [Bun](https://bun.sh) >= 1.0, [Neovim](https://neovim.io) >= 0.11

```bash
bun install -g @proxysoul/soulforge
soulforge   # or: sf
```

SoulForge checks for prerequisites on first launch and offers to install Neovim and Nerd Fonts if missing.

> Configure your `.npmrc` for GitHub Packages, or see [GETTING_STARTED.md](GETTING_STARTED.md) for detailed setup.

---

## Usage

### CLI Flags

```bash
soulforge                                    # Launch TUI
soulforge --session <id>                     # Resume a saved session
soulforge --headless "your prompt here"      # Stream to stdout
soulforge --headless --json "prompt"         # Structured JSON
soulforge --headless --events "prompt"       # JSONL event stream
soulforge --headless --model provider/model  # Override model
soulforge --headless --mode architect        # Read-only analysis
soulforge --headless --system "role" "prompt"# Inject system prompt
soulforge --headless --include file.ts       # Pre-load files
soulforge --headless --session <id> "prompt" # Resume session
soulforge --headless --save-session "prompt" # Save for later
soulforge --headless --max-steps 10          # Limit steps
soulforge --headless --timeout 60000         # Abort after 60s
soulforge --headless --no-repomap "prompt"   # Skip repo map
soulforge --headless --diff "fix the bug"    # Show changed files
soulforge --headless --chat                  # Interactive multi-turn chat
soulforge --headless --chat --events         # Chat with JSONL events
echo "prompt" | soulforge --headless         # Pipe from stdin
soulforge --list-providers                   # Provider status
soulforge --list-models [provider]           # Available models
soulforge --set-key <provider> <key>         # Save API key
soulforge --version                          # Version info
```

[Headless mode deep dive →](docs/headless.md)

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+L` | Select LLM model |
| `Ctrl+E` | Toggle editor panel |
| `Ctrl+G` | Git menu |
| `Ctrl+S` | Skills browser |
| `Ctrl+K` | Command picker |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+X` | Abort current generation |
| `Tab` | Switch tabs |
| `Escape` | Toggle chat/editor focus |

### Slash Commands

74 commands available — press `/` or `Ctrl+K` to browse. Key ones by category:

**Models & Providers**
`/model` `/router` `/provider` `/model-scope`

**Agent & Modes**
`/mode` `/plan` `/agent-features` `/reasoning`

**Editor & Display**
`/editor` `/split` `/diff-style` `/chat-style` `/vim-hints` `/open <file>`

**Git**
`/git` `/commit` `/push` `/pull` `/branch` `/log` `/diff` `/stash` `/lazygit` `/co-author-commits`

**Intelligence & LSP**
`/lsp` `/lsp-install` `/diagnose` `/repo-map` `/web-search` `/keys`

**Context & Memory**
`/compact` `/context` `/memory` `/compaction` `/instructions`

**Sessions & Tabs**
`/sessions` `/new-tab` `/close-tab` `/rename` `/tabs` `/claims` `/unclaim-all` `/force-claim`

**Files & Changes**
`/changes` `/files` `/open <file>`

**System**
`/setup` `/skills` `/privacy` `/storage` `/errors` `/status` `/proxy`

[Full command reference →](docs/commands-reference.md)

### Forge Modes

| Mode | Description |
|------|-------------|
| **default** | Full agent — reads and writes code |
| **auto** | Full tool access, executes immediately, minimal questions |
| **architect** | Read-only design and architecture |
| **socratic** | Questions first, then suggestions |
| **challenge** | Adversarial review, finds flaws |
| **plan** | Research → structured plan → execute |

---

## Tool Suite

SoulForge ships 30+ tools organized by capability:

### Code Intelligence

| Tool | What it does |
|------|-------------|
| `read_code` | Extract function/class/type by name (LSP-powered) |
| `navigate` | Definition, references, call hierarchy, implementations |
| `analyze` | File diagnostics, unused symbols, complexity |
| `rename_symbol` | Compiler-guaranteed rename across all files |
| `move_symbol` | Move to another file + update all importers |
| `refactor` | Extract function/variable, organize imports |

### Codebase Analysis (zero LLM cost)

| Tool | What it does |
|------|-------------|
| `soul_grep` | Count-mode ripgrep with repo map intercept |
| `soul_find` | Fuzzy file/symbol search, PageRank-ranked, signatures included |
| `soul_analyze` | Identifier frequency, unused exports, file profiles, top files by PageRank, external package usage, symbol lookup by kind/name with signatures |
| `soul_impact` | Dependency graph — dependents, cochanges, blast radius |

### Project Management

| Tool | What it does |
|------|-------------|
| `project` | Auto-detected lint, format, test, build, typecheck across [22 ecosystems](#project-toolchain-detection) |
| `project(list)` | Discover monorepo packages with per-package capabilities |
| `dispatch` | Parallel multi-agent execution (up to 8 agents, 3 concurrent) |
| `git` | Structured git operations with auto co-author tracking |

<details>
<summary><strong>All tools</strong></summary>

**Read/Write:** `read_file`, `edit_file`, `write_file`, `create_file`, `list_dir`, `glob`, `grep`

**Shell:** `shell` (with pre-commit lint gate, co-author injection, project tool redirect)

**Memory:** `memory_write`, `memory_search`, `memory_list`, `memory_delete`

**Agent:** `dispatch`, `web_search`, `fetch_page`

**Editor:** `editor` (Neovim integration — read, edit, navigate, diagnostics, format)

**Planning:** `plan`, `update_plan_step`, `task_list`, `ask_user`

</details>

---

## LLM Providers

| Provider | Models | Setup |
|----------|--------|-------|
| [**Anthropic**](https://console.anthropic.com/) | Claude 4.6 Opus/Sonnet, Haiku 4.5 | `ANTHROPIC_API_KEY` |
| [**OpenAI**](https://platform.openai.com/) | GPT-4.5, o3, o4-mini | `OPENAI_API_KEY` |
| [**Google**](https://aistudio.google.com/) | Gemini 2.5 Pro/Flash | `GOOGLE_GENERATIVE_AI_API_KEY` |
| [**xAI**](https://console.x.ai/) | Grok 3 | `XAI_API_KEY` |
| [**Ollama**](https://ollama.ai) | Any local model | Auto-detected |
| [**OpenRouter**](https://openrouter.ai) | 200+ models | `OPENROUTER_API_KEY` |
| [**LLM Gateway**](https://llmgateway.io) | Multi-model gateway (OpenAI, Claude, Gemini, DeepSeek) | `LLM_GATEWAY_API_KEY` |
| [**Vercel AI Gateway**](https://vercel.com/ai-gateway) | Unified gateway for 15+ providers with caching, fallbacks, rate limiting | `AI_GATEWAY_API_KEY` |
| [**Proxy**](https://github.com/router-for-me/CLIProxyAPI) | Local proxy with auto-lifecycle management — starts/stops with SoulForge | `PROXY_API_KEY` |
| **Custom** | Any OpenAI-compatible API — add via config | Any env var |

### Custom Providers

Add any OpenAI-compatible API as a provider — no code changes needed:

```json
// ~/.soulforge/config.json (global) or .soulforge/config.json (project)
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "envVar": "DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-coder"],
      "modelsAPI": "https://api.deepseek.com/v1/models"
    }
  ]
}
```

Then use `deepseek/deepseek-chat` as a model ID anywhere — TUI model picker, headless `--model`, task router slots. Custom providers show `[custom]` in listings. If a custom `id` conflicts with a built-in, it auto-renames to `{id}-custom`.

[Custom providers reference →](docs/headless.md#custom-providers)

### Task Router

Assign different models to different jobs. Configure via `/router`:

| Slot | Default | Purpose |
|------|---------|---------|
| Planning | Sonnet | Architecture, design decisions |
| Coding | Opus | Implementation, bug fixes |
| Exploration | Opus | Research, code reading |
| Web Search | Haiku | Search queries |
| Trivial | Haiku | Small, simple tasks (auto-detected) |
| De-sloppify | Haiku | Post-implementation cleanup pass |
| Compact | Haiku | Context compaction summaries |

---

## Repo Map

SQLite-backed graph of your entire codebase, updated in real-time as files are edited.

```mermaid
graph LR
    Scan[File Scanner<br/>watches edits] --> Parse[tree-sitter<br/>20+ languages]
    Parse --> Symbols[(Symbols<br/>name · kind · line · exports)]
    Parse --> Refs[(References<br/>cross-file imports)]
    Refs --> Graph[Dependency Graph]
    Graph --> PR[PageRank]
    Graph --> CC[Cochange<br/>git log analysis]
    Graph --> BR[Blast Radius]
    Symbols --> FTS[FTS5 Search]
    Symbols --> Clones[Clone Detection<br/>minhash signatures]

    style Symbols fill:#1a3,color:#fff
    style Refs fill:#1a3,color:#fff
    style PR fill:#47a,color:#fff
    style CC fill:#47a,color:#fff
    style BR fill:#47a,color:#fff
```

**Powers:** `soul_find` (PageRank-ranked search with signatures), `soul_grep` (zero-cost identifier counts), `soul_analyze` (unused exports with dead code vs unnecessary export classification, file profiles, top files, external packages, symbol-by-kind queries with signatures), `soul_impact` (blast radius, dependency chains), dispatch enrichment (auto-injects symbol line ranges), AST semantic summaries (docstrings for top 500 symbols).

**Language support:** Convention-based visibility detection for 30+ languages. Export inference via Go capitalization, Rust/Zig `pub`, Python/Dart underscore convention, Java/Kotlin/Swift/C#/Scala not-private, PHP, Elixir `def`/`defp`, C/C++/ObjC header files, Solidity, and more. Identifier extraction patterns cover camelCase, PascalCase, snake_case, and hyphenated (Elisp) naming conventions across all supported languages.

**Monorepo support:** Partial. The repo map indexes files within the working directory. Cross-package dependencies within a monorepo are not yet tracked — each package is treated as an independent unit. The `project` tool handles monorepo workspace discovery separately.

[Full reference →](docs/repo-map.md)

---

## Context Management

```mermaid
graph TB
    subgraph "Per-Step — every API call"
        Pruning[Tool Result Pruning<br/>last 4 full · older → summaries]
    end

    subgraph "On Threshold — auto-triggered"
        V1[V1 Compaction<br/>LLM summarization]
        V2[V2 Compaction<br/>deterministic extraction<br/>+ 2k token gap-fill]
    end

    subgraph "Always Active"
        Steering[User Steering<br/>queue + inject mid-stream]
        Sessions[Session Save<br/>incremental · crash-resilient]
        PreCommit[Pre-Commit Gate<br/>lint + typecheck before commit]
    end

    style Pruning fill:#47a,color:#fff
    style V1 fill:#a74,color:#fff
    style V2 fill:#4a7,color:#fff
    style PreCommit fill:#a47,color:#fff
```

- **Tool result pruning** — older tool results become one-line summaries enriched with repo map symbols
- **V1 compaction** — full LLM summarization when context exceeds threshold
- **V2 compaction** — deterministic state extraction from tool calls, cheap LLM gap-fill
- **User steering** — type while the agent works, messages inject at the next step
- **Pre-commit gate** — auto-runs native lint + typecheck before allowing `git commit`

[Compaction deep dive →](docs/compaction.md) · [Steering deep dive →](docs/steering.md)

---

## Project Toolchain Detection

The `project` tool auto-detects your toolchain from config files — no setup required:

| Ecosystem | Lint | Typecheck | Test | Build |
|-----------|------|-----------|------|-------|
| **JS/TS (Bun)** | biome / oxlint / eslint | tsc | bun test | bun run build |
| **JS/TS (Node)** | biome / oxlint / eslint | tsc | npm test | npm run build |
| **Deno** | deno lint | deno check | deno test | — |
| **Rust** | cargo clippy | cargo check | cargo test | cargo build |
| **Go** | golangci-lint / go vet | go build | go test | go build |
| **Python** | ruff / flake8 | pyright / mypy | pytest | — |
| **PHP** | phpstan / psalm | phpstan / psalm | phpunit | — |
| **Ruby** | rubocop | — | rspec / rails test | — |
| **Swift** | swiftlint | swift build | swift test | swift build |
| **Elixir** | credo | dialyzer | mix test | mix compile |
| **Java/Kotlin** | gradle check | javac / kotlinc | gradle test | gradle build |
| **C/C++** | clang-tidy | cmake build | ctest | cmake build |
| **Dart/Flutter** | dart analyze | dart analyze | flutter test | flutter build |
| **Zig** | — | zig build | zig build test | zig build |
| **Haskell** | hlint | stack build | stack test | stack build |
| **Scala** | — | sbt compile | sbt test | sbt compile |

**Monorepo support:** `project(action: "list")` discovers workspace packages across pnpm, npm/yarn, Cargo, and Go workspaces.

[Full reference →](docs/project-tool.md)

---

## Project Instructions

SoulForge loads `SOULFORGE.md` from your project root as project-specific instructions — conventions, architecture notes, toolchain preferences — injected into every prompt.

You can also load instruction files from other AI tools to reduce friction when migrating or working across tools:

| File | Source | Default |
|------|--------|---------|
| `SOULFORGE.md` | SoulForge | **on** |
| `CLAUDE.md` | Claude Code | off |
| `.cursorrules` | Cursor | off |
| `.github/copilot-instructions.md` | GitHub Copilot | off |
| `.clinerules` | Cline | off |
| `.windsurfrules` | Windsurf | off |
| `.aider.conf.yml` | Aider | off |
| `AGENTS.md` | OpenAI Codex | off |
| `.opencode/instructions.md` | OpenCode | off |
| `AMPLIFY.md` | Amp | off |

Toggle via `/instructions` in the TUI or set `"instructionFiles"` in config:

```json
{ "instructionFiles": ["soulforge", "claude", "cursorrules"] }
```

---

## Configuration

Layered config: global (`~/.soulforge/config.json`) + project (`.soulforge/config.json`).

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-6",
  "thinking": { "mode": "adaptive" },
  "repoMap": true,
  "semanticSummaries": "ast",
  "diffStyle": "default",
  "chatStyle": "accent",
  "vimHints": true,
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseURL": "https://api.deepseek.com/v1",
      "envVar": "DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-coder"]
    }
  ]
}
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for the full reference.

---

## Testing

```bash
bun test              # 1942 tests across 40 files
bun run typecheck     # tsc --noEmit
bun run lint          # biome check (lint + format)
bun run lint:fix      # auto-fix
```

---

## Documentation

| Document | Description |
|----------|-------------|
| **[Command Reference](docs/commands-reference.md)** | All 74 slash commands by category |
| **[Headless Mode](docs/headless.md)** | Non-interactive CLI for CI/CD, scripting, automation |
| **[Architecture](docs/architecture.md)** | System overview, data flow, component lifecycle |
| **[Repo Map](docs/repo-map.md)** | PageRank, cochange, blast radius, clone detection |
| **[Agent Bus](docs/agent-bus.md)** | Multi-agent coordination, shared cache, edit ownership |
| **[Compound Tools](docs/compound-tools.md)** | rename_symbol, move_symbol, refactor internals |
| **[Compaction](docs/compaction.md)** | V1/V2 context management strategies |
| **[Project Tool](docs/project-tool.md)** | Toolchain detection, pre-commit checks, monorepo discovery |
| **[Steering](docs/steering.md)** | Mid-stream user input injection |
| **[Provider Options](docs/provider-options.md)** | Thinking modes, context management, degradation |
| [Getting Started](GETTING_STARTED.md) | Installation, configuration, first steps |
| [Contributing](CONTRIBUTING.md) | Dev setup, project structure, PR guidelines |
| [Security](SECURITY.md) | Security policy, forbidden file management, responsible disclosure |

---

## Roadmap

**SoulForge beyond the TUI** — the intelligence layer is being extracted into reusable packages:

```
@soulforge/intelligence    Core library — repo map, tools, agent loop
       ↑
@soulforge/mcp             MCP server — plug into Claude Code, Cursor, Copilot
       ↑
sf --headless              CLI mode — CI/CD, scripts, automation  ✓ shipped
       ↑
SoulForge TUI              Full experience (what you're looking at now)
```

- **`@soulforge/intelligence`** — graph intelligence, 30+ tools, and agent orchestration as an importable package. Build your own AI tools on top of SoulForge's brain.
- **`@soulforge/mcp`** — expose soul_grep, soul_find, soul_analyze, soul_impact, navigate, read_code as MCP tools. Any AI tool that supports MCP gets SoulForge's graph intelligence.
- **`sf --headless`** — non-interactive mode. Pipe in a prompt, get back results. For CI/CD, automation, and benchmarks. [Documentation →](docs/headless.md)

**In progress:**
- **MCP support** — consume external MCP servers from within SoulForge + expose tools as an MCP server
- **Repo Map visualization** — interactive dependency graph, PageRank heatmap, blast radius explorer
- **GitHub CLI integration** — native `gh_pr`, `gh_issue`, `gh_status` tools with structured output
- **Dispatch worktrees** — git worktree per code agent for conflict-free parallel edits

**Planned:**
- **Monorepo graph support** — cross-package dependency tracking for pnpm/npm/yarn workspaces, Cargo workspaces, Go workspaces (`go.work`), Nx/Turborepo, and Bazel/Buck. Currently the repo map treats each workspace root as an isolated unit — cross-package imports resolve as external dependencies instead of internal edges. This means PageRank, blast radius, and unused export detection don't span package boundaries.
- **Benchmarks** — side-by-side comparisons: tool calls, edit accuracy, token efficiency on large codebases
- **Orchestrated workflows** — sequential agent handoffs (planner → TDD → reviewer → security)

---

## Inspirations

SoulForge builds on ideas from projects we respect:

- **[Aider](https://github.com/Aider-AI/aider)** — pioneered tree-sitter repo maps with PageRank for AI code editing. SoulForge extends this with cochange analysis, blast radius, clone detection, and real-time graph updates on file edits.
- **[Everything Claude Code (ECC)](https://github.com/affaan-m/everything-claude-code)** — design philosophy: enforce behavior with code, not prompt instructions. Our `targetFiles` schema validation, pre-commit lint gates, confident tool output, and auto-enrichment patterns come from this thinking.
- **[Vercel AI SDK](https://sdk.vercel.ai)** — the multi-provider abstraction layer that makes 9 providers possible with a single tool loop interface.
- **[Neovim](https://neovim.io)** — the editor. SoulForge embeds it via msgpack-RPC rather than reimplementing it, because your config and muscle memory shouldn't be a compromise.

---

## License

[Business Source License 1.1](LICENSE). Free for personal and internal use. Commercial use requires a [commercial license](COMMERCIAL_LICENSE.md). Converts to Apache 2.0 on March 15, 2030. Third-party licenses in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

<p align="center">
  <sub>Built with care by <a href="https://github.com/proxysoul">proxySoul</a></sub>
</p>
