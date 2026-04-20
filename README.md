<div align="center">

<a href="https://paypal.me/waeru"><img src="https://img.shields.io/badge/%E2%9A%94%EF%B8%8F_Fuel_the_Forge-PayPal-9B30FF.svg?style=for-the-badge&logo=paypal&logoColor=white" alt="Fuel the Forge" /></a>

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/SOULFORGE_LOGO.png" />
  <source media="(prefers-color-scheme: light)" srcset="assets/SOULFORGE_LOGO_LIGHT.png" />
  <img alt="SoulForge" src="assets/SOULFORGE_LOGO.png" width="800" />
</picture>

  <img src="assets/separator.svg" width="100%" height="8" />

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

## The agent that treats code as code

<table>
<tr>
<td align="center" width="33%"><h3>~5 tokens</h3><sub>to change a function return type<br/>(AST edit vs ~100 lines of <code>oldString</code>)</sub></td>
<td align="center" width="33%"><h3>~$0</h3><sub>average compaction cost<br/>(V2 extracts as you go)</sub></td>
<td align="center" width="33%"><h3>34 → 5</h3><sub>messages after compaction<br/>with 0 LLM tokens spent</sub></td>
</tr>
</table>

Every other AI coding tool treats your codebase as text. It `grep`s, it pastes 500-line files into context, it builds `oldString`/`newString` blobs and prays the whitespace matches. Half the turn is orientation. The other half is string-matching roulette.

SoulForge treats code as code. On startup it parses your project into a **live Soul Map** — every file, symbol, import edge — ranked by PageRank and git co-change. Forge opens every turn oriented: it reads single symbols by name (not whole files), edits TS/JS through the AST (symbol kind + name, 65+ ops, zero text matching), and rewrites the rest with line-anchored edits that never drift.

**What that means in practice:**

- `ast_edit` changes a return type with `value: "Promise<User>"` — no `oldString`, no whitespace failures, no line-offset math.
- Reads pull one function by name, not an 800-line dump. Context stays lean.
- V2 compaction serializes structured state as the conversation happens — when context fills, it compacts for free.
- Sub-agents share a read cache, so 3 parallel explorers don't re-open the same file 3 times.

Same work, a fraction of the tokens, a fraction of the seconds.

<img src="assets/separator.svg" width="100%" height="8" />

## Not your average CLI

