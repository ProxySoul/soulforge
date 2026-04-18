/**
 * Markdown → Telegram HTML converter.
 *
 * Telegram's Bot API accepts a narrow HTML subset with `parse_mode: "HTML"`:
 *   <b>, <strong>, <i>, <em>, <u>, <s>, <code>, <pre>, <a href="…">,
 *   <blockquote>, <blockquote expandable>, <tg-spoiler>.
 *
 * Nesting is limited — `<b><i>` works, but `<blockquote><pre>` misbehaves on
 * older clients. We stick to one level where practical.
 *
 * Escape burden is tiny: only `&`, `<`, `>` must be escaped in plain text.
 * Inside `<pre>` and `<code>`, those three still escape — everything else is
 * literal, which makes code blocks painless compared to MarkdownV2's 18-char
 * context-sensitive escape table.
 *
 * This is intentionally a small hand-rolled converter — we don't want the
 * weight of a full markdown parser dependency, and LLM-produced markdown hits
 * only a few common patterns (fences, inline code, bold, italic, links, bullets).
 */

/** Escape `&`, `<`, `>` — the only three reserved chars in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert LLM-produced markdown to Telegram's HTML subset. */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return "";

  // 1. Fenced code blocks (```lang\n…\n```). Extract first so the contents
  //    survive the inline passes below.
  const fences: string[] = [];
  let work = md.replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_m, lang: string, body: string) => {
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const trimmed = body.replace(/\n$/, "");
      const token = `__FENCE_${fences.length}__`;
      fences.push(`<pre><code${cls}>${escapeHtml(trimmed)}</code></pre>`);
      return token;
    },
  );

  // 2. Inline code — backticks. Same placeholder trick to survive escaping.
  const inlines: string[] = [];
  work = work.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const token = `__ICODE_${inlines.length}__`;
    inlines.push(`<code>${escapeHtml(body)}</code>`);
    return token;
  });

  // 3. Escape everything else.
  work = escapeHtml(work);

  // 4. Links [text](url). url is escaped above → decode back for the href.
  work = work.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    const decoded = href.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return `<a href="${escapeHtml(decoded)}">${text}</a>`;
  });

  // 5. Bold **x** and __x__ (avoid matching across newlines — breaks paragraphs).
  work = work.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<b>$1</b>");
  work = work.replace(/__([^_\n][^_]*?)__/g, "<b>$1</b>");

  // 6. Italic *x* and _x_ (single-star/underscore, avoid list markers).
  work = work.replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, "$1<i>$2</i>");
  work = work.replace(/(^|[^_])_([^_\s][^_\n]*?)_(?!_)/g, "$1<i>$2</i>");

  // 7. Bullet markers — convert "- item" and "* item" to "• item" so they
  //    look right on mobile. Telegram HTML has no native list tag.
  work = work.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // 8. Re-inject placeholders.
  work = work.replace(/__ICODE_(\d+)__/g, (_m, i: string) => inlines[Number(i)] ?? "");
  work = work.replace(/__FENCE_(\d+)__/g, (_m, i: string) => fences[Number(i)] ?? "");

  return work;
}

/** Wrap a long piece of content in an expandable blockquote — ideal for tool dumps. */
export function expandableBlockquote(content: string): string {
  return `<blockquote expandable>${escapeHtml(content)}</blockquote>`;
}
