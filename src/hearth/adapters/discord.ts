/**
 * Discord surface — WebSocket gateway client. Zero third-party deps: uses
 * Bun's built-in WebSocket + REST via fetch.
 *
 * Security:
 *   - Identity allowlist by numeric snowflake (user.id), never username
 *   - Bot token read from keychain (discord.bot.<appId>)
 *   - Outbound content passes through redact()
 *   - Component interactions respond within 3s or Discord times us out
 *
 * Scope for v1:
 *   - Receive MESSAGE_CREATE events from allowed DM channels + mentions
 *   - Send plain-text messages via POST /channels/:id/messages
 *   - Approval buttons via component interactions
 *   - No voice, no slash-command registration (users run `/pair` as plain text)
 */

import { getSecret } from "../../core/secrets.js";
import type { HeadlessEvent } from "../../headless/types.js";
import { redact } from "../redact.js";
import type {
  ApprovalUI,
  ExternalChatId,
  InboundMessage,
  PermissionDecision,
  SurfaceId,
  SurfaceRenderInput,
} from "../types.js";
import { BaseSurface, parseCommand } from "./base.js";
import { TextRenderer } from "./render-text.js";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_API = "https://discord.com/api/v10";

// Intents: DIRECT_MESSAGES only. MESSAGE_CONTENT is a privileged intent
// (requires verification for ≥75 guilds and explicit toggle in the Discord
// developer portal); omit it since DM content arrives without it on the
// current gateway version. GUILDS / GUILD_MESSAGES are unused for the DM-
// only remote-control workflow — least privilege.
const INTENTS = 1 << 12; // DIRECT_MESSAGES

export interface DiscordSurfaceOptions {
  /** Surface suffix (after "discord:"). Usually the application id. */
  appId: string;
  /** Allowed Discord user snowflakes per channel. */
  allowedUserIdsByChannel?: Record<string, string[]>;
  log?: (line: string) => void;
  /** Test hooks. */
  readToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
}

interface PendingApprovalEntry {
  resolve: (r: { decision: PermissionDecision }) => void;
  externalId: ExternalChatId;
  ui: ApprovalUI;
  messageId?: string;
}

interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export class DiscordSurface extends BaseSurface {
  private appId: string;
  private allowedByChannel: Record<string, string[]>;
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval = 0;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private renderers = new Map<string, TextRenderer>();
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  private stopRequested = false;
  /** When true a fatal close code (auth-fail / forbidden intents / sharding)
   *  fired — stop reconnecting so we don't token-loop. */
  private fatalClose = false;
  /** Reconnect attempt counter for exponential backoff. */
  private reconnectAttempts = 0;
  /** Per-channel outbound throttle — Discord enforces per-route buckets
   *  and a 50 req/sec global. 1 msg/sec per channel stays well under. */
  private lastSendAt = new Map<string, number>();
  private fetchImpl: typeof fetch;
  private readToken: () => Promise<string | null>;
  private wsImpl: typeof WebSocket;

  constructor(opts: DiscordSurfaceOptions) {
    super(`discord:${opts.appId}` as SurfaceId, "discord", opts.log);
    this.appId = opts.appId;
    this.allowedByChannel = opts.allowedUserIdsByChannel ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsImpl = opts.webSocketImpl ?? WebSocket;
    this.readToken =
      opts.readToken ??
      (async () => getSecret(`discord.bot.${this.appId}`) ?? getSecret("discord.bot.default"));
  }

  protected async connect(): Promise<void> {
    const token = await this.readToken();
    if (!token) throw new Error("discord bot token missing — set discord.bot.<appId>");
    this.token = token;
    this.stopRequested = false;
    this.openSocket(DISCORD_GATEWAY_URL);
  }

  protected async disconnect(): Promise<void> {
    this.stopRequested = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const entry of this.pendingApprovals.values()) entry.resolve({ decision: "deny" });
    this.pendingApprovals.clear();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {}
      this.ws = null;
    }
    this.renderers.clear();
  }

  private openSocket(url: string): void {
    if (this.stopRequested) return;
    const ws = new this.wsImpl(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.log("discord gateway open");
    });
    ws.addEventListener("message", (ev) => {
      try {
        const raw =
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        const payload = JSON.parse(raw) as DiscordGatewayPayload;
        this.handleGateway(payload);
      } catch (err) {
        this.log(redact(`discord msg parse: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    ws.addEventListener("close", (ev) => {
      this.log(`discord gateway closed ${String(ev.code)}`);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      // Discord fatal close codes — these mean retrying will never succeed.
      //   4004 = authentication failed (bad token)
      //   4010 = invalid shard
      //   4011 = sharding required
      //   4012 = invalid API version
      //   4013 = invalid intents
      //   4014 = disallowed intents (privileged intent not toggled)
      const fatalCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
      if (fatalCodes.has(ev.code)) {
        this.fatalClose = true;
        this.stopRequested = true;
        this.log(`discord fatal close ${String(ev.code)} — not reconnecting`);
        return;
      }
      if (!this.stopRequested && !this.fatalClose) {
        // Exponential backoff: 3s, 6s, 12s, 24s, max 60s.
        this.reconnectAttempts++;
        const backoff = Math.min(60_000, 3_000 * 2 ** Math.min(4, this.reconnectAttempts - 1));
        setTimeout(() => this.openSocket(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL), backoff);
      }
    });
    ws.addEventListener("error", (ev) => {
      this.log(redact(`discord ws error: ${String((ev as unknown as Event).type)}`));
    });
  }

  private send(payload: DiscordGatewayPayload): void {
    if (!this.ws || this.ws.readyState !== this.wsImpl.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {}
  }

  private handleGateway(payload: DiscordGatewayPayload): void {
    if (typeof payload.s === "number") this.lastSeq = payload.s;
    switch (payload.op) {
      case 10: {
        const d = payload.d as { heartbeat_interval?: number } | undefined;
        this.heartbeatInterval = d?.heartbeat_interval ?? 45_000;
        this.startHeartbeat();
        this.identify();
        return;
      }
      case 11:
        // Heartbeat ack — no-op
        return;
      case 0:
        this.handleDispatch(payload.t, payload.d);
        return;
      case 7:
        // Reconnect request
        try {
          this.ws?.close(4000);
        } catch {}
        return;
      case 9:
        // Invalid session — clear resume state so identify() takes the fresh path,
        // not the RESUME path. Without this, op 9 loops forever against a dead session.
        this.sessionId = null;
        this.lastSeq = null;
        this.resumeGatewayUrl = null;
        setTimeout(() => this.identify(), 2000);
        return;
      default:
        return;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.lastSeq ?? null });
    }, this.heartbeatInterval);
  }

  private identify(): void {
    if (!this.token) return;
    if (this.sessionId && this.resumeGatewayUrl) {
      this.send({
        op: 6,
        d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq },
      });
      return;
    }
    this.send({
      op: 2,
      d: {
        token: this.token,
        intents: INTENTS,
        properties: {
          os: process.platform,
          browser: "soulforge-hearth",
          device: "soulforge-hearth",
        },
      },
    });
  }

  private handleDispatch(name: string | null | undefined, data: unknown): void {
    if (!name) return;
    switch (name) {
      case "READY": {
        const d = data as { session_id?: string; resume_gateway_url?: string };
        this.sessionId = d.session_id ?? null;
        this.resumeGatewayUrl = d.resume_gateway_url ?? DISCORD_GATEWAY_URL;
        this.log("discord session ready");
        return;
      }
      case "MESSAGE_CREATE": {
        this.handleMessage(data as DiscordMessage);
        return;
      }
      case "INTERACTION_CREATE": {
        this.handleInteraction(data as DiscordInteraction);
        return;
      }
      default:
        return;
    }
  }

  private handleMessage(msg: DiscordMessage): void {
    if (!msg || msg.author?.bot) return;
    if (!msg.channel_id || !msg.author?.id || !msg.content) return;
    // Default-deny: unknown channel OR empty allowlist OR sender not listed = drop.
    // The prior `allowed.length > 0 && !allowed.includes(...)` form fell open
    // for any channel that wasn't explicitly configured.
    const allowed = this.allowedByChannel[msg.channel_id];
    if (!allowed?.includes(msg.author.id)) return;
    // H5: DM-only — `member` is only present in guild interactions. Any DM
    // adapter receiving a guild-scoped MESSAGE_CREATE is a misconfiguration
    // (we request DIRECT_MESSAGES intent only); drop defensively.
    if ((msg as unknown as { guild_id?: string }).guild_id) return;
    const cmd = parseCommand(msg.content);
    const inbound: InboundMessage = {
      externalId: msg.channel_id,
      senderId: msg.author.id,
      text: msg.content,
      command: cmd,
      platformTs: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
    };
    this.emitInbound(inbound);
  }

  private handleInteraction(interaction: DiscordInteraction): void {
    if (interaction.type !== 3) return; // only button components
    // H5 DM-only identity: refuse any interaction that carries `member`
    // (guild context). We only accept DM interactions where `user` is set.
    if (interaction.member) {
      void this.respondInteraction(interaction, "dm-only");
      return;
    }
    const interactorId = interaction.user?.id ?? null;
    const chanId = interaction.channel_id ?? null;
    // H1 default-deny: drop if channel unknown, allowlist empty, or user not listed.
    if (!chanId || !interactorId) {
      void this.respondInteraction(interaction, "not authorised");
      return;
    }
    const allowed = this.allowedByChannel[chanId];
    if (!allowed?.includes(interactorId)) {
      void this.respondInteraction(interaction, "not authorised");
      return;
    }
    const custom = interaction.data?.custom_id;
    if (!custom) return;
    const [kind, approvalId, decisionRaw] = custom.split(":");
    if (kind !== "apr" || !approvalId || !decisionRaw) return;
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) {
      void this.respondInteraction(interaction, "expired");
      return;
    }
    this.pendingApprovals.delete(approvalId);
    const decision: PermissionDecision = decisionRaw === "a" ? "allow" : "deny";
    entry.resolve({ decision });
    void this.respondInteraction(interaction, decision === "allow" ? "approved" : "denied");
  }

  private async respondInteraction(interaction: DiscordInteraction, msg: string): Promise<void> {
    try {
      await this.fetchImpl(
        `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: 4,
            data: { content: msg, flags: 64 /* ephemeral */ },
          }),
        },
      );
    } catch {}
  }

  protected async renderImpl(input: SurfaceRenderInput): Promise<void> {
    const r = this.getRenderer(input.externalId);
    const lines = r.renderAll(input.event as HeadlessEvent);
    for (const line of lines) {
      if (!line.text) continue;
      await this.sendChannelMessage(input.externalId, line.text);
    }
  }

  protected async requestApprovalImpl(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(ui.approvalId, { resolve, externalId, ui });
      const body = [`🔐 Approval · ${ui.toolName}`, redact(ui.summary), `cwd: ${ui.cwd}`].join(
        "\n",
      );
      void this.sendChannelMessage(externalId, body, [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: "Approve", custom_id: `apr:${ui.approvalId}:a` },
            { type: 2, style: 4, label: "Deny", custom_id: `apr:${ui.approvalId}:d` },
          ],
        },
      ]);
    });
  }

  protected async notifyImpl(externalId: ExternalChatId, message: string): Promise<void> {
    await this.sendChannelMessage(externalId, message);
  }

  protected async sendPairingPromptImpl(externalId: ExternalChatId, code: string): Promise<void> {
    await this.sendChannelMessage(
      externalId,
      `Pairing code: ${code}\nRun locally: \`soulforge-remote pair ${this.id} ${code}\``,
    );
  }

  private getRenderer(externalId: ExternalChatId): TextRenderer {
    let r = this.renderers.get(externalId);
    if (!r) {
      r = new TextRenderer();
      this.renderers.set(externalId, r);
    }
    return r;
  }

  private async sendChannelMessage(
    channelId: string,
    content: string,
    components?: unknown[],
  ): Promise<void> {
    if (!this.token) return;
    await this.enforcePerChannelPace(channelId);
    // Retry once on 429 honoring retry_after (seconds). Further 429s bubble
    // as a log line. Honoring retry_after is required to avoid Cloudflare bans.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await this.fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bot ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ content, components }),
        });
        if (resp.status === 429) {
          let retryAfter = 5;
          let isGlobal = false;
          try {
            const parsed = (await resp.json()) as {
              retry_after?: number;
              global?: boolean;
            };
            retryAfter = parsed.retry_after ?? retryAfter;
            isGlobal = !!parsed.global;
          } catch {
            const hdr = resp.headers.get("retry-after");
            if (hdr) retryAfter = Number.parseFloat(hdr) || retryAfter;
          }
          this.log(
            redact(`discord 429${isGlobal ? " global" : ""} — retry after ${String(retryAfter)}s`),
          );
          if (attempt === 0) {
            await sleep(Math.ceil(retryAfter * 1000));
            continue;
          }
        }
        if (!resp.ok) {
          this.log(redact(`discord send HTTP ${String(resp.status)}`));
        }
        return;
      } catch (err) {
        this.log(
          redact(`discord send failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
    }
  }

  /** Per-channel outbound throttle — enforces 1 msg/sec to stay well under
   *  Discord's per-route bucket limits. */
  private async enforcePerChannelPace(channelId: string): Promise<void> {
    const MIN_INTERVAL_MS = 1000;
    const last = this.lastSendAt.get(channelId) ?? 0;
    const wait = last + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSendAt.set(channelId, Date.now());
  }
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; bot?: boolean; username?: string };
  content?: string;
  timestamp?: string;
}

interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { custom_id?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