<table>
<tr>
<td width="50%" valign="top">
<h4>🧠 Live Soul Map</h4>
<p>SQLite graph of every file, symbol, and import — PageRank-ranked, git-co-change-aware, personalized per turn. Renders into the system prompt with <strong>blast radius</strong> tags so the agent knows which edits ripple. <a href="https://soulforge.proxysoul.com/concepts/repo-map">Learn more</a></p>
</td>
<td width="50%" valign="top">
<h4>🔪 Surgical reads across 33 languages</h4>
<p>Read a single function by name. A 500-line file becomes a 20-line extraction. TypeScript, Python, Rust, Go, Java, Ruby, C/C++, Swift, Kotlin, Elixir, Zig, Solidity, and more. <a href="https://soulforge.proxysoul.com/concepts/intelligence">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🤖 Parallel agents with shared cache</h4>
<p>Forge dispatches explore, code, and web-search agents in parallel. Files one reads are cached for the others — 3 agents don't re-read 3x. Real-time findings propagate between them. <a href="https://soulforge.proxysoul.com/agents/dispatch">Learn more</a></p>
</td>
<td valign="top">
<h4>💰 Free compaction</h4>
<p>V2 compaction tracks structured state as the conversation happens — files touched, decisions, failures, tool results. When context fills up, serialization is instant and typically costs <strong>zero LLM tokens</strong>. <a href="https://soulforge.proxysoul.com/context/compaction">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🎯 One call, complete job</h4>
<p><code>rename_symbol</code> runs LSP rename, verifies zero dangling refs, reports back. <code>move_symbol</code> moves a symbol and updates every import across TS/JS, Python, and Rust. <code>project</code> auto-detects your toolchain across <strong>23 ecosystems</strong>. <a href="https://soulforge.proxysoul.com/concepts/compound-tools">Learn more</a></p>
</td>
<td valign="top">
<h4>🔬 AST-native editing</h4>
<p><code>ast_edit</code> addresses TS/JS symbols by name, not text. 65+ operations. Changing a return type costs <strong>~5 tokens</strong> instead of 100 lines of <code>oldString</code>. Atomic batches, auto-rollback. <a href="https://soulforge.proxysoul.com/tools/ast-edit">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>📝 Your Neovim, embedded</h4>
<p>Real Neovim in a PTY — your config, your plugins, your LSP servers. Agent edits route through the same editor you use. Over SSH, in tmux, wherever.</p>
</td>
<td valign="top">
<h4>🎚️ Mix-and-match models</h4>
<p>Haiku for exploration. Sonnet for code. Flash for compaction. The task router wires a different model to each job — cheap work goes to cheap models. <strong>21 providers</strong> + any OpenAI-compatible API.</p>
</td>
</tr>
<tr>
<td valign="top">
<h4>📱 Reach your forge from anywhere</h4>
<p><strong>Hearth</strong> turns a running SoulForge into a remote agent. Telegram, Discord, iMessage, or VS Code. Tap-to-approve for destructive ops, auto-redaction of secrets. Your code never leaves your host. <a href="https://soulforge.proxysoul.com/tools/hearth">Learn more</a></p>
</td>
<td valign="top">
<h4>↶ Undo any turn</h4>
<p>Every prompt is a checkpoint. <code>Ctrl+B</code> / <code>Ctrl+F</code> walks history. Branching from any point rewrites the conversation AND restores files on disk. <a href="https://soulforge.proxysoul.com/tools/checkpoints">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>📑 Tab-aware file claims</h4>
<p>Up to 5 tabs per project with independent model, mode, session, and checkpoints. Tabs see each other's claimed files and active agents. Git hard-blocks during cross-tab dispatch, partial commits are impossible. <a href="https://soulforge.proxysoul.com/agents/cross-tab">Learn more</a></p>
</td>
<td valign="top">
<h4>🪝 Drop-in Claude Code hooks</h4>
<p>13 lifecycle events (PreToolUse, PostToolUse, compaction, subagents). Reads your existing <code>.claude/settings.json</code> — no rewrites. <a href="https://soulforge.proxysoul.com/tools/hooks">Learn more</a></p>
</td>
</tr>
<tr>
<td valign="top">
<h4>🔌 MCP-compatible</h4>
<p>Any <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server works out of the box. stdio, HTTP, SSE. Auto-reconnect, namespaced tools. <a href="https://soulforge.proxysoul.com/tools/mcp">Learn more</a></p>
</td>
<td valign="top">
<h4>🧩 Skills</h4>
<p>Install domain-specific skills with <code>Ctrl+S</code>. Bun development, Three.js fundamentals, product marketing, whatever. Approval-gated, scoped per session.</p>
</td>
</tr>
</table>

<details>
<summary><strong>And a lot more</strong></summary>
<br/>

