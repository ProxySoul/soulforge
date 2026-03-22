import { type ModalName, useUIStore } from "../stores/ui.js";
import type { ChatMessage } from "../types/index.js";
import { CompactionLog } from "./modals/CompactionLog.js";
import { ErrorLog } from "./modals/ErrorLog.js";
import { HelpPopup } from "./modals/HelpPopup.js";
import { ApiKeySettings } from "./settings/ApiKeySettings.js";
import { LspStatusPopup } from "./settings/LspStatusPopup.js";
import { SetupGuide } from "./settings/SetupGuide.js";
import { WebSearchSettings } from "./settings/WebSearchSettings.js";

interface SimpleModalLayerProps {
  messages: ChatMessage[];
  onSystemMessage: (msg: string) => void;
}

const closerCache: Partial<Record<ModalName, () => void>> = {};
const getCloser = (name: ModalName) =>
  (closerCache[name] ??= () => useUIStore.getState().closeModal(name));

/** Renders simple modals that only need visible + onClose (+ minor props).
 *  Complex modals (LlmSelector, GitCommit, RouterSettings, etc.) stay in App.tsx
 *  because they're tightly coupled with App-level state. */
export function SimpleModalLayer({ messages, onSystemMessage }: SimpleModalLayerProps) {
  const modalHelpPopup = useUIStore((s) => s.modals.helpPopup);
  const modalWebSearchSettings = useUIStore((s) => s.modals.webSearchSettings);
  const modalApiKeySettings = useUIStore((s) => s.modals.apiKeySettings);
  const modalSetup = useUIStore((s) => s.modals.setup);
  const modalErrorLog = useUIStore((s) => s.modals.errorLog);
  const modalLspStatus = useUIStore((s) => s.modals.lspStatus);
  const modalCompactionLog = useUIStore((s) => s.modals.compactionLog);

  return (
    <>
      <HelpPopup visible={modalHelpPopup} onClose={getCloser("helpPopup")} />
      <WebSearchSettings
        visible={modalWebSearchSettings}
        onClose={getCloser("webSearchSettings")}
      />
      <ApiKeySettings visible={modalApiKeySettings} onClose={getCloser("apiKeySettings")} />
      <SetupGuide
        visible={modalSetup}
        onClose={getCloser("setup")}
        onSystemMessage={onSystemMessage}
      />
      <ErrorLog visible={modalErrorLog} messages={messages} onClose={getCloser("errorLog")} />
      <LspStatusPopup visible={modalLspStatus} onClose={getCloser("lspStatus")} />
      <CompactionLog visible={modalCompactionLog} onClose={getCloser("compactionLog")} />
    </>
  );
}
