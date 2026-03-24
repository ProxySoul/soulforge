# Prompt System

SoulForge uses a modular, per-family prompt architecture. Each model family (Claude, OpenAI, Gemini) gets a tailored system prompt optimized for its strengths, with shared rules and tool guidance appended automatically.

This approach was inspired by [OpenCode](https://github.com/opencode-ai/opencode)'s provider-specific prompt design.

## Architecture

```
src/core/prompts/
├── builder.ts              # Assembles system prompt from all sections
├── index.ts                # Module entry — re-exports everything
├── families/
│   ├── index.ts            # Barrel export
│   ├── shared-rules.ts     # Tool policy, conventions, commit rules (shared by all)
│   ├── claude.ts           # Claude family — concise, zero-filler, fix-first
│   ├── openai.ts           # OpenAI family — agent framing, coding guidelines
│   ├── google.ts           # Gemini family — core mandates, structured workflow
│   └── default.ts          # Fallback — DeepSeek, Llama, Qwen, Mistral, etc.
├── shared/
│   ├── tool-guidance.ts    # Tool priority list (with/without Soul Map variants)
│   └── soul-map.ts         # Soul Map user message builder + directory tree
└── modes/
    └── index.ts            # Mode overlays (architect, plan, auto, socratic, challenge)
```

## Family Detection

The builder uses `detectModelFamily(modelId)` from `src/core/llm/provider-options.ts`:

| Model ID Pattern | Family | Prompt |
|---|---|---|
| `anthropic/*`, `claude-*` | `claude` | Concise, imperative, zero-filler |
| `openai/*`, `xai/*`, `gpt-*`, `o1*`, `o3*` | `openai` | Agent framing, structured guidelines |
| `google/*`, `gemini-*` | `google` | Core mandates, enumerated workflows |
| Everything else | `other` | Generic, works with any model |

Gateway providers (OpenRouter, LLM Gateway, Vercel AI Gateway, Proxy) are detected by inspecting the model name portion of the ID. For example, `llmgateway/claude-sonnet-4` → model starts with `claude` → family `claude`.

## Prompt Assembly

`buildSystemPrompt()` in `builder.ts` assembles the final prompt:

1. **Family base prompt** — identity, tone, style, workflow (per-model)
2. **Shared rules** — tool policy, conventions, commit restrictions (same for all)
3. **Tool guidance** — priority list, editing rules, dispatch rules (with/without Soul Map)
4. **Project context** — cwd, toolchain, project instructions (SOULFORGE.md, CLAUDE.md, etc.)
5. **Forbidden files** — security patterns
6. **Editor context** — open file, cursor position, visual selection
7. **Git context** — branch, status, conflicts
8. **Memory** — persistent memory index
9. **Mode overlay** — architect, plan, auto, etc. (if active)
10. **Skills reference** — static reference line

## Cache Strategy

The system prompt is split for Anthropic prompt caching efficiency:

- **System prompt** (steps 1-10 above) → marked with `EPHEMERAL_CACHE`, stable across steps
- **Soul Map** → injected as a user→assistant message pair (aider-style repo map pattern), updates after edits without invalidating the cached system prompt
- **Skills** → injected as a separate user→assistant message pair

This means the ~12k token system prompt + tool schemas are cached on the first turn and reused on subsequent turns, saving significant cost.

## Adding a New Family

1. Create `src/core/prompts/families/yourfamily.ts`:
   ```typescript
   import { SHARED_RULES } from "./shared-rules.js";
   export const YOUR_PROMPT = `You are Forge — ...
   ${SHARED_RULES}`;
   ```

2. Add to `FAMILY_PROMPTS` in `src/core/prompts/builder.ts`:
   ```typescript
   const FAMILY_PROMPTS: Record<string, string> = {
     claude: CLAUDE_PROMPT,
     openai: OPENAI_PROMPT,
     google: GOOGLE_PROMPT,
     yourfamily: YOUR_PROMPT,  // ← add here
     other: DEFAULT_PROMPT,
   };
   ```

3. Add detection in `src/core/llm/provider-options.ts` `detectModelFamily()`:
   ```typescript
   if (base.startsWith("yourmodel")) return "yourfamily";
   ```

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

The Soul Map is injected as a user→assistant message pair prepended to the conversation:

```
User: <soul_map>
  <description>...</description>
  <how_to_use>...</how_to_use>
  <directory_tree>
    ├── src/
    │   ├── core/
    │   ├── components/
    │   └── hooks/
    └── tests/
  </directory_tree>
  <data>
    src/types/index.ts: (→86)
      +TaskRouter — [types] interface: task router
      ...
  </data>
</soul_map>