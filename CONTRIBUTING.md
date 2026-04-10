# Contributing

Thanks for your interest in SoulForge. This document tells you everything you need to know.

## Setup

```bash
git clone https://github.com/proxysoul/soulforge
cd soulforge
bun install
bun run dev
```

**Requirements:** [Bun](https://bun.sh) >= 1.0, [Neovim](https://neovim.io) >= 0.9, at least one LLM API key (see [README](README.md#llm-providers)).

**Scripts:**

```bash
bun run dev          # start soulforge
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run lint:fix     # biome auto-fix
bun run format       # biome format
```

Run all three checks before submitting a PR:

```bash
bun run lint:fix && bun run format && bun run typecheck
```

## Project Structure

```
src/
├── index.tsx                 # entry point
├── boot.tsx                  # bootstrap / startup sequence
├── types/index.ts            # shared types
├── config/index.ts           # scoped config (session/project/global)
│
├── stores/                   # Zustand state stores
│   ├── ui.ts                 # global UI state
│   ├── errors.ts             # error log
│   ├── repomap.ts            # repo map status
│   └── statusbar.ts          # status bar state
│
├── components/               # UI (OpenTUI — React for terminals)
│   ├── App.tsx               # root — state, keybindings, layout
│   ├── commands.ts           # slash command dispatch (50+ commands)
│   ├── shared.tsx            # Spinner, PopupRow, color constants
│   ├── syntax.ts             # syntax highlighting
│   ├── EditorPanel.tsx       # neovim display
│   ├── InputBox.tsx          # chat input (paste collapse, history)
│   ├── MessageList.tsx       # chat history
│   ├── ToolCallDisplay.tsx   # tool call progress
│   ├── DiffView.tsx          # inline/side-by-side diffs
│   ├── PlanView.tsx          # plan mode sidebar
│   ├── StructuredPlanView.tsx # step-by-step plan progress
│   ├── PlanProgress.tsx      # plan execution tracking
│   ├── LlmSelector.tsx       # Ctrl+L model picker
│   ├── RouterSettings.tsx    # per-task model assignment
│   ├── ProviderSettings.tsx  # thinking, effort, speed settings
│   ├── WebSearchSettings.tsx # web search configuration
│   ├── SkillSearch.tsx       # Ctrl+S skills browser
│   ├── GitMenu.tsx           # Ctrl+G git operations
│   ├── GitCommitModal.tsx    # AI commit message
│   ├── SessionPicker.tsx     # session restore
│   ├── ContextBar.tsx        # context budget inspector
│   ├── ChangedFiles.tsx      # changed files tree
│   ├── RepoMapIndicator.tsx  # repo map status display
│   ├── MemoryIndicator.tsx   # memory status
│   ├── EditorSettings.tsx    # editor/LSP toggles
│   └── ...                   # other popups and views
│
├── core/
│   ├── agents/               # forge + subagent definitions
│   │   ├── forge.ts          # main agent (factory — new per turn)
│   │   ├── explore.ts        # read-only subagent
│   │   ├── code.ts           # full-access subagent
│   │   ├── web-search.ts     # web search agent (multi-step research)
│   │   ├── agent-bus.ts      # shared cache, edit mutex, findings
│   │   ├── bus-tools.ts      # bus-aware tool wrappers
│   │   ├── subagent-tools.ts # exposes subagents as tool calls
│   │   ├── subagent-events.ts # dispatch event system
│   │   └── step-utils.ts     # step counting, budget tracking
│   │
│   ├── context/              # system prompt builder
│   │   └── manager.ts        # repo map, memory, git, toolchain detection
│   │
│   ├── intelligence/         # multi-backend code intelligence
│   │   ├── router.ts         # LSP → ts-morph → tree-sitter → regex
│   │   ├── instance.ts       # singleton intelligence instance
│   │   ├── cache.ts          # result caching
│   │   ├── repo-map.ts       # SQLite graph, PageRank, co-change, semantic summaries
│   │   ├── post-edit.ts      # post-edit diagnostics (before/after diff)
│   │   ├── types.ts          # shared intelligence types
│   │   └── backends/
│   │       ├── lsp/          # LSP client, server registry, standalone servers
│   │       ├── tree-sitter.ts # 20+ language grammars via WASM
│   │       └── ts-morph.ts   # TypeScript AST analysis
│   │
│   ├── editor/               # neovim spawn, screen, RPC
│   │
│   ├── llm/
│   │   ├── models.ts         # model fetching, context windows
│   │   ├── task-router.ts    # per-task model assignment
│   │   ├── provider-options.ts # thinking, effort, speed
│   │   └── providers/        # one file per provider
│   │       ├── types.ts      # ProviderDefinition interface
│   │       ├── anthropic.ts
│   │       ├── openai.ts
│   │       ├── google.ts
│   │       ├── xai.ts
│   │       ├── ollama.ts
│   │       ├── gateway.ts    # AI Gateway
│   │       └── proxy.ts      # CLIProxyAPI relay
│   │
│   ├── tools/                # 30+ tool definitions
│   │   ├── index.ts          # tool registry
│   │   ├── edit-file.ts      # file editing
│   │   ├── read-file.ts      # file reading
│   │   ├── read-code.ts      # symbol-level extraction
│   │   ├── grep.ts           # content search
│   │   ├── glob.ts           # file pattern matching
│   │   ├── shell.ts          # shell execution
│   │   ├── git.ts            # git operations
│   │   ├── navigate.ts       # LSP go-to-def, references, call hierarchy
│   │   ├── analyze.ts        # diagnostics, type info, outlines
│   │   ├── refactor.ts       # extract function/variable
│   │   ├── rename-symbol.ts  # workspace rename + grep verification
│   │   ├── move-symbol.ts    # cross-file symbol move + import update
│   │   ├── project.ts        # auto-detect toolchain, test/build/lint
│   │   ├── discover-pattern.ts # recurring code pattern detection
│   │   ├── web-search.ts     # multi-backend web search
│   │   ├── web-search-scraper.ts # Brave/DDG backends
│   │   ├── fetch-page.ts     # Jina/Readability page fetcher
│   │   ├── test-scaffold.ts  # test file generation
│   │   ├── editor.ts         # neovim integration tools
│   │   ├── interactive.ts    # user prompts
│   │   ├── memory.ts         # persistent memory tools
│   │   └── file-events.ts    # edit/read event emission
│   │
│   ├── memory/               # SQLite-backed persistent memory
│   ├── sessions/             # session save/restore
│   ├── security/             # forbidden file patterns
│   ├── history/              # command history
│   ├── proxy/                # CLIProxyAPI lifecycle
│   ├── setup/                # prerequisite checks
│   └── secrets.ts            # secret detection
│
└── hooks/                    # React hooks
    ├── useChat.ts            # main chat logic
    ├── useNeovim.ts          # neovim lifecycle
    ├── useEditorFocus.ts     # focus management
    ├── useEditorInput.ts     # keystroke forwarding
    ├── useTabs.ts            # multi-tab management
    ├── useSessionBuilder.ts  # session construction
    ├── useLspStatus.ts       # LSP server status
    └── ...                   # other hooks
```

## Rules

These are non-negotiable. PRs that break them will be asked to fix before merge.

- **Bun only.** Never `node`, `npm`, or `npx`.
- **No `any`.** TypeScript strict mode. Use proper types or Zod inference.
- **No unused variables.** The compiler catches these.
- **No `import React`.** JSX transform handles it.
- **Biome, not ESLint/Prettier.** One toolchain for linting and formatting.
- **The AI is named Forge.** Never "AI", "assistant", or "bot" in UI strings or prompts.

## Architecture

For the full technical reference, see [docs/architecture.md](docs/architecture.md).

### Agent System

SoulForge uses the Vercel AI SDK's `ToolLoopAgent`. Each chat turn creates a **new agent instance** (not a singleton) so the user can switch models mid-session with `Ctrl+L`.

The main agent (Forge) has 30+ direct tools and three subagent types:

- **Explore** — read-only tools, fresh context window, for researching a codebase
- **Code** — full tool access, fresh context window, for implementing changes
- **WebSearch** — multi-step web research with search + page fetch in an agent loop

Subagents are exposed to Forge as regular tool calls via `buildSubagentTools()`. Each invocation gets its own context window. Multiple subagents run in parallel, coordinated through the **AgentBus**:

- **Shared file cache** — deduplicates reads across agents (waiter pattern)
- **Tool result cache** — LRU 200, cross-agent reuse
- **Edit mutex** — serializes concurrent writes to the same file
- **Real-time findings** — agents post discoveries visible to peers within 1-2 steps
- **Cache persistence** — warm starts across dispatch calls

See [docs/agent-bus.md](docs/agent-bus.md) for the full coordination reference.

### Task Router

The task router assigns different LLM models to different task types (planning, coding, exploration, web search, semantic summaries). Configure via `/router` in the UI. See [README](README.md#task-router--per-task-model-assignment).

### Code Intelligence

A tiered router tries the best available backend for every code operation:

1. **LSP** — definitions, references, rename, diagnostics, call hierarchy, formatting
2. **ts-morph** — TypeScript/JavaScript AST analysis, **tree-sitter** — 20+ languages via WASM
3. **regex** — universal fallback

The intelligence layer also powers:
- **Repo map** — SQLite graph with PageRank ranking, git co-change analysis, LLM semantic summaries
- **Post-edit diagnostics** — snapshots LSP errors before/after edits, reports only new errors

See [docs/repo-map.md](docs/repo-map.md) for the ranking system.

### Compound Tools

Tools that do the complete job in a single call — no agent guessing:

- `rename_symbol` — LSP rename + grep verification, finds the symbol itself
- `move_symbol` — cross-file move with per-language import updates (TS/JS, Python, Rust)
- `project` — auto-detects toolchain across 20+ ecosystems, runs test/build/lint/typecheck
- `navigate` — LSP-backed go-to-definition, references, call hierarchy
- `read_code` — extracts a single symbol's source instead of the whole file

See [docs/compound-tools.md](docs/compound-tools.md) for design principles and benchmarks.

### How Neovim Works

Neovim runs in a real PTY (via `Bun.spawn` with `terminal`) and uses `--listen <socket>` for a separate RPC channel. The PTY output is rendered natively by `ghostty-terminal` (ghostty's Zig VT parser), which handles cursor shapes, escape sequences, and scroll regions. RPC over the Unix socket provides API access for file operations, cursor polling, and LSP integration. When the editor panel is focused, raw stdin bytes are forwarded directly to the PTY.

### How Providers Work

Each LLM provider is a self-contained file in `src/core/llm/providers/` that implements the `ProviderDefinition` interface. The provider registry handles everything else — model resolution, icon display, API fetching, context window lookup.

## Adding a New LLM Provider

One file, two lines in the registry.

**1. Create the provider file.** Copy any existing one as a template:

```bash
cp src/core/llm/providers/anthropic.ts src/core/llm/providers/mistral.ts
```

Implement the `ProviderDefinition` interface:

```typescript
export const mistral: ProviderDefinition = {
  id: "mistral",
  name: "Mistral",
  envVar: "MISTRAL_API_KEY",
  icon: "▲",
  createModel(modelId) { /* ... */ },
  fetchModels() { /* ... */ },
  fallbackModels: [ /* ... */ ],
  contextWindows: [ ["mistral-large", 128_000] ],
};
```

**2. Register it.** In `src/core/llm/providers/index.ts`:

```typescript
import { mistral } from "./mistral.js";

const ALL_PROVIDERS: ProviderDefinition[] = [
  gatewayProvider, anthropic, openai, xai, google, ollama,
  mistral,  // add here
];
```

**3. Verify.** `bun run typecheck` will catch any missing fields.

That's it. The model picker, provider status checks, context window lookup, and icon display all work automatically.

## Adding a New Tool

Tools live in `src/core/tools/`. Each file exports a builder function that returns a Vercel AI SDK tool definition.

**1. Create the tool file:**

```typescript
// src/core/tools/my-tool.ts
import { tool } from "ai";
import { z } from "zod";

export function buildMyTool(ctx: ToolContext) {
  return tool({
    description: "What this tool does — be specific",
    parameters: z.object({
      param: z.string().describe("What this param is"),
    }),
    execute: async ({ param }) => {
      // Tool output should state facts confidently
      // Never say "verify" or "check" — it triggers agent spirals
      return `Done. Result: ${param}`;
    },
  });
}
```

**2. Register it** in `src/core/tools/index.ts`.

**3. Design principles** (from [compound tools](docs/compound-tools.md)):
- Tool finds things itself — don't make the agent locate/explore first
- Confident output — state facts, never hedge
- One call = complete job
- Accept flexible input — symbol name over file path + line number
- Large files (>50MB) auto-truncate with a helpful message — never refuse or hang

## Submitting a PR

1. Fork and branch off `main`
2. Make your changes
3. Run `bun run lint:fix && bun run format && bun run typecheck`
4. Open a PR with a clear description of what and why
5. One feature or fix per PR

If you're unsure whether something is in scope, open an issue first.

## License

Business Source License 1.1. By contributing, you agree your code is licensed under the same terms. See [LICENSE](LICENSE) and [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) for details.
