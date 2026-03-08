import { describe, expect, it } from "bun:test";
import { createThinkingParser, type ParsedChunk } from "../src/core/thinking-parser.js";

function feedAll(deltas: string[]): ParsedChunk[] {
  const parser = createThinkingParser();
  const chunks: ParsedChunk[] = [];
  for (const d of deltas) chunks.push(...parser.feed(d));
  chunks.push(...parser.flush());
  return chunks;
}

function textContent(chunks: ParsedChunk[]): string {
  return chunks.filter((c) => c.type === "text").map((c) => c.content).join("");
}

function reasoningContent(chunks: ParsedChunk[]): string {
  return chunks.filter((c) => c.type === "reasoning-content").map((c) => c.content).join("");
}

describe("thinking-parser — basic", () => {
  it("passes through plain text", () => {
    const chunks = feedAll(["hello world"]);
    expect(textContent(chunks)).toBe("hello world");
    expect(chunks.every((c) => c.type === "text")).toBe(true);
  });

  it("extracts <thinking> block", () => {
    const chunks = feedAll(["<thinking>deep thought</thinking>answer"]);
    expect(reasoningContent(chunks)).toBe("deep thought");
    expect(textContent(chunks)).toBe("answer");
  });

  it("extracts <think> block", () => {
    const chunks = feedAll(["<think>hmm</think>result"]);
    expect(reasoningContent(chunks)).toBe("hmm");
    expect(textContent(chunks)).toBe("result");
  });

  it("extracts <reasoning> block", () => {
    const chunks = feedAll(["<reasoning>logic</reasoning>answer"]);
    expect(reasoningContent(chunks)).toBe("logic");
  });

  it("extracts <reason> block", () => {
    const chunks = feedAll(["<reason>why</reason>answer"]);
    expect(reasoningContent(chunks)).toBe("why");
  });
});

describe("thinking-parser — streaming (split across deltas)", () => {
  it("tag split across two deltas", () => {
    const chunks = feedAll(["<thin", "king>thought</thinking>done"]);
    expect(reasoningContent(chunks)).toBe("thought");
    expect(textContent(chunks)).toBe("done");
  });

  it("closing tag split across deltas", () => {
    const chunks = feedAll(["<thinking>thought</thin", "king>done"]);
    expect(reasoningContent(chunks)).toBe("thought");
    expect(textContent(chunks)).toBe("done");
  });

  it("content arrives in single-char deltas", () => {
    const input = "<thinking>ab</thinking>cd";
    const deltas = input.split("");
    const chunks = feedAll(deltas);
    expect(reasoningContent(chunks)).toBe("ab");
    expect(textContent(chunks)).toBe("cd");
  });

  it("tag split at every character boundary", () => {
    const input = "<think>x</think>y";
    for (let split = 1; split < input.length; split++) {
      const chunks = feedAll([input.slice(0, split), input.slice(split)]);
      expect(reasoningContent(chunks)).toBe("x");
      expect(textContent(chunks)).toBe("y");
    }
  });
});

