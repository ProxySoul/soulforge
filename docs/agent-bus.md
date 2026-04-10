# Agent Bus — Parallel Coordination

The AgentBus coordinates multiple AI agents running in parallel: shared file reads, shared tool results, edit coordination, and real-time peer findings.

## Spark vs Ember

Subagents are classified into two tiers:

- **⚡ Spark** (explore/investigate): shares the forge's cache for efficiency. Read-only. Uses `taskRouter.spark` model.
- **🔥 Ember** (code): own model and context. Full edit capabilities. Uses `taskRouter.ember` model.

## How it works

- **File cache** — first agent to read a file caches it. Other agents get the cached content. Edits invalidate the cache.
- **Tool result cache** — read-only tool results are cached across agents and dispatches within the same session.
- **Edit coordination** — concurrent edits to the same file are serialized. First editor owns the file; second gets a warning.
- **Findings** — agents share discoveries in real-time. One agent's finding influences the next agent within a step or two.

## Dispatch flow

1. Warm cache from previous dispatch if available
2. Classify tasks → spark or ember, select models from task router
3. Spawn agents with staggered starts
4. Agents run independently with shared cache access
5. Wait for completion (or timeout)
6. Optional post-dispatch: de-sloppify pass, verify pass
7. Aggregate results, compress, return to Forge

Single-task dispatches skip coordination overhead.
