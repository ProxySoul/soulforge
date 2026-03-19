# SoulForge

AI-Powered Terminal IDE by proxySoul.

## Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript (strict mode)
- **TUI**: Ink (React for CLIs) via OpenTUI
- **LLM**: Vercel AI SDK (multi-provider)
- **Editor**: Neovim (embedded via msgpack-RPC)
- **Linter/Formatter**: Biome
- **Database**: SQLite (bun:sqlite) for repo map, memory, sessions

## Commands

- `bun run dev` — start soulforge
- `bun run lint` — lint with biome
- `bun run lint:fix` — auto-fix lint issues
- `bun run format` — format with biome
- `bun run typecheck` — check types
- `bun test` — run all tests
- `bun test tests/<file>` — run specific test file

## CLI Flags

- `--session <id>` / `--resume <id>` / `-s <id>` — resume a saved session
- `--headless <prompt>` — run without TUI, stream to stdout
- `--headless --json` — structured JSON after completion
- `--headless --events` — JSONL event stream (real-time)
- `--headless --model <provider/model>` — override model
- `--headless --mode <mode>` — set mode (default/architect/plan/auto)
- `--headless --system "..."` — inject system prompt
- `--headless --include <file>` — pre-load file into context (repeatable)
- `--headless --session <id>` — resume a previous session
- `--headless --save-session` — save session after completion
- `--headless --max-steps <n>` — limit agent steps
- `--headless --timeout <ms>` — abort after timeout
- `--headless --no-repomap` — skip repo map scan
- `--headless --diff` — show files changed after run
- `--headless --quiet` / `-q` — suppress header/footer
- `--headless --cwd <dir>` — set working directory
- `--headless --chat` — interactive multi-turn chat (auto-saves session on exit)
- `--list-providers` — show providers and key status
- `--list-models [provider]` — show available models
- `--set-key <provider> <key>` — save API key
- `--version` / `-v` — show version
- `--help` / `-h` — show usage
- Piped input: `echo "prompt" | soulforge --headless`
- Exit codes: 0=success, 1=error, 2=timeout, 130=abort

## Conventions

- Use `bun` instead of `node`, `npm`, `npx`
- Use Biome for linting + formatting (not ESLint/Prettier)
- Strict TypeScript — no `any`, no unused vars
- React JSX transform (no `import React` needed)
- No unnecessary comments — clean code speaks for itself
- Prefer editing existing files over creating new ones
- Keep solutions simple — don't over-engineer

## Architecture

### Entry Points

- `src/boot.tsx` — main entry, splash animation, headless detection, dependency setup
- `src/index.tsx` — TUI renderer setup (OpenTUI + React)
- `src/headless/` — headless CLI (parse, run, providers, output, types, constants)
- `src/components/App.tsx` — main React component

### Core Modules

- `src/core/agents/forge.ts` — main Forge agent (createForgeAgent)
- `src/core/context/manager.ts` — ContextManager (system prompt, repo map, memory)
- `src/core/tools/` — all 30+ tools (read_file, edit_file, shell, soul_*, etc.)
- `src/core/llm/` — provider registry, model resolution, provider options
- `src/core/llm/providers/custom.ts` — config-driven custom provider builder
- `src/core/intelligence/` — LSP, ts-morph, tree-sitter, regex fallback chain
- `src/core/instructions.ts` — SOULFORGE.md / CLAUDE.md / .cursorrules loader (10 sources)
- `src/core/sessions/` — session save/restore (used by TUI and headless)

### Key Patterns

- Agent loop is fully decoupled from TUI — works headless via `createForgeAgent().stream()`
- All approval callbacks are optional — omitting them auto-allows (headless behavior)
- Custom providers use `createOpenAI({ baseURL, apiKey })` pattern (same as Ollama)
- Config is layered: global (`~/.soulforge/config.json`) > project (`.soulforge/config.json`)
- Skills scan: `~/.soulforge/skills/`, `~/.agents/skills/`, `~/.claude/skills/` (+ project-local)
- Instruction files: SOULFORGE.md on by default, others toggled via `/instructions` or config

### Tool Suite

**Intelligence tools (use first):** `navigate`, `analyze`, `read_file` (with target/name), `soul_find`, `soul_grep`, `soul_analyze`, `soul_impact`

**Edit tools:** `edit_file`, `write_file`, `create_file`, `rename_symbol`, `move_symbol`, `refactor`

**Project tools:** `project` (lint/test/build/typecheck), `shell`, `dispatch` (multi-agent)

**Memory:** `memory_write`, `memory_search`, `memory_list`, `memory_delete`

### Repo Map

SQLite-backed codebase graph with:
- Tree-sitter parsing (30+ languages)
- PageRank file ranking
- Cochange analysis (git log)
- Blast radius estimation
- Clone detection (minhash)
- FTS5 symbol search

### Provider System

9 built-in providers + custom providers via config:
- Built-in: Anthropic, OpenAI, Google, xAI, Ollama, OpenRouter, LLM Gateway, Vercel AI Gateway, Proxy
- Custom: any OpenAI-compatible API via `providers` array in config
- Conflicts auto-suffix to `{id}-custom`
- `--set-key` works for both built-in and custom providers

## Testing

- Tests live in `tests/` directory
- Use `bun:test` (describe, test, expect, beforeEach, mock, spyOn)
- Test files: `tests/<feature>.test.ts`
- Run specific: `bun test tests/headless.test.ts`
- Mock process.exit with spyOn to test error paths

## Config

Global: `~/.soulforge/config.json`
Project: `.soulforge/config.json`

Key fields:
- `defaultModel` — e.g. `"anthropic/claude-sonnet-4-6"`
- `providers` — custom OpenAI-compatible providers array
- `instructionFiles` — which instruction files to load (default: `["soulforge"]`)
- `taskRouter` — per-task model routing
- `agentFeatures` — toggle desloppify, verify, tier routing
- `thinking` — thinking mode config
- `performance` — effort, speed, parallel tool use
