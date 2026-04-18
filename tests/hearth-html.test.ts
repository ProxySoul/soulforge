/**
 * Tests for the Telegram HTML formatter + tag-aware chunker.
 *
 * Covers:
 *   - escapeHtml handles &, <, > and leaves other chars alone
 *   - markdownToTelegramHtml converts fences, inline code, bold, italic, links
 *   - chunkHtml closes/reopens <pre><code> spanning a chunk boundary
 *   - TextRenderer({format:"html"}) emits parseMode "HTML" lines
 */
import { describe, expect, test } from "bun:test";
import {
  chunkHtml,
  TextRenderer,
} from "../src/hearth/adapters/render-text.js";
import {
  escapeHtml,
  markdownToTelegramHtml,
} from "../src/hearth/adapters/telegram-format.js";

describe("escapeHtml", () => {
  test("escapes the three reserved chars", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });
  test("leaves regular text untouched", () => {
    expect(escapeHtml("hello world.")).toBe("hello world.");
  });
});

describe("markdownToTelegramHtml", () => {
  test("converts ```ts fences to <pre><code class>", () => {
    const out = markdownToTelegramHtml("```typescript\nconst x = 1;\n```");
    expect(out).toBe('<pre><code class="language-typescript">const x = 1;</code></pre>');
  });

  test("converts inline code to <code>", () => {
    const out = markdownToTelegramHtml("Use `useChat.ts:42` to find it.");
    expect(out).toBe("Use <code>useChat.ts:42</code> to find it.");
  });

  test("converts bold and italic", () => {
    const out = markdownToTelegramHtml("**bold** and *italic*.");
    expect(out).toBe("<b>bold</b> and <i>italic</i>.");
  });

  test("converts markdown links to <a href>", () => {
    const out = markdownToTelegramHtml("[docs](https://example.com)");
    expect(out).toBe('<a href="https://example.com">docs</a>');
  });

  test("escapes <script> in plain text outside code", () => {
    const out = markdownToTelegramHtml("watch out for <script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("preserves angle brackets inside fences as escaped HTML", () => {
    const out = markdownToTelegramHtml("```\n<div>x</div>\n```");
    expect(out).toContain("&lt;div&gt;");
    expect(out).toMatch(/^<pre><code>/);
  });
});

describe("chunkHtml", () => {
  test("returns input unchanged when under cap", () => {
    expect(chunkHtml("hello", 100)).toEqual(["hello"]);
  });

  test("closes and reopens <pre><code> across a split", () => {
    // Build a code block longer than the cap.
    const body = "x".repeat(80);
    const html = `<pre><code class="language-ts">${body}</code></pre>`;
    const chunks = chunkHtml(html, 50);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk that opened a tag must close it.
    for (const c of chunks) {
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

describe("TextRenderer html mode", () => {
  test("renders text events as HTML with parseMode HTML", () => {
    const r = new TextRenderer({ format: "html" });
    r.renderAll({ type: "text", content: "hello " });
    r.renderAll({ type: "text", content: "**world**" });
    const out = r.flushAll();
    expect(out.length).toBe(1);
    expect(out[0]?.parseMode).toBe("HTML");
    expect(out[0]?.text).toContain("<b>world</b>");
  });

  test("plain mode keeps markdown literal", () => {
    const r = new TextRenderer({ format: "plain" });
    r.renderAll({ type: "text", content: "**world**" });
    const out = r.flushAll();
    expect(out[0]?.text).toBe("**world**");
    expect(out[0]?.parseMode).toBe("plain");
  });
});
