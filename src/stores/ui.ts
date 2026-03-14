import { create } from "zustand";
import type { CommandPickerConfig } from "../components/CommandPicker.js";
import type { InfoPopupConfig } from "../components/InfoPopup.js";
import type { ChatStyle, TaskRouter } from "../types/index.js";

export type ModalName =
  | "llmSelector"
  | "skillSearch"
  | "gitCommit"
  | "sessionPicker"
  | "helpPopup"
  | "errorLog"
  | "gitMenu"
  | "editorSettings"
  | "routerSettings"
  | "providerSettings"
  | "commandPicker"
  | "infoPopup"
  | "repoMapStatus"
  | "setup"
  | "webSearchSettings"
  | "lspStatus"
  | "lspInstall"
  | "compactionLog";

type Modals = Record<ModalName, boolean>;

const INITIAL_MODALS: Modals = {
  llmSelector: false,
  skillSearch: false,
  gitCommit: false,
  sessionPicker: false,
  helpPopup: false,
  errorLog: false,
  gitMenu: false,
  editorSettings: false,
  routerSettings: false,
  providerSettings: false,
  commandPicker: false,
  infoPopup: false,
  repoMapStatus: false,
  setup: false,
  webSearchSettings: false,
  lspStatus: false,
  lspInstall: false,
  compactionLog: false,
};

interface UIState {
  modals: Modals;
  routerSlotPicking: keyof TaskRouter | null;
  commandPickerConfig: CommandPickerConfig | null;
  infoPopupConfig: InfoPopupConfig | null;

  codeExpanded: boolean;
  changesExpanded: boolean;
  chatStyle: ChatStyle;
  showReasoning: boolean;
  reasoningExpanded: boolean;
  suspended: boolean;
  editorSplit: number;

  openModal: (name: ModalName) => void;
  closeModal: (name: ModalName) => void;
  toggleModal: (name: ModalName) => void;

  setRouterSlotPicking: (slot: keyof TaskRouter | null) => void;

  openCommandPicker: (config: CommandPickerConfig) => void;
  updatePickerOptions: (options: CommandPickerConfig["options"]) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  closeInfoPopup: () => void;

  toggleCodeExpanded: () => void;
  setCodeExpanded: (v: boolean) => void;
  toggleChangesExpanded: () => void;
  setChangesExpanded: (v: boolean) => void;
  setChatStyle: (style: ChatStyle) => void;
  setShowReasoning: (v: boolean) => void;
  toggleShowReasoning: () => void;
  toggleReasoningExpanded: () => void;
  setSuspended: (v: boolean) => void;
  cycleEditorSplit: () => void;
}

export const useUIStore = create<UIState>()((set) => ({
  modals: { ...INITIAL_MODALS },
  routerSlotPicking: null,
  commandPickerConfig: null,
  infoPopupConfig: null,

  codeExpanded: false,
  changesExpanded: false,
  chatStyle: "accent",
  showReasoning: true,
  reasoningExpanded: false,
  suspended: false,
  editorSplit: 60,

  openModal: (name) => set((s) => ({ modals: { ...s.modals, [name]: true } })),
  closeModal: (name) => set((s) => ({ modals: { ...s.modals, [name]: false } })),
  toggleModal: (name) => set((s) => ({ modals: { ...s.modals, [name]: !s.modals[name] } })),

  setRouterSlotPicking: (slot) => set({ routerSlotPicking: slot }),

  openCommandPicker: (config) =>
    set((s) => ({
      commandPickerConfig: config,
      modals: { ...s.modals, commandPicker: true },
    })),
  updatePickerOptions: (options) =>
    set((s) => ({
      commandPickerConfig: s.commandPickerConfig ? { ...s.commandPickerConfig, options } : null,
    })),
  openInfoPopup: (config) =>
    set((s) => ({
      infoPopupConfig: config,
      modals: { ...s.modals, infoPopup: true },
    })),
  closeInfoPopup: () =>
    set((s) => ({
      infoPopupConfig: null,
      modals: { ...s.modals, infoPopup: false },
    })),

  toggleCodeExpanded: () => set((s) => ({ codeExpanded: !s.codeExpanded })),
  setCodeExpanded: (v) => set({ codeExpanded: v }),
  toggleChangesExpanded: () => set((s) => ({ changesExpanded: !s.changesExpanded })),
  setChangesExpanded: (v) => set({ changesExpanded: v }),
  setChatStyle: (style) => set({ chatStyle: style }),
  setShowReasoning: (v) => set({ showReasoning: v }),
  toggleShowReasoning: () => set((s) => ({ showReasoning: !s.showReasoning })),
  toggleReasoningExpanded: () => set((s) => ({ reasoningExpanded: !s.reasoningExpanded })),
  setSuspended: (v) => set({ suspended: v }),
  cycleEditorSplit: () =>
    set((s) => {
      const splits = [40, 50, 60, 70];
      const idx = splits.indexOf(s.editorSplit);
      return { editorSplit: splits[(idx + 1) % splits.length] ?? 60 };
    }),
}));

export const selectIsAnyModalOpen = (s: UIState): boolean => Object.values(s.modals).some(Boolean);

export function resetUIStore(): void {
  useUIStore.setState({
    modals: { ...INITIAL_MODALS },
    routerSlotPicking: null,
    commandPickerConfig: null,
    infoPopupConfig: null,
    codeExpanded: false,
    changesExpanded: false,
    chatStyle: "accent",
    showReasoning: true,
    reasoningExpanded: false,
    suspended: false,
  });
}
