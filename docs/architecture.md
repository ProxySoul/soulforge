# Architecture

Technical reference for SoulForge's internals. Each section is self-contained — read what you need.

## System Overview

```
User Input
    │
    ▼
┌─────────┐     ┌──────────────┐     ┌───────────────┐
│ InputBox │────▶│   useChat    │────▶│  Forge Agent   │
│ (OpenTUI)│     │  (AI SDK)    │     │ (orchestrator) │
└─────────┘     └──────────────┘     └───────┬───────┘
                                             │ dispatch
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                        ┌──────────┐  ┌──────────┐  ┌──────────┐
                        │  Explore  │  │   Code   │  │WebSearch │
                        │ subagent  │  │ subagent │  │ subagent │
                        └─────┬────┘  └────┬─────┘  └────┬─────┘
                              │            │              │
                              └──────┬─────┘──────────────┘
                                     ▼
                              ┌──────────────┐
                              │   AgentBus   │
                              │ file cache   │
                              │ tool cache   │
                              │ findings     │
                              │ edit mutex   │
                              └──────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
             ┌───────────┐   ┌───────────┐   ┌───────────┐
             │   Tools   │   │Intelligence│   │  Neovim   │
             │ 30+ tools │   │  Router    │   │ (msgpack) │
             └───────────┘   └─────┬─────┘   └───────────┘
                                   │
                        ┌──────────┼──────────┐
                        ▼          ▼          ▼
                      LSP    tree-sitter    regex
```

---

## Repo Map

**File**: `src/core/intelligence/repo-map.ts`

A SQLite-backed index of the entire codebase. On startup, SoulForge walks the file tree, parses every source file with tree-sitter, and builds a graph.

### Schema

| Table | Purpose |
|-------|---------|
| `files` | Every tracked file — path, mtime, language, line count, symbol count, PageRank score |
| `symbols` | Every exported/local symbol — name, kind, signature, line number, exported flag |
| `edges` | Import/reference edges between files (source → target, weighted) |
| `refs` | Identifier references per file (for cross-file edge building) |
| `cochanges` | Git co-change pairs — files that historically appear in the same commit |
| `semantic_summaries` | LLM-generated one-line descriptions of top symbols, keyed by file mtime |
| `symbols_fts` | FTS5 virtual table over symbol names for conversation-term matching |

### Ranking Pipeline

The repo map renders a ranked, token-budgeted view of the codebase for the system prompt:

```
1. PageRank (20 iterations, damping 0.85)
   - Base: structural importance from import graph
   - Personalization vector: edited files (5x), mentioned files (3x),
     editor file (2x), co-change partners (scaled by count)

2. Post-hoc scoring (signals PageRank can't capture)
   - FTS match on conversation terms: +0.5
   - Neighbor of context file (connected via edge): +1
   - Co-change partner: +min(count/5, 3)

3. Rendering
   - Binary search to fit max blocks within token budget
   - Each block: file path + exported symbols with signatures
   - Semantic summaries inline where available
   - Tags: [R:N] blast radius, [NEW] for files new since last render
```

### Dynamic Budget

The repo map competes for system prompt space. Budget scales inversely with conversation length:

| Conversation tokens | Repo map budget |
|--------------------|-----------------|
| < 1,000 | 2,500 tokens |
| 50,000 | ~2,000 tokens |
| 100,000 | 1,500 tokens (minimum) |

### Real-Time Updates

Files are re-indexed on edit via debounced `onFileChanged()`. The file event system (`src/core/tools/file-events.ts`) wires tool actions to the context manager:

- `emitFileEdited(path)` → re-index symbols + edges, invalidate PageRank, clear repo map cache
- `emitFileRead(path)` → `trackMentionedFile(path)` → boost in next PageRank personalization

### Git Co-Change

Parses `git log --name-only` (last 300 commits). For each commit with 2–20 changed files, builds all pairwise combinations and increments their co-change count. Mega-commits (>20 files) are filtered as noise.

Co-change partners appear in two places:
1. **PageRank personalization** — light boost proportional to co-change count
2. **Post-hoc scoring** — additive score bump for final ranking

### Semantic Summaries

Top symbols (by PageRank) are batched to a fast LLM to generate one-line descriptions. Results are cached in `semantic_summaries` keyed by `(symbol_id, file_mtime)` — a file edit invalidates its summaries automatically.

