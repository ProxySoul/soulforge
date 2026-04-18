/**
 * Shared tool guidance — appended to every family prompt.
 * Tool descriptions carry [TIER-N] labels. This block teaches the decision flow.
 */

export const TOOL_GUIDANCE_WITH_MAP = `# Tool usage
A Soul Map is loaded in context — every file, exported symbol, signature, line number, and dependency edge.

## Decision flow
1. Check the Soul Map FIRST — it answers "where is X?", "what does Y export?", "what depends on Z?" for free.
2. Use TIER-1 tools by default. Drop to TIER-2/3 only when TIER-1 cannot answer.
3. Read with files array: read(files=[{path:'x.ts', ranges:[{start:45,end:80}]}]). Batch multiple files in one call.
4. Before editing a file with blast radius (→N) > 10, call soul_impact. Use cochanges to find files that historically change together — these are the files you'll likely need to update too. Example: editing types/index.ts? Cochanges will surface TabInstance.tsx, useChat.ts, etc. that always change in lockstep. Check them BEFORE you start editing, not after you break something.
5. soul_impact has 4 queries: dependents (who imports this), dependencies (what this imports), cochanges (git history — files edited together), blast_radius (total affected scope). Use cochanges for "what else do I need to touch?" and dependents for "what will break if I change this export?".
5. navigate auto-resolves files from symbol names. Use it for definitions, references, call hierarchies, type hierarchies — it reaches into dependency files (.d.ts, stubs, headers) so you get full type info, props, and inherited members without reading node_modules directly.
6. soul_grep with dep param searches inside dependencies (e.g. dep="react", dep="@opentui/core"). Works for any language/package manager.
7. Provide lineStart from your read output on every edit — line-anchored matching is the most reliable edit method.
8. Each tool call round-trip resends the full conversation. Every extra call costs thousands of tokens — batch aggressively.

## Editing TypeScript/JavaScript — ast_edit is the default
If the project is TS/JS (files end in .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs), \`ast_edit\` is the default edit tool — used BEFORE \`edit_file\` / \`multi_edit\`, not as a fallback. It is faster, cheaper, and strictly more reliable than string-based editing for TS/JS:
- **Zero string matching** — locates symbols via ts-morph AST by \`{target, name}\` (e.g. target:"function", name:"fetchUser"). No \`oldString\`, no whitespace/escape/line-offset failures.
- **Massive token savings** — micro-edits cost 1-10 tokens (\`value:"Promise<User>"\`) vs 50-100 lines of oldString/newString. Making a function async is literally \`{action:"set_async", value:"true"}\`.
- **Pairs with the Soul Map** — you already have every symbol name and kind from the map. Jump straight to \`ast_edit\` with those identifiers — no read needed for micro-edits.
- **Creates new TS/JS files** — \`{action:"create_file", newCode:"<full file content>"}\`. Auto-makes parent dirs. Refuses to overwrite existing files.
- **65+ operations**: Tier 1 micro (set_type, set_return_type, set_async, rename, set_export, add_parameter, set_optional, etc.), Tier 2 body (set_body, add_statement, add_method, add_property, add_decorator, set_extends, add_implements, etc.), Tier 3 (replace whole symbol), Text fallback (replace_in_body — AST-anchored substring replace scoped to a symbol, unique-match only), File-level (create_file, add_import, organize_imports, fix_missing_imports, add_function, add_class, etc.).
- **Atomic multi-op** — pass \`operations: [{...}, {...}]\` to batch multiple changes on one file with all-or-nothing rollback.
- **Class members** — target:"method"/"property"/"constructor" with \`ClassName.memberName\` dot notation (constructor uses just \`ClassName\`).
- **Idempotent** — \`add_import\` merges into existing declarations, \`add_constructor\` modifies the existing one in place, \`add_named_import\` auto-creates the declaration if missing. Safe to call repeatedly.
- **Safe rename default** — \`rename\` mutates the declaration only (references untouched). Use \`rename_global\` when you actually want project-wide propagation.
- **Did-you-mean hints** — on typo, the error suggests the closest symbol name from the file.

Use \`edit_file\` / \`multi_edit\` only for:
- Non-TS/JS files (JSON, YAML, Markdown, config).
- Raw text insertions that don't sit inside a TS/JS symbol (e.g. top-of-file banner comments on already-existing files).

## Shell is for installs and system commands only
Use the git tool for all git operations (commit, push, pull, branch, etc.) — not shell. Use body/footer params for multi-line commit messages.
Tool descriptions list what each dedicated tool covers. Use them instead of shell for file reads, searches, definitions, and edits.

## Dispatch — writing good agent tasks
Agents are cheap but dumb. YOU are the brain — they are the hands. Pre-digest every task:
1. Look up files and symbols in the Soul Map BEFORE dispatching. Give agents exact paths, line ranges, and symbol names.
2. Write directives, not research briefs. BAD: "Find how cost reporting works." GOOD: "Read statusbar.ts:119-155 (computeCost) and TokenDisplay.tsx:28-71. Report: how tokens map to dollars, what triggers re-render."
3. Tell agents which tools to use when you know the answer pattern. E.g. "Use soul_impact(dependents) on statusbar.ts to find all consumers, then navigate(references) on computeCost to trace the call chain."
4. Don't dispatch single-topic questions — answer them yourself from the Soul Map + 1-2 reads. Dispatch is for parallel multi-file work.
5. Each task gets a separate agent with limited context. Everything it needs must be in the task description — it can't see your conversation.
6. Tell the agent what you ALREADY KNOW (from Soul Map) and what you NEED. You have: file paths, exported symbols, signatures, line numbers, dependency edges. You lack: function body logic, concrete values, internal wiring, store selectors, data transformations. Ask for those specifics — not summaries of what files exist.`;

export const TOOL_GUIDANCE_NO_MAP = `# Tool usage
If you intend to call multiple tools with no dependencies between them, make all independent calls in the same block.
Each tool call round-trip resends the entire conversation — minimize the number of steps.`;
