/**
 * Shared Hearth types — consumed by daemon, adapters, and approve CLI.
 * Wire formats here are stable; changes need a protocol version bump.
 */

import type { HeadlessEvent } from "../headless/types.js";
import type { ForgeMode, InteractiveCallbacks } from "../types/index.js";

export const HEARTH_PROTOCOL_VERSION = 1;

export type SurfaceKind = "telegram" | "imessage" | "discord" | "vscode" | "web" | "fakechat";

/** A concrete surface+bot pair, e.g. "telegram:1234" or "imessage:default". */
export type SurfaceId = `${SurfaceKind}:${string}`;

/** A chat inside a surface — external to SoulForge (Telegram chat id, iMessage handle, etc.). */
export type ExternalChatId = string;

export type HearthCaps = "main" | "sandboxed";

export interface ChatBinding {
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
  label?: string;
  cwd: string;
  defaultModel?: string;
  mode?: ForgeMode;
  caps: HearthCaps;
  autoApprove: string[];
  autoDeny: string[];
  readDenylistExtra: string[];
  dailyTokenBudget?: number;
  maxTabs: number;
}

export interface HearthSurfaceConfig {
  enabled: boolean;
  transport?: "long-poll" | "websocket" | "poll";
  chats: Record<ExternalChatId, Partial<ChatBinding>>;
  /** Per-surface allowed user identities. Shape depends on the surface. */
  allowed?: Record<string, string[]>;
}

export interface HearthDaemonConfig {
  socketPath: string;
  stateFile: string;
  logFile: string;
  maxChats: number;
  maxTabsPerChat: number;
  approvalTimeoutMs: number;
  pairingTtlMs: number;
}

export interface HearthConfig {
  surfaces: Record<SurfaceId, HearthSurfaceConfig>;
  daemon: HearthDaemonConfig;
  /** Default auto-approve/deny applied when the chat binding doesn't override. */
  defaults: {
    autoApprove: string[];
    autoDeny: string[];
    readDenylistExtra: string[];
    maxTabs: number;
    caps: HearthCaps;
  };
}

// ── Permission socket protocol ───────────────────────────────────────────

export type PermissionDecision = "allow" | "deny";

export interface PermissionRequest {
  op: "approve";
  v: typeof HEARTH_PROTOCOL_VERSION;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  cwd: string;
  tabId?: string;
  toolInput?: Record<string, unknown>;
  event?: string;
}

export interface PermissionResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  decision: PermissionDecision;
  reason?: string;
  remember?: "once" | "session" | "always";
}

export interface DenyReadRequest {
  op: "deny-read";
  v: typeof HEARTH_PROTOCOL_VERSION;
  path: string;
  cwd: string;
}

export interface DenyReadResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  decision: PermissionDecision;
  matchedPattern?: string;
}

export interface HealthRequest {
  op: "health";
  v: typeof HEARTH_PROTOCOL_VERSION;
}

export interface HealthResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: true;
  surfaces: { id: SurfaceId; connected: boolean; chats: number }[];
  pendingApprovals: number;
  uptime: number;
  /** Lifetime stats since daemon start. */
  stats: HearthLifetimeStats;
  /** Which process is currently driving Telegram/Discord/iMessage long-polls.
   *   "daemon" = this daemon process owns surfaces.
   *   "tui"    = a TUI holds the bridge lock; daemon is a passive socket.
   *   "unknown" = no one owns (transient during handoff). */
  surfaceOwner: "daemon" | "tui" | "unknown";
  /** Pid of the TUI holding the bridge lock, when surfaceOwner === "tui". */
  surfaceOwnerPid?: number;
}

export interface PairRequest {
  op: "pair";
  v: typeof HEARTH_PROTOCOL_VERSION;
  surfaceId: SurfaceId;
  code: string;
}

export interface PairResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  externalId?: ExternalChatId;
  error?: string;
}

export interface ReloadRequest {
  op: "reload";
  v: typeof HEARTH_PROTOCOL_VERSION;
}

export interface ReloadResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  started: SurfaceId[];
  stopped: SurfaceId[];
  errors: { id: SurfaceId; error: string }[];
}

/** Ask the daemon to mint a pairing code for a surface. The TUI uses this —
 *  generating a code locally doesn't work because only the daemon's registry
 *  is consulted when the user types `/pair <CODE>` from Telegram. */
export interface IssueCodeRequest {
  op: "issue-code";
  v: typeof HEARTH_PROTOCOL_VERSION;
  surfaceId: SurfaceId;
  /** Optional target chat id — when unknown, daemon binds on redemption. */
  externalId?: ExternalChatId;
}

export interface IssueCodeResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  code?: string;
  expiresAt?: number;
  error?: string;
}

// ── Bridge / cross-process ownership ─────────────────────────────────────

/** Snapshot of one daemon-side ChatWorkspace — used by claim-workspace. */
export interface RemoteWorkspaceSnapshot {
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
  cwd: string;
  sessionId: string;
  activeTabId: string | null;
  tabs: { id: string; label: string }[];
}

