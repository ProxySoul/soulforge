/**
 * Shared tool guidance — appended to every family prompt.
 * Dramatically simplified from the old tier system.
 * Detailed behavior lives in individual tool descriptions, not here.
 */

export const TOOL_GUIDANCE_WITH_MAP = `# Tool usage
A Soul Map of the codebase is loaded in context — it lists every file, exported symbol, signature, and dependency. Consult it before any tool call.

Tool priority — use the cheapest tool that answers your question:
1. **Soul Map** (already in context, zero cost) — answers "where is X", "what does Y export", "what depends on Z"
2. **LSP tools** (instant, no file I/O) — navigate for definitions/references/callers, analyze for types/diagnostics/outlines
3. **Soul tools** (indexed, fast) — soul_find for files/symbols, soul_grep for pattern counts, soul_impact for dependencies, soul_analyze for profiles
4. **Targeted reads** — read_file with target+name to extract one symbol
5. **Broad reads** — read_file full, grep for string literals, web_search for external docs
6. **Expensive** — project tool (typecheck/lint/test/build — auto-detects toolchain), shell, dispatch (7+ files)

Editing: read file ONCE in full, plan all changes, multi_edit in ONE call per file.
Compound tools (rename_symbol, move_symbol, refactor) do the complete job — no verification needed after.

Dispatch: ≤6 files → edit directly. 7+ files or 4+ parallel edits → dispatch. Always search before dispatching.
After dispatch: act on results immediately — never re-read dispatched files.
Use exact Soul Map paths for targetFiles. Agents with precise targets finish in 1-2 tool calls.

Planning: edit files directly unless 7+ files involved. When planning: research → plan → user confirms → execute.`;

export const TOOL_GUIDANCE_NO_MAP = `# Tool usage
Tool priority — use the cheapest tool that answers your question:
1. **Search tools** — grep for patterns, glob for files, soul_find when available
2. **LSP tools** — navigate for definitions/references, analyze for types/diagnostics
3. **Read tools** — read_file for source and config files
4. **Expensive** — project tool (typecheck/lint/test/build — auto-detects toolchain), shell, dispatch (7+ files)

Editing: read file ONCE in full, plan all changes, multi_edit in ONE call per file.
Compound tools (rename_symbol, move_symbol, refactor) do the complete job — no verification needed after.

Dispatch: ≤6 files → edit directly. 7+ files → dispatch.`;
