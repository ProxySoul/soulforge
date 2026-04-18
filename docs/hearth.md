# Hearth — Remote Control for SoulForge

> Your forge keeps burning at home. Reach it from anywhere.

Hearth turns a running SoulForge host into a remote-accessible coding agent. Messaging
apps (Telegram, iMessage, Discord, Fakechat for dev) become thin front-ends on top of
the same Forge loop you use locally. Same tools, same sessions, same permissions —
just a different keyboard.

---

## Quick start

```bash
# 1) Start the daemon
soulforge hearth start

# 2) Store a bot token (Telegram / Discord)
soulforge hearth login telegram:<botId> <token>
#   or pipe the token so it never shows in ps:
cat token.txt | soulforge hearth login telegram:<botId>

# 3) Pair your personal chat
soulforge hearth pair telegram:<botId> --issue    # prints a 6-char code
# DM the bot in Telegram: /pair <code>

# 4) Talk
# Any message you send now goes to your forge. Approval prompts arrive as
# inline keyboards inside the chat.
```

The daemon is the only thing that needs to be running on your machine. Surfaces
connect outwards — your code never leaves your host.

---

## Architecture

```
  ┌── Telegram long-poll bot
  │
  ├── iMessage chat.db poller  (macOS only, Full Disk Access)
  │
  ├── Discord gateway (WSS)
  │
  ├── Fakechat   (HTTP + SSE, dev/testing)
  │
  └── Any future adapter — write a ~300-line Surface subclass
            │
            ▼
    ┌───────────────────┐
    │  HearthDaemon     │   single process, UNIX socket 0o600
    ├───────────────────┤
    │  SurfaceRegistry  │   start/stop each surface
    │  ChatWorkspace[]  │   one per (surface, chatId); N tabs each
    │  ApprovalRegistry │   pending PreToolUse requests
    │  PairingRegistry  │   short-lived 6-char codes
    └───────────────────┘
            │
            ▼
    runChat() — unchanged Forge loop, seam-parameterised for:
      readPrompt, signal, callbacks, onEvent, tabId, embedded
```

Every surface uses the *same* seam. A new adapter only needs to:

1. receive platform events → call `emitInbound(InboundMessage)`
2. implement `renderImpl`, `notifyImpl`, `requestApprovalImpl`, `sendPairingPromptImpl`

`BaseSurface` handles start/stop idempotency, redaction, and error isolation.

---

## Security

Hearth inherits SoulForge's existing hooks system and adds four layers on top.

### L1 — Identity allowlist (per surface)

| Surface   | Identity                               | Allowlist key                         |
| --------- | -------------------------------------- | ------------------------------------- |
| Telegram  | numeric `message.from.id`              | `surfaces[].allowed[chatId]: number[]`|
| iMessage  | full handle (`+15551234567` or email)  | `surfaces[].allowed` (flat)           |
| Discord   | `user.id` snowflake                    | `surfaces[].allowed[channelId]`       |

Unknown senders are **silently dropped** — existence non-disclosure.

### L2 — Permission gate via `PreToolUse`

Hearth's default config installs a single `PreToolUse` hook:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|edit_file|multi_edit|shell|git|refactor|rename_symbol|move_symbol|rename_file",
        "hooks": [
          { "type": "command", "command": "soulforge-remote approve", "timeout": 300 }
        ]
      },
      {
        "matcher": "read|Read",
        "hooks": [
          { "type": "command", "command": "soulforge-remote deny-read", "timeout": 2 }
        ]
      }
    ]
  }
}
```

`soulforge-remote` opens the UNIX socket, the daemon routes to the correct surface,
the user taps Approve/Deny — `exit 0` or `exit 2` is returned to Forge core.
Auto-approve and auto-deny lists short-circuit the round-trip for low-risk reads
and unambiguous destructive commands.

### L3 — Secrets & log redaction

Bot tokens live in the keychain (`telegram.bot.<botId>`, `discord.bot.<appId>`).
`installGlobalRedaction()` wraps stdout/stderr and scrubs:

- Telegram bot tokens (`123456:AAA…`)
- Discord bot tokens (three-dot base64)
- OpenAI / Anthropic keys (`sk-…`, `sk-ant-…`)
- GitHub PATs (classic + fine-grained)
- Slack tokens (`xoxb-…`)
- AWS access key ids (`AKIA…`)
- Bearer tokens in Authorization headers
- Long hex secrets (64+ chars)

### L4 — Capability caps per surface

`caps: "main"` (default) runs tools on the host.
`caps: "sandboxed"` runs destructive ops inside Docker (`agents.defaults.sandbox`).
Group chats default to sandboxed.

### L5 — Read denylist

`soulforge-remote deny-read` applies before every read. Built-in patterns:

```
**/.env, **/.env.*, **/secrets/**, **/*.pem, **/*.key,
**/id_rsa*, **/id_ed25519*, ~/.ssh/**, ~/.aws/credentials,
~/.soulforge/secrets.*, ~/.soulforge/hearth.sock
```

Extend per chat with `readDenylistExtra`.

---

## Config — `~/.soulforge/hearth.json`

See [`docs/examples/hearth.json`](./examples/hearth.json) for a commented template.
Schema is a simple layered merge: global → project-local → per-chat override.

---

## Commands (inside any chat)

| Command             | Effect                              |
| ------------------- | ----------------------------------- |
| `/pair <code>`      | Redeem a pairing code               |
| `/new [label]`      | Open a new tab (max 5 per chat)     |
| `/tab [id]`         | List tabs, or switch active tab     |
| `/stop`             | Abort the current turn              |
| `/close [id]`       | Close a tab                         |
| `/help`             | Show available commands             |

Free-form text becomes a prompt to the active tab.

---

## `soulforge hearth` CLI reference

```
soulforge hearth start [--detach]                      Run the daemon foreground
soulforge hearth stop                                  Graceful shutdown
soulforge hearth status                                Socket health + surfaces
soulforge hearth login <surface[:id]> [token]          Store a bot token
soulforge hearth pair  <surface> --issue               Mint a pairing code
soulforge hearth pair  <surface> <code>                Redeem a pairing code
soulforge hearth unpair <surface> <chatId>             Remove a paired chat
soulforge hearth doctor                                Env + keychain + socket
soulforge hearth logs [--follow]                       Tail daemon log
```

`soulforge remote <sub>` and the `soulforge-remote` binary are identical shims for
the permission CLI — use whichever your hook config prefers.

---

## Non-goals

- WhatsApp (ToS)
- iMessage on non-macOS (no safe path)
- 24/7 uptime without your host running (Hearth is "reach your host", not a cloud service)
- E2E encryption through TG/Discord (use Signal or Tailscale-Serve WebSocket later)
- Multiple users editing the same tab concurrently (reads ok; writes single-owner)

---

## Build order recap

1. Seam extraction — `HeadlessChatOptions` + `HeadlessEvent` + parametrized `runChat`.
2. Redaction middleware.
3. Permission socket + `soulforge-remote` CLI.
4. Daemon + workspace + tab loop.
5. Surface base + Fakechat adapter.
6. Telegram, iMessage, Discord adapters.
7. `soulforge hearth` CLI + boot routing.
8. Docs + UI integration.
