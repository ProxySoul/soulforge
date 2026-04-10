import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { POPUP_BG, Popup, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 88;
const CHROME_ROWS = 6;

interface HelpLine {
  type: "header" | "separator" | "entry" | "text" | "spacer";
  label?: string;
  desc?: string;
  color?: string;
}

function buildHelpLines(t: ReturnType<typeof useTheme>): HelpLine[] {
  return [
    { type: "text", label: "Ctrl+K — open command palette (search all commands)" },
    { type: "text", label: "/settings — all settings in one place" },
    { type: "spacer" },
    { type: "separator" },

    { type: "header", label: "Keybindings" },
    { type: "text", label: "General" },
    { type: "entry", label: "Ctrl+X", desc: "stop/abort generation" },
    { type: "entry", label: "Ctrl+C", desc: "copy selection / exit" },
    { type: "entry", label: "Ctrl+D", desc: "cycle forge mode" },
    { type: "entry", label: "Ctrl+K", desc: "command palette" },
    { type: "entry", label: "Ctrl+O", desc: "expand/collapse all (code, reasoning)" },
    { type: "entry", label: "Ctrl+Y", desc: "thinking variant for current model" },
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
    { type: "entry", label: "Ctrl+T", desc: "new tab" },
    { type: "entry", label: "Ctrl+W", desc: "close tab" },
    { type: "entry", label: "Ctrl+1-9", desc: "switch to tab N" },
    { type: "entry", label: "Ctrl+[ / Ctrl+]", desc: "prev / next tab" },
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
      color: t.textMuted,
    },
    {
      type: "entry",
      label: "architect",
      desc: "design only — outlines, tradeoffs, no code",
      color: t.brand,
    },
    {
      type: "entry",
      label: "socratic",
      desc: "asks probing questions before implementing",
      color: t.warning,
    },
    {
      type: "entry",
      label: "challenge",
      desc: "devil's advocate — challenges every assumption",
      color: t.brandSecondary,
    },
    {
      type: "entry",
      label: "plan",
      desc: "research & plan only — no file edits or shell",
      color: t.info,
    },
  ];
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function HelpPopup({ visible, onClose }: Props) {
  const t = useTheme();
  const LINES = buildHelpLines(t);
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.8));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor(containerRows * 0.8) - CHROME_ROWS);
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
    <Popup
      width={popupWidth}
      title="SoulForge Help"
      icon={icon("info")}
      footer={[
        { key: "↑↓", label: "scroll" },
        { key: "esc", label: "close" },
      ]}
    >
      <box flexDirection="column" height={Math.min(LINES.length, maxVisible)} overflow="hidden">
        {LINES.slice(scrollOffset, scrollOffset + maxVisible).map((line, vi) => {
          const key = String(vi + scrollOffset);
          switch (line.type) {
            case "header":
              return (
                <PopupRow key={key} w={innerW}>
                  <text bg={POPUP_BG} fg={t.brandAlt} attributes={TextAttributes.BOLD}>
                    {line.label}
                  </text>
                </PopupRow>
              );
            case "separator":
              return (
                <PopupRow key={key} w={innerW}>
                  <text bg={POPUP_BG} fg={t.textFaint}>
                    {"─".repeat(innerW - 2)}
                  </text>
                </PopupRow>
              );
            case "entry":
              return (
                <PopupRow key={key} w={innerW}>
                  <text bg={POPUP_BG} fg={line.color ?? t.brandSecondary}>
                    {(line.label ?? "").padEnd(20)}
                  </text>
                  <text bg={POPUP_BG} fg={t.textMuted}>
                    {line.desc}
                  </text>
                </PopupRow>
              );
            case "text":
              return (
                <PopupRow key={key} w={innerW}>
                  <text bg={POPUP_BG} fg={t.textMuted}>
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
          <text fg={t.textMuted} bg={POPUP_BG}>
            {scrollOffset > 0 ? "↑ " : "  "}
            {scrollOffset + 1}-{Math.min(scrollOffset + maxVisible, LINES.length)}/{LINES.length}
            {scrollOffset + maxVisible < LINES.length ? " ↓" : ""}
          </text>
        </PopupRow>
      )}
    </Popup>
  );
}
