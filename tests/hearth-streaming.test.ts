/**
 * Tests for the streaming emitters (text + reasoning) and the remote-callback
 * registry. Covers:
 *   - bridgeStreamEmitter coalesces text deltas into batched flushes
 *   - non-text events flush buffered text first (chronology preserved)
 *   - reasoningStreamEmitter is independent of the text emitter
 *   - askRemote returns fallback when no binding exists
 *   - askRemote resolves when resolveRemoteCallback fires
 *   - resolveRemoteCallback returns false on unknown id
 *   - cancelRemoteCallbacksForTab drains pending callbacks
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HeadlessEvent } from "../src/headless/types.js";
import {
  askRemote,
  bridgeStreamEmitter,
  cancelRemoteCallbacksForTab,
  hearthBridge,
  reasoningStreamEmitter,
  resolveRemoteCallback,
} from "../src/hearth/bridge.js";
import type { SurfaceId } from "../src/hearth/types.js";
import { splitForTelegram } from "../src/hearth/adapters/telegram.js";

const SID = "telegram:99999" as SurfaceId;
const CHAT = "12345";
const TAB = "tab-stream";

beforeEach(() => {
  hearthBridge._disablePersistForTests();
  hearthBridge._resetForTests();
});

afterEach(() => {
  bridgeStreamEmitter.discard(TAB);
  reasoningStreamEmitter.discard(TAB);
  cancelRemoteCallbacksForTab(TAB);
});

describe("BridgeStreamEmitter — text coalescing", () => {
  test("buffered text events merge into a single emit on flushNow", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      out.push(ev);
    });
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });

    bridgeStreamEmitter.stream(TAB, { type: "text", content: "hello " });
    bridgeStreamEmitter.stream(TAB, { type: "text", content: "world" });
    expect(out).toHaveLength(0);
    bridgeStreamEmitter.flushNow(TAB);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "text", content: "hello world" });
  });

  test("non-text event flushes pending text first, preserving order", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      out.push(ev);
    });
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });

    bridgeStreamEmitter.stream(TAB, { type: "text", content: "before" });
    bridgeStreamEmitter.stream(TAB, {
      type: "tool-call",
      tool: "read",
      toolCallId: "t1",
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "text", content: "before" });
    expect(out[1]?.type).toBe("tool-call");
  });

  test("discard drops buffered text without emitting", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      out.push(ev);
    });
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });
    bridgeStreamEmitter.stream(TAB, { type: "text", content: "discard me" });
    bridgeStreamEmitter.discard(TAB);
    bridgeStreamEmitter.flushNow(TAB);
    expect(out).toHaveLength(0);
  });
});

describe("ReasoningStreamEmitter — independent of text", () => {
  test("reasoning emits separately from text", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      out.push(ev);
    });
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });

    reasoningStreamEmitter.append(TAB, "thinking step one. ");
    reasoningStreamEmitter.append(TAB, "thinking step two.");
    reasoningStreamEmitter.flushNow(TAB);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "reasoning",
      content: "thinking step one. thinking step two.",
    });
  });
});

describe("askRemote / resolveRemoteCallback", () => {
  test("askRemote returns fallback when no binding exists", async () => {
    const result = await askRemote(
      "no-such-tab",
      (cb) => ({ type: "ask-user", callbackId: cb, question: "?", options: [] }),
      "fallback",
      50,
    );
    expect(result).toBe("fallback");
  });

  test("askRemote resolves when resolveRemoteCallback fires", async () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      out.push(ev);
    });
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });

    const promise = askRemote<string>(
      TAB,
      (cb) => ({
        type: "ask-user",
        callbackId: cb,
        question: "yes?",
        options: [{ label: "Y", value: "yes" }],
      }),
      "default",
      5_000,
    );
    // Outbound emit should fire synchronously.
    expect(out).toHaveLength(1);
    const ev = out[0];
    if (!ev || ev.type !== "ask-user") throw new Error("expected ask-user");
    const ok = resolveRemoteCallback(ev.callbackId, "yes");
    expect(ok).toBe(true);
    const answered = await promise;
    expect(answered).toBe("yes");
  });

  test("resolveRemoteCallback returns false for unknown id", () => {
    expect(resolveRemoteCallback("nope", "x")).toBe(false);
  });
});
describe("emitTabEvent — /tab view-switch routing", () => {
  test("switchActiveTab does NOT mutate binding.tabId (home tab preserved)", () => {
    const TAB1 = "tab-home";
    const TAB2 = "tab-viewed";
    hearthBridge.registerTab({ tabId: TAB1, label: "H", submit: () => {}, abort: () => {} });
    hearthBridge.registerTab({ tabId: TAB2, label: "V", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB1 });

    const next = hearthBridge.switchActiveTab(SID, CHAT, TAB2);
    expect(next).toBe(TAB2);
    expect(hearthBridge.getBinding(SID, CHAT)?.tabId).toBe(TAB1);
    expect(hearthBridge.getActiveTabId(SID, CHAT)).toBe(TAB2);
  });

  test("after /tab 2, events from viewed tab reach chat; events from home tab do not", () => {
    const TAB1 = "tab-home";
    const TAB2 = "tab-viewed";
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => { out.push(ev); });
    hearthBridge.registerTab({ tabId: TAB1, label: "H", submit: () => {}, abort: () => {} });
    hearthBridge.registerTab({ tabId: TAB2, label: "V", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB1 });
    hearthBridge.switchActiveTab(SID, CHAT, TAB2);

    hearthBridge.emitTabEvent(TAB2, { type: "text", content: "from viewed" });
    hearthBridge.emitTabEvent(TAB1, { type: "text", content: "from home" });

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "text", content: "from viewed" });
  });

  test("with no /tab switch, events from home tab reach chat", () => {
    const TAB1 = "tab-home";
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => { out.push(ev); });
    hearthBridge.registerTab({ tabId: TAB1, label: "H", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB1 });

    hearthBridge.emitTabEvent(TAB1, { type: "text", content: "hi" });
    expect(out).toHaveLength(1);
  });
});
describe("splitForTelegram — paginator", () => {
  test("short text returns single page untouched", () => {
    expect(splitForTelegram("hello")).toEqual(["hello"]);
  });

  test("long text splits into multiple pages under 4096 chars each", () => {
    const huge = "line \n".repeat(2000);
    const pages = splitForTelegram(huge);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(4096);
    expect(pages[0]).toContain("(page 1/");
  });

  test("single oversized line is hard-split", () => {
    const mega = "x".repeat(9000);
    const pages = splitForTelegram(mega);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(4096);
  });
});
describe("setNotifyModeForChat — outbound filter", () => {
  test("notify=off drops everything", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_s, _e, ev) => { out.push(ev); });
    hearthBridge.registerTab({ tabId: TAB, label: "T", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });
    hearthBridge.setNotifyModeForChat(SID, CHAT, "off");
    hearthBridge.emitTabEvent(TAB, { type: "text", content: "hi" });
    hearthBridge.emitTabEvent(TAB, { type: "error", error: "oops" });
    expect(out).toHaveLength(0);
  });

  test("notify=errors drops text but keeps errors and turn-done", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_s, _e, ev) => { out.push(ev); });
    hearthBridge.registerTab({ tabId: TAB, label: "T", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });
    hearthBridge.setNotifyModeForChat(SID, CHAT, "errors");
    hearthBridge.emitTabEvent(TAB, { type: "text", content: "hi" });
    hearthBridge.emitTabEvent(TAB, { type: "error", error: "oops" });
    hearthBridge.emitTabEvent(TAB, { type: "turn-done", steps: 1, tokens: 0, durationMs: 0 } as HeadlessEvent);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((e) => e.type !== "text")).toBe(true);
  });

  test("notify=on (default) lets everything through", () => {
    const out: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_s, _e, ev) => { out.push(ev); });
    hearthBridge.registerTab({ tabId: TAB, label: "T", submit: () => {}, abort: () => {} });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });
    hearthBridge.setNotifyModeForChat(SID, CHAT, "on");
    hearthBridge.emitTabEvent(TAB, { type: "text", content: "hi" });
    expect(out).toHaveLength(1);
  });

  test("setNotifyModeForChat returns null when no binding exists", () => {
    expect(hearthBridge.setNotifyModeForChat(SID, "nonexistent", "off")).toBe(null);
  });
});

describe("handleInbound — image forwarding", () => {
  test("images are forwarded to TabHandle.submit's 4th arg", async () => {
    let captured: { input: string; images?: Array<{ url: string; mediaType: string }> } | null = null;
    hearthBridge.registerTab({
      tabId: TAB,
      label: "T",
      submit: (input, _origin, _id, images) => {
        captured = { input, images };
      },
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: TAB });
    const handled = hearthBridge.handleInbound(
      {
        surfaceId: SID,
        externalId: CHAT,
        text: "look",
        images: [{ url: "data:image/png;base64,iVBOR", mediaType: "image/png" }],
      },
      "telegram",
    );
    expect(handled).toBe(true);
    expect(captured).toBeTruthy();
    expect(captured?.input).toBe("look");
    expect(captured?.images).toEqual([{ url: "data:image/png;base64,iVBOR", mediaType: "image/png" }]);
  });
});
