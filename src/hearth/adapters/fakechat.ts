/**
 * Fakechat — zero-dep HTTP surface for local development and integration tests.
 *
 * Features:
 *   POST /send          { externalId, senderId, text }         → enqueue inbound
 *   POST /approve/:id   { decision, remember? }                 → resolve approval
 *   GET  /events/:id    SSE stream of redacted HeadlessEvents   (one connection per chat)
 *   GET  /state                                                    → debug snapshot
 *
 * Used by `soulforge hearth doctor` and the test suite to prove the flow
 * without Telegram/Discord credentials.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { HeadlessEvent } from "../../headless/types.js";
import type {
  ApprovalUI,
  ExternalChatId,
  PermissionDecision,
  SurfaceId,
  SurfaceRenderInput,
} from "../types.js";
import { BaseSurface, parseCommand } from "./base.js";

export interface FakechatOptions {
  port?: number;
  host?: string;
  log?: (line: string) => void;
}

interface PendingApprovalResolve {
  resolve: (res: {
    decision: PermissionDecision;
    remember?: "once" | "session" | "always";
  }) => void;
  ui: ApprovalUI;
  externalId: ExternalChatId;
}

type SSEClient = { res: ServerResponse; externalId: ExternalChatId };

export class FakechatSurface extends BaseSurface {
  private server: Server | null = null;
  private port: number;
  private host: string;
  private pendingApprovals = new Map<string, PendingApprovalResolve>();
  private sseClients: SSEClient[] = [];

  constructor(id: SurfaceId, opts: FakechatOptions = {}) {
    super(id, "fakechat", opts.log);
    this.port = opts.port ?? 48744;
    this.host = opts.host ?? "127.0.0.1";
  }

  protected async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.log(`fakechat listening at http://${this.host}:${String(this.port)}`);
        resolve();
      });
    });
  }

  protected async disconnect(): Promise<void> {
    // Snapshot first — client.res.end() triggers the 'close' listener that splices
    // from this.sseClients, which would corrupt an in-flight iteration.
    const clientsSnapshot = [...this.sseClients];
    this.sseClients = [];
    for (const client of clientsSnapshot) {
      try {
        client.res.end();
      } catch {}
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({ decision: "deny" });
    }
    this.pendingApprovals.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
  }

  protected async renderImpl(input: SurfaceRenderInput): Promise<void> {
    const payload = JSON.stringify({
      externalId: input.externalId,
      tabId: input.tabId,
      event: input.event,
    });
    for (const client of this.sseClients) {
      if (client.externalId !== input.externalId) continue;
      try {
        client.res.write(`event: hearth\ndata: ${payload}\n\n`);
      } catch {
        // connection closed — swept on next write
      }
    }
  }

  protected async requestApprovalImpl(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(ui.approvalId, { resolve, ui, externalId });
      const payload = JSON.stringify({ kind: "approval", ui });
      for (const client of this.sseClients) {
        if (client.externalId !== externalId) continue;
        try {
          client.res.write(`event: approval\ndata: ${payload}\n\n`);
        } catch {}
      }
    });
  }

  protected async notifyImpl(externalId: ExternalChatId, message: string): Promise<void> {
    const payload = JSON.stringify({ kind: "notify", externalId, message });
    for (const client of this.sseClients) {
      if (client.externalId !== externalId) continue;
      try {
        client.res.write(`event: notify\ndata: ${payload}\n\n`);
      } catch {}
    }
  }

  protected async sendPairingPromptImpl(externalId: ExternalChatId, code: string): Promise<void> {
    await this.notifyImpl(externalId, `pairing code: ${code}`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.method) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? this.host}`);

    try {
      if (req.method === "POST" && url.pathname === "/send") {
        await this.handleSend(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/approve/")) {
        await this.handleApprove(url.pathname.slice("/approve/".length), req, res);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/events/")) {
        this.handleEvents(url.pathname.slice("/events/".length), res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            pendingApprovals: [...this.pendingApprovals.keys()],
            sseClients: this.sseClients.length,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  }

  private async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<{ externalId: string; senderId?: string; text?: string }>(req);
    if (!body.externalId || !body.text) {
      res.statusCode = 400;
      res.end("externalId and text required");
      return;
    }
    const cmd = parseCommand(body.text);
    this.emitInbound({
      externalId: body.externalId,
      senderId: body.senderId ?? "fakechat:anon",
      text: body.text,
      command: cmd,
      platformTs: Date.now(),
    });
    res.statusCode = 204;
    res.end();
  }

  private async handleApprove(
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      res.statusCode = 404;
      res.end("no such approval");
      return;
    }
    const body = await readJsonBody<{ decision: string; remember?: string }>(req);
    const decision: PermissionDecision = body.decision === "allow" ? "allow" : "deny";
    this.pendingApprovals.delete(id);
    pending.resolve({
      decision,
      remember:
        body.remember === "session" || body.remember === "always" || body.remember === "once"
          ? body.remember
          : undefined,
    });
    res.statusCode = 204;
    res.end();
  }

  private handleEvents(externalId: ExternalChatId, res: ServerResponse): void {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.write(": hearth-fakechat connected\n\n");
    const client: SSEClient = { externalId, res };
    this.sseClients.push(client);
    res.on("close", () => {
      this.sseClients = this.sseClients.filter((c) => c !== client);
    });
  }

  /** Helper for tests — drive an inbound message without HTTP. */
  injectInbound(externalId: ExternalChatId, senderId: string, text: string): void {
    const cmd = parseCommand(text);
    this.emitInbound({ externalId, senderId, text, command: cmd, platformTs: Date.now() });
  }

  /** Helper for tests — force a decision on a pending approval. */
  resolvePendingApproval(approvalId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve({ decision });
    return true;
  }

  /** Snapshot the most recent events for a chat — useful for tests. */
  debugSnapshot(): { pendingApprovals: string[]; sseClients: number } {
    return {
      pendingApprovals: [...this.pendingApprovals.keys()],
      sseClients: this.sseClients.length,
    };
  }

  /** Rendered events we'd send right now (text only) — used for test assertions. */
  formatEventForDebug(ev: HeadlessEvent): string {
    return JSON.stringify(ev);
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
