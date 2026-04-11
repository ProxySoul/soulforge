# MCP Servers — Model Context Protocol

SoulForge connects to MCP servers, exposing their tools to the AI agent alongside built-in tools. Supports stdio (local subprocess), Streamable HTTP, and legacy SSE transports.

## Configuration

Add to global (`~/.soulforge/config.json`) or project (`.soulforge/config.json`):

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    {
      "name": "sentry",
      "transport": "http",
      "url": "https://mcp.sentry.dev/sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  ]
}
```

Project config overrides global by server name.

## Config reference

| Field | Type | Description |
|---|---|---|
| name | string | Display name and tool namespace prefix (required) |
| transport | "stdio" \| "http" \| "sse" | Transport type (default: "stdio") |
| command | string | Command to spawn (stdio transport) |
| args | string[] | Arguments for command |
| env | Record<string,string> | Environment variables for subprocess |
| url | string | URL for http/sse transports |
| timeout | number | Per-tool-call timeout in ms (default: 30000) |
| disabled | boolean | Disable without removing config |
| headers | Record<string,string> | HTTP headers for http/sse transports |

## Tool namespacing

MCP tools are namespaced as `mcp__<server>__<tool>`. A server named "github" with tool "create_issue" becomes `mcp__github__create_issue`. This prevents collisions with built-in tools.

## Transport types

**stdio** — Spawns a local subprocess. The server communicates via JSON-RPC over stdin/stdout. Best for local tools.

**http** — Streamable HTTP (recommended for remote). Modern MCP transport.

**sse** — Server-Sent Events. Legacy remote transport. Use http for new servers.

## Lifecycle

- On startup, all enabled servers connect with bounded concurrency (max 5 simultaneous)
- Failed servers retry up to 3 times with exponential backoff (1s, 2s, 4s)
- Servers that crash auto-restart (stdio transport)
- On exit, all connections are closed and subprocesses terminated

## TUI management

Open with `/mcp` or `Ctrl+K` → search "mcp".

| Shortcut | Action |
|---|---|
| Type | Filter servers |
| Ctrl+A | Add server |
| Ctrl+D | Delete server |
| Ctrl+T | Toggle enable/disable |
| Ctrl+E | Edit server config |
| Ctrl+R | Retry failed connection |
| Tab | Switch to tools browser |
| Enter | Server detail view |

## Headless mode

MCP servers connect automatically in headless mode. Tools are available to the agent immediately.

```bash
soulforge --headless "use the github MCP to list open issues"
```
