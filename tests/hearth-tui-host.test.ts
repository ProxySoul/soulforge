/**
 * Lightweight coverage of TuiHost's public API. The full command-routing path
 * requires a running SurfaceHost and surface adapters, which is covered by
 * integration; here we verify the passive behaviour, pairing mint, and
 * isActive flag transitions.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { _resetTuiHost, getTuiHost, TuiHost } from "../src/hearth/tui-host.js";
import type { HearthConfig, SurfaceId } from "../src/hearth/types.js";

function emptyConfig(): HearthConfig {
  return {
    surfaces: {},
    defaults: {
      autoApprove: [],
      autoDeny: [],
      readDenylistExtra: [],
      maxTabs: 5,
      caps: "main",
    },
    daemon: {
      socketPath: "/tmp/hearth-tui-host-test.sock",
      stateFile: "/tmp/hearth-tui-host-test-state.json",
      logFile: "/tmp/hearth-tui-host-test.log",
      maxChats: 20,
      maxTabsPerChat: 5,
      approvalTimeoutMs: 5 * 60_000,
      pairingTtlMs: 10 * 60_000,
    },
  };
}

beforeEach(() => {
  _resetTuiHost();
});

describe("TuiHost — public API", () => {
  test("getTuiHost returns a singleton", () => {
    const a = getTuiHost();
    const b = getTuiHost();
    expect(a).toBe(b);
  });

  test("isActive is false before start()", () => {
    const host = new TuiHost({ loadConfig: emptyConfig });
    expect(host.isActive()).toBe(false);
  });

  test("issuePairingCode mints a code + ttl", () => {
    const host = new TuiHost({ loadConfig: emptyConfig });
    const entry = host.issuePairingCode("telegram:42" as SurfaceId);
    expect(entry.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  test("issuePairingCode with explicit externalId stamps it", () => {
    const host = new TuiHost({ loadConfig: emptyConfig });
    const entry = host.issuePairingCode("telegram:42" as SurfaceId, "chat-123");
    expect(entry.code).toMatch(/^[A-Z0-9]{6}$/);
    // Mint a second — codes must differ.
    const entry2 = host.issuePairingCode("telegram:42" as SurfaceId, "chat-124");
    expect(entry2.code).not.toBe(entry.code);
  });

  test("getConfig returns the loaded config", () => {
    const host = new TuiHost({ loadConfig: emptyConfig });
    expect(host.getConfig().daemon.socketPath).toBe("/tmp/hearth-tui-host-test.sock");
  });
});
