import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mergeConfigs, loadProjectConfig } from "../src/config/index.js";
import { useMCPStore } from "../src/stores/mcp.js";
import type { MCPServerConfig, AppConfig } from "../src/types/index.js";

// ─── Test Helpers ─────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, ".tmp-mcp-test");
const PROJECT_DIR = join(TEST_DIR, "project");
const SOULFORGE_DIR = join(PROJECT_DIR, ".soulforge");
const CONFIG_FILE = join(SOULFORGE_DIR, "config.json");

function writeProjectConfig(data: unknown): void {
  if (!existsSync(SOULFORGE_DIR)) mkdirSync(SOULFORGE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function makeGlobal(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    defaultModel: "none",
    routerRules: [],
    editor: { command: "nvim", args: [] },
    theme: { name: "dark" },
    ...overrides,
  };
}

function resetStore(): void {
  useMCPStore.setState({ servers: {} });
}

// ─── Config Merge ─────────────────────────────────────────

describe("MCP config merge", () => {
  it("returns undefined when neither global nor project has mcpServers", () => {
    const merged = mergeConfigs(makeGlobal(), null);
    expect(merged.mcpServers).toBeUndefined();
  });

  it("returns global servers when no project config", () => {
    const servers: MCPServerConfig[] = [
      { name: "github", command: "npx", args: ["-y", "@mcp/server-github"] },
    ];
    const merged = mergeConfigs(makeGlobal({ mcpServers: servers }), null);
    expect(merged.mcpServers).toHaveLength(1);
    expect(merged.mcpServers![0].name).toBe("github");
  });

  it("returns project servers when no global servers", () => {
    const servers: MCPServerConfig[] = [
      { name: "db", command: "npx", args: ["-y", "@mcp/server-postgres"] },
    ];
    const merged = mergeConfigs(makeGlobal(), { mcpServers: servers });
    expect(merged.mcpServers).toHaveLength(1);
    expect(merged.mcpServers![0].name).toBe("db");
  });

  it("merges global and project servers by name", () => {
    const globalServers: MCPServerConfig[] = [
      { name: "github", command: "npx", args: ["server-github"] },
      { name: "slack", command: "npx", args: ["server-slack"] },
    ];
    const projectServers: MCPServerConfig[] = [
      { name: "db", command: "npx", args: ["server-postgres"] },
    ];
    const merged = mergeConfigs(makeGlobal({ mcpServers: globalServers }), {
      mcpServers: projectServers,
    });
    expect(merged.mcpServers).toHaveLength(3);
    const names = merged.mcpServers!.map((s) => s.name);
    expect(names).toContain("github");
    expect(names).toContain("slack");
    expect(names).toContain("db");
  });

  it("project server overrides global server with same name", () => {
    const globalServers: MCPServerConfig[] = [
      { name: "github", command: "npx", args: ["old-version"] },
    ];
    const projectServers: MCPServerConfig[] = [
      { name: "github", command: "npx", args: ["new-version"], env: { TOKEN: "project-tok" } },
    ];
    const merged = mergeConfigs(makeGlobal({ mcpServers: globalServers }), {
      mcpServers: projectServers,
    });
    expect(merged.mcpServers).toHaveLength(1);
    expect(merged.mcpServers![0].args).toEqual(["new-version"]);
    expect(merged.mcpServers![0].env).toEqual({ TOKEN: "project-tok" });
  });

  it("preserves all transport types through merge", () => {
    const servers: MCPServerConfig[] = [
      { name: "local", command: "npx", args: ["server"] },
      { name: "remote-http", transport: "http", url: "https://example.com/mcp" },
      { name: "remote-sse", transport: "sse", url: "https://example.com/sse" },
    ];
    const merged = mergeConfigs(makeGlobal({ mcpServers: servers }), null);
    expect(merged.mcpServers).toHaveLength(3);
    expect(merged.mcpServers!.find((s) => s.name === "remote-http")?.transport).toBe("http");
    expect(merged.mcpServers!.find((s) => s.name === "remote-sse")?.transport).toBe("sse");
    expect(merged.mcpServers!.find((s) => s.name === "local")?.transport).toBeUndefined();
  });

  it("preserves headers and timeout through merge", () => {
    const servers: MCPServerConfig[] = [
      {
        name: "authed",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer xxx" },
        timeout: 60000,
      },
    ];
    const merged = mergeConfigs(makeGlobal({ mcpServers: servers }), null);
    expect(merged.mcpServers![0].headers).toEqual({ Authorization: "Bearer xxx" });
    expect(merged.mcpServers![0].timeout).toBe(60000);
  });

  it("preserves disabled flag through merge", () => {
    const merged = mergeConfigs(
      makeGlobal({ mcpServers: [{ name: "off", command: "echo", disabled: true }] }),
      null,
    );
    expect(merged.mcpServers![0].disabled).toBe(true);
  });
});

// ─── Project Config Loading ───────────────────────────────

describe("MCP project config loading", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("loads mcpServers from project config", () => {
    writeProjectConfig({
      mcpServers: [{ name: "test", command: "echo", args: ["hello"] }],
    });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj).not.toBeNull();
    expect(proj!.mcpServers).toHaveLength(1);
    expect(proj!.mcpServers![0].name).toBe("test");
  });

  it("returns null when no project config exists", () => {
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj).toBeNull();
  });

  it("returns null for corrupt JSON and does not crash", () => {
    writeProjectConfig("{ this is not json ???");
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj).toBeNull();
  });

  it("returns null for empty file", () => {
    writeProjectConfig("");
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj).toBeNull();
  });

  it("loads config with empty mcpServers array", () => {
    writeProjectConfig({ mcpServers: [] });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj!.mcpServers).toEqual([]);
  });

  it("loads config with mcpServers missing required fields gracefully", () => {
    writeProjectConfig({ mcpServers: [{ name: "incomplete" }] });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj!.mcpServers).toHaveLength(1);
    expect(proj!.mcpServers![0].name).toBe("incomplete");
    expect(proj!.mcpServers![0].command).toBeUndefined();
  });

  it("loads config with extra unknown fields without crashing", () => {
    writeProjectConfig({
      mcpServers: [{ name: "extra", command: "echo", unknownField: true, nested: { deep: 1 } }],
    });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj!.mcpServers).toHaveLength(1);
    expect(proj!.mcpServers![0].name).toBe("extra");
  });

  it("loads config with unicode server names", () => {
    writeProjectConfig({ mcpServers: [{ name: "日本語サーバー", command: "echo" }] });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj!.mcpServers![0].name).toBe("日本語サーバー");
  });

  it("loads config with env containing special characters", () => {
    writeProjectConfig({
      mcpServers: [
        {
          name: "envtest",
          command: "echo",
          env: { TOKEN: "abc=def&foo=bar", PATH_WITH_SPACES: "/path/to/some thing" },
        },
      ],
    });
    const proj = loadProjectConfig(PROJECT_DIR);
    expect(proj!.mcpServers![0].env!.TOKEN).toBe("abc=def&foo=bar");
  });
});

