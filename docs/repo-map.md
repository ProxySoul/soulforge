# Repo Map — Technical Deep Dive

The repo map is SoulForge's primary mechanism for codebase awareness. It replaces the naive file tree listing used by most AI coding tools with a graph-ranked, context-adaptive, semantically-enriched view.

## Problem

AI coding assistants need to know what's in the codebase to make useful edits. Common approaches:

| Approach | Tool | Limitation |
|----------|------|-----------|
| Flat file tree | Claude Code, most tools | No structural info — the AI can't tell which files matter |
| Manual file reads | All tools | Burns tokens reading irrelevant files; requires the AI to already know what to look for |
| Static repo map | Aider (original) | Fixed-size, doesn't adapt to conversation context |
| RAG / embeddings | Cursor, Cody | Requires embedding model, chunk boundaries are lossy, no structural ranking |

SoulForge's approach: **build the dependency graph, rank with PageRank, personalize to the active conversation, and enrich with LLM summaries.**

## How It Works

### 1. Index Phase (startup)

Walk the file tree (respecting `.gitignore`, ignored dirs, max depth 10). For each source file:

1. Parse with tree-sitter to extract symbols (functions, classes, interfaces, types, enums) and their signatures
2. Extract import statements and identifier references
3. Build cross-file edges: if file A references a symbol exported by file B, create an edge A → B
4. Store everything in SQLite (in-memory for speed, on-disk for persistence)

Indexing is incremental — files are re-indexed only when their mtime changes.

### 2. Graph Phase

Run PageRank (20 iterations, damping factor 0.85) over the file→file edge graph. Files imported by many other files score higher. The algorithm uses a personalization vector that can be biased toward specific files (see below).

### 3. Co-Change Phase

Parse `git log --name-only` for the last 300 commits. For each commit that touches 2–20 files, record all pairwise file combinations in the `cochanges` table. Commits with >20 files are filtered as noise (refactors, mass renames).

This captures implicit coupling that the import graph misses — files that are always edited together even without direct imports (e.g., a migration file and its corresponding model).

### 4. Ranking Phase (per-turn)

When building the system prompt, the repo map produces a ranked view:

**PageRank with personalized restart vector:**
- Edited files: 5x base weight
- Mentioned files (tool reads, grep hits): 3x base weight
- Active editor file: 2x base weight
- Co-change partners of context files: proportional to co-change count (capped at 2x)

**Post-hoc signals** (things PageRank can't capture):
- FTS match on conversation terms: +0.5 score
- Graph neighbor of any context file: +1.0 score
- Co-change partner of any context file: +min(count/5, 3.0) score

The final ranking blends structural importance (PageRank) with conversational relevance (FTS, neighbors, co-change).

### 5. Rendering Phase

Binary search to maximize the number of file blocks that fit within the token budget. Each block shows:

```
src/core/agents/agent-bus.ts [R:12]
  +AgentBus — Shared coordination bus for parallel subagent communication
  +acquireFileRead — Lock-free file read with cache and waiter pattern
  +SharedCache — Pre-seeded cache for warm agent starts
   FileCacheEntry
```

- `+` = exported symbol
- `[R:12]` = blast radius (12 files import this one)
- `[NEW]` = file appeared since last render
- Italic descriptions are semantic summaries from the LLM

### 6. Semantic Summaries

After the initial scan, top symbols (by PageRank) are batched to a fast LLM:

```
Prompt: "One-line summary of what this symbol does. No intro, just the summary."
Input: { name: "AgentBus", kind: "class", signature: "class AgentBus { ... }" }
Output: "Shared coordination bus for parallel subagent communication"
```

Summaries are cached in SQLite keyed by `(symbol_id, file_mtime)`. When a file is edited, its mtime changes and summaries are regenerated on the next pass.

The summary model is configurable via the task router (defaults to the cheapest available model).

## Budget Dynamics

The repo map's token budget scales inversely with conversation length:

```
budget = MIN + (MAX - MIN) × max(0, 1 - conversationTokens / 100,000)
```

| State | Budget | Rationale |
|-------|--------|-----------|
| Start of conversation | 2,500 tokens | AI needs maximum orientation |
| Mid conversation (~50K tokens) | ~2,000 tokens | Context established, less map needed |
| Late conversation (~100K+ tokens) | 1,500 tokens | Save space for actual work |

The budget can reach 4,000 tokens maximum (for very early turns with many files).

## Real-Time Updates

The file event system ensures the repo map stays current:

```
Tool calls edit_file / write_file
    ↓
emitFileEdited(absPath)
    ↓
ContextManager.onFileChanged(absPath)
    ↓
RepoMap.onFileChanged(absPath)
    ↓
Mark file dirty → debounced re-index (500ms, busy_timeout = 5000ms)
    ↓
Re-extract symbols + edges → recompute PageRank
    ↓
Clear repo map render cache
    ↓
Next system prompt gets updated ranking
```

Similarly, `emitFileRead(absPath)` feeds into `trackMentionedFile()`, which boosts the file in the next PageRank personalization without re-indexing.

## Schema Details

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  mtime_ms REAL NOT NULL,
  language TEXT NOT NULL,
  line_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  pagerank REAL NOT NULL DEFAULT 0
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  signature TEXT,
  is_exported INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE edges (
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_file_id, target_file_id)
);

