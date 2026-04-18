/**
 * iMessage surface — macOS only. Polls `~/Library/Messages/chat.db` for new
 * messages using `sqlite3` CLI (readonly) and sends replies via `osascript`.
 *
 * Requirements:
 *   - macOS with Messages.app signed in
 *   - Full Disk Access for the SoulForge binary (doctor step reports this)
 *   - sqlite3 in PATH (bundled with macOS)
 *
 * Security:
 *   - Identity allowlist by full handle (+15551234567 or email)
 *   - chat.db is opened with `mode=ro&immutable=1` URI, never written
 *   - osascript text is shell-escaped via env var passing, never interpolated
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export interface IMessageSurfaceOptions {
  /** Surface suffix (after "imessage:"). Usually "default". */
  id: string;
  /** Allowed handles (+15551234567 or email). */
  allowedHandles: string[];
  /** Path to chat.db. Override for tests. */
  chatDbPath?: string;
  /** Poll interval in ms. */
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

interface PendingApprovalEntry {
  resolve: (r: { decision: PermissionDecision }) => void;
  expireAt: number;
  externalId: ExternalChatId;
  ui: ApprovalUI;
}

export class IMessageSurface extends BaseSurface {
  private chatDbPath: string;
  private pollInterval: number;
  private allowedHandles: Set<string>;
  private lastRowId = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private renderers = new Map<string, TextRenderer>();
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  private macOnly: boolean;

  constructor(opts: IMessageSurfaceOptions) {
    super(`imessage:${opts.id}` as SurfaceId, "imessage", opts.log);
    this.chatDbPath = opts.chatDbPath ?? join(homedir(), "Library", "Messages", "chat.db");
    this.pollInterval = opts.pollIntervalMs ?? 2000;
    this.allowedHandles = new Set(opts.allowedHandles);
    this.macOnly = process.platform === "darwin";
  }

  protected async connect(): Promise<void> {
    if (!this.macOnly) {
      throw new Error("iMessage surface requires macOS");
    }
    if (!existsSync(this.chatDbPath)) {
      throw new Error(
        `chat.db missing at ${this.chatDbPath} — grant Full Disk Access to the SoulForge binary`,
      );
    }
    // Seed lastRowId with the current max so we don't replay history.
    this.lastRowId = await this.queryMaxRowId();
    this.pollTimer = setInterval(() => void this.poll(), this.pollInterval);
  }

  protected async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const entry of this.pendingApprovals.values()) entry.resolve({ decision: "deny" });
    this.pendingApprovals.clear();
    this.renderers.clear();
  }

  protected async renderImpl(input: SurfaceRenderInput): Promise<void> {
    const r = this.getRenderer(input.externalId);
    const lines = r.renderAll(input.event as HeadlessEvent);
    for (const line of lines) {
      if (!line.text) continue;
      await this.sendMessage(input.externalId, line.text);
    }
  }

  protected async requestApprovalImpl(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(ui.approvalId, {
        resolve,
        externalId,
        ui,
        expireAt: Date.now() + 5 * 60_000,
      });
      const body = [
        `Approval · ${ui.toolName}`,
        redact(ui.summary),
        `Reply "approve ${ui.approvalId.slice(0, 6)}" or "deny ${ui.approvalId.slice(0, 6)}"`,
      ].join("\n");
      void this.sendMessage(externalId, body);
    });
  }

  protected async notifyImpl(externalId: ExternalChatId, message: string): Promise<void> {
    await this.sendMessage(externalId, message);
  }

  protected async sendPairingPromptImpl(externalId: ExternalChatId, code: string): Promise<void> {
    await this.sendMessage(externalId, `Pairing code: ${code}`);
  }

  private getRenderer(externalId: ExternalChatId): TextRenderer {
    let r = this.renderers.get(externalId);
    if (!r) {
      r = new TextRenderer();
      this.renderers.set(externalId, r);
    }
    return r;
  }

  private async queryMaxRowId(): Promise<number> {
    try {
      const out = await this.runSqlite(`SELECT IFNULL(MAX(ROWID), 0) FROM message;`);
      return Number.parseInt(out.trim() || "0", 10);
    } catch {
      return 0;
    }
  }

  private async poll(): Promise<void> {
    try {
      const rows = await this.runSqlite(
        `SELECT m.ROWID, h.id, m.text, m.is_from_me, m.date
         FROM message m
         JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ${String(this.lastRowId)} AND m.is_from_me = 0 AND m.text IS NOT NULL
         ORDER BY m.ROWID ASC
         LIMIT 50;`,
      );
      const lines = rows
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length < 5) continue;
        const rowId = Number.parseInt(parts[0] ?? "0", 10);
        const handle = parts[1] ?? "";
        const text = parts[2] ?? "";
        this.lastRowId = Math.max(this.lastRowId, rowId);

        if (!handle || !this.allowedHandles.has(handle)) continue;

        // Approval short-reply parsing: "approve abcdef" / "deny abcdef"
        const mApprove = /^(approve|deny)\s+([A-Za-z0-9]{4,})/i.exec(text.trim());
        if (mApprove) {
          const prefix = mApprove[2]?.toLowerCase() ?? "";
          if (prefix) {
            for (const [id, entry] of this.pendingApprovals) {
              if (id.slice(0, prefix.length).toLowerCase() === prefix) {
                this.pendingApprovals.delete(id);
                entry.resolve({
                  decision: mApprove[1]?.toLowerCase() === "approve" ? "allow" : "deny",
                });
                break;
              }
            }
          }
          continue;
        }

        const cmd = parseCommand(text);
        const inbound: InboundMessage = {
          externalId: handle,
          senderId: handle,
          text,
          command: cmd,
          platformTs: Date.now(),
        };
        this.emitInbound(inbound);
      }
    } catch (err) {
      this.log(redact(`imessage poll failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private runSqlite(sql: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = [`file:${this.chatDbPath}?mode=ro&immutable=1`, sql];
      const child = spawn("sqlite3", ["-separator", "|", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf-8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf-8");
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(stderr || `sqlite3 exit ${String(code)}`));
        else resolve(stdout);
      });
    });
  }

  private async sendMessage(handle: ExternalChatId, text: string): Promise<void> {
    if (!this.macOnly) return;
    // Pass text via env var to keep AppleScript immune to quote injection
    const script = `
on run argv
  set textToSend to system attribute "HEARTH_TEXT"
  set recipient to system attribute "HEARTH_RECIPIENT"
  tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy recipient of targetService
    send textToSend to targetBuddy
  end tell
end run
`;
    await new Promise<void>((resolve) => {
      const child: ChildProcess = spawn("osascript", ["-"], {
        env: { ...process.env, HEARTH_TEXT: text, HEARTH_RECIPIENT: handle },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf-8");
      });
      child.once("error", () => resolve());
      child.once("close", (code) => {
        if (code !== 0) this.log(redact(`osascript exit ${String(code)}: ${stderr}`));
        resolve();
      });
      child.stdin?.write(script);
      child.stdin?.end();
    });
  }
}
