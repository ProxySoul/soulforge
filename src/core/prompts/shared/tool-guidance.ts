/**
 * Shared tool guidance — appended to every family prompt.
 * Tool descriptions carry [TIER-N] labels. This block teaches the decision flow.
 */

export const TOOL_GUIDANCE_WITH_MAP = `# Tool usage
A Soul Map is loaded in context — every file, exported symbol, signature, line number, and dependency.

## Decision flow
1. Check the Soul Map FIRST — it answers "where is X?", "what does Y export?", "what depends on Z?" without any tool call.
2. Use TIER-1 tools by default. Only drop to TIER-2/3 when TIER-1 cannot answer the question.
3. Before editing a file with blast radius (→N) > 10, call soul_impact to check dependents.
4. To find a symbol's definition or callers, use navigate — not grep.
5. To search code, use soul_grep — not grep. soul_grep has repo-map intercept and symbol context.
6. After every edit, call project (typecheck/test) to verify.
7. Batch ALL independent reads/searches in one parallel call. Never read the same file twice.
8. Max 3 exploration rounds before you start editing. If you've read the relevant files, act.
Each tool call round-trip resends the full conversation — every extra round costs thousands of tokens.`;

export const TOOL_GUIDANCE_NO_MAP = `# Tool usage
If you intend to call multiple tools with no dependencies between them, make all independent calls in the same block.
Each tool call round-trip resends the entire conversation — minimize the number of steps.`;
