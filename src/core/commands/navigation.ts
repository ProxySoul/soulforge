import type { CommandPickerOption } from "../../components/modals/CommandPicker.js";
import { useTerminalStore } from "../../stores/terminals.js";
import { useUIStore } from "../../stores/ui.js";
import { icon } from "../icons.js";
import { closeTerminal, spawnTerminal } from "../terminal/manager.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function handleEditor(_input: string, ctx: CommandContext): void {
  ctx.toggleFocus();
}

function handleHelp(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("commandPalette");
}

function handleOpen(input: string, ctx: CommandContext): void {
  const filePath = input
    .trim()
    .replace(/^\/(editor\s+)?open\s*/i, "")
    .trim();
  if (!filePath) {
    sysMsg(ctx, "Usage: /editor open <file-path>");
    return;
  }
  ctx.openEditorWithFile(filePath);
  sysMsg(ctx, `Opening ${filePath} in editor...`);
}

function handleEditorSettings(_input: string, ctx: CommandContext): void {
  ctx.openEditorSettings();
}

function handleRouter(_input: string, ctx: CommandContext): void {
  ctx.openRouterSettings();
}

function handleProviderSettings(_input: string, ctx: CommandContext): void {
  ctx.openProviderSettings();
}

function handleModels(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("llmSelector");
}

function handleWebSearch(_input: string, ctx: CommandContext): void {
  ctx.openWebSearchSettings();
}

function handleApiKeys(_input: string, ctx: CommandContext): void {
  ctx.openApiKeySettings();
}

function handleChanges(_input: string, ctx: CommandContext): void {
  ctx.toggleChanges();
}

function handleErrors(_input: string, ctx: CommandContext): void {
  ctx.openErrorLog();
}

function handleCompactionLogs(_input: string, ctx: CommandContext): void {
  ctx.openCompactionLog();
}

function handleSkills(_input: string, ctx: CommandContext): void {
  ctx.openSkills();
}

function handleTabs(_input: string, ctx: CommandContext): void {
  const tabOptions: CommandPickerOption[] = ctx.tabMgr.tabs.map((tab, i) => ({
    value: tab.id,
    label: `${String(i + 1)}. ${tab.label}`,
    icon: tab.id === ctx.tabMgr.activeTabId ? "▸" : " ",
    color: tab.id === ctx.tabMgr.activeTabId ? getThemeTokens().brand : undefined,
  }));
  ctx.openCommandPicker({
    title: "Switch Tab",
    icon: icon("tabs"),
    options: tabOptions,
    currentValue: ctx.tabMgr.activeTabId,
    onSelect: (tabId) => ctx.tabMgr.switchTab(tabId),
  });
}

function handleNewTab(_input: string, ctx: CommandContext): void {
  ctx.tabMgr.createTab();
}

function handleCloseTab(_input: string, ctx: CommandContext): void {
  if (ctx.tabMgr.tabCount <= 1) {
    sysMsg(ctx, "Can't close the last tab.");
    return;
  }
  if (ctx.tabMgr.isTabLoading(ctx.tabMgr.activeTabId)) {
    const closingId = ctx.tabMgr.activeTabId;
    ctx.openCommandPicker({
      title: "Tab is busy — close anyway?",
      icon: "⚠",
      options: [
        { value: "yes", label: "Yes, close it", icon: "✓" },
        { value: "no", label: "Cancel", icon: "✕" },
      ],
      onSelect: (val) => {
        if (val === "yes") ctx.tabMgr.closeTab(closingId);
      },
    });
  } else {
    ctx.tabMgr.closeTab(ctx.tabMgr.activeTabId);
  }
}

function handleRename(input: string, ctx: CommandContext): void {
  const newName = input
    .trim()
    .replace(/^\/(tab\s+rename|rename)\s*/i, "")
    .trim();
  if (newName) {
    ctx.tabMgr.renameTab(ctx.tabMgr.activeTabId, newName);
    sysMsg(ctx, `Tab renamed to: ${newName}`);
  } else {
    sysMsg(ctx, "Usage: /tab rename <name>");
  }
}

function resolveTerminalByPosition(posStr: string): number | null {
  const pos = Number(posStr);
  if (!Number.isInteger(pos) || pos < 1) return null;
  const terminals = useTerminalStore.getState().terminals;
  const entry = terminals[pos - 1];
  return entry?.id ?? null;
}

