/**
 * Surface-agnostic event renderer — converts HeadlessEvent into a small number
 * of cohesive messages per turn. The old line-at-a-time renderer produced one
 * Telegram send per 240-char chunk, which showed up as "chopped" messages. This
 * version buffers for the entire turn and flushes on meaningful boundaries:
 *   - tool-call (commits preceding text, emits one tool-call line)
 *   - turn-done (commits final text + summary)
 *   - explicit flush()
 *
 * Messenger surfaces cap inbound text at ~4000 chars (TG: 4096, Discord: 2000).
 * We chunk at `MAX_CHUNK_CHARS` on paragraph / sentence / hard boundaries.
 *
 * Output format:
 *   - "plain" — default, no markup. Safe for Discord / iMessage / fakechat.
 *   - "html"  — Telegram Bot API subset: <b>, <i>, <code>, <pre>, <a>,
 *     <blockquote>, <tg-spoiler>. Chunker is tag-aware: if a split falls
 *     inside a <pre><code>…</code></pre> block it closes the block cleanly
 *     and reopens it in the next chunk.
 */

import type { HeadlessEvent } from "../../headless/types.js";
import { redact } from "../redact.js";
import { escapeHtml, expandableBlockquote, markdownToTelegramHtml } from "./telegram-format.js";

export interface RenderedLine {
  text: string;
  /** When true, append to the previous bubble instead of starting a new one. */
  continuation?: boolean;
  /** Hint for surfaces that support typing/progress indicators. */
  ephemeral?: boolean;
  /** Parse mode for surfaces that support it (Telegram). */
  parseMode?: "HTML" | "MarkdownV2" | "plain";
}

/**
 * Default chunk cap. Telegram allows 4096 per message; Discord 2000. We pick
 * 3800 as a safe middle ground — the TG adapter can override via constructor.
 */
const MAX_CHUNK_CHARS = 3800;

/** Split text into <=max-char chunks, preferring paragraph/sentence boundaries. */
export function chunkText(input: string, max = MAX_CHUNK_CHARS): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= max) return [text];

  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer a paragraph break before max. Fall back to sentence, then space, then hard cut.
    const slice = rest.slice(0, max);
    let cut = slice.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = slice.lastIndexOf("\n");
    if (cut < max * 0.5) {
      const m = /[.!?](?=\s|$)[^.!?]*$/.exec(slice);
      if (m && m.index > max * 0.5) cut = m.index + 1;
    }
    if (cut < max * 0.5) cut = slice.lastIndexOf(" ");
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Tag-aware chunker for HTML output. Closes any open `<pre>`/`<code>` at the
 * chunk boundary and reopens it in the next chunk so Telegram doesn't reject
 * half-open tags. Only `<pre>` and `<code>` are tracked — `<b>`/`<i>` nested
 * across a split are unusual enough to accept the rare formatting glitch.
 */
export function chunkHtml(input: string, max = MAX_CHUNK_CHARS): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= max) return [text];

  // First pass: use plain-text chunker on the raw stream; then re-close any
  // <pre>/<code> tags that were left open at each boundary and reopen on the
  // next chunk. We only recognise the exact forms `<pre><code class="…">` and
  // `<code>` that our markdown→HTML emits, so this stays deterministic.
  const rough = chunkText(text, max);
  if (rough.length <= 1) return rough;

  const out: string[] = [];
  let reopen = "";
  for (let i = 0; i < rough.length; i++) {
    let chunk = (reopen + (rough[i] ?? "")).trim();
    reopen = "";

    // Detect unclosed <pre> / <code> in this chunk
    const preOpens = (chunk.match(/<pre(\s[^>]*)?>/g) ?? []).length;
    const preCloses = (chunk.match(/<\/pre>/g) ?? []).length;
    const codeOpens = (chunk.match(/<code(\s[^>]*)?>/g) ?? []).length;
    const codeCloses = (chunk.match(/<\/code>/g) ?? []).length;

    const pending: string[] = [];
    if (codeOpens > codeCloses) {
      // Find the last opening <code …> tag so we can reopen it verbatim.
      const m = [...chunk.matchAll(/<code(\s[^>]*)?>/g)].pop();
      pending.push(m?.[0] ?? "<code>");
      chunk += "</code>";
    }
    if (preOpens > preCloses) {
      pending.unshift("<pre>");
      chunk += "</pre>";
    }
    out.push(chunk);
    if (i < rough.length - 1) reopen = pending.join("");
  }
  return out;
}

export interface TextRendererOptions {
  /** Override chunk cap — Discord uses ~2000, TG ~4000. */
  maxChunkChars?: number;
  /** Include tool-call markers between text blocks. Default true. */
  showToolCalls?: boolean;
  /** Include the summary line on turn-done. Default true. */
  showTurnSummary?: boolean;
  /** Output format. "plain" (default) emits no markup; "html" emits Telegram HTML. */
  format?: "plain" | "html";
}

