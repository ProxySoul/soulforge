/**
 * Public Hearth entry point — single module surface for the daemon and CLI.
 */

export { BaseSurface, parseCommand } from "./adapters/base.js";
export { DiscordSurface, type DiscordSurfaceOptions } from "./adapters/discord.js";
export { type FakechatOptions, FakechatSurface } from "./adapters/fakechat.js";
export { IMessageSurface, type IMessageSurfaceOptions } from "./adapters/imessage.js";
export { type RenderedLine, TextRenderer } from "./adapters/render-text.js";
export { TelegramSurface, type TelegramSurfaceOptions } from "./adapters/telegram.js";
export { ApprovalRegistry } from "./approvals.js";
export {
  acquireBridgeLock,
  BRIDGE_LOCK_PATH,
  BRIDGE_STATE_PATH,
  type BridgeBinding,
  type BridgeInbound,
  type BridgeOrigin,
  type BridgeOutboundSender,
  BridgeStreamEmitter,
  bridgeStreamEmitter,
  hearthBridge,
  ReasoningStreamEmitter,
  readBridgeOwner,
  reasoningStreamEmitter,
  releaseBridgeLock,
  type TabHandle,
} from "./bridge.js";
export { buildHearthCallbacks, type CallbacksCtx } from "./callbacks.js";
export { parseHearthArgs, runHearthCli } from "./cli.js";
export {
  DEFAULT_LOG_PATH,
  DEFAULT_SOCKET_PATH,
  DEFAULT_STATE_PATH,
  GLOBAL_CONFIG_PATH,
  loadHearthConfig,
  makeDefaultConfig,
  resolveChatBinding,
  upsertChatBinding,
  writeGlobalHearthConfig,
} from "./config.js";
export {
  HearthDaemon,
  type HearthDaemonOptions,
  startHearth,
} from "./daemon.js";
export {
  generatePairingCode,
  PairingRegistry,
  randomNonceHex,
  randomNumericCode,
} from "./pairing.js";
export { describeTool, evaluatePolicy, type PolicyDecision } from "./policy.js";
export {
  auditRedaction,
  DEFAULT_REDACTION_RULES,
  installGlobalRedaction,
  isRedactionInstalled,
  type RedactionRule,
  redact,
  redactUnknown,
  uninstallGlobalRedaction,
} from "./redact.js";
export { ChatWorkspaceRegistry, SurfaceRegistry } from "./registry.js";
export { type BuildSurfacesResult, buildSurfacesFromConfig } from "./surface-factory.js";
export { TabLoop, type TabLoopOptions } from "./tab-loop.js";
export { botIdFromToken, type GetMeResult, getMe, type TelegramBotInfo } from "./telegram-api.js";
export type {
  ApprovalUI,
  CallbacksFactory,
  ChatBinding,
  ExternalChatId,
  HearthCaps,
  HearthConfig,
  HearthDaemonConfig,
  HearthPersistedState,
  HearthSurfaceConfig,
  InboundMessage,
  PairingCode,
  PendingApproval,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  Surface,
  SurfaceId,
  SurfaceKind,
  SurfaceRenderInput,
} from "./types.js";
export { HEARTH_PROTOCOL_VERSION } from "./types.js";
export { ChatWorkspace, type WorkspaceDeps } from "./workspace.js";
