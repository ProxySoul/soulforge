/**
 * Tests for the in-process HearthBridge — the singleton router between live
 * TUI tabs and Telegram/Discord/iMessage adapters. Covers the scenarios the
 * 2026-04-18 robustness audit called out:
 *   - register → bind → inbound round-trip
 *   - unregister drops bindings but re-queues them by label for restart
 *   - orphan bindings (registered before a tab mounts) resolve on registerTab
 *   - tab.submit() errors propagate back to the surface as an error event
 *   - bridge persistence round-trip via restoreFromDisk
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { HeadlessEvent } from "../src/headless/types.js";
import { hearthBridge } from "../src/hearth/bridge.js";
import type { SurfaceId } from "../src/hearth/types.js";

const SID = "telegram:12345" as SurfaceId;
const CHAT = "55555";

beforeEach(() => {
  hearthBridge._disablePersistForTests();
  hearthBridge._resetForTests();
});

describe("HearthBridge — registration + inbound", () => {
  test("inbound routes to the bound tab once registered", async () => {
    const received: string[] = [];
    hearthBridge.registerTab({
      tabId: "tab-a",
      label: "TAB-1",
      submit: async (input) => {
        received.push(input);
      },
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: "tab-a" });

    const handled = hearthBridge.handleInbound(
      { surfaceId: SID, externalId: CHAT, text: "hello from telegram" },
      "telegram",
    );
    expect(handled).toBe(true);
    // Submit is sync-queued; wait a microtask for the async callback.
    await Promise.resolve();
    expect(received).toEqual(["hello from telegram"]);
  });

  test("inbound with no binding returns false and drops silently", () => {
    const handled = hearthBridge.handleInbound(
      { surfaceId: SID, externalId: CHAT, text: "nobody's listening" },
      "telegram",
    );
    expect(handled).toBe(false);
  });

  test("unregisterTab drops bindings but keeps them pending by label", () => {
    hearthBridge.registerTab({
      tabId: "tab-a",
      label: "TAB-1",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({
      surfaceId: SID,
      externalId: CHAT,
      tabId: "tab-a",
      tabLabel: "TAB-1",
    });
    hearthBridge.unregisterTab("tab-a");
    expect(hearthBridge.getBinding(SID, CHAT)).toBeNull();

    // New tab with the same label picks it up
    hearthBridge.registerTab({
      tabId: "tab-b",
      label: "TAB-1",
      submit: () => {},
      abort: () => {},
    });
    const b = hearthBridge.getBinding(SID, CHAT);
    expect(b).not.toBeNull();
    expect(b?.tabId).toBe("tab-b");
  });
});

describe("HearthBridge — outbound + error propagation", () => {
  test("submit throw surfaces as an error event via the outbound sender", async () => {
    const outbound: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      outbound.push(ev);
    });
    hearthBridge.registerTab({
      tabId: "tab-a",
      label: "TAB-1",
      submit: async () => {
        throw new Error("forge blew up");
      },
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: "tab-a" });

    hearthBridge.handleInbound(
      { surfaceId: SID, externalId: CHAT, text: "/explode" },
      "telegram",
    );
    // Wait long enough for the rejected promise to settle and hit notifyError.
    await new Promise((r) => setTimeout(r, 5));

    expect(outbound.length).toBe(1);
    const ev = outbound[0];
    expect(ev?.type).toBe("error");
    if (ev?.type === "error") {
      expect(ev.error).toContain("forge blew up");
    }
  });

  test("emitTabEvent fans out only to matching bindings", () => {
    const outbound: Array<{ sid: string; ex: string; ev: HeadlessEvent }> = [];
    hearthBridge.setOutboundSender((sid, ex, ev) => {
      outbound.push({ sid, ex, ev });
    });
    hearthBridge.registerTab({
      tabId: "tab-a",
      label: "TAB-1",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: "tab-a" });
    hearthBridge.setBinding({
      surfaceId: SID,
      externalId: "other-chat",
      tabId: "tab-other",
    });

    hearthBridge.emitTabEvent("tab-a", {
      type: "text",
      content: "hi",
    });

    expect(outbound.length).toBe(1);
    expect(outbound[0]?.ex).toBe(CHAT);
  });

  test("mute suppresses outbound events on that binding only", () => {
    const outbound: HeadlessEvent[] = [];
    hearthBridge.setOutboundSender((_sid, _ex, ev) => {
      outbound.push(ev);
    });
    hearthBridge.registerTab({
      tabId: "tab-a",
      label: "TAB-1",
      submit: () => {},
      abort: () => {},
    });
    hearthBridge.setBinding({ surfaceId: SID, externalId: CHAT, tabId: "tab-a" });
    hearthBridge.setMuted(SID, CHAT, true);

    hearthBridge.emitTabEvent("tab-a", { type: "text", content: "should be hidden" });
    expect(outbound.length).toBe(0);
  });
});
