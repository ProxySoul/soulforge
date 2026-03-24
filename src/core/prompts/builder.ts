/**
 * PromptBuilder — assembles system prompts from modular sections.
 *
 * Architecture:
 * 1. Base prompt selected by model family (claude, openai, google, default)
 * 2. Shared tool guidance appended (with/without Soul Map variant)
 * 3. Dynamic project context appended (cwd, toolchain, instructions, git, memory, etc.)
 * 4. Mode overlay appended if active
 *
 * Cache strategy:
 * - The system prompt string returned here is marked with EPHEMERAL_CACHE in forge.ts
 * - Soul Map is injected as a separate user→assistant message pair (aider pattern)
 *   so it can update after edits without invalidating the cached system prompt
 * - Skills are injected as a separate message pair (same pattern)
 */

import type { ForgeMode } from "../../types/index.js";
import { detectModelFamily } from "../llm/provider-options.js";
import { CLAUDE_PROMPT, DEFAULT_PROMPT, GOOGLE_PROMPT, OPENAI_PROMPT } from "./families/index.js";
import { getModeInstructions } from "./modes/index.js";
import { TOOL_GUIDANCE_NO_MAP, TOOL_GUIDANCE_WITH_MAP } from "./shared/index.js";

export type { ModelFamily } from "../llm/provider-options.js";

const FAMILY_PROMPTS: Record<string, string> = {
  claude: CLAUDE_PROMPT,
  openai: OPENAI_PROMPT,
  google: GOOGLE_PROMPT,
  other: DEFAULT_PROMPT,
};

/** Get the base prompt for a model family. */
export function getFamilyPrompt(family: string): string {
  return FAMILY_PROMPTS[family] ?? DEFAULT_PROMPT;
}

/** Get the base prompt for a model ID. */
export function getPromptForModel(modelId: string): string {
  const family = detectModelFamily(modelId);
  return getFamilyPrompt(family);
}

export interface PromptBuilderOptions {
  modelId: string;
  cwd: string;
  hasRepoMap: boolean;
  hasSymbols: boolean;
  forgeMode: ForgeMode;
  contextPercent: number;
  isMinimalContext: boolean;

  // Dynamic sections (null = omit)
  projectInfo: string | null;
  projectInstructions: string | null;
  forbiddenContext: string | null;
  editorSection: string[];
  gitContext: string | null;
  memoryContext: string | null;
}

/**
 * Build the complete system prompt.
 *
 * Returns a single string. The caller (forge.ts) wraps it in a system message
 * with EPHEMERAL_CACHE for Anthropic prompt caching.
 *
 * The Soul Map is NOT included here — it's injected as a separate user message
 * in prepareStep (aider pattern: user message = context, system = instructions).
 */
export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  const family = detectModelFamily(opts.modelId);
  const parts: string[] = [];

  // ── STATIC SECTION (stable across steps → cached) ──

  // 1. Family-specific base prompt
  parts.push(getFamilyPrompt(family));

  // 2. Tool guidance (only for non-minimal context windows)
  if (!opts.isMinimalContext) {
    if (opts.hasRepoMap) {
      parts.push(TOOL_GUIDANCE_WITH_MAP);

      if (!opts.hasSymbols) {
        parts.push(
          "Code intelligence limited: No symbols indexed. Intelligence tools fall back to regex.",
        );
      }
    } else {
      parts.push(TOOL_GUIDANCE_NO_MAP);
    }
  }

  // ── DYNAMIC SECTION (changes per project/session) ──

  // 3. Project context
  parts.push(`Project cwd: ${opts.cwd}`);
  if (opts.projectInfo) parts.push(opts.projectInfo);
  if (opts.projectInstructions) parts.push(opts.projectInstructions);

  // 4. Forbidden files
  if (opts.forbiddenContext) parts.push("", opts.forbiddenContext);

  // 5. Editor context
  if (opts.editorSection.length > 0) parts.push("", ...opts.editorSection);

  // 6. Git context
  if (opts.gitContext) parts.push(`Git: ${opts.gitContext}`);

  // 7. Memory
  if (opts.memoryContext) parts.push(`Memory: ${opts.memoryContext}`);

  // 8. Mode overlay
  const modeInstructions = getModeInstructions(opts.forgeMode, {
    contextPercent: opts.contextPercent,
  });
  if (modeInstructions) parts.push(`Mode: ${modeInstructions}`);

  // 9. Skills reference (skills are injected as message pairs, not here)
  parts.push(
    "Skills may be loaded as context at the start of the conversation. Use skills(action: search) to find new ones, or Ctrl+S to browse.",
  );

  return parts.filter(Boolean).join("\n");
}
