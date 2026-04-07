# Context Compaction

SoulForge supports two compaction strategies for managing long conversations. When context usage exceeds a threshold, older messages are compacted to free space while preserving critical information.

## Strategies

### V1 — LLM Batch Summarization

The original approach. When compaction triggers:

1. Splits messages: last N kept verbatim, everything older goes to the summarizer
2. Formats older messages (6k chars/msg, 8k for tool results)
3. Sends to an LLM with a structured prompt requesting: Environment, Files Touched, Tool Results, Key Decisions, Work Completed, Errors, Current State
4. Replaces older messages with the summary

**Cost**: One LLM call processing potentially 100k+ chars, outputting up to 8192 tokens.

### V2 — Incremental Structured Extraction (default)

Maintains a `WorkingStateManager` that extracts structured state **as the conversation happens**, not in a batch at compaction time.

**What gets extracted (deterministic, zero LLM cost):**
- **Files** — tracked from read/edit/write tool calls with action details
- **Failures** — extracted from error results
- **Tool results** — rolling window of shell/grep/project outputs
- **Task** — set from first user message

**What gets extracted (regex-based, zero LLM cost):**
- **Decisions** — patterns like "I'll use...", "decided to...", "because..."
- **Discoveries** — patterns like "found that...", "the issue was..."

**On compaction:**
1. Serializes the pre-built structured state into markdown
2. Optionally runs a cheap LLM **gap-fill** pass (2048 tokens max) that sees the structured state + a 4k char sample of older messages and only outputs what's missing
3. Same message replacement as v1

**Cost**: Rule-based extraction during conversation (free). Gap-fill pass ~2k tokens vs v1's 8k. If `llmExtraction: false`, compaction is instant with zero API calls.

## Configuration

```jsonc
// ~/.soulforge/config.json (global) or .soulforge/config.json (project)
{
  "compaction": {
    "strategy": "v2",           // "v2" (default) | "v1"
    "triggerThreshold": 0.7,    // auto-compact at 70% context usage
    "resetThreshold": 0.4,      // hysteresis reset to prevent oscillation
    "keepRecent": 4,            // verbatim recent messages to preserve
    "maxToolResults": 30,       // rolling window for tool result slots (v2)
    "llmExtraction": true       // cheap LLM gap-fill on compact (v2)
  }
}
```

All fields are optional. Omitting `compaction` or `strategy` defaults to v2.

### Live toggle

Use `/compaction` to switch strategies with project/global scope support. The change takes effect immediately — switching to v2 starts extraction on the next message, switching to v1 drops the working state entirely.

### Dedicated model via task router

Both strategies use the task router's `compact` slot:

```jsonc
{
  "taskRouter": {
    "compact": "google/gemini-2.0-flash"
  }
}
```

Falls back to `taskRouter.default`, then the active model. For v2, only the gap-fill pass uses this model. For v1, the full summarization uses it.

## Visual Indicators

- **ContextBar**: Shows `v2:N` (slot count) when v2 is active and extracting
- **ContextBar**: Shows `◐ compacting` spinner during active compaction (both strategies)
- **InputBox**: Shows "Compacting context..." status during compaction
- **System message**: Reports strategy used and before/after context percentages

## Architecture

```
src/core/compaction/
├── types.ts           — WorkingState, CompactionConfig, slot types
├── working-state.ts   — WorkingStateManager class (semantic slots + serialization)
├── extractor.ts       — Rule-based extractors for tool calls and messages
├── summarize.ts       — buildV2Summary() with optional LLM gap-fill
└── index.ts           — barrel exports
```

### Data flow (v2)

```
User message ──────────────────────► extractFromUserMessage()  ──► WSM.task
Tool call (read/edit/shell/etc.) ──► extractFromToolCall()     ──► WSM.files, WSM.toolResults
Tool result (success/error) ───────► extractFromToolResult()   ──► WSM.toolResults, WSM.failures
Assistant text ────────────────────► extractFromAssistantMessage() ► WSM.decisions, WSM.discoveries
                                                                     │
Context > threshold ───► buildV2Summary() ──► serialize WSM          │
                              │               + optional gap-fill ◄──┘
                              ▼
                    [summary msg] + [ack msg] + [N recent msgs]
```

### Guard behavior

When strategy is not `"v2"`, the `WorkingStateManager` is `null`. Every extraction call site checks `if (workingStateRef.current)` — no WSM instance means zero v2 code executes. No background tasks, no timers, no allocations.

## Real-World Example

A session with 10 user turns fixing TypeScript errors, updating a README comparison table, testing LSP rename, and fixing a `project format` bug. Model: Claude Opus 4.6.

### Before compaction