/**
 * Turn-buffered renderer. Feed every HeadlessEvent; collect the returned
 * RenderedLine[] (may be empty) and send each as a separate message.
 *
 * Flush semantics:
 *   - text events append to an in-memory buffer; never emit mid-stream.
 *   - tool-call flushes buffered text as message(s), then emits the tool line.
 *   - turn-done flushes remaining text, then the summary.
 *   - errors / warnings flush first so they stay in order.
 */
export class TextRenderer {
  private textBuffer = "";
  private readonly maxChunkChars: number;
  private readonly showToolCalls: boolean;
  private readonly showTurnSummary: boolean;
  private readonly format: "plain" | "html";

  constructor(opts: TextRendererOptions = {}) {
    this.maxChunkChars = opts.maxChunkChars ?? MAX_CHUNK_CHARS;
    this.showToolCalls = opts.showToolCalls ?? true;
    this.showTurnSummary = opts.showTurnSummary ?? true;
    this.format = opts.format ?? "plain";
  }

  /** Feed one event. Returns zero or more lines to send. */
  renderAll(event: HeadlessEvent): RenderedLine[] {
    const html = this.format === "html";
    const asLine = (text: string, extra: Partial<RenderedLine> = {}): RenderedLine => ({
      text,
      parseMode: html ? "HTML" : "plain",
      ...extra,
    });
    switch (event.type) {
      case "start":
        return [
          asLine(
            html
              ? `🔥 <b>${escapeHtml(event.model)}</b> · <i>${escapeHtml(event.mode)}</i>${
                  event.repoMap ? ` · ${String(event.repoMap.files)} files` : ""
                }`
              : `🔥 ${event.model} · ${event.mode}${
                  event.repoMap ? ` · ${String(event.repoMap.files)} files` : ""
                }`,
            { ephemeral: true },
          ),
        ];
      case "ready":
        return [];
      case "text":
        this.textBuffer += event.content;
        return [];
      case "tool-call": {
        if (!this.showToolCalls) return this.flushBuffered();
        const out = this.flushBuffered();
        const tool = html ? `<b>${escapeHtml(event.tool)}</b>` : event.tool;
        out.push(asLine(`▸ ${tool}`, { ephemeral: true }));
        return out;
      }
      case "tool-result":
        return [];
      case "step":
        return [];
      case "reasoning": {
        const out = this.flushBuffered();
        const body = redact(event.content.trim());
        if (!body) return out;
        if (html) {
          out.push(asLine(expandableBlockquote(body), { ephemeral: true }));
        } else {
          out.push(
            asLine(`💭 ${body.slice(0, 300)}${body.length > 300 ? "…" : ""}`, { ephemeral: true }),
          );
        }
        return out;
      }
      case "warning": {
        const out = this.flushBuffered();
        const body = redact(event.message);
        out.push(asLine(html ? `⚠ ${escapeHtml(body)}` : `⚠ ${body}`));
        return out;
      }
      case "error": {
        const out = this.flushBuffered();
        const body = redact(event.error);
        out.push(asLine(html ? `✗ <i>${escapeHtml(body)}</i>` : `✗ ${body}`));
        return out;
      }
      case "turn-done": {
        const out = this.flushBuffered();
        if (this.showTurnSummary) {
          const totalTokens = event.tokens.input + event.tokens.output;
          const summary = `✓ ${String(event.steps)} step${event.steps === 1 ? "" : "s"} · ${String(totalTokens)} tokens`;
          out.push(asLine(html ? `<i>${escapeHtml(summary)}</i>` : summary, { ephemeral: true }));
        }
        return out;
      }
      case "chat-done":
        return [asLine(`· chat ended · ${String(event.turns)} turns`)];
      case "session-saved":
        return [asLine(`· session ${event.sessionId.slice(0, 8)} saved`, { ephemeral: true })];
      default:
        return [];
    }
  }

  /**
   * Legacy single-line API — returns the FIRST line and silently drops the rest.
   * Kept for adapters that haven't migrated to renderAll() yet.
   * New callers should use renderAll().
   */
  render(event: HeadlessEvent): RenderedLine | null {
    const all = this.renderAll(event);
    return all[0] ?? null;
  }

  /** Force-flush any buffered text. Adapter calls this on disconnect / timeout. */
  flush(): RenderedLine | null {
    const lines = this.flushBuffered();
    return lines[0] ?? null;
  }

  /** Same as flush() but returns all chunks (for the new renderAll path). */
  flushAll(): RenderedLine[] {
    return this.flushBuffered();
  }

  private flushBuffered(): RenderedLine[] {
    if (!this.textBuffer.trim()) {
      this.textBuffer = "";
      return [];
    }
    const raw = redact(this.textBuffer);
    this.textBuffer = "";
    if (this.format === "html") {
      const html = markdownToTelegramHtml(raw);
      return chunkHtml(html, this.maxChunkChars).map((chunk) => ({
        text: chunk,
        continuation: true,
        parseMode: "HTML" as const,
      }));
    }
    return chunkText(raw, this.maxChunkChars).map((chunk) => ({
      text: chunk,
      continuation: true,
      parseMode: "plain" as const,
    }));
  }
}
