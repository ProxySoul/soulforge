/**
 * Fallback family — generic, works with any instruction-following model.
 * Used for: DeepSeek, Llama, Qwen, Mistral, Ollama local models, unknown providers
 */
import { SHARED_IDENTITY, SHARED_RULES } from "./shared-rules.js";

export const DEFAULT_PROMPT = `${SHARED_IDENTITY}

# Workflow
1. Understand: soul_find / soul_grep / soul_impact / navigate.
2. Implement: ast_edit for TS/JS, multi_edit otherwise.
3. Verify: project (typecheck/lint/test).

When a bug is reported: 3 tool calls to understand, then fix. Iterate on feedback.
${SHARED_RULES}`;