The summary generator is pluggable via `setSummaryGenerator()`. The context manager wires it to the AI SDK's `generateText()` with a dedicated model (configurable via task router).

---

## Agent System

### Three-Tier Architecture

| Tier | Agent | Step limit | Token limit | Purpose |
|------|-------|-----------|-------------|---------|
| 1 | **Forge** | 500 | Full context | Main orchestrator — plans, dispatches, responds |
| 2 | **Code** | 25 | 150K | File edits, refactoring, implementation |
| 2 | **Explore** | 15 | 80K | Read-only research, code analysis |
| 2 | **WebSearch** | — | — | Multi-step web research with scraping |

### AgentBus

**File**: `src/core/agents/agent-bus.ts`

In-process coordination layer for parallel subagents.

**File Cache**
- First reader caches the content; concurrent readers get the same Promise
- Generation counter prevents stale overwrites after concurrent edits
- `invalidateFile()` resolves waiters with null and expires related tool cache entries

**Tool Result Cache**
- LRU, max 200 entries
- Keyed by `toolName:canonicalized-args`
- Covers: `read_code`, `grep`, `glob`, `navigate`, `analyze`, `web_search`
- Persists across dispatches via `exportCaches()` / `SharedCache` constructor

**Edit Mutex**
- Promise-chaining serializes edits to the same file
- First editor becomes owner; second gets a warning
- `recordFileEdit()` tracks which agents edit which files for conflict reporting

**Findings**
- Agents call `report_finding(label, content)` to post to the bus
- Each step, `prepareStep()` drains unseen findings via per-agent index
- Injected into system prompt as `--- Peer findings (new) ---`

### Step Lifecycle

**File**: `src/core/agents/step-utils.ts`

Each agent step passes through `prepareStep()`:

```
Step 0: toolChoice = "required" (force immediate tool use, no wasted text)
     ↓
Each step: capture path map → sanitize inputs → inject peer findings → check budget
     ↓
Step 3+: compact old tool results (rolling window, last 6 messages full, older → one-line summaries)
  - read_file/read_code: "[pruned] 245 lines — exports: Foo, Bar" (symbols from repo map)
  - grep: "[pruned] 42 matches"  |  glob: "[pruned] 25 files"
  - edit_file/write_file/create_file: always preserved
     ↓
Trim threshold (50K explore, 80K code): inject context recovery via AgentBus
     ↓
Budget warning (60K explore, 120K code): inject "wrap up soon"
     ↓
Force-done (70K explore, 135K code): activeTools = ["done"], toolChoice = "required"
     ↓
Hard stop (80K explore, 150K code): abort
```

### Result Pipeline

```
Subagent finishes
    ↓
extractDoneResult() — look for structured done() call
    ↓  found                    ↓  not found
formatDoneResult()      buildFallbackResult()
(structured summary)    (extract from tool results, 2K/tool, 8K total)
    ↓                          ↓
bus.setResult(text)
    ↓
Multi-agent: aggregate all results + findings
Single-agent: return directly
    ↓
toModelOutput() — compact for parent context
```

### Agent Quality Pipeline

**File**: `src/core/agents/subagent-tools.ts`

Built on SoulForge's AgentBus and dispatch infrastructure to improve subagent output quality and reduce wasted agent steps.

**Schema Enforcement** — The dispatch schema requires a `targetFiles` array on every task. Pre-dispatch validation rejects tasks without real file paths (must contain `/` or `.`) before any subagent runs. File paths are auto-injected into subagent prompts.

**Complexity-Tier Routing** — `detectTaskTier()` classifies tasks as `trivial` (single-file explore with short prompt, or single-file small edit) or `standard`. `selectModel()` routes trivial tasks to the `trivialModel` when configured. The `tier` field on the dispatch schema allows LLM override.

**De-Sloppify Pass** — `runDesloppify()` runs a cleanup code agent after code agents finish, only when: (1) a `desloppifyModel` is configured, (2) code agents ran, and (3) files were actually edited. The cleanup agent runs in fresh context (never wrote the code it reviews) and removes: tests of language features, redundant type checks, console.log, commented-out code, over-defensive error handling. The "two agents > one constrained agent" concept is from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code).

