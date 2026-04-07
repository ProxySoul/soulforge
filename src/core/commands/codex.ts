import { useUIStore } from "../../stores/ui.js";
import { checkProviders } from "../llm/provider.js";
import { runCodexBrowserLogin } from "../llm/providers/codex.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandHandler } from "./types.js";

async function handleCodexLogin(_input: string): Promise<void> {
  type Line = import("../../components/modals/InfoPopup.js").InfoPopupLine;
  const lines: Line[] = [
    {
      type: "text",
      label: "Starting Codex login...",
      color: getThemeTokens().textSecondary,
    },
  ];

  let handle: ReturnType<typeof runCodexBrowserLogin> | null = null;
  const updatePopup = () => {
    useUIStore.getState().openInfoPopup({
      title: "Codex Login",
      icon: "⌘",
      lines: [...lines],
      onClose: () => handle?.abort(),
    });
  };

  updatePopup();
  handle = runCodexBrowserLogin((message) => {
    lines.push({ type: "text", label: message, color: getThemeTokens().textPrimary });
    updatePopup();
  });

  try {
    await handle.promise;
    await checkProviders().catch(() => {});
    lines.push({
      type: "text",
      label: "Select a Codex model with Ctrl+L or /models.",
      color: getThemeTokens().success,
    });
    updatePopup();
    useUIStore.getState().openModal("llmSelector");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push({
      type: "text",
      label: `Error: ${message}`,
      color: getThemeTokens().brandSecondary,
    });
    updatePopup();
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/codex login", handleCodexLogin);
}
