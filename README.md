<div align="center">

<a href="https://paypal.me/waeru"><img src="https://img.shields.io/badge/%E2%9A%94%EF%B8%8F_Fuel_the_Forge-PayPal-9B30FF.svg?style=for-the-badge&logo=paypal&logoColor=white" alt="Fuel the Forge" /></a>

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/header-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/header-light.svg" />
  <img alt="SoulForge" src="assets/header-dark.svg" width="800" />
</picture>

<a href="https://www.npmjs.com/package/@proxysoul/soulforge"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/@proxysoul/soulforge?label=version&color=7844f0&style=flat-square&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/npm/v/@proxysoul/soulforge?label=version&color=7844f0&style=flat-square" /><img alt="Version" src="https://img.shields.io/npm/v/@proxysoul/soulforge?label=version&color=7844f0&style=flat-square" /></picture></a>&nbsp;
<a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/License-BSL%201.1-ff0059.svg?style=flat-square&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/badge/License-BSL%201.1-ff0059.svg?style=flat-square" /><img alt="License" src="https://img.shields.io/badge/License-BSL%201.1-ff0059.svg?style=flat-square" /></picture></a>&nbsp;
<a href="https://github.com/ProxySoul/soulforge/actions/workflows/ci.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/ci.yml?label=CI&style=flat-square&color=0b8b00&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/ci.yml?label=CI&style=flat-square&color=0b8b00" /><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/ci.yml?label=CI&style=flat-square" /></picture></a>&nbsp;
<a href="https://github.com/ProxySoul/soulforge/actions/workflows/playground.yml"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/headless-forge.yml?label=Soul&style=flat-square&color=9b6af5&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/headless-forge.yml?label=Soul&style=flat-square&color=9b6af5" /><img alt="Headless Forge" src="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/headless-forge.yml?label=Soul&style=flat-square" /></picture></a>&nbsp;
<a href="https://www.typescriptlang.org/"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/TypeScript-strict-00a2ce.svg?style=flat-square&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/badge/TypeScript-strict-00a2ce.svg?style=flat-square" /><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-00a2ce.svg?style=flat-square" /></picture></a>&nbsp;
<a href="https://bun.sh"><picture><source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/runtime-Bun-ff0059.svg?style=flat-square&labelColor=0a0818" /><source media="(prefers-color-scheme: light)" srcset="https://img.shields.io/badge/runtime-Bun-ff0059.svg?style=flat-square" /><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-ff0059.svg?style=flat-square" /></picture></a>

<br/><br/>

<img src="assets/intro.gif" alt="SoulForge" width="900" />

<br/>

<img src="assets/features.svg" width="800" />

<br/>

<a href="https://www.star-history.com/?repos=ProxySoul%2Fsoulforge&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ProxySoul/soulforge&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ProxySoul/soulforge&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ProxySoul/soulforge&type=date&legend=top-left" width="700" />
 </picture>
</a>

</div>

<img src="assets/separator.svg" width="100%" height="8" />

## The agent that already knows your codebase

Every AI coding tool starts blind. It reads files, greps around, slowly builds a mental model of your codebase. You wait. You pay. The agent is doing orientation work, not real work.

SoulForge already knows. It builds a **live dependency graph** on startup and keeps it updated as you work. The agent knows which files matter, what depends on what, and how far an edit will ripple before it writes a single line.

**Result: ~2x fewer steps, ~2x lower cost on the same tasks.** The agent spends time on real work, not figuring out where things are.

<img src="assets/separator.svg" width="100%" height="8" />

## What makes it different

