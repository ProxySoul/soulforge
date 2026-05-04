import { describe, expect, test } from "bun:test";
import { createThinkingParser } from "../src/core/thinking-parser.js";

/**
 * Locks issue #64 fix: when a model emits many <thinking>...</thinking>
 * blocks in a single stream, the consumer (useChat handleSubmit) MUST
 * coalesce consecutive reasoning blocks into one segment. Without this,
 * segment arrays grow unbounded over a long autonomous loop and cause
 * O(N²) work in flushStreamState.
 *
 * This test replays the consumer's coalescing rule against the parser
 * output. Mirror of the production rule: if the last segment is an open
 * reasoning block, reuse it.
 */

type Segment =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string; done: boolean };

function applyConsumer(deltas: string[]): Segment[] {
  const parser = createThinkingParser();
  const segments: Segment[] = [];

  const pushReasoning = () => {
    const last = segments[segments.length - 1];
    if (last?.type === "reasoning" && !last.done) return;
    segments.push({ type: "reasoning", content: "", done: false });
  };
  const appendReasoning = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "reasoning") last.content += text;
  };
  const markDone = () => {
    const last = segments[segments.length - 1];
    if (last?.type === "reasoning") last.done = true;
  };
  const appendText = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") {
      last.content += text;
    } else {
      segments.push({ type: "text", content: text });
    }
  };

  for (const d of deltas) {
    for (const chunk of parser.feed(d)) {
      if (chunk.type === "text") appendText(chunk.content);
      else if (chunk.type === "reasoning-start") pushReasoning();
      else if (chunk.type === "reasoning-content") appendReasoning(chunk.content);
      else if (chunk.type === "reasoning-end") markDone();
    }
  }

  return segments;
}

describe("issue #64 — reasoning segment coalescing", () => {
  test("100 consecutive <think> blocks collapse to <= 100 segments (one per closed block)", () => {
    const deltas: string[] = [];
    for (let i = 0; i < 100; i++) {
      deltas.push(`<think>step ${String(i)}</think>`);
    }
    const segs = applyConsumer(deltas);
    // Each block opens and closes — the coalescing rule still creates a new
    // segment AFTER one is marked done. So 100 closed blocks = 100 segments.
    // The crucial invariant: NO segment is empty + open at the end.
    expect(segs.length).toBe(100);
    for (const s of segs) {
      expect(s.type).toBe("reasoning");
      if (s.type === "reasoning") {
        expect(s.done).toBe(true);
        expect(s.content.length).toBeGreaterThan(0);
      }
    }
  });

  test("reopened <think> after only-empty parser events does NOT push duplicate empty segment", () => {
    // Models sometimes emit <think></think><think>real content</think>.
    // The first pair must not leave an empty open segment around.
    const segs = applyConsumer(["<think>", "</think>", "<think>real content</think>"]);
    // Because the first pair closes (done=true), the second pair correctly
    // opens a new segment. Coalescing only applies to OPEN consecutive blocks.
    expect(segs.length).toBe(2);
    if (segs[1]?.type === "reasoning") {
      expect(segs[1].content).toBe("real content");
    }
  });

  test("text between thinking blocks creates separate segments", () => {
    const segs = applyConsumer([
      "<think>plan</think>",
      "answer",
      "<think>refine</think>",
      "more answer",
    ]);
    expect(segs.map((s) => s.type)).toEqual(["reasoning", "text", "reasoning", "text"]);
  });

  test("partial open tag split across deltas", () => {
    const segs = applyConsumer(["<thi", "nking>partial</thinking>"]);
    expect(segs.length).toBe(1);
    if (segs[0]?.type === "reasoning") {
      expect(segs[0].content).toBe("partial");
      expect(segs[0].done).toBe(true);
    }
  });

  test("invariant: no two consecutive open reasoning segments", () => {
    // Manually simulate consumer with a stream that COULD produce duplicates
    // if the rule were missing — empty parser bug repro.
    const segs: Segment[] = [];
    const pushReasoning = () => {
      const last = segs[segs.length - 1];
      if (last?.type === "reasoning" && !last.done) return;
      segs.push({ type: "reasoning", content: "", done: false });
    };

    // Hammer pushReasoning 1000× in a row without closing.
    for (let i = 0; i < 1000; i++) pushReasoning();

    expect(segs.length).toBe(1);
  });
});