CREATE TABLE cochanges (
  file_id_a INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  file_id_b INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (file_id_a, file_id_b)
);

CREATE TABLE semantic_summaries (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  file_mtime REAL NOT NULL
);

-- FTS5 for conversation-term matching
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, content=symbols, content_rowid=id);
```

## Comparison

| Feature | SoulForge | Aider | Claude Code | OpenCode |
|---------|-----------|-------|-------------|----------|
| Index method | tree-sitter AST | tree-sitter AST | None | LSP diagnostics |
| Ranking | PageRank + personalization | Graph ranking | N/A | N/A |
| Context adaptation | Per-turn personalization vector | Dynamic sizing | N/A | N/A |
| Git co-change | Yes (300 commits) | No | No | No |
| Semantic summaries | LLM-generated, cached by mtime | No | No | No |
| FTS on symbols | Yes (SQLite FTS5) | No | No | No |
| Real-time updates | Debounced re-index on edit | Per-turn rescan | N/A | N/A |
| Budget management | Inverse-linear with conversation | Dynamic per-turn | N/A | N/A |
| Blast radius tags | Yes ([R:N]) | No | No | No |
| Cross-file edges | Import graph | Tag graph | N/A | N/A |
| Clone detection | AST shape hash + MinHash | No | No | No |
| Dead code detection | Unused exports (dead vs unnecessary) | No | No | No |
| External package tracking | Yes (per-file specifiers) | No | No | No |

## Language Support

The repo map supports 30+ languages with convention-based visibility detection:

| Convention | Languages | Rule |
|---|---|---|
| Name-based | Go | Capitalized = public |
| Name-based | Python, Dart | No `_` prefix = public |
| Name-based | Elisp | No `--` prefix = public |
| Keyword-based | Rust, Zig | `pub` keyword |
| Keyword-based | Java, Kotlin, Swift, C#, Scala | Not `private` = public |
| Keyword-based | PHP | Not `private`/`protected` = public |
| Keyword-based | Elixir | `def` (not `defp`) = public |
| Keyword-based | Solidity | `public`/`external` or contract/event/struct |
| File-based | C, C++, Objective-C | Header file (`.h`/`.hpp`/`.hh`) = public |
| Default public | Ruby, Lua, Bash, OCaml, ReScript, TLA+ | All top-level symbols treated as public |

Identifier extraction covers three naming families:
- **camelCase + PascalCase**: TypeScript, JavaScript, Go, Rust, Java, Kotlin, Swift, C#, Dart, Scala, Objective-C, Solidity
- **snake_case + PascalCase**: Python, Ruby, Elixir, PHP, C, C++, Zig, Lua, Bash, OCaml, ReScript
- **Hyphenated**: Elisp

IDENTIFIER_KEYWORDS filters ~190 reserved words across all supported languages to prevent noise in the reference graph.

### Monorepo Support (Partial)

The repo map currently indexes files within the working directory (`cwd`). In monorepo setups:

- PageRank, blast radius, and dependency edges only span files within `cwd`
- Cross-package imports (e.g., `@myorg/shared` in a pnpm workspace) resolve as external dependencies, not internal edges
- Co-change analysis works across the full git history regardless of package boundaries
- The `project` tool handles workspace discovery separately via `project(action: "list")`

Full monorepo graph support (cross-package edge building, workspace-aware PageRank) is planned.
