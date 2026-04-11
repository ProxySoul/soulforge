# Prompt System

SoulForge uses a modular, per-family prompt architecture. Each model family (Claude, OpenAI, Gemini) gets a tailored system prompt optimized for its strengths, with shared rules and tool guidance appended automatically.

## Family Detection

SoulForge detects the model family from the model ID:

| Model ID Pattern | Family | Prompt style |
|---|---|---|
| `anthropic/*`, `claude-*` | `claude` | Concise, imperative, zero-filler |
| `openai/*`, `xai/*`, `gpt-*`, `o1*`, `o3*` | `openai` | Agent framing, structured guidelines |
| `google/*`, `gemini-*` | `google` | Core mandates, enumerated workflows |
| Everything else | `other` | Generic, works with any model |

Gateway providers (OpenRouter, LLM Gateway, Vercel AI Gateway, Proxy) are detected by inspecting the model name portion of the ID. For example, `llmgateway/claude-sonnet-4` → matches `claude` family.

## Prompt Assembly

The system prompt is assembled from these sections:

1. **Family base prompt** — identity, tone, style, workflow (per-model)
2. **Shared rules** — tool policy, conventions, commit restrictions (same for all)
3. **Tool guidance** — priority list, editing rules, dispatch rules
4. **Project context** — cwd, toolchain, project instructions (SOULFORGE.md, CLAUDE.md, etc.)
5. **Forbidden files** — security patterns
6. **Editor context** — open file, cursor position, visual selection
7. **Git context** — branch, status, conflicts
8. **Memory** — persistent memory index
9. **Mode overlay** — architect, plan, auto, etc. (if active)
10. **Skills reference** — loaded skill instructions

## Cache Strategy

The system prompt is structured for Anthropic prompt caching efficiency:

- **System prompt** (all sections above) — stable across steps, cached after the first turn
- **Soul Map** — injected as a separate message pair (updates after edits without invalidating the cached system prompt)
- **Skills** — injected as a separate message pair

## Mode Overlays

Modes append additional instructions to the base prompt:

| Mode | Behavior |
|---|---|
| `default` | No overlay — full agent |
| `architect` | Read-only, produces structured architecture analysis |
| `socratic` | Investigates first, asks targeted questions |
| `challenge` | Adversarial review with evidence from soul tools |
| `plan` | Research → structured plan → user confirms → execute |
| `auto` | Autonomous execution, minimal interruptions |

Plan mode has two variants: `full` (high context — includes code snippets and diffs) and `light` (low context — just steps and descriptions).

## Soul Map Injection

The Soul Map is injected as a message pair prepended to the conversation, showing the ranked file/symbol view of the codebase. This keeps structural context visible to the model without bloating the cached system prompt.
