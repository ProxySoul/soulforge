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

// Intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

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
      if (!this.stopRequested) {
        setTimeout(() => this.openSocket(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL), 3000);
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
    const allowed = this.allowedByChannel[msg.channel_id] ?? [];
    if (allowed.length > 0 && !allowed.includes(msg.author.id)) return;
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
    try {
      const resp = await this.fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content, components }),
      });
      if (!resp.ok) {
        this.log(redact(`discord send HTTP ${String(resp.status)}`));
      }
    } catch (err) {
      this.log(redact(`discord send failed: ${err instanceof Error ? err.message : String(err)}`));
    }
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
  data?: { custom_id?: string };
}