| Metric | Value |
|---|---|
| Core messages | 34 |
| Prompt tokens | 4,517,349 |
| Cache read tokens | 2,740,557 (60.6% hit rate) |
| Completion tokens | 14,364 |
| Estimated cost | ~$33 |
| Context utilization | 6% |

### After V2 compaction

| Metric | Value |
|---|---|
| Core messages | **5** |
| Prompt tokens | **7,539** |
| Cache read tokens | 0 (cache invalidated by new content) |
| Gap-fill tokens | **0** (WSM had ≥15 slots, skipped) |
| Context utilization | **4%** |

34 messages → 5. The compaction cost **zero tokens** — no LLM call at all.

### What V2 produced

The compacted summary is a single structured message:

```markdown
## Task
(all user requests concatenated)

## User Requirements
- fix all issues
- are they really forwarded and the stuff will work?
- run tests, lint, typecheck format and commit
- ...9 items total

## Files Touched
- `tsconfig.json`: read; edited (×2)
- `src/core/tools/web-search.ts`: read (×4); analyzed (×3); edited
- `node_modules/ai/dist/index.d.ts`: read (×3)
- `node_modules/ai/src/agent/tool-loop-agent.ts`: read (×3)
- `README.md`: read (×2); edited
- `src/core/intelligence/router.ts`: read (×4); grep
- `src/core/tools/project.ts`: read (×9); grep; edited

## Assistant Notes
- `baseUrl` is only needed to support `paths` mapping...
- `AgentCallParameters` doesn't include experimental callbacks...
- (truncated excerpts from assistant reasoning)

## Tool Results
- **soul_analyze**: Top 20 identifiers by cross-file reference count...
- **navigate**: References to 'emitSubagentStep' (13): 5 files
- **rename_symbol**: Renamed across 5 files [lsp], verified zero remaining
- **project**: typecheck passed, lint passed, 2292 tests passed

## Errors & Failures
- project: typecheck failed — TS5090 non-relative paths
- project: typecheck failed — TS2353 experimental_onToolCallStart
- project: lint failed — formatter would have printed different content
- project: format failed — biome check without --write (×3)
```

Then just the last 2 messages (the final commit + result) are kept verbatim.

### What this means for the next turn

Without compaction, the next API call would re-send all 34 messages (~100K+ tokens). After V2 compaction, the next call sends:

- System prompt + Soul Map: ~15K tokens (unchanged)
- V2 summary: ~3-4K tokens
- Last 2 messages: ~500 tokens
- **Total: ~19K tokens** — an ~80% reduction in per-turn input cost

The one-turn cost is the **cache invalidation**: the old prefix cache is gone, so the first post-compaction turn has 0% cache hits. Subsequent turns rebuild the cache from the new prefix.

### Gap-fill threshold

The WSM tracks state across these slot categories: task, plan, files, decisions, failures, discoveries, environment, toolResults, userRequirements, assistantNotes. When **≥15 slots are populated** across all categories, the state is considered rich enough and the LLM gap-fill pass is skipped entirely.

This session filled slots from ~60 tool calls (read, edit_file, project, navigate, rename_symbol, soul_grep, web_search, git, shell) — well above the threshold. Sessions with fewer tool calls (e.g. mostly discussion) would trigger the 2K-token gap-fill to capture reasoning that only existed in prose.

### V1 comparison

The same compaction with V1 would have:
- Sent all 34 messages to an LLM for summarization
- Cost ~8K output tokens (~$0.60 on Haiku, ~$6 on Opus)
- Taken 5-15 seconds of latency
- Produced a prose summary that captures reasoning better but loses structured data

V2's tradeoff: **zero cost, instant, structured data preserved, but reasoning chains truncated**. For mechanical coding sessions (fix/edit/test cycles), V2 is strictly better. For design-heavy sessions where the "why" matters more than the "what", V1's LLM summarization may retain more nuance.

### MemPalace integration

When a [MemPalace](https://github.com/milla-jovovich/mempalace) MCP server is connected, compaction v2 automatically persists the working state to the palace before resetting. Three things happen at zero extra cost:

1. **Drawer** — the full serialized summary is filed as a palace drawer (wing = project name, room = compaction)
2. **Knowledge graph** — decisions, discoveries, and failures are filed as temporal triples with `valid_from` timestamps. MemPalace's contradiction detection flags conflicting decisions across compactions.
3. **Agent diary** — a compact AAAK-format entry summarising the task, key decisions, and files touched

This means every compaction event becomes searchable across sessions. Six months later, `mempalace search "auth migration decisions"` finds the exact tradeoffs and file changes.

Setup: add `mempalace` as an [MCP server](mcp.md). See [examples/soulforge_setup.md](https://github.com/milla-jovovich/mempalace/blob/main/examples/soulforge_setup.md) in the MemPalace repo for the full guide.