<table>
<tr>
<td width="50%" valign="top">
<h4>⚡ Live Soul Map</h4>
<p>Graph of every file, symbol, and import, ranked by importance, enriched with git history, updated in real-time. The agent never wastes a turn orienting itself. <a href="docs/repo-map.md">Learn more</a></p>
</td>
<td width="50%" valign="top">
<h4>🔪 Surgical reads</h4>
<p>Extracts exactly the function or class it needs by name. A 500-line file becomes a 20-line extraction. 33 languages supported. <a href="docs/architecture.md">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🤖 Multi-agent dispatch</h4>
<p>Parallel explore, code, and web search agents with shared cache. One agent's discovery reaches others instantly. <a href="docs/agent-bus.md">Learn more</a></p>
</td>
<td valign="top">
<h4>💰 Instant compaction</h4>
<p>Context state is tracked as the conversation happens. When it gets long, compaction fires instantly, often with zero LLM cost. <a href="docs/compaction.md">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🧠 4-tier code intelligence</h4>
<p>LSP, ts-morph, tree-sitter, regex fallback chain. Dual LSP backend, works with or without the editor open. <a href="docs/architecture.md">Learn more</a></p>
</td>
<td valign="top">
<h4>🔧 Compound tools</h4>
<p><code>rename_symbol</code>, <code>move_symbol</code>, <code>refactor</code>, <code>project</code>. Compiler-guaranteed, one call does the complete job. <a href="docs/compound-tools.md">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🎯 Mix-and-match models</h4>
<p>Opus for planning, Sonnet for coding, Haiku for cleanup. 20 providers built-in. Task router gives full control.</p>
</td>
<td valign="top">
<h4>📝 Embedded Neovim</h4>
<p>Your config, your plugins, your LSP servers. The AI edits through the same editor you use.</p>
</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">
<h4>🔌 MCP servers</h4>
<p>Connect to any <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server. stdio, HTTP, SSE transports. Auto-reconnect, namespaced tools. <a href="docs/mcp.md">Learn more</a></p>
</td>
<td width="50%" valign="top">
<h4>🪝 Lifecycle hooks</h4>
<p>13 hook events (PreToolUse, PostToolUse, SessionStart, etc.). Claude Code compatible, drop in your existing <code>.claude/settings.json</code> hooks. <a href="docs/hooks.md">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🧩 Skills</h4>
<p>Installable domain-specific capabilities with approval gates. Browse and install from the community registry with <code>Ctrl+S</code>.</p>
</td>
<td valign="top">
<h4>📑 Multi-tab</h4>
<p>Up to 5 concurrent sessions with per-tab models, file claims, and git coordination. <a href="docs/cross-tab-coordination.md">Learn more</a></p>
</td>
</tr>
</table>

<details>
<summary><strong>Even more</strong></summary>
<br/>

- **User steering** type while the agent works, messages inject mid-stream. [More](docs/steering.md)
- **Lock-in mode** hides narration, shows only tool activity and final answer
- **Inline images** pixel-perfect images and animated GIFs in chat via Kitty graphics protocol
- **24 themes** Catppuccin, Dracula, Gruvbox, Nord, Tokyo Night, and more. Custom themes with hot reload. [More](docs/themes.md)
- **Code execution** sandboxed Python for data processing and calculations
- **100 slash commands** [Full reference](docs/commands-reference.md)

</details>

<br/>
<img src="assets/separator.svg" width="100%" height="8" />


## Get started

macOS and Linux. First launch offers to install Neovim and Nerd Fonts if missing.

```bash
brew tap proxysoul/tap && brew install soulforge
```

<details>
<summary><strong>Other install methods</strong></summary>
<br/>

**Bun (global):**
```bash
bun install -g @proxysoul/soulforge
```

**Prebuilt binary:**
```bash
# Download from https://github.com/ProxySoul/soulforge/releases/latest
tar xzf soulforge-*.tar.gz && cd soulforge-*/ && ./install.sh
```

**Build from source:**
```bash
git clone https://github.com/ProxySoul/soulforge.git && cd soulforge && bun install
bun run dev
```

</details>

```bash
soulforge                                  # launch, pick a model with Ctrl+L
soulforge --set-key anthropic sk-ant-...   # save a key
soulforge --headless "your prompt here"    # non-interactive
```