- **Steering** — type while the agent works, messages inject mid-stream. [More](https://soulforge.proxysoul.com/agents/steering)
- **Lock-in mode** — hide narration, show only tool activity and final answer
- **Inline images** — pixel-perfect images and animated GIFs via Kitty graphics protocol
- **24 themes** — Catppuccin, Dracula, Gruvbox, Nord, Tokyo Night, Rose Pine, and more. Hot-reload custom themes. [More](https://soulforge.proxysoul.com/tools/themes)
- **Floating terminals** — Ghostty-powered PTYs next to the chat
- **Plan mode** — research, write a structured plan, you approve, then execute. [More](https://soulforge.proxysoul.com/recipes/plan-mode)
- **Memory** — persistent SQLite memory across sessions, scoped per project or global
- **Pre-commit enforcement** — `git commit` auto-runs lint + typecheck; fails block the commit
- **100 slash commands** — [full reference](https://soulforge.proxysoul.com/reference/commands)

</details>

<br/>
<img src="assets/separator.svg" width="100%" height="8" />

## Install

```bash
brew tap proxysoul/tap && brew install soulforge
```

macOS and Linux. Neovim and a Nerd Font auto-install on first launch.

<details>
<summary><strong>Other install methods</strong></summary>
<br/>

```bash
# Bun (global)
bun install -g @proxysoul/soulforge

# Prebuilt binary
# download from https://github.com/ProxySoul/soulforge/releases/latest
tar xzf soulforge-*.tar.gz && cd soulforge-*/ && ./install.sh

# Source
git clone https://github.com/ProxySoul/soulforge.git && cd soulforge && bun install && bun run dev
```

</details>

## Get a key

Pick any one.

```bash
soulforge --set-key llmgateway sk-...         # one key for every major model, up to 30% off frontier
soulforge --set-key anthropic sk-ant-...      # or any individual provider you already have
soulforge                                     # launch, Ctrl+L to pick a model
```

[All providers](https://soulforge.proxysoul.com/providers) · [Custom providers](https://soulforge.proxysoul.com/providers/custom)

<img src="assets/separator.svg" width="100%" height="8" />

## How it compares

<table>
<thead>
<tr>
<th width="170"></th>
<th>SoulForge</th>
<th>Claude Code</th>
<th>Codex CLI</th>
<th>OpenCode</th>
</tr>
</thead>
<tbody>
<tr>
<td><strong>Codebase awareness</strong></td>
<td>Live SQLite graph — PageRank + git co-change, blast-radius tags, per-turn personalization</td>
<td>File reads + grep</td>
<td>File reads + grep</td>
<td>File reads + grep</td>
</tr>
<tr>
<td><strong>Cost tactics</strong></td>
<td>Surgical reads, parallel shared cache, free V2 compaction, model-per-task router</td>
<td>Auto-compaction</td>
<td>Server-side compaction</td>
<td>Auto-compaction</td>
</tr>
<tr>
<td><strong>Code intelligence</strong></td>
<td>LSP → ts-morph → tree-sitter → regex, 33 languages, Mason installer (576+ servers)</td>
<td>LSP via plugins</td>
<td>—</td>
<td>LSP auto-load</td>
</tr>
<tr>
<td><strong>Editor</strong></td>
<td>Embedded Neovim — your config</td>
<td>—</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td><strong>Remote control</strong></td>
<td>Hearth: Telegram, Discord, iMessage, VS Code</td>
<td>—</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td><strong>Multi-agent</strong></td>
<td>Parallel dispatch + shared cache + edit coordination</td>
<td>Subagents + Teams</td>
<td>Multi-agent v2</td>
<td>Multi-session subagents</td>
</tr>
<tr>
<td><strong>Hooks</strong></td>
<td>13 events, Claude Code drop-in compatible</td>
<td>Hooks (PreToolUse, etc.)</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td><strong>Providers</strong></td>
<td>21 + any OpenAI-compatible</td>
<td>Anthropic only</td>
<td>OpenAI only</td>
<td>75+ via Models.dev</td>
</tr>
<tr>
<td><strong>License</strong></td>
<td>BSL 1.1 (converts to Apache 2.0 in 2030)</td>
<td>Proprietary</td>
<td>Apache 2.0</td>
<td>MIT</td>
</tr>
</tbody>
</table>

<sub>Verified April 2026. <a href="https://github.com/ProxySoul/soulforge/issues">Report inaccuracies.</a></sub>

<img src="assets/separator.svg" width="100%" height="8" />

## Real numbers

All from SoulForge's own codebase, on Claude Sonnet 4.6:

<table>
<tr>
<td><strong>Rename a class across 8 files</strong></td>
<td>19 steps, $0.228 (text edits) → <strong>3 steps, $0.036</strong> (<code>rename_symbol</code>)</td>
</tr>
<tr>
<td><strong>Change a function return type</strong></td>
<td>~100 lines of <code>oldString</code>/<code>newString</code> → <strong>~5 tokens</strong> with <code>ast_edit</code></td>
</tr>
<tr>
<td><strong>Compact a 34-message session</strong></td>
<td>V1 LLM summary: ~8k output tokens, 5-15s → V2: <strong>0 tokens, instant</strong></td>
</tr>
<tr>
<td><strong>Post-compaction conversation</strong></td>
<td>4.5M prompt tokens → <strong>7.5k tokens</strong> (context utilization 6% → 4%)</td>
</tr>
</table>

Claude Code's Explore subagent averages ~$0.70 per 5-minute research run with Haiku. SoulForge matches it when you route `spark` to Haiku via the task router — with the added benefit of full repo-map context.

<img src="assets/separator.svg" width="100%" height="8" />

## Try it

```bash
brew tap proxysoul/tap && brew install soulforge
cd your-project
soulforge
```

Then:

```
> rename AgentBus to CoordinationBus across the project
> run tests and commit
```

Pair a Telegram/Discord/iMessage bot once with `/hearth pair`, then keep chatting from your phone — the session auto-syncs both ways.

Full docs at **[soulforge.proxysoul.com](https://soulforge.proxysoul.com/introduction)**.

<img src="assets/separator.svg" width="100%" height="8" />

## License

[Business Source License 1.1](LICENSE). Free for personal and internal use. Commercial use requires a [commercial license](COMMERCIAL_LICENSE.md). Converts to Apache 2.0 on March 15, 2030.

<br/>

<div align="center">
<sub>Open-sourced March 30, 2026. Built by <a href="https://github.com/proxysoul">proxySoul</a></sub>
</div>
