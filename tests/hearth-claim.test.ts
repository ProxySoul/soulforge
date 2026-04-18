/**
 * Tests for auto-claim + bindClaimedSessions. Exercises only the in-memory
 * bridge-binding effect — socket round-trip is covered by integration.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { bindClaimedSessions, type ClaimedSession } from "../src/hearth/claim.js";
import { hearthBridge } from "../src/hearth/bridge.js";
import type { SurfaceId } from "../src/hearth/types.js";

beforeEach(() => {
  hearthBridge._disablePersistForTests();
  hearthBridge._resetForTests();
});

function fakeSession(overrides?: Partial<ClaimedSession>): ClaimedSession {
  return {
    surfaceId: "telegram:11111" as SurfaceId,
    externalId: "222",
    sessionId: "sess-1",
    meta: {
      id: "sess-1",
      title: "hearth test",
      cwd: "/tmp/proj",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      activeTabId: "tab-a",
      forgeMode: "default",
      tabs: [
        {
          id: "tab-a",
          label: "TAB-1",
          activeModel: "",
          sessionId: "sess-1",
          planMode: false,
          planRequest: null,
          coAuthorCommits: false,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          messageRange: { startLine: 0, endLine: 0 },
          forgeMode: "default",
        },
      ],
    },
    tabMessages: new Map(),
    ...overrides,
  };
}

describe("bindClaimedSessions", () => {
  test("binds each claimed session to its active tab by id", () => {
    const s = fakeSession();
    bindClaimedSessions([s]);
    const b = hearthBridge.getBinding(s.surfaceId, s.externalId);
    expect(b).not.toBeNull();
    expect(b?.tabId).toBe("tab-a");
    expect(b?.tabLabel).toBe("TAB-1");
  });

  test("falls back to first tab when activeTabId is unknown", () => {
    const s = fakeSession();
    s.meta.activeTabId = "does-not-exist";
    bindClaimedSessions([s]);
    const b = hearthBridge.getBinding(s.surfaceId, s.externalId);
    expect(b?.tabId).toBe("tab-a");
  });

  test("skips sessions with no tabs", () => {
    const s = fakeSession();
    s.meta.tabs = [];
    bindClaimedSessions([s]);
    expect(hearthBridge.getBinding(s.surfaceId, s.externalId)).toBeNull();
  });

  test("binds multiple independent sessions", () => {
    const s1 = fakeSession();
    const s2 = fakeSession({
      surfaceId: "telegram:33333" as SurfaceId,
      externalId: "444",
      sessionId: "sess-2",
      meta: {
        ...fakeSession().meta,
        id: "sess-2",
        activeTabId: "tab-b",
        tabs: [
          {
            id: "tab-b",
            label: "TAB-2",
            activeModel: "",
            sessionId: "sess-2",
            planMode: false,
            planRequest: null,
            coAuthorCommits: false,
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
            messageRange: { startLine: 0, endLine: 0 },
            forgeMode: "default",
          },
        ],
      },
    });
    bindClaimedSessions([s1, s2]);
    expect(hearthBridge.getBinding(s1.surfaceId, s1.externalId)?.tabId).toBe("tab-a");
    expect(hearthBridge.getBinding(s2.surfaceId, s2.externalId)?.tabId).toBe("tab-b");
  });
});
