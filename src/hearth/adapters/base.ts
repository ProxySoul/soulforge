/**
 * Shared plumbing for surface adapters. Subclasses implement `connect()`,
 * `disconnect()`, `renderImpl()`, `requestApprovalImpl()`, `notifyImpl()`,
 * and `sendPairingPromptImpl()`. Base handles inbound fan-out, idempotent
 * start/stop, and redaction before emitting outbound strings.
 */

import { redact } from "../redact.js";
import type {
  ApprovalUI,
  ExternalChatId,
  InboundMessage,
  PermissionDecision,
  Surface,
  SurfaceId,
  SurfaceKind,
  SurfaceRenderInput,
} from "../types.js";

export abstract class BaseSurface implements Surface {
  readonly id: SurfaceId;
  readonly kind: SurfaceKind;
  protected inboundHandlers: Array<(msg: InboundMessage) => void> = [];
  protected connected = false;
  protected starting: Promise<void> | null = null;
  protected stopping: Promise<void> | null = null;
  protected log: (line: string) => void;

  constructor(id: SurfaceId, kind: SurfaceKind, log?: (line: string) => void) {
    this.id = id;
    this.kind = kind;
    this.log = log ?? (() => {});
  }

  onInbound(handler: (msg: InboundMessage) => void): void {
    this.inboundHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        await this.connect();
        this.connected = true;
      } finally {
        this.starting = null;
      }
    })();
    await this.starting;
  }

  async stop(): Promise<void> {
    if (!this.connected) return;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      try {
        await this.disconnect();
      } finally {
        this.connected = false;
        this.stopping = null;
      }
    })();
    await this.stopping;
  }

  async render(input: SurfaceRenderInput): Promise<void> {
    if (!this.connected) return;
    await this.renderImpl(input).catch((err) =>
      this.log(redact(`render failed: ${err instanceof Error ? err.message : String(err)}`)),
    );
  }

  async requestApproval(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    if (!this.connected) return { decision: "deny" };
    try {
      return await this.requestApprovalImpl(externalId, ui);
    } catch (err) {
      this.log(redact(`approval failed: ${err instanceof Error ? err.message : String(err)}`));
      return { decision: "deny" };
    }
  }

  async notify(externalId: ExternalChatId, message: string): Promise<void> {
    if (!this.connected) return;
    await this.notifyImpl(externalId, redact(message)).catch((err) =>
      this.log(redact(`notify failed: ${err instanceof Error ? err.message : String(err)}`)),
    );
  }

  async sendPairingPrompt(externalId: ExternalChatId, code: string): Promise<void> {
    await this.sendPairingPromptImpl(externalId, code).catch((err) =>
      this.log(
        redact(`pairing prompt failed: ${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }

  protected emitInbound(msg: InboundMessage): void {
    for (const handler of this.inboundHandlers) {
      try {
        handler(msg);
      } catch (err) {
        this.log(
          redact(`inbound handler threw: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  protected abstract connect(): Promise<void>;
  protected abstract disconnect(): Promise<void>;
  protected abstract renderImpl(input: SurfaceRenderInput): Promise<void>;
  protected abstract requestApprovalImpl(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }>;
  protected abstract notifyImpl(externalId: ExternalChatId, message: string): Promise<void>;
  protected abstract sendPairingPromptImpl(externalId: ExternalChatId, code: string): Promise<void>;
}

/** Parse a text message into a slash command if it looks like one. */
export function parseCommand(text: string): { name: string; args: string[] } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const parts = trimmed.split(/\s+/);
  const name = parts[0];
  if (!name) return undefined;
  return { name, args: parts.slice(1) };
}
