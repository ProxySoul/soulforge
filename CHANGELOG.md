# Changelog

All notable changes to SoulForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-14

### Added
- Multi-agent dispatch system with parallel explore, code, and web search agents
- AgentBus: shared file cache, edit mutex, real-time findings, tool result deduplication
- Repo map with PageRank ranking, git cochange analysis, clone detection (MinHash/Jaccard), blast radius graphs
- AST semantic summaries (tree-sitter docstring extraction, zero LLM cost)
- Soul tools suite: soul_grep, soul_find, soul_analyze, soul_impact (zero-cost repo map queries)
- Compound tools: rename_symbol (cross-file LSP rename), move_symbol (cross-file move + import updates), project (20+ toolchain auto-detect)
- Line-anchored edit_file with auto re-read on content drift
- V2 compaction: incremental structured extraction via WorkingStateManager
- Rolling tool result pruning with symbol enrichment (step-utils)
- Forge modes: default, architect, socratic, challenge, plan
- Task router: per-task model assignment (planning, coding, exploration, trivial, desloppify)
- Persistent memory system (SQLite FTS5, title-only, pull-based)
- Multi-tab sessions with independent chat contexts
- Embedded Neovim with LSP integration (msgpack-RPC)
- 4-tier code intelligence: LSP, ts-morph, tree-sitter, regex
- 9 LLM providers: Anthropic, OpenAI, Google, xAI, Ollama, OpenRouter, LLMGateway, Vercel Gateway, Proxy
- Web search with multi-step research agent
- Crash-resilient session saves (incremental + exit handler)
- Boot splash with child-process spinner (survives blocking imports)
- Forbidden file enforcement across all tools
- Outside-CWD write confirmation
- Shell anti-pattern blocking

### Fixed
- SQLite "database is locked" crash on concurrent repo map access
- useMemo after early return in WritePlanCall (Rules of Hooks violation)
- Database busy_timeout set on all SQLite databases (Memory, History, RepoMap)
- Non-null assertions replaced with safe checks in multi-edit and edit-stack