**Dispatch Cache** — `wrapReadFileWithDispatchCache()` in forge.ts wraps the parent's `read_file` tool. When the parent reads a file that a subagent already read (stored in `SharedCacheRef`), it gets a cache hit instead of disk I/O.

**Done Tool Contracts** — Explore and code done tools demand pasteable code, not prose descriptions. "The parent agent ONLY sees what you put here — your tool results are invisible to it." If the parent has to re-read files, the done call failed.

**Result Richness** — Tool result caps sized to carry full context: 4K per tool result, 16K total. Code block line limits: 1500. Prevents re-read spirals by ensuring subagent results contain enough detail.

All features can be toggled via `/agent-features` or `agentFeatures` in config.

---

## Intelligence Router

**File**: `src/core/intelligence/router.ts`

Routes code intelligence operations to the best available backend.

### Backends

| Backend | Tier | Capabilities |
|---------|------|-------------|
| **LSP** | 1 | definitions, references, rename, diagnostics, code actions, call hierarchy, type info, formatting |
| **ts-morph** | 2 | TypeScript/JavaScript — AST definitions, references, rename, extract function/variable, unused detection, type info |
| **tree-sitter** | 2 | 20+ languages — symbol extraction, imports/exports, scopes, outlines via WASM grammars |
| **regex** | 3 | Universal fallback — symbol search, simple definitions, import patterns |

For each operation, the router tries backends in tier order. If tier 1 returns null or throws, tier 2 is tried, then tier 3.

### LSP Integration

**File**: `src/core/intelligence/backends/lsp/`

- Auto-discovers language servers via PATH and Mason (`~/.local/share/nvim/mason/bin/`)
- Per-language client pool cached by `(language, projectRoot)`
- Standalone mode (no Neovim) and bridge mode (via running Neovim instance)
- Anchor-file discovery for workspace-wide queries without an open buffer

### Post-Edit Diagnostics

**File**: `src/core/intelligence/post-edit.ts`

After file edits, snapshots LSP diagnostics and diffs against pre-edit state:
- New errors introduced by the edit
- New warnings
- Previously existing errors that were resolved
- Cross-file errors (in other files caused by this edit)

---

## Web Search System

### Architecture

```
web_search tool call
    │
    ├── webSearchModel configured?
    │       │
    │       ├── YES → spawn ToolLoopAgent (up to 15 steps, 120s)
    │       │         ├── web_search tool → Brave API → DDG fallback
    │       │         ├── fetch_page tool → Jina → Readability → fallback
    │       │         └── synthesize structured summary
    │       │
    │       └── NO → direct webSearchScraper → Brave → DDG
    │
    └── return result (cached 5 min)
```

### Search Backends

| Backend | Trigger | Notes |
|---------|---------|-------|
| **Brave Search API** | `BRAVE_API_KEY` set | Structured results with snippets, max 20 per query |
| **DuckDuckGo HTML** | Brave unavailable | Scrapes `html.duckduckgo.com`, regex extraction, no API key |

### Page Fetch Backends

| Backend | Trigger | Notes |
|---------|---------|-------|
| **Jina Reader** | Always tried first | `r.jina.ai/{url}` returns clean markdown, optional API key |
| **Readability** | Jina fails | `@mozilla/readability` + `linkedom`, extracts article content |
| **Fallback strip** | Readability fails | Regex HTML→text, strips scripts/nav/footer |

Page content is truncated to 16KB and cached with 5 min TTL.

### Agent Mode

**File**: `src/core/agents/web-search.ts`

When `webSearchModel` is configured via the task router, the `web_search` tool spawns a `ToolLoopAgent` with access to both `web_search` and `fetch_page` tools. The agent can:
- Run multiple search queries with refined terms
- Follow promising URLs for full-page reads
- Synthesize a structured summary with source citations

The agent reports live progress via `emitSubagentStep()` — the UI shows each search query and page fetch as nested steps under the parent tool call.

---

## Tool Design

### Principles

1. **Tool finds things itself** — don't make the agent locate/explore before calling
2. **Confident output** — state facts, never say "verify" or "check" (causes verification spirals)
3. **One call does the whole job** — agent shouldn't orchestrate multi-step mechanical workflows
4. **Know the project** — toolchain, test runner, linter detected automatically
5. **Accept flexible input** — symbol name instead of line numbers, no file hint needed

### Compound Tools