describe("thinking-parser — edge cases", () => {
  it("< that is not a tag (plain text)", () => {
    const chunks = feedAll(["1 < 2 and 3 > 2"]);
    expect(textContent(chunks)).toBe("1 < 2 and 3 > 2");
  });

  it("multiple < characters without tag match", () => {
    const chunks = feedAll(["<<<< not a tag >>>>"]);
    expect(textContent(chunks)).toBe("<<<< not a tag >>>>");
  });

  it("< followed by partial but non-matching prefix", () => {
    const chunks = feedAll(["<div>hello</div>"]);
    expect(textContent(chunks)).toBe("<div>hello</div>");
  });

  it("unclosed thinking block — flush closes it", () => {
    const parser = createThinkingParser();
    const chunks: ParsedChunk[] = [];
    chunks.push(...parser.feed("<thinking>still thinking..."));
    chunks.push(...parser.flush());
    expect(reasoningContent(chunks)).toBe("still thinking...");
    const hasEnd = chunks.some((c) => c.type === "reasoning-end");
    expect(hasEnd).toBe(true);
  });

  it("empty thinking block", () => {
    const chunks = feedAll(["<thinking></thinking>done"]);
    const hasStart = chunks.some((c) => c.type === "reasoning-start");
    const hasEnd = chunks.some((c) => c.type === "reasoning-end");
    expect(hasStart).toBe(true);
    expect(hasEnd).toBe(true);
    expect(textContent(chunks)).toBe("done");
  });

  it("nested < inside thinking content", () => {
    const chunks = feedAll(["<thinking>if x < 10 then y</thinking>done"]);
    expect(reasoningContent(chunks)).toBe("if x < 10 then y");
  });

  it("thinking block with HTML-like content inside", () => {
    const chunks = feedAll(["<thinking>use <div> for layout</thinking>result"]);
    expect(reasoningContent(chunks)).toBe("use <div> for layout");
    expect(textContent(chunks)).toBe("result");
  });

  it("multiple thinking blocks", () => {
    const chunks = feedAll(["<think>a</think>b<think>c</think>d"]);
    expect(reasoningContent(chunks)).toBe("ac");
    expect(textContent(chunks)).toBe("bd");
  });

  it("empty input", () => {
    const chunks = feedAll([""]);
    expect(chunks).toEqual([]);
  });

  it("only whitespace", () => {
    const chunks = feedAll(["   "]);
    expect(textContent(chunks)).toBe("   ");
  });
});

describe("thinking-parser — hang safety", () => {
  it("1000 deltas of plain text", () => {
    const deltas = Array.from({ length: 1000 }, (_, i) => `word${i} `);
    const chunks = feedAll(deltas);
    expect(textContent(chunks).length).toBeGreaterThan(0);
  });

  it("1000 deltas of '<' characters (no tag match)", () => {
    const deltas = Array.from({ length: 1000 }, () => "<");
    const chunks = feedAll(deltas);
    expect(textContent(chunks)).toBe("<".repeat(1000));
  });

  it("rapid open/close cycles", () => {
    const deltas = Array.from({ length: 100 }, () => "<think>x</think>");
    const chunks = feedAll(deltas);
    expect(reasoningContent(chunks)).toBe("x".repeat(100));
  });

  it("very long thinking content", () => {
    const content = "a".repeat(100000);
    const chunks = feedAll([`<thinking>${content}</thinking>`]);
    expect(reasoningContent(chunks)).toBe(content);
  });

  it("partial tag at EOF (flush handles it)", () => {
    const parser = createThinkingParser();
    const chunks: ParsedChunk[] = [];
    chunks.push(...parser.feed("hello <thin"));
    chunks.push(...parser.flush());
    // "<thin" is a partial tag prefix — flush should emit it as text
    expect(textContent(chunks)).toBe("hello <thin");
  });

  it("partial close tag at EOF", () => {
    const parser = createThinkingParser();
    const chunks: ParsedChunk[] = [];
    chunks.push(...parser.feed("<thinking>content</thin"));
    chunks.push(...parser.flush());
    expect(reasoningContent(chunks)).toContain("content");
    // flush should close the reasoning block
    const hasEnd = chunks.some((c) => c.type === "reasoning-end");
    expect(hasEnd).toBe(true);
  });
});

