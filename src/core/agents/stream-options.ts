import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

/**
 * Sanitize tool-call inputs in messages to prevent Anthropic API rejections.
 *
 * When the model generates malformed tool call args (unparseable JSON or non-object
 * JSON like a string/array/number), the AI SDK stores the raw value as `input` and
 * marks the call `invalid: true`. On the next step, the SDK replays these tool_use
 * blocks as-is. The Anthropic API requires `tool_use.input` to be a dictionary —
 * sending a raw string or array causes:
 *   "messages.N.content.M.tool_use.input: Input should be a valid dictionary"
 *
 * This prepareStep hook ensures all tool-call inputs are plain objects.
 */
export function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  let dirty = false;
  const cleaned = messages.map((msg) => {
    if (msg.role !== "assistant" || typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let contentDirty = false;
    const content = msg.content.map((part) => {
      if (part.type !== "tool-call") return part;
      const input = part.input;
      if (typeof input === "object" && input !== null && !Array.isArray(input)) return part;
      contentDirty = true;
      return { ...part, input: {} };
    });

    if (!contentDirty) return msg;
    dirty = true;
    return { ...msg, content };
  });

  return dirty ? cleaned : messages;
}

/** prepareStep hook that sanitizes tool-call inputs. */
export function sanitizeToolInputsStep({
  messages,
}: {
  messages: ModelMessage[];
}): { messages: ModelMessage[] } | undefined {
  const cleaned = sanitizeMessages(messages);
  return cleaned !== messages ? { messages: cleaned } : undefined;
}

/**
 * Attempt to repair malformed tool call JSON from weaker models.
 *
 * Common issues:
 * - Trailing commas in objects/arrays
 * - Truncated JSON (unclosed brackets from output token limits)
 * - Unquoted property names
 *
 * Returns the repaired tool call or null if repair isn't possible.
 */
export async function repairToolCall({
  toolCall,
}: {
  toolCall: LanguageModelV3ToolCall;
}): Promise<LanguageModelV3ToolCall | null> {
  let input = toolCall.input.trim();
  if (!input) return null;

  // Fix trailing commas: {"a": 1,} → {"a": 1}
  input = input.replace(/,\s*([}\]])/g, "$1");

  // Try closing truncated JSON — track bracket stack outside of strings
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}") {
      if (stack.length > 0 && stack[stack.length - 1] === "{") stack.pop();
    }
    if (ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === "[") stack.pop();
    }
  }

  // Close any unclosed brackets (truncated output)
  if (stack.length > 0) {
    // Strip trailing partial key/value that might be mid-string
    if (inString) {
      const lastQuote = input.lastIndexOf('"');
      if (lastQuote > 0) {
        input = input.slice(0, lastQuote);
        // Remove the dangling key or value back to the last comma or bracket
        input = input.replace(/,?\s*"[^"]*$/, "");
      }
    }
    // Re-scan after trimming
    const stack2: string[] = [];
    let inStr2 = false;
    let esc2 = false;
    for (const ch of input) {
      if (esc2) {
        esc2 = false;
        continue;
      }
      if (ch === "\\") {
        esc2 = inStr2;
        continue;
      }
      if (ch === '"') {
        inStr2 = !inStr2;
        continue;
      }
      if (inStr2) continue;
      if (ch === "{" || ch === "[") stack2.push(ch);
      if (ch === "}") {
        if (stack2.length > 0 && stack2[stack2.length - 1] === "{") stack2.pop();
      }
      if (ch === "]") {
        if (stack2.length > 0 && stack2[stack2.length - 1] === "[") stack2.pop();
      }
    }
    // Fix trailing commas again after trimming
    input = input.replace(/,\s*$/, "");
    // Close remaining brackets in reverse order
    for (let i = stack2.length - 1; i >= 0; i--) {
      input += stack2[i] === "{" ? "}" : "]";
    }
  }

  // Nothing changed — repair not possible
  if (input === toolCall.input.trim()) return null;

  // Verify the result actually parses
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  return { ...toolCall, input };
}
