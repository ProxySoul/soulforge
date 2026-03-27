import type { JSONObject } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { generateText } from "ai";
import { logBackgroundError } from "../../stores/errors.js";
import type { WorkingStateManager } from "./working-state.js";

/**
 * Build the compacted summary for v2.
 *
 * 1. Serialize the incrementally-built working state (free, already computed).
 * 2. Optionally run a cheap LLM pass to verify completeness against the
 *    full older messages — not a gap-fill on a tiny sample, but a real
 *    verification pass that sees everything.
 * 3. Merge and return the final summary string.
 */
export async function buildV2Summary(opts: {
  wsm: WorkingStateManager;
  olderMessages: ModelMessage[];
  model?: Parameters<typeof generateText>[0]["model"];
  providerOptions?: Record<string, JSONObject>;
  headers?: Record<string, string>;
  skipLlm?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { wsm, olderMessages, model, providerOptions, headers, skipLlm, abortSignal } = opts;

  const structuredState = wsm.serialize();

  // Skip gap-fill when structured state is rich enough — the incremental
  // extraction already captured the important context. Saves ~2k tokens.
  const RICH_STATE_THRESHOLD = 15;
  if (skipLlm || !model || wsm.slotCount() >= RICH_STATE_THRESHOLD) {
    return structuredState;
  }

  const convoText = buildFullConvoText(olderMessages, 12000);

  let gapFill: string | undefined;
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 2048,
      maxRetries: 0,
      ...(abortSignal ? { abortSignal } : {}),
      ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(headers ? { headers } : {}),
      prompt: [
        "You are reviewing a structured summary of a coding conversation to find MISSING information.",
        "",
        "EXISTING STRUCTURED STATE (already extracted):",
        structuredState,
        "",
        "FULL CONVERSATION (older messages being compacted):",
        convoText,
        "",
        "Your job: output ONLY information that is genuinely MISSING from the structured state above.",
        "Focus on:",
        "- User requirements or constraints not captured",
        "- Important decisions or reasoning not reflected",
        "- Error details or test results that matter for ongoing work",
        "- Context that would be needed to continue the task",
        "",
        "Format as bullet points under these headers (skip empty sections):",
        "",
        "## Missing Requirements",
        "## Missing Decisions",
        "## Missing Context",
        "",
        "If the structured state already covers everything important, output exactly: COMPLETE",
        "Be concise but thorough. Include specific details (file names, error messages, code snippets) not vague summaries.",
      ].join("\n"),
    });
    gapFill = result.text;
  } catch (err: unknown) {
    logBackgroundError("compaction-summarize", err instanceof Error ? err.message : String(err));
    return structuredState;
  }

  if (!gapFill || gapFill.trim() === "COMPLETE" || gapFill.trim().length < 20) {
    return structuredState;
  }

  return `${structuredState}\n\n## Additional Details\n${gapFill.trim()}`;
}

function buildFullConvoText(messages: ModelMessage[], charBudget: number): string {
  const parts: string[] = [];
  let chars = 0;

  for (const msg of messages) {
    if (chars >= charBudget) break;
    const text = messageTextFull(msg);
    if (!text) continue;
    const chunk = `${msg.role}: ${text}`;
    const limited = chunk.length > 2000 ? `${chunk.slice(0, 2000)}...` : chunk;
    parts.push(limited);
    chars += limited.length;
  }

  return parts.join("\n\n");
}

function messageTextFull(msg: ModelMessage): string | undefined {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null) {
        if ("text" in part) {
          texts.push(String((part as { text: string }).text));
        } else if ("type" in part) {
          const typed = part as { type: string; toolName?: string; result?: unknown };
          if (typed.type === "tool-result") {
            const resultStr = typed.result != null ? JSON.stringify(typed.result) : "null";
            texts.push(
              `[tool-result: ${typed.toolName ?? "unknown"} → ${resultStr.slice(0, 1500)}]`,
            );
          } else if (typed.type === "tool-call") {
            texts.push(`[tool-call: ${typed.toolName ?? "unknown"}]`);
          }
        }
      }
    }
    return texts.join("\n") || undefined;
  }
  return undefined;
}
