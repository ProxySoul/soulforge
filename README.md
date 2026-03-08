# SoulForge

AI-powered terminal IDE by [proxySoul](https://github.com/proxysoul). Built on Bun, React (OpenTUI), Neovim, and the Vercel AI SDK.

SoulForge combines a multi-agent system, deep code intelligence, and an embedded Neovim editor into a single terminal interface. It understands your codebase structurally — not just as flat files — and uses that understanding to make AI-assisted development faster, cheaper, and more accurate.

## Highlights

**Multi-Backend Code Intelligence** — A tiered router (LSP → ts-morph → tree-sitter → regex) provides definitions, references, rename, diagnostics, and more across any language. Full LSP when a server is running, graceful degradation otherwise. Post-edit diagnostics catch regressions automatically.

**Repo Map with PageRank** — A live SQLite graph of files, symbols, and import edges. PageRank surfaces the most important files in the system prompt. Adapts in real time via personalization vectors, FTS on symbols, neighbor boosting, and dynamic token budgets. [Deep dive →](docs/repo-map.md)

**LLM Semantic Summaries** — Top symbols get one-line descriptions from a fast model, cached in SQLite. The AI sees what your code *does*, not just its structure.

**Git Co-Change Analysis** — Files that historically change together (from `git log`) boost each other in ranking — catching implicit coupling the import graph misses.

**Compound Tools** — `rename_symbol`, `move_symbol`, `project`, `navigate`, `read_code`, `analyze`, `discover_pattern`. Each does the complete job in one call. Benchmark: 19 agent steps → 3, $0.228 → $0.036. [Deep dive →](docs/compound-tools.md)

**Parallel Agents with Shared Memory** — Explore, Code, and WebSearch subagents run in parallel, coordinated through an AgentBus with shared file cache, tool result cache, edit mutex, and real-time findings. [Deep dive →](docs/agent-bus.md)

**Web Search** — Brave API → DuckDuckGo fallback for search, Jina Reader → Readability → regex for page fetching. Agent-loop mode for multi-step research. OS keychain secret storage.

**Context Compaction** — Two strategies: V1 (LLM batch summarization) and V2 (incremental structured extraction). V2 builds working state as-you-go from tool calls and messages — compaction is near-instant with an optional cheap gap-fill pass. Configurable thresholds, dedicated model via task router, live toggle via `/compaction`. [Deep dive →](docs/compaction.md)

**Task Router** — Assign different models per task type (planning, coding, exploration, web search, compact, semantic). Opus for architecture, Haiku for grep.

**7 LLM Providers** — Anthropic, OpenAI, xAI, Google, Ollama, AI Gateway, Proxy (CLIProxyAPI). Switch mid-conversation with `Ctrl+L`.

**Embedded Neovim** — Real Neovim via msgpack-RPC. Your config, plugins, and LSP all work. Shares the intelligence layer with the AI.

**50+ Slash Commands** — Chat, editor, git, AI modes, plan mode, skills, web search, context inspector, memory, storage, scoped config, and more.

## Install

```bash
git clone https://github.com/proxysoul/soulforge
cd soulforge
bun install
bun run dev
```

**Prerequisites**: [Bun](https://bun.sh) >= 1.0, [Neovim](https://neovim.io) >= 0.9, a [Nerd Font](https://www.nerdfonts.com/), at least one LLM API key (or local Ollama).

See [GETTING_STARTED.md](GETTING_STARTED.md) for the full setup guide.

## Key Bindings

| Key | Action |
|-----|--------|
| `Ctrl+E` | Toggle editor / cycle focus |
| `Ctrl+L` | Switch LLM model |
| `Ctrl+D` | Cycle forge mode |
| `Ctrl+G` | Git menu |
| `Ctrl+S` | Browse skills |
| `Ctrl+T` | Toggle plan sidebar |
| `Ctrl+X` | Stop generation |
| `Ctrl+R` | Fuzzy history search |
| `/` | Slash commands |

## Architecture

**Stack**: Bun + TypeScript (strict) + OpenTUI + Vercel AI SDK + Neovim + SQLite + tree-sitter + ts-morph

```
┌──────────────────────────────────────────────────────────┐
│  UI Layer (OpenTUI)                                       │
│  App ─ TabBar ─ MessageList ─ InputBox ─ EditorPanel      │
├──────────────────────────────────────────────────────────┤
│  Agent Layer                                              │
│  Forge → dispatch → Code / Explore / WebSearch            │
│  AgentBus: file cache, tool cache, findings, edit mutex   │
├──────────────────────────────────────────────────────────┤
│  Intelligence Layer                                       │
│  Router: LSP → ts-morph → tree-sitter → regex             │
│  RepoMap: PageRank, co-change, semantic summaries         │
├──────────────────────────────────────────────────────────┤
│  Tool Layer (30+ tools)                                   │
│  edit, read, grep, shell, git, rename, move, project...   │
├──────────────────────────────────────────────────────────┤
│  Runtime: Neovim (RPC) ─ LSP ─ SQLite ─ Bun              │
│  Providers: Anthropic, OpenAI, xAI, Google, Ollama, Proxy │
└──────────────────────────────────────────────────────────┘
```

## Documentation

| Doc | What it covers |
|-----|---------------|
| [Getting Started](GETTING_STARTED.md) | Setup, prerequisites, first run, UI guide, troubleshooting |
| [Contributing](CONTRIBUTING.md) | Project structure, rules, architecture, adding providers/tools |
| [Architecture](docs/architecture.md) | Full technical reference — all layers, all systems |
| [Repo Map](docs/repo-map.md) | PageRank ranking, co-change, semantic summaries, dynamic budgets |
| [Compound Tools](docs/compound-tools.md) | Design principles, benchmarks, tool reference |
| [Agent Bus](docs/agent-bus.md) | Parallel coordination, shared cache, edit mutex, findings |
| [Compaction](docs/compaction.md) | V1/V2 strategies, configuration, task router, visual indicators |

## Dev Commands

```bash
bun run dev          # start soulforge
bun run lint         # lint with biome
bun run lint:fix     # auto-fix lint issues
bun run format       # format with biome
bun run typecheck    # check types
```

## License

AGPL-3.0-only