**`rename_symbol`** (`src/core/tools/rename-symbol.ts`)
- Locates symbol via LSP workspace search + grep fallback
- Validates `isFile()` on workspace symbol results (filters nested properties)
- LSP workspace rename, then grep verification of all references
- Output: "All references updated. No errors."

**`move_symbol`** (`src/core/tools/move-symbol.ts`)
- Extracts symbol source from origin file
- Inserts into target (created if needed)
- Updates all import statements across the codebase
- Per-language import handlers: TS/JS, Python, Rust auto-update; Go/C/C++ graceful degradation
- Handles TypeScript `verbatimModuleSyntax` (uses `import type {}`)

**`project`** (`src/core/tools/project.ts`)
- Auto-detects toolchain by probing for config files (package.json, Cargo.toml, go.mod, pyproject.toml, etc.)
- Actions: test, build, lint, typecheck, run
- Supports: bun, deno, npm, cargo, go, pytest/ruff/mypy, xcodebuild, gradlew, flutter, dotnet, cmake, mix, bundle
- Accepts flags, env vars, cwd override, timeout

### Token-Saving Measures

- `grep`: `--max-filesize=256K` prevents token explosions from minified files
- `glob`: `--max-depth 8` prevents deep directory traversal
- `shell`: 16KB output truncation
- `read_code`: extracts single symbols instead of full files
- `toModelOutput`: compresses dispatch results before feeding to parent

---

## Context Manager

**File**: `src/core/context/manager.ts`

Assembles the system prompt from multiple sources:

1. **Mode instructions** — persona-specific behavior (default, architect, socratic, etc.)
2. **Project info** — detected toolchain, package.json metadata
3. **Git context** — branch, recent commits, dirty files
4. **Repo map** — PageRank-ranked file/symbol view (see above)
5. **Memory** — persistent project/global memory from SQLite
6. **Forbidden files** — security patterns that block AI access
7. **Skills** — loaded skill instructions

### Conversation Tracking

Tracks edited files, mentioned files, and conversation terms. These flow into repo map personalization — the system prompt evolves as the conversation progresses.

`resetConversationTracking()` clears all tracking state between tasks (important for benchmarking).

### Context Compaction

**File**: `src/hooks/useChat.ts` (`summarizeConversation`)

When context usage exceeds 70% (or manually via `/compact`), the older portion of the conversation is summarized by an LLM and replaced with a structured summary.

```
1. Guard: skip if < 4 messages or < 2 older messages
2. Split: keep last 4 messages verbatim, summarize the rest
3. Summarize: LLM generates structured summary (Environment, Files Touched,
   Tool Results, Key Decisions, Work Completed, Errors, Current State)
4. Replace: coreMessages = [summary, ack, ...recentMessages]
5. Report: "Context compacted: 25% -> 6%" shown as persistent chat message
```

**Task routing**: The compact task type has its own model slot — use a fast model for summarization.

**Queue safety**: Messages queued during compaction drain after completion. If compaction is triggered during active streaming, it defers via `pendingCompactRef` until the generation settles, then auto-continues.

**Auto-compact**: Triggers at 70% context usage with hysteresis reset at 40% to prevent repeated compaction.

---

## LLM Layer

### Providers

**File**: `src/core/llm/providers/`

| Provider | SDK | Notes |
|----------|-----|-------|
| **Anthropic** | `@ai-sdk/anthropic` | Claude models, prompt caching support |
| **OpenAI** | `@ai-sdk/openai` | GPT-4o, o3, o4-mini |
| **xAI** | `@ai-sdk/xai` | Grok models |
| **Google** | `@ai-sdk/google` | Gemini models |
| **Ollama** | Custom | Local models, no API key needed |
| **AI Gateway** | Custom | Vercel AI Gateway — all providers through one key |
| **Proxy** | `@ai-sdk/anthropic` (custom baseURL) | Local CLIProxyAPI relay for Claude web session auth |

Each provider implements `ProviderDefinition`: `createModel()`, `fetchModels()`, `fallbackModels`, `contextWindows`. Model lists are fetched from provider APIs at startup and cached.

Context window detection: provider API → OpenRouter metadata → hardcoded patterns → 128K default.

### Task Router

**File**: `src/core/llm/task-router.ts`

Maps task types to specific models:

