# Context Compaction

SoulForge supports two compaction strategies for managing long conversations. When context usage exceeds a threshold, older messages are compacted to free space while preserving critical information.

## Strategies

### V1 — LLM Batch Summarization

The original approach. When compaction triggers:

1. Splits messages: last N kept verbatim, everything older goes to the summarizer
2. Formats older messages for the summarizer
3. Sends to an LLM with a structured prompt requesting: Environment, Files Touched, Tool Results, Key Decisions, Work Completed, Errors, Current State
4. Replaces older messages with the summary

**Cost**: One LLM call processing the older messages.

### V2 — Incremental Structured Extraction (default)

Extracts structured state **as the conversation happens**, not in a batch at compaction time.

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
2. Optionally runs a cheap LLM **gap-fill** pass that only outputs what's missing
3. Same message replacement as V1

**Cost**: Rule-based extraction during conversation (free). If the extracted state is rich enough, the LLM gap-fill is skipped entirely — zero API calls.

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

All fields are optional. Omitting `compaction` or `strategy` defaults to V2.

### Live toggle

Use `/compact settings` to switch strategies. The change takes effect immediately — switching to V2 starts extraction on the next message, switching to V1 drops the working state.

### Dedicated model via task router

Both strategies use the task router's `compact` slot:

```jsonc
{
  "taskRouter": {
    "compact": "google/gemini-2.0-flash"
  }
}
```

Falls back to `taskRouter.default`, then the active model.

## Visual Indicators

- Context bar shows compaction strategy and slot count when V2 is active
- Compacting spinner during active compaction
- System message reports strategy used and before/after context percentages

### MemPalace integration

When a [MemPalace](https://github.com/milla-jovovich/mempalace) MCP server is connected, compaction V2 automatically persists the working state to the palace before resetting — decisions, discoveries, and failures become searchable across sessions at zero extra cost.

Setup: add `mempalace` as an [MCP server](mcp.md). See [examples/soulforge_setup.md](https://github.com/milla-jovovich/mempalace/blob/main/examples/soulforge_setup.md) in the MemPalace repo for the full guide.
