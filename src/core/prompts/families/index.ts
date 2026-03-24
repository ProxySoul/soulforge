/**
 * Family-specific base prompts.
 *
 * To add a new family:
 * 1. Create a new file here (e.g., `deepseek.ts`) exporting a prompt string
 * 2. Import it in ../builder.ts and add to FAMILY_PROMPTS
 * 3. Add the detection case in ../../llm/provider-options.ts detectModelFamily()
 */
export { CLAUDE_PROMPT } from "./claude.js";
export { DEFAULT_PROMPT } from "./default.js";
export { GOOGLE_PROMPT } from "./google.js";
export { OPENAI_PROMPT } from "./openai.js";
export { SHARED_RULES } from "./shared-rules.js";