describe("thinking-parser — missing edge cases", () => {
  it("mismatched open/close tags — <think> opened, </thinking> close", () => {
    // <think> sets activeClose to "</think>". "</thinking>" does NOT start with "</think>"
    // because char 7 is 'i' vs '>'. The close tag never matches, so flush closes the block.
    const chunks = feedAll(["<think>content</thinking>done"]);
    expect(reasoningContent(chunks)).toBe("content</thinking>done");
    expect(textContent(chunks)).toBe("");
  });

  it("nested thinking tags — <thinking><thinking>inner</thinking>after</thinking>", () => {
    const chunks = feedAll(["<thinking>outer<thinking>inner</thinking>after</thinking>done"]);
    // Parser doesn't track nesting. Inside state, <thinking> is not a close tag,
    // so "<" is emitted as reasoning-content char-by-char until close tag found.
    // First </thinking> closes the block.
    expect(reasoningContent(chunks)).toContain("inner");
    expect(reasoningContent(chunks)).toContain("outer");
    // "after</thinking>done" becomes text — </thinking> outside is just angle brackets
    const text = textContent(chunks);
    expect(text).toContain("after");
    expect(text).toContain("done");
  });

  it("tag with attributes — <thinking lang='en'> should not match", () => {
    const chunks = feedAll(["<thinking lang='en'>content</thinking>done"]);
    // tryMatchOpen checks startsWith("<thinking>") — attribute breaks the match.
    // The "<" gets emitted as text, then everything else is text too.
    // </thinking> outside doesn't match any open tag either.
    const text = textContent(chunks);
    expect(text).toContain("content");
    expect(text).toContain("done");
  });

  it("mixed tag types in sequence", () => {
    const chunks = feedAll(["<think>a</think>b<reasoning>c</reasoning>d"]);
    expect(reasoningContent(chunks)).toBe("ac");
    expect(textContent(chunks)).toBe("bd");
  });

  it("text between back-to-back thinking blocks (space separator)", () => {
    const chunks = feedAll(["<think>a</think> <think>b</think>"]);
    expect(reasoningContent(chunks)).toBe("ab");
    expect(textContent(chunks)).toBe(" ");
  });

  it("thinking block at very end with no trailing text", () => {
    const chunks = feedAll(["hello<think>thought</think>"]);
    expect(textContent(chunks)).toBe("hello");
    expect(reasoningContent(chunks)).toBe("thought");
  });

  it("only whitespace inside thinking block", () => {
    const chunks = feedAll(["<thinking>   </thinking>done"]);
    expect(reasoningContent(chunks)).toBe("   ");
    expect(textContent(chunks)).toBe("done");
  });

  it("newlines inside thinking block", () => {
    const chunks = feedAll(["<thinking>line1\nline2\nline3</thinking>done"]);
    expect(reasoningContent(chunks)).toBe("line1\nline2\nline3");
  });

  it("< inside text that partially matches tag prefix then fails", () => {
    const chunks = feedAll(["hello <thinki world"]);
    expect(textContent(chunks)).toBe("hello <thinki world");
  });

  it("closing tag without opening — </thinking> as plain text", () => {
    const chunks = feedAll(["hello</thinking>world"]);
    const text = textContent(chunks);
    expect(text).toContain("hello");
    expect(text).toContain("world");
  });

  it("unicode content inside thinking block", () => {
    const chunks = feedAll(["<think>日本語テスト 🤔</think>結果"]);
    expect(reasoningContent(chunks)).toBe("日本語テスト 🤔");
    expect(textContent(chunks)).toBe("結果");
  });

  it("very long tag-like prefix that doesn't match", () => {
    // "<thinkingaboutlife>" does NOT match "<thinking>" — char 9 is 'a' vs '>'.
    // The "<" is emitted as text, then everything else is plain text.
    const chunks = feedAll(["<thinkingaboutlife>not a tag</thinkingaboutlife>"]);
    const text = textContent(chunks);
    expect(text).toContain("<thinkingaboutlife>");
    expect(reasoningContent(chunks)).toBe("");
  });

  it("three deltas splitting mid-tag and mid-content", () => {
    const chunks = feedAll(["<thi", "nking>con", "tent</thinking>done"]);
    expect(reasoningContent(chunks)).toBe("content");
    expect(textContent(chunks)).toBe("done");
  });
});
