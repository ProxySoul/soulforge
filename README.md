<h1 align="center">SoulForge</h1>

<p align="center">
  <strong>AI-Powered Terminal IDE</strong><br/>
  Embedded Neovim + Multi-Agent System + Graph-Powered Code Intelligence
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/version-3.0.0-brightgreen.svg" alt="Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue.svg" alt="TypeScript" /></a>
  <a href="#testing"><img src="https://img.shields.io/badge/tests-1262%20passing-brightgreen.svg" alt="Tests" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6.svg" alt="Bun" /></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/proxysoul">proxySoul</a></em>
</p>

---

## What is SoulForge?

A terminal IDE where your AI pair programmer lives inside your editor — not beside it. Real Neovim with your config, multi-agent dispatch that parallelizes work, and a code intelligence graph that understands your entire codebase. All in a single terminal session that works over SSH.

<p align="center">
  <img src="assets/soulforge-hero.png" alt="SoulForge in action" width="900" />
</p>

---

## Highlights

<table>
<tr>
<td width="50%">

### Embedded Neovim
Your actual config, plugins, keybindings, and LSP — connected to the AI via msgpack-RPC. The AI reads, navigates, and edits through the same editor you use.

</td>
<td width="50%">

### Multi-Agent Dispatch
Parallelize work across explore, code, and web search agents. Shared file cache prevents redundant reads. Edit coordination prevents conflicts. [Deep dive →](docs/agent-bus.md)

</td>
</tr>
<tr>
<td>

### Graph-Powered Repo Map
SQLite-backed codebase graph with PageRank ranking, cochange analysis, blast radius estimation, and clone detection. Zero-token queries — no LLM cost. [Deep dive →](docs/repo-map.md)

</td>
<td>

### 4-Tier Code Intelligence
LSP → ts-morph → tree-sitter → regex fallback chain. Covers 20+ languages. Always has an answer, from precise to approximate. [Deep dive →](docs/architecture.md)

</td>
</tr>
<tr>
<td>

### Compound Tools
`rename_symbol`, `move_symbol`, `refactor`, `project` do the complete job in one call. Compiler-guaranteed renames. Atomic moves with import updates. [Deep dive →](docs/compound-tools.md)

</td>
<td>

### Task Router
Assign models per task type — Opus for planning, Sonnet for coding, Haiku for search. Automatic tier detection routes trivial tasks to fast models.

</td>
</tr>
<tr>
<td>

### Context Management
Two-layer compaction keeps long sessions productive: rolling tool-result pruning per step, plus V1 (LLM summary) or V2 (deterministic extraction) compaction on threshold. [Deep dive →](docs/compaction.md)

</td>
<td>

### User Steering
Type messages while the agent is working — they queue up and inject into the next agent step. Abort cleanly with Ctrl+X. [Deep dive →](docs/steering.md)

</td>
</tr>
<tr>
<td>

### Project Toolchain
Auto-detects lint, typecheck, test, and build commands across 16 ecosystems. Pre-commit gate blocks `git commit` on lint/type errors. Monorepo package discovery. [Deep dive →](docs/project-tool.md)

</td>
<td>

### 9 LLM Providers
Anthropic, OpenAI, Google, xAI, Ollama (local), OpenRouter, LLMGateway, Vercel Gateway, and custom proxy — all through the Vercel AI SDK with automatic provider option degradation. [Deep dive →](docs/provider-options.md)

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

**Requirements:** [Bun](https://bun.sh) >= 1.0, [Neovim](https://neovim.io) >= 0.9

```bash
bun install -g @proxysoul/soulforge
soulforge   # or: sf
```

SoulForge checks for prerequisites on first launch and offers to install Neovim and Nerd Fonts if missing.

> Configure your `.npmrc` for GitHub Packages, or see [GETTING_STARTED.md](GETTING_STARTED.md) for detailed setup.

---

## Usage

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+L` | Select LLM model |
| `Ctrl+E` | Toggle editor panel |
| `Ctrl+G` | Git menu |
| `Ctrl+S` | Skills browser |
| `Ctrl+K` | Command picker |
| `Ctrl+N` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+X` | Abort current generation |
| `Tab` | Switch tabs |
| `Escape` | Toggle chat/editor focus |

### Slash Commands

| Command | Description |
|---------|-------------|
| `/model` | Switch model |
| `/router` | Per-task model routing |
| `/provider` | Thinking, effort, speed settings |
| `/mode` | Switch forge mode |
| `/git` | Git operations |
| `/compact` | Trigger context compaction |
| `/sessions` | Browse and restore sessions |
| `/setup` | Check and install prerequisites |

### Forge Modes

| Mode | Description |
|------|-------------|
| **default** | Full agent — reads and writes code |
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
| `soul_find` | Fuzzy file/symbol search, PageRank-ranked |
| `soul_analyze` | Identifier frequency, unused exports, file profile |
| `soul_impact` | Dependency graph — dependents, cochanges, blast radius |

### Project Management

| Tool | What it does |
|------|-------------|
| `project` | Auto-detected lint, test, build, typecheck across [16 ecosystems](#project-toolchain-detection) |
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
| **Anthropic** | Claude 4.6 Opus/Sonnet, Haiku 4.5 | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-4.5, o3, o4-mini | `OPENAI_API_KEY` |
| **Google** | Gemini 2.5 Pro/Flash | `GOOGLE_GENERATIVE_AI_API_KEY` |
| **xAI** | Grok 3 | `XAI_API_KEY` |
| **Ollama** | Any local model | Auto-detected |
| **OpenRouter** | 200+ models | `OPENROUTER_API_KEY` |
| **LLMGateway** | Custom proxy | `LLMGATEWAY_API_KEY` |
| **Vercel Gateway** | Vercel AI Gateway | `VERCEL_GATEWAY_API_KEY` |
| **Proxy** | Custom endpoint | `PROXY_API_KEY` |

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

**Powers:** `soul_find` (PageRank-ranked search), `soul_grep` (zero-cost identifier counts), `soul_analyze` (unused exports, file profiles), `soul_impact` (blast radius, dependency chains), dispatch enrichment (auto-injects symbol line ranges), AST semantic summaries (docstrings for top 500 symbols).

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
  "vimHints": true
}
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for the full reference.

---

## Testing

```bash
bun test              # 1262 tests across 27 files
bun run typecheck     # tsc --noEmit
bun run lint          # biome check (lint + format)
bun run lint:fix      # auto-fix
```

---

## Documentation

| Document | Description |
|----------|-------------|
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
| [Security](SECURITY.md) | Security policy, responsible disclosure |

---

## License

[AGPL-3.0-only](LICENSE). Third-party licenses in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

<p align="center">
  <sub>Built with care by <a href="https://github.com/proxysoul">proxySoul</a></sub>
</p>