function handleTerminals(input: string, ctx: CommandContext): void {
  const firstSpace = input.indexOf(" ");
  const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
  const parts = rest.split(/\s+/);
  const sub = parts[0]?.toLowerCase() ?? "";
  const arg = parts.slice(1).join(" ");

  if (!sub || sub === "list") {
    useUIStore.getState().toggleTerminalsExpanded();
    return;
  }

  if (sub === "new") {
    const cwd = arg || ctx.cwd;
    const result = spawnTerminal(cwd);
    if (!result.success) {
      sysMsg(ctx, result.error ?? "Failed to spawn terminal.");
      return;
    }
    useUIStore.getState().setTerminalsExpanded(true);
    useUIStore.getState().openModal("floatingTerminal");
    return;
  }

  if (sub === "close" || sub === "kill") {
    const store = useTerminalStore.getState();
    const id = arg ? resolveTerminalByPosition(arg) : store.selectedId;
    if (!id) {
      sysMsg(ctx, "Usage: /terminals close <number>");
      return;
    }
    const entry = store.terminals.find((t) => t.id === id);
    if (!entry) {
      sysMsg(ctx, `No terminal at position ${arg}.`);
      return;
    }
    closeTerminal(id);
    sysMsg(ctx, `Terminal ${entry.label} closed.`);
    return;
  }

  if (sub === "show" || sub === "open") {
    if (arg) {
      const id = resolveTerminalByPosition(arg);
      if (!id) {
        sysMsg(ctx, `No terminal at position ${arg}.`);
        return;
      }
      useTerminalStore.getState().selectTerminal(id);
    }
    const store = useTerminalStore.getState();
    if (!store.selectedId || !store.terminals.some((t) => t.id === store.selectedId)) {
      sysMsg(ctx, "No terminals. Use /terminals new to create one.");
      return;
    }
    useUIStore.getState().openModal("floatingTerminal");
    return;
  }

  if (sub === "hide") {
    useUIStore.getState().closeModal("floatingTerminal");
    return;
  }

  if (sub === "rename") {
    const store = useTerminalStore.getState();
    if (!store.selectedId) {
      sysMsg(ctx, "No terminal selected.");
      return;
    }
    if (!arg) {
      sysMsg(ctx, "Usage: /terminals rename <name>");
      return;
    }
    store.renameTerminal(store.selectedId, arg);
    return;
  }

  sysMsg(ctx, `Unknown subcommand: ${sub}. Available: new, close, show, hide, list, rename`);
}

function handleQuit(_input: string, ctx: CommandContext): void {
  ctx.exit();
}

function handleRestart(_input: string, ctx: CommandContext): void {
  ctx.chat.abort();
  import("../../index.js").then(({ restart }) => restart());
}

function handleWizard(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("firstRunWizard");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/quit", handleQuit);
  map.set("/exit", handleQuit);
  map.set("/restart", handleRestart);
  map.set("/editor", handleEditor);
  map.set("/edit", handleEditor);
  map.set("/help", handleHelp);

  // Editor subcommands
  map.set("/editor settings", handleEditorSettings);
  map.set("/editor open", handleOpen);
  map.set("/editor-settings", handleEditorSettings); // legacy alias
  map.set("/open", handleOpen); // legacy alias

  map.set("/router", handleRouter);
  map.set("/mcp", (_input: string) => {
    useUIStore.getState().openModal("mcpSettings");
  });
  map.set("/provider-settings", handleProviderSettings);
  map.set("/perf", handleProviderSettings);
  map.set("/providers", handleModels);
  map.set("/provider", handleModels);
  map.set("/models", handleModels);
  map.set("/model", handleModels);
  map.set("/web-search", handleWebSearch);
  map.set("/keys", handleApiKeys);
  map.set("/api-keys", handleApiKeys);
  map.set("/changes", handleChanges);
  map.set("/files", handleChanges);
  map.set("/errors", handleErrors);
  map.set("/compact logs", handleCompactionLogs);
  map.set("/compact-v2-logs", handleCompactionLogs); // legacy alias
  map.set("/skills", handleSkills);
  map.set("/terminals", handleTerminals);
  map.set("/terminal", handleTerminals);
  map.set("/tab", handleTabs);
  map.set("/tab new", handleNewTab);
  map.set("/tab close", handleCloseTab);
  map.set("/tab rename", handleRename);
  map.set("/wizard", handleWizard);
}

export function matchNavPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/editor open ")) return handleOpen;
  if (cmd.startsWith("/open ")) return handleOpen;
  if (cmd.startsWith("/tab rename ")) return handleRename;
  if (cmd.startsWith("/terminals ")) return handleTerminals;
  if (cmd.startsWith("/terminal ")) return handleTerminals;
  return null;
}
