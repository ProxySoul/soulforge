import type { ModelMessage } from "ai";
import type { ContextManager } from "../../core/context/manager.js";

export function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PATH_ARG_KEYS = new Set([
  "file",
  "path",
  "filePath",
  "file_path",
  "target_file",
  "source_file",
  "target",
]);

export function reprimeContextFromMessages(cm: ContextManager, msgs: ModelMessage[]): void {
  try {
    for (const msg of msgs) {
      if (typeof msg.content === "string") {
        extractPathsFromText(msg.content, cm);
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (typeof part !== "object" || part === null) continue;
        const typed = part as { type?: string; text?: string; args?: Record<string, unknown> };
        if (typed.type === "tool-call" && typed.args && typeof typed.args === "object") {
          for (const [key, val] of Object.entries(typed.args)) {
            if (PATH_ARG_KEYS.has(key) && typeof val === "string" && val.length > 0) {
              cm.trackMentionedFile(val);
            }
            if (key === "files" && Array.isArray(val)) {
              for (const f of val) {
                if (typeof f === "string") cm.trackMentionedFile(f);
              }
            }
          }
        } else if ("text" in typed && typeof typed.text === "string") {
          extractPathsFromText(typed.text, cm);
        }
      }
    }
  } catch {
    // Best-effort — partial priming is better than crashing compaction/restore
  }
}

export const BACKTICK_PATH_RE = /`([^`\s]+)`/g;

export function extractPathsFromText(text: string, cm: ContextManager): void {
  if (text.length > 500_000) return;
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    if (match[1] && looksLikeFilePath(match[1])) {
      cm.trackMentionedFile(match[1]);
    }
  }
}

export function looksLikeFilePath(s: string): boolean {
  if (s.length < 3 || s.length > 300) return false;
  if (/[<>{}[\]|&;$!()@#=+]/.test(s)) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  if (/\s/.test(s)) return false;
  if (!s.includes("/")) return false;
  const lastDot = s.lastIndexOf(".");
  if (lastDot < 0) return false;
  const ext = s.slice(lastDot + 1);
  return ext.length > 0 && ext.length <= 10 && /^[a-zA-Z0-9]+$/.test(ext);
}