export interface ListWorkspacesRequest {
  op: "list-workspaces";
  v: typeof HEARTH_PROTOCOL_VERSION;
  /** Optional filter — only return workspaces matching this cwd. */
  cwd?: string;
}

export interface ListWorkspacesResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  workspaces: RemoteWorkspaceSnapshot[];
  error?: string;
}

/** Atomically yield a daemon-side workspace to a calling TUI. Closes daemon-side tabs
 *  after flushing session metadata so the TUI can rehydrate from disk. */
export interface ClaimWorkspaceRequest {
  op: "claim-workspace";
  v: typeof HEARTH_PROTOCOL_VERSION;
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
}

export interface ClaimWorkspaceResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  snapshot?: RemoteWorkspaceSnapshot;
  error?: string;
}

/** TUI -> daemon notification when bridge ownership changes (boot/exit).
 *  Daemon uses this as a cooperative signal to release/reacquire surfaces
 *  without waiting on the file-lock poll. */
export interface BridgeNotifyRequest {
  op: "bridge-notify";
  v: typeof HEARTH_PROTOCOL_VERSION;
  /** "acquired" — TUI just took the lock. "released" — TUI is exiting cleanly. */
  state: "acquired" | "released";
  pid: number;
}

export interface BridgeNotifyResponse {
  v: typeof HEARTH_PROTOCOL_VERSION;
  ok: boolean;
  surfacesActive: number;
  error?: string;
}

export type SocketRequest =
  | PermissionRequest
  | DenyReadRequest
  | HealthRequest
  | PairRequest
  | ReloadRequest
  | IssueCodeRequest
  | ListWorkspacesRequest
  | ClaimWorkspaceRequest
  | BridgeNotifyRequest;
export type SocketResponse =
  | PermissionResponse
  | DenyReadResponse
  | HealthResponse
  | PairResponse
  | ReloadResponse
  | IssueCodeResponse
  | ListWorkspacesResponse
  | ClaimWorkspaceResponse
  | BridgeNotifyResponse;

// ── Daemon state ─────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  cwd: string;
  tabId?: string;
  toolInput?: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  resolve: (decision: PermissionResponse) => void;
}

export interface PairingCode {
  code: string;
  surfaceId: SurfaceId;
  externalId: ExternalChatId;
  createdAt: number;
  expiresAt: number;
}

export interface HearthPersistedState {
  version: 1;
  workspaces: {
    surfaceId: SurfaceId;
    externalId: ExternalChatId;
    cwd: string;
    lastSessionId?: string;
    activeTabId?: string;
  }[];
}

// ── Surface adapter contract ─────────────────────────────────────────────

export interface InboundMessage {
  externalId: ExternalChatId;
  senderId: string;
  text?: string;
  command?: { name: string; args: string[] };
  images?: { url: string; mediaType: string }[];
  platformTs: number;
}

export interface ApprovalUI {
  approvalId: string;
  toolName: string;
  summary: string;
  cwd: string;
  tabId?: string;
}

export interface SurfaceRenderInput {
  externalId: ExternalChatId;
  tabId: string;
  event: HeadlessEvent;
}

export interface Surface {
  readonly id: SurfaceId;
  readonly kind: SurfaceKind;

  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  onInbound(handler: (msg: InboundMessage) => void): void;

  render(input: SurfaceRenderInput): Promise<void>;

  requestApproval(
    externalId: ExternalChatId,
    ui: ApprovalUI,
  ): Promise<{ decision: PermissionDecision; remember?: "once" | "session" | "always" }>;

  notify(externalId: ExternalChatId, message: string): Promise<void>;

  sendPairingPrompt(externalId: ExternalChatId, code: string): Promise<void>;
}

export type CallbacksFactory = (ctx: {
  surface: Surface;
  externalId: ExternalChatId;
  tabId: string;
}) => InteractiveCallbacks;
/**
 * Aggregate counters kept by the daemon since it was started. Reset to zero
 * on every daemon boot; never persisted — these are "uptime" numbers.
 */
export interface HearthLifetimeStats {
  /** Inbound user messages routed into workspaces. */
  messagesIn: number;
  /** Outbound events rendered back to a surface (text/tool-call/etc). */
  eventsOut: number;
  /** Approvals evaluated (auto-allow + auto-deny + asks). */
  approvalsHandled: number;
  /** Approvals explicitly allowed. */
  approvalsAllowed: number;
  /** Approvals explicitly denied. */
  approvalsDenied: number;
  /** Pairing codes minted. */
  pairingsIssued: number;
  /** Tabs opened (cumulative). */
  tabsOpened: number;
  /** Turns completed by any tab. */
  turnsCompleted: number;
  /** Tool calls observed across all tabs. */
  toolCalls: number;
  /** Total workspaces ever opened (live or closed). */
  workspacesEver: number;
}
