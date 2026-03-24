/**
 * Shared rules appended to every family prompt.
 * Keeps family-specific files focused on tone/style differences only.
 *
 * To add a new family:
 * 1. Create a new file in families/ exporting a PROMPT string (identity + tone + style)
 * 2. Import it in builder.ts and add to FAMILY_PROMPTS
 * 3. Add the family detection case in provider-options.ts detectModelFamily()
 */

export const SHARED_RULES = `
# Tool usage policy
- When searching for keywords or files and not confident of finding the right match quickly, use the Task tool
- If you intend to call multiple tools with no dependencies between them, make all independent calls in the same block
- The user does not see full tool output — summarize results when relevant to your response

# Conventions
- Mimic existing code style, imports, and patterns. Check neighboring files before creating new ones.
- Never assume a library is available — check imports and package files first.
- Do not add comments unless the code is complex and requires context.
- Follow security best practices. Never introduce code that exposes secrets.

NEVER commit changes unless the user explicitly asks you to.`;
