# Context Compaction

SoulForge supports two compaction strategies for managing long conversations. When context usage exceeds a threshold, older messages are compacted to free space while preserving critical information.

## Strategies

### V1 — LLM Batch Summarization (default)

The original approach. When compaction triggers:

1. Splits messages: last N kept verbatim, everything older goes to the summarizer
2. Formats older messages (6k chars/msg, 8k for tool results)
3. Sends to an LLM with a structured prompt requesting: Environment, Files Touched, Tool Results, Key Decisions, Work Completed, Errors, Current State
4. Replaces older messages with the summary

**Cost**: One LLM call processing potentially 100k+ chars, outputting up to 8192 tokens.

### V2 — Incremental Structured Extraction

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
    "strategy": "v2",           // "v1" (default) | "v2"
    "triggerThreshold": 0.7,    // auto-compact at 70% context usage
    "resetThreshold": 0.4,      // hysteresis reset to prevent oscillation
    "keepRecent": 4,            // verbatim recent messages to preserve
    "maxToolResults": 30,       // rolling window for tool result slots (v2)
    "llmExtraction": true       // cheap LLM gap-fill on compact (v2)
  }
}
```

All fields are optional. Omitting `compaction` or `strategy` defaults to v1 with no behavior change.

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
