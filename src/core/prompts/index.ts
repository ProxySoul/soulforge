/**
 * Prompt system — modular, per-family prompts with shared sections.
 *
 * Architecture:
 * - families/  — base prompts per model family (claude, openai, google, default)
 * - shared/    — tool guidance, soul map builder
 * - modes/     — mode overlays (architect, plan, auto, etc.)
 * - builder.ts — assembles everything into a complete system prompt
 */

export type { PromptBuilderOptions } from "./builder.js";
export { buildSystemPrompt, getFamilyPrompt, getPromptForModel } from "./builder.js";
export { getModeInstructions } from "./modes/index.js";
export {
  buildDirectoryTree,
  buildSoulMapAck,
  buildSoulMapUserMessage,
  TOOL_GUIDANCE_NO_MAP,
  TOOL_GUIDANCE_WITH_MAP,
} from "./shared/index.js";
