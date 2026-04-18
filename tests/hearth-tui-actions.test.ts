/**
 * Tests for the TUI-action provider surface on hearthBridge — /new, /close,
 * /status route remote commands into React state via these callbacks.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { hearthBridge, type TabStatusSnapshot } from "../src/hearth/bridge.js";

beforeEach(() => {
  hearthBridge._disablePersistForTests();
  hearthBridge._resetForTests();
});

describe("HearthBridge — TuiActions", () => {
  test("createTab returns null when no provider is set", () => {
    expect(hearthBridge.createTab("foo")).toBeNull();
  });

  test("closeRemoteTab returns false when no provider is set", () => {
    expect(hearthBridge.closeRemoteTab("any-id")).toBe(false);
  });

  test("getTabStatus returns null when no provider is set", () => {
    expect(hearthBridge.getTabStatus("any-id")).toBeNull();
  });

  test("setTuiActions wires createTab → returns the id", () => {
    hearthBridge.setTuiActions({
      createTab: (label) => `id-${label ?? "anon"}`,
    });
    expect(hearthBridge.createTab("alpha")).toBe("id-alpha");
    expect(hearthBridge.createTab()).toBe("id-anon");
  });

  test("setTuiActions wires closeRemoteTab", () => {
    const closed: string[] = [];
    hearthBridge.setTuiActions({
      closeTab: (id) => {
        closed.push(id);
        return true;
      },
    });
    expect(hearthBridge.closeRemoteTab("tab-a")).toBe(true);
    expect(closed).toEqual(["tab-a"]);
  });

  test("getTabStatus returns a real snapshot when provider is set", () => {
    const snap: TabStatusSnapshot = {
      tabId: "tab-a",
      label: "TAB-1",
      activeModel: "anthropic/claude-sonnet-4",
      forgeMode: "default",
      isLoading: false,
      messageCount: 12,
      tokenUsage: { input: 1200, output: 340 },
    };
    hearthBridge.setTuiActions({
      getTabStatus: (id) => (id === "tab-a" ? snap : null),
    });
    expect(hearthBridge.getTabStatus("tab-a")).toEqual(snap);
    expect(hearthBridge.getTabStatus("other")).toBeNull();
  });

  test("setTuiActions merges — partial updates don't drop existing handlers", () => {
    hearthBridge.setTuiActions({
      createTab: () => "first",
    });
    hearthBridge.setTuiActions({
      closeTab: () => true,
    });
    expect(hearthBridge.createTab()).toBe("first");
    expect(hearthBridge.closeRemoteTab("x")).toBe(true);
  });

  test("_resetForTests clears TuiActions", () => {
    hearthBridge.setTuiActions({
      createTab: () => "present",
    });
    expect(hearthBridge.createTab()).toBe("present");
    hearthBridge._resetForTests();
    expect(hearthBridge.createTab()).toBeNull();
  });
});