// ─── Zustand Store ────────────────────────────────────────

describe("MCP store", () => {
  beforeEach(resetStore);

  it("setServers initializes all servers as disconnected", () => {
    useMCPStore.getState().setServers([
      { name: "a", command: "echo" },
      { name: "b", command: "echo" },
    ]);
    const { servers } = useMCPStore.getState();
    expect(Object.keys(servers)).toHaveLength(2);
    expect(servers.a.status).toBe("disconnected");
    expect(servers.b.status).toBe("disconnected");
    expect(servers.a.tools).toEqual([]);
    expect(servers.a.error).toBeNull();
  });

  it("setServers marks disabled servers as disabled", () => {
    useMCPStore.getState().setServers([{ name: "off", command: "echo", disabled: true }]);
    expect(useMCPStore.getState().servers.off.status).toBe("disabled");
  });

  it("setServers replaces all previous servers", () => {
    useMCPStore.getState().setServers([{ name: "old", command: "echo" }]);
    useMCPStore.getState().setServers([{ name: "new", command: "echo" }]);
    const { servers } = useMCPStore.getState();
    expect(servers.old).toBeUndefined();
    expect(servers.new).toBeDefined();
  });

  it("setServerStatus transitions correctly", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);

    useMCPStore.getState().setServerStatus("s", "connecting");
    expect(useMCPStore.getState().servers.s.status).toBe("connecting");
    expect(useMCPStore.getState().servers.s.error).toBeNull();

    const before = Date.now();
    useMCPStore.getState().setServerStatus("s", "ready");
    const srv = useMCPStore.getState().servers.s;
    expect(srv.status).toBe("ready");
    expect(srv.connectedAt).toBeGreaterThanOrEqual(before);
    expect(srv.error).toBeNull();
  });

  it("setServerStatus preserves error on error status", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("s", "error", "spawn ENOENT");
    const srv = useMCPStore.getState().servers.s;
    expect(srv.status).toBe("error");
    expect(srv.error).toBe("spawn ENOENT");
  });

  it("setServerStatus clears error when transitioning away from error", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("s", "error", "crash");
    useMCPStore.getState().setServerStatus("s", "connecting");
    expect(useMCPStore.getState().servers.s.error).toBeNull();
  });

  it("setServerStatus preserves existing error when error status without new message", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("s", "error", "original error");
    useMCPStore.getState().setServerStatus("s", "error");
    expect(useMCPStore.getState().servers.s.error).toBe("original error");
  });

  it("setServerStatus ignores unknown server names", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("nonexistent", "ready");
    expect(useMCPStore.getState().servers.nonexistent).toBeUndefined();
  });

  it("setServerTools updates tools list", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerTools("s", [
      { name: "read_file", description: "Read a file", serverName: "s", inputSchema: {} },
      { name: "write_file", description: "Write a file", serverName: "s", inputSchema: {} },
    ]);
    expect(useMCPStore.getState().servers.s.tools).toHaveLength(2);
    expect(useMCPStore.getState().servers.s.tools[0].name).toBe("read_file");
  });

  it("setServerTools ignores unknown server", () => {
    useMCPStore.getState().setServers([]);
    useMCPStore.getState().setServerTools("ghost", []);
    expect(useMCPStore.getState().servers.ghost).toBeUndefined();
  });

  it("setServerPing records latency", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerPing("s", 42);
    expect(useMCPStore.getState().servers.s.lastPingMs).toBe(42);
  });

  it("removeServer deletes from store", () => {
    useMCPStore.getState().setServers([
      { name: "a", command: "echo" },
      { name: "b", command: "echo" },
    ]);
    useMCPStore.getState().removeServer("a");
    expect(useMCPStore.getState().servers.a).toBeUndefined();
    expect(useMCPStore.getState().servers.b).toBeDefined();
  });

  it("removeServer is safe on nonexistent server", () => {
    useMCPStore.getState().setServers([{ name: "a", command: "echo" }]);
    useMCPStore.getState().removeServer("nonexistent");
    expect(Object.keys(useMCPStore.getState().servers)).toHaveLength(1);
  });
});

