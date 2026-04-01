import type { ConfigScope } from "../../components/layout/shared.js";
import type { CommandPickerConfig } from "../../components/modals/CommandPicker.js";
import type { InfoPopupConfig } from "../../components/modals/InfoPopup.js";
import type { ChatInstance } from "../../hooks/useChat.js";
import type { UseTabsReturn } from "../../hooks/useTabs.js";
import type {
  AgentFeatures,
  AppConfig,
  ChatStyle,
  ForgeMode,
  NvimConfigMode,
} from "../../types/index.js";
import type { CompactionStrategy } from "../compaction/types.js";
import type { ContextManager } from "../context/manager.js";

export interface CommandContext {
  chat: ChatInstance;
  tabMgr: UseTabsReturn;
  toggleFocus: () => void;
  nvimOpen: (path: string) => Promise<void>;
  exit: () => void;
  openSkills: () => void;
  openGitCommit: () => void;
  openSessions: () => void;
  openHelp: () => void;
  openErrorLog: () => void;
  openCompactionLog: () => void;
  cwd: string;
  refreshGit: () => void;
  setForgeMode: (mode: ForgeMode) => void;
  currentMode: ForgeMode;
  currentModeLabel: string;
  contextManager: ContextManager;
  chatStyle: ChatStyle;
  setChatStyle: (style: ChatStyle) => void;
  handleSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  openGitMenu: () => void;
  openEditorWithFile: (file: string) => void;
  effectiveNvimConfig: NvimConfigMode | undefined;
  vimHints: boolean;
  verbose: boolean;
  diffStyle: "default" | "sidebyside" | "compact";
  autoCompactDiffs: boolean;
  compactionStrategy: CompactionStrategy;
  showReasoning: boolean;
  setShowReasoning: (v: boolean) => void;
  lockIn: boolean;
  setLockIn: (v: boolean) => void;
  openSetup: () => void;
  openEditorSettings: () => void;
  openRouterSettings: () => void;
  openProviderSettings: () => void;
  openWebSearchSettings: () => void;
  openApiKeySettings: () => void;
  openLspStatus: () => void;
  openLspInstall: () => void;
  openCommandPicker: (config: CommandPickerConfig) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  toggleChanges: () => void;
  saveToScope: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  detectScope: (key: string) => ConfigScope;
  agentFeatures: AgentFeatures | undefined;
  instructionFiles: string[] | undefined;
  /** Sync model change to both the active chat and the header UI */
  syncActiveModel: (modelId: string) => void;
}

export type CommandHandler = (input: string, ctx: CommandContext) => void | Promise<void>;