See [GETTING_STARTED.md](GETTING_STARTED.md) for a full walkthrough, or the [full docs](docs/README.md) for everything.

<img src="assets/separator.svg" width="100%" height="8" />

## How it compares

<table>
<thead>
<tr>
<th width="160"></th>
<th>SoulForge</th>
<th>Claude Code</th>
<th>Codex CLI</th>
<th>Aider</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Codebase awareness</strong></td>
<td>Live dependency graph with ranking</td>
<td>File reads + grep</td>
<td>MCP plugins</td>
<td>Tree-sitter + PageRank</td>
</tr>
<tr>
<td><strong>Cost optimization</strong></td>
<td>Surgical reads + instant compaction + shared cache + model mixing</td>
<td>Auto-compaction</td>
<td>Server-side compaction</td>
<td>-</td>
</tr>
<tr>
<td><strong>Code intelligence</strong></td>
<td>4-tier fallback, dual LSP, 33 languages</td>
<td>LSP via plugins</td>
<td>MCP-based LSP</td>
<td>Tree-sitter AST</td>
</tr>
<tr>
<td><strong>Multi-agent</strong></td>
<td>Parallel dispatch with shared cache</td>
<td>Subagents + Teams</td>
<td>Multi-agent v2</td>
<td>Single</td>
</tr>
<tr>
<td><strong>Editor</strong></td>
<td>Embedded Neovim (your config)</td>
<td>No</td>
<td>No</td>
<td>No</td>
</tr>
<tr>
<td><strong>Providers</strong></td>
<td>20 + custom</td>
<td>Anthropic only</td>
<td>OpenAI only</td>
<td>100+ LLMs</td>
</tr>
<tr>
<td><strong>License</strong></td>
<td>BSL 1.1</td>
<td>Proprietary</td>
<td>Apache 2.0</td>
<td>Apache 2.0</td>
</tr>
</tbody>
</table>

<sub>Verified April 2026. <a href="https://github.com/ProxySoul/soulforge/issues">Report inaccuracies.</a></sub>


<img src="assets/separator.svg" width="100%" height="8" />

## 20 providers

Anthropic · OpenAI · Google · xAI · Groq · DeepSeek · Mistral · Bedrock · Fireworks · MiniMax · Codex · Copilot · GitHub Models · Ollama · LM Studio · OpenRouter · LLM Gateway · Vercel AI Gateway · Proxy · **any OpenAI-compatible API**

Set a key and go: `soulforge --set-key anthropic sk-ant-...` or `export ANTHROPIC_API_KEY=sk-ant-...`

[Provider setup guide](docs/headless.md#provider-management) · [Custom providers](docs/headless.md#custom-providers)

<img src="assets/separator.svg" width="100%" height="8" />

## Documentation

| | |
|---|---|
| **[Architecture](docs/architecture.md)** | System overview, agent tiers, intelligence router |
| **[Repo Map](docs/repo-map.md)** | Graph ranking, co-change analysis, blast radius |
| **[Commands](docs/commands-reference.md)** | All 100 slash commands |
| **[Headless Mode](docs/headless.md)** | CLI flags, JSON output, CI/CD |
| **[Configuration](docs/README.md)** | Config files, task router, custom providers |
| **[Themes](docs/themes.md)** | 24 themes, custom themes, hot reload |
| **[MCP Servers](docs/mcp.md)** | Model Context Protocol integration |
| **[Copilot Provider](docs/copilot-provider.md)** | Setup and legal review |

<img src="assets/separator.svg" width="100%" height="8" />

## License

[Business Source License 1.1](LICENSE). Free for personal and internal use. Commercial use requires a [commercial license](COMMERCIAL_LICENSE.md). Converts to Apache 2.0 on March 15, 2030.

<br/>

<div align="center">
<sub>Open-sourced March 30, 2026. Built by <a href="https://github.com/proxysoul">proxySoul</a></sub>
</div>
