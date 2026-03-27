/**
 * Shared tool guidance — appended to every family prompt.
 * Dramatically simplified from the old tier system.
 * Detailed behavior lives in individual tool descriptions, not here.
 */

export const TOOL_GUIDANCE_WITH_MAP = `# Tool usage
A Soul Map of the codebase is loaded in context — it lists every file, exported symbol, signature, and dependency. Consult it before any tool call.
If you intend to call multiple tools with no dependencies between them, make all independent calls in the same block.
Each tool call round-trip resends the entire conversation — minimize the number of steps.`;

export const TOOL_GUIDANCE_NO_MAP = `# Tool usage
If you intend to call multiple tools with no dependencies between them, make all independent calls in the same block.
Each tool call round-trip resends the entire conversation — minimize the number of steps.`;