```typescript
interface TaskRouter {
  planning: string | null;    // Plan mode, architecture decisions
  coding: string | null;      // File edits, implementation
  exploration: string | null; // Read-only research
  webSearch: string | null;   // Web search agent model
  compact: string | null;     // Context compaction summarizer
  semantic: string | null;    // Repo map semantic summaries
  default: string | null;     // Fallback
}
```

Task detection is automatic based on message content (regex patterns for explore/code/web/plan prefixes). Resolution: `taskRouter[taskType]` → `taskRouter.default` → active model.

### Proxy Provider

**File**: `src/core/proxy/lifecycle.ts`

CLIProxyAPI is a local HTTP relay that authenticates with Claude's web session. SoulForge auto-manages the binary:
- Installs to `~/.soulforge/` via vendored binary or PATH lookup
- Starts on demand, stops on exit
- Default: `http://127.0.0.1:8317/v1` with API key `soulforge`
- Health check: `GET /models` with auth header

---

## UI Layer

**Framework**: OpenTUI (React reconciler for terminal UIs)

Previously built on Ink — migrated to OpenTUI for performance and native scroll/input primitives.

### State Management

Zustand stores decouple UI state from component trees:

| Store | Purpose |
|-------|---------|
| `stores/ui.ts` | Modal state, active panels, layout flags |
| `stores/errors.ts` | Background error log |
| `stores/repomap.ts` | Scan progress, stats, semantic summary status |
| `stores/statusbar.ts` | Memory usage, polling |

### Key Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Root — wires all state, keybindings, modals |
| `InputBox.tsx` | Multiline input with paste collapse, fuzzy history (Ctrl+R), command autocomplete, compaction status |
| `MessageList.tsx` | Chat messages with markdown, syntax highlighting, tool call progress, persistent system messages |
| `ContextBar.tsx` | Live/estimated context usage with green/gray dot indicator and percentage |
| `EditorPanel.tsx` | Embedded Neovim with screen rendering |
| `CommandPicker.tsx` | Slash command palette |
| `ToolCallDisplay.tsx` | Real-time tool execution visualization |

---

## Session System

**Files**: `src/core/sessions/manager.ts`, `src/core/sessions/rebuild.ts`

Sessions are persisted as JSONL files (one JSON object per message) with a `meta.json` per session. On restore, `rebuildCoreMessages()` reconstructs AI SDK `CoreMessage[]` from stored `ChatMessage[]`, preserving tool call/result pairing for mid-conversation recovery. System messages with `showInChat: true` (e.g. compaction results) are preserved across save/restore; ephemeral system messages are stripped.

---

## File Layout

```
src/
├── boot.tsx                    # Entry point
├── index.tsx                   # App initialization
├── components/                 # OpenTUI components
├── hooks/                      # React hooks (useChat, useNeovim, useTabs...)
├── stores/                     # Zustand stores
├── types/                      # Shared type definitions
├── config/                     # Config loading/saving
└── core/
    ├── agents/                 # Forge, Code, Explore, WebSearch agents
    │   ├── agent-bus.ts        # Shared coordination bus
    │   ├── subagent-tools.ts   # Dispatch orchestration
    │   ├── step-utils.ts       # Per-step injection logic
    │   └── stream-options.ts   # Streaming configuration builder
    ├── context/
    │   └── manager.ts          # System prompt assembly
    ├── editor/                 # Neovim integration
    ├── history/                # Input history (SQLite)
    ├── intelligence/
    │   ├── repo-map.ts         # PageRank codebase index
    │   ├── router.ts           # Multi-backend operation router
    │   ├── post-edit.ts        # Diagnostic diffing after edits
    │   └── backends/           # LSP, tree-sitter, regex
    ├── llm/                    # Provider config, model registry
    ├── memory/                 # Persistent memory (SQLite)
    ├── modes/                  # Forge personas
    ├── security/               # Forbidden file patterns
    ├── sessions/               # Session persistence + rebuild
    ├── setup/                  # Prerequisite checks
    └── tools/                  # All 30+ tools
        ├── rename-symbol.ts
        ├── move-symbol.ts
        ├── project.ts
        ├── edit-file.ts
        ├── read-code.ts
        ├── navigate.ts
        ├── analyze.ts
        ├── refactor.ts
        ├── repo-map-intercept.ts  # Repo map tool interception
        └── ...
```
