import type { JSONObject } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { generateText } from "ai";
import type { WorkingStateManager } from "./working-state.js";

/**
 * Build the compacted summary for v2.
 *
 * 1. Serialize the incrementally-built working state (free, already computed).
 * 2. Optionally run a cheap LLM pass to extract anything the rule-based
 *    extractor might have missed from the older messages.
 * 3. Merge and return the final summary string.
 *
 * The LLM pass is a small "gap-fill" — NOT a full conversation summarization.
 * It receives the existing structured state + the raw older messages and only
 * outputs what's missing. This is ~10x cheaper than v1's full summarization.
 */
export async function buildV2Summary(opts: {
  wsm: WorkingStateManager;
  olderMessages: ModelMessage[];
  model?: Parameters<typeof generateText>[0]["model"];
  providerOptions?: Record<string, JSONObject>;
  headers?: Record<string, string>;
  skipLlm?: boolean;
}): Promise<string> {
  const { wsm, olderMessages, model, providerOptions, headers, skipLlm } = opts;

  const structuredState = wsm.serialize();

  if (skipLlm || !model) {
    return structuredState;
  }

  const convoSample = buildConvoSample(olderMessages, 4000);

  const { text: gapFill } = await generateText({
    model,
    maxOutputTokens: 2048,
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(headers ? { headers } : {}),
    prompt: [
      "You are reviewing a structured summary of a coding conversation to find MISSING information.",
      "",
      "EXISTING STRUCTURED STATE (already extracted):",
      structuredState,
      "",
      "RAW CONVERSATION SAMPLE (older messages):",
      convoSample,
      "",
      "Your job: output ONLY information that is MISSING from the structured state above.",
      "Format as bullet points under these headers (skip empty sections):",
      "",
      "## Missing Decisions",
      "## Missing Discoveries",
      "## Missing Context",
      "",
      "If the structured state already covers everything important, output exactly: COMPLETE",
      "Be very concise. Only add genuinely missing context — don't repeat what's already captured.",
    ].join("\n"),
  });

  if (!gapFill || gapFill.trim() === "COMPLETE" || gapFill.trim().length < 20) {
    return structuredState;
  }

  return `${structuredState}\n\n## Additional Context (gap-fill)\n${gapFill.trim()}`;
}

function buildConvoSample(messages: ModelMessage[], charBudget: number): string {
  const parts: string[] = [];
  let chars = 0;

  for (let i = messages.length - 1; i >= 0 && chars < charBudget; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const text = messageTextBrief(msg);
    if (!text) continue;
    const chunk = `${msg.role}: ${text.slice(0, 1000)}`;
    parts.unshift(chunk);
    chars += chunk.length;
  }

  return parts.join("\n\n");
}

function messageTextBrief(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null && "text" in part) {
        texts.push(String((part as { text: string }).text));
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}