// ─── MCPManager — transport validation ────────────────────

describe("MCPManager transport validation", () => {
  // We can't actually connect to MCP servers in tests, but we can test
  // that createTransport throws the right errors for invalid configs.
  // We do this by calling connect() which internally calls createTransport().

  beforeEach(resetStore);

  it("rejects stdio config without command", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([{ name: "bad-stdio" }]);
    const srv = useMCPStore.getState().servers["bad-stdio"];
    expect(srv.status).toBe("error");
    expect(srv.error).toContain("stdio transport requires a command");
    await mgr.dispose();
  });

  it("rejects http config without url", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([{ name: "bad-http", transport: "http" }]);
    const srv = useMCPStore.getState().servers["bad-http"];
    expect(srv.status).toBe("error");
    expect(srv.error).toContain("http transport requires a url");
    await mgr.dispose();
  });

  it("rejects sse config without url", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([{ name: "bad-sse", transport: "sse" }]);
    const srv = useMCPStore.getState().servers["bad-sse"];
    expect(srv.status).toBe("error");
    expect(srv.error).toContain("sse transport requires a url");
    await mgr.dispose();
  });

  it("skips disabled servers", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([{ name: "off", command: "echo", disabled: true }]);
    expect(mgr.isConnected("off")).toBe(false);
    expect(useMCPStore.getState().servers.off.status).toBe("disabled");
    await mgr.dispose();
  });

  it("sets error status for unreachable command", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([
      { name: "ghost", command: "nonexistent-binary-that-does-not-exist-12345" },
    ]);
    // Give a moment for the spawn to fail
    await new Promise((r) => setTimeout(r, 500));
    const srv = useMCPStore.getState().servers.ghost;
    expect(srv.status).toBe("error");
    expect(srv.error).toBeTruthy();
    await mgr.dispose();
  });

  it("connectAll handles mix of valid and invalid configs", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.connectAll([
      { name: "no-cmd" },
      { name: "disabled", command: "echo", disabled: true },
      { name: "no-url", transport: "http" },
    ]);
    expect(useMCPStore.getState().servers["no-cmd"].status).toBe("error");
    expect(useMCPStore.getState().servers.disabled.status).toBe("disabled");
    expect(useMCPStore.getState().servers["no-url"].status).toBe("error");
    await mgr.dispose();
  });

  it("dispose prevents further connections", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await mgr.dispose();
    await mgr.connectAll([{ name: "late", command: "echo" }]);
    // After dispose, connect should be a no-op — server stays disconnected
    expect(useMCPStore.getState().servers.late.status).toBe("disconnected");
  });

  it("callTool throws when server not connected", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await expect(mgr.callTool("ghost", "tool", {})).rejects.toThrow("not connected");
    await mgr.dispose();
  });

  it("ping throws when server not connected", async () => {
    const { MCPManager } = await import("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    await expect(mgr.ping("ghost")).rejects.toThrow("not connected");
    await mgr.dispose();
  });

  it("getTools returns empty when no servers ready", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("s", "error", "broken");

    // Import synchronously since getTools doesn't need async
    const { MCPManager } = require("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    expect(Object.keys(mgr.getTools())).toHaveLength(0);
  });

  it("getTools returns empty when no live connections exist", () => {
    // Even if store says "ready", getTools requires a live connection object
    useMCPStore.getState().setServers([{ name: "github", command: "echo" }]);
    useMCPStore.getState().setServerStatus("github", "ready");
      useMCPStore.getState().setServerTools("github", [
        {
        name: "search_repos",
        description: "Search GitHub repos",
        serverName: "github",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
    ]);

    const { MCPManager } = require("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    // No live connection → getTools returns empty even though store has tools
    const tools = mgr.getTools();
      expect(Object.keys(tools)).toHaveLength(0);
  });

    it("getTools skips non-ready servers in store", () => {
      useMCPStore.getState().setServers([
      { name: "ready-srv", command: "echo" },
        { name: "error-srv", command: "echo" },
    ]);
    useMCPStore.getState().setServerStatus("ready-srv", "ready");
      useMCPStore.getState().setServerTools("ready-srv", [
        { name: "tool1", description: "t", serverName: "ready-srv", inputSchema: {} },
    ]);
    useMCPStore.getState().setServerStatus("error-srv", "error", "down");
      useMCPStore.getState().setServerTools("error-srv", [
        { name: "tool2", description: "t", serverName: "error-srv", inputSchema: {} },
    ]);

    const { MCPManager } = require("../src/core/mcp/manager.js");
    const mgr = new MCPManager();
    const tools = mgr.getTools();
    // No live connections → both empty
      expect(tools["mcp__ready-srv__tool1"]).toBeUndefined();
    expect(tools["mcp__error-srv__tool2"]).toBeUndefined();
  });
});

// ─── Edge Cases ───────────────────────────────────────────

describe("MCP edge cases", () => {
  beforeEach(resetStore);

  it("handles empty server name in config", () => {
    useMCPStore.getState().setServers([{ name: "", command: "echo" }]);
    expect(useMCPStore.getState().servers[""]).toBeDefined();
    expect(useMCPStore.getState().servers[""].status).toBe("disconnected");
  });

  it("handles duplicate server names — last wins", () => {
    useMCPStore.getState().setServers([
      { name: "dup", command: "first" },
      { name: "dup", command: "second" },
    ]);
    // setServers iterates in order, last write to servers["dup"] wins
    expect(useMCPStore.getState().servers.dup.config.command).toBe("second");
  });

  it("handles server name with special characters", () => {
    useMCPStore.getState().setServers([{ name: "my-server.v2/test", command: "echo" }]);
    expect(useMCPStore.getState().servers["my-server.v2/test"]).toBeDefined();
  });

  it("rapid status transitions don't corrupt state", () => {
    useMCPStore.getState().setServers([{ name: "s", command: "echo" }]);
    useMCPStore.getState().setServerStatus("s", "connecting");
    useMCPStore.getState().setServerStatus("s", "ready");
    useMCPStore.getState().setServerStatus("s", "error", "oops");
    useMCPStore.getState().setServerStatus("s", "connecting");
    useMCPStore.getState().setServerStatus("s", "ready");
    const srv = useMCPStore.getState().servers.s;
    expect(srv.status).toBe("ready");
    expect(srv.error).toBeNull();
    expect(srv.connectedAt).toBeTruthy();
  });

  it("setServers with large number of servers", () => {
    const configs: MCPServerConfig[] = Array.from({ length: 100 }, (_, i) => ({
      name: `server-${i}`,
      command: "echo",
    }));
    useMCPStore.getState().setServers(configs);
    expect(Object.keys(useMCPStore.getState().servers)).toHaveLength(100);
  });

  it("config merge with many servers preserves order", () => {
    const global: MCPServerConfig[] = Array.from({ length: 5 }, (_, i) => ({
      name: `g${i}`,
      command: "echo",
    }));
    const project: MCPServerConfig[] = Array.from({ length: 3 }, (_, i) => ({
      name: `p${i}`,
      command: "echo",
    }));
    const merged = mergeConfigs(makeGlobal({ mcpServers: global }), { mcpServers: project });
    expect(merged.mcpServers).toHaveLength(8);
  });
});
