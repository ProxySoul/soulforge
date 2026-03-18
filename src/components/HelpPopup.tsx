import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { icon } from "../core/icons.js";
import { Overlay, POPUP_BG, PopupRow } from "./shared.js";

const MAX_POPUP_WIDTH = 78;
const CHROME_ROWS = 6;

interface HelpLine {
  type: "header" | "separator" | "entry" | "text" | "spacer";
  label?: string;
  desc?: string;
  color?: string;
}

const LINES: HelpLine[] = [
  { type: "header", label: "Commands" },
  { type: "entry", label: "/agent-features", desc: "toggle agent features (de-sloppify, routing)" },
  { type: "entry", label: "/branch [name]", desc: "show or create branch" },
  { type: "entry", label: "/changes", desc: "toggle changed files tree" },
  { type: "entry", label: "/chat-style", desc: "toggle chat layout (accent/bubble)" },
  { type: "entry", label: "/clear", desc: "clear chat history" },
  { type: "entry", label: "/close-tab", desc: "close current tab" },
  { type: "entry", label: "/co-author-commits", desc: "toggle co-author trailer on commits" },
  { type: "entry", label: "/commit", desc: "Git commit with message" },
  { type: "entry", label: "/compact", desc: "compact conversation to save context" },
  { type: "entry", label: "/compact-v2-logs", desc: "view compaction events & summaries" },
  { type: "entry", label: "/compaction", desc: "switch compaction strategy (v1/v2)" },
  { type: "entry", label: "/context", desc: "show context budget breakdown" },
  { type: "entry", label: "/context clear", desc: "reset context (git|skills|memory|all)" },
  { type: "entry", label: "/continue", desc: "continue interrupted generation" },
  { type: "entry", label: "/diagnose", desc: "intelligence health check — probe all backends" },
  { type: "entry", label: "/diff", desc: "open diff in editor" },
  { type: "entry", label: "/diff-style", desc: "switch diff view (default/sidebyside/compact)" },
  { type: "entry", label: "/editor", desc: "toggle editor panel" },
  { type: "entry", label: "/editor-settings", desc: "toggle editor/LSP integrations" },
  { type: "entry", label: "/errors", desc: "browse tool call & error log" },
  { type: "entry", label: "/export", desc: "export chat to markdown (.soulforge/exports/)" },
  { type: "entry", label: "/export json", desc: "export chat as JSON" },
  { type: "entry", label: "/font", desc: "show installed fonts & current terminal font" },
  { type: "entry", label: "/font set <name>", desc: "auto-set terminal font (e.g. fira-code)" },
  { type: "entry", label: "/git", desc: "open git menu" },
  { type: "entry", label: "/git-status", desc: "git status overview" },
  { type: "entry", label: "/help", desc: "show this help" },
  { type: "entry", label: "/init", desc: "initialize git repo" },
  { type: "entry", label: "/keys", desc: "manage LLM provider API keys" },
  { type: "entry", label: "/lazygit", desc: "launch lazygit fullscreen" },
  { type: "entry", label: "/log", desc: "show recent commits" },
  { type: "entry", label: "/lsp", desc: "language server status & diagnostics" },
  { type: "entry", label: "/lsp-install", desc: "install & manage LSP servers (Mason registry)" },
  { type: "entry", label: "/memory", desc: "manage memory scopes, view & clear memories" },
  { type: "entry", label: "/mode [name]", desc: "show or switch forge mode" },
  { type: "entry", label: "/model-scope", desc: "set model scope (project/global)" },
  { type: "entry", label: "/models", desc: "switch LLM model (Ctrl+L)" },
  { type: "entry", label: "/nerd-font", desc: "toggle nerd font icons (yes/no)" },
  { type: "entry", label: "/new-tab", desc: "open a new tab" },
  {
    type: "entry",
    label: "/nvim-config [mode]",
    desc: "switch neovim config (auto|default|user|none)",
  },
  { type: "entry", label: "/open <path>", desc: "open file in editor" },
  { type: "entry", label: "/plan [task]", desc: "toggle plan mode — research & plan, no edits" },
  { type: "entry", label: "/privacy", desc: "manage forbidden file patterns" },
  { type: "entry", label: "/privacy add <pat>", desc: "block a pattern (project)" },
  { type: "entry", label: "/provider", desc: "thinking, effort, speed, context management" },
  { type: "entry", label: "/provider-settings", desc: "thinking, effort, speed, context mgmt" },
  { type: "entry", label: "/providers", desc: "provider & models" },
  { type: "entry", label: "/proxy", desc: "show proxy status (installed, running)" },
  { type: "entry", label: "/proxy install", desc: "manually install CLIProxyAPI" },
  { type: "entry", label: "/proxy login", desc: "authenticate with Claude (browser OAuth)" },
  { type: "entry", label: "/pull", desc: "pull from remote" },
  { type: "entry", label: "/push", desc: "push to remote" },
  { type: "entry", label: "/quit", desc: "exit soulforge" },
  { type: "entry", label: "/reasoning", desc: "show or hide reasoning content in chat" },
  { type: "entry", label: "/rename <name>", desc: "rename current tab" },
  { type: "entry", label: "/repo-map", desc: "soul map settings — toggle, refresh, clear" },
  { type: "entry", label: "/restart", desc: "full restart of soulforge" },
  { type: "entry", label: "/router", desc: "assign different models per task type" },
  { type: "entry", label: "/sessions", desc: "browse & restore past sessions" },
  { type: "entry", label: "/setup", desc: "check & install prerequisites" },
  { type: "entry", label: "/skills", desc: "browse & install skills" },
  { type: "entry", label: "/split", desc: "cycle editor/chat split (40/50/60/70)" },
  { type: "entry", label: "/stash", desc: "stash changes" },
  { type: "entry", label: "/stash pop", desc: "pop latest stash" },
  { type: "entry", label: "/status", desc: "system status (context, tokens, soul map, memory)" },
  { type: "entry", label: "/storage", desc: "view & manage storage usage" },
  { type: "entry", label: "/tabs", desc: "list open tabs" },
  { type: "entry", label: "/verbose", desc: "toggle verbose tool output in chat" },
  { type: "entry", label: "/vim-hints", desc: "toggle vim keybinding hints in editor" },
  { type: "entry", label: "/web-search", desc: "web search keys & settings" },

  { type: "spacer" },
  { type: "separator" },

  { type: "header", label: "Keybindings" },
  { type: "text", label: "General" },
  { type: "entry", label: "Ctrl+X", desc: "stop/abort generation" },
  { type: "entry", label: "Ctrl+C", desc: "copy selection / exit" },
  { type: "entry", label: "Ctrl+D", desc: "cycle forge mode" },
  { type: "entry", label: "Ctrl+O", desc: "expand/collapse code blocks" },
  { type: "entry", label: "Ctrl+H", desc: "show help" },
  { type: "spacer" },
  { type: "text", label: "Panels" },
  { type: "entry", label: "Ctrl+L", desc: "switch LLM model" },
  { type: "entry", label: "Ctrl+S", desc: "browse skills" },
  { type: "entry", label: "Ctrl+P", desc: "browse sessions" },
  { type: "entry", label: "Alt+R", desc: "error log" },
  { type: "entry", label: "Ctrl+G", desc: "git menu" },
  { type: "spacer" },
  { type: "text", label: "Editor" },
  { type: "entry", label: "Ctrl+E", desc: "open/close editor" },
  { type: "spacer" },
  { type: "text", label: "Tabs" },
  { type: "entry", label: "Alt+T", desc: "new tab" },
  { type: "entry", label: "Alt+W", desc: "close tab" },
  { type: "entry", label: "Alt+1-9", desc: "switch to tab N" },
  { type: "entry", label: "Alt+[ / Alt+]", desc: "prev / next tab" },
  { type: "spacer" },
  { type: "text", label: "Scroll" },
  { type: "entry", label: "Page Up / Down", desc: "scroll chat" },

  { type: "spacer" },
  { type: "separator" },

  { type: "header", label: "Forge Modes" },
  { type: "text", label: "Switch with /mode <name> or Ctrl+D to cycle." },
  { type: "spacer" },
  {
    type: "entry",
    label: "default",
    desc: "standard assistant — implements directly",
    color: "#555",
  },
  {
    type: "entry",
    label: "architect",
    desc: "design only — outlines, tradeoffs, no code",
    color: "#9B30FF",
  },
  {
    type: "entry",
    label: "socratic",
    desc: "asks probing questions before implementing",
    color: "#FF8C00",
  },
  {
    type: "entry",
    label: "challenge",
    desc: "devil's advocate — challenges every assumption",
    color: "#FF0040",
  },
  {
    type: "entry",
    label: "plan",
    desc: "research & plan only — no file edits or shell",
    color: "#00BFFF",
  },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function HelpPopup({ visible, onClose }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.7));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor(containerRows * 0.7) - CHROME_ROWS);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    if (visible) setScrollOffset(0);
  }, [visible]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (evt.name === "down") {
      setScrollOffset((prev) => Math.min(Math.max(0, LINES.length - maxVisible), prev + 1));
    }
  });

  if (!visible) return null;

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
            {icon("info")}
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            SoulForge Help
          </text>
          <text bg={POPUP_BG} fg="#555">
            {"  "}↑↓ scroll
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <box flexDirection="column" height={Math.min(LINES.length, maxVisible)} overflow="hidden">
          {LINES.slice(scrollOffset, scrollOffset + maxVisible).map((line, vi) => {
            const key = String(vi + scrollOffset);
            switch (line.type) {
              case "header":
                return (
                  <PopupRow key={key} w={innerW}>
                    <text bg={POPUP_BG} fg="#8B5CF6" attributes={TextAttributes.BOLD}>
                      {line.label}
                    </text>
                  </PopupRow>
                );
              case "separator":
                return (
                  <PopupRow key={key} w={innerW}>
                    <text bg={POPUP_BG} fg="#333">
                      {"─".repeat(innerW - 2)}
                    </text>
                  </PopupRow>
                );
              case "entry":
                return (
                  <PopupRow key={key} w={innerW}>
                    <text bg={POPUP_BG} fg={line.color ?? "#FF0040"}>
                      {(line.label ?? "").padEnd(20)}
                    </text>
                    <text bg={POPUP_BG} fg="#666">
                      {line.desc}
                    </text>
                  </PopupRow>
                );
              case "text":
                return (
                  <PopupRow key={key} w={innerW}>
                    <text bg={POPUP_BG} fg="#555">
                      {line.label}
                    </text>
                  </PopupRow>
                );
              case "spacer":
                return (
                  <PopupRow key={key} w={innerW}>
                    <text bg={POPUP_BG}>{""}</text>
                  </PopupRow>
                );
              default:
                return null;
            }
          })}
        </box>
        {LINES.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, LINES.length)}/{LINES.length}
              {scrollOffset + maxVisible < LINES.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG}>{""}</text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"↑↓"} scroll | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
