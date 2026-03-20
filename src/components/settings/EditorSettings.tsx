import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { EditorIntegration } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES, Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 60;
const CHROME_ROWS = 8;

interface ToggleItem {
  key: keyof EditorIntegration;
  label: string;
  desc: string;
}

const ITEMS: ToggleItem[] = [
  { key: "diagnostics", label: "LSP Diagnostics", desc: "errors & warnings from LSP" },
  { key: "symbols", label: "Document Symbols", desc: "functions, classes, variables" },
  { key: "hover", label: "Hover / Type Info", desc: "type info at cursor position" },
  { key: "references", label: "Find References", desc: "all usages of a symbol" },
  { key: "definition", label: "Go to Definition", desc: "jump to symbol definition" },
  { key: "codeActions", label: "Code Actions", desc: "quick fixes & refactorings" },
  { key: "rename", label: "LSP Rename", desc: "workspace-wide symbol rename" },
  { key: "lspStatus", label: "LSP Status", desc: "check attached LSP servers" },
  { key: "format", label: "LSP Format", desc: "format buffer via LSP" },
  { key: "editorContext", label: "Editor Context", desc: "file/cursor/selection in prompt" },
];

const ALL_ON: EditorIntegration = {
  diagnostics: true,
  symbols: true,
  hover: true,
  references: true,
  definition: true,
  codeActions: true,
  editorContext: true,
  rename: true,
  lspStatus: true,
  format: true,
};

const ALL_OFF: EditorIntegration = {
  diagnostics: false,
  symbols: false,
  hover: false,
  references: false,
  definition: false,
  codeActions: false,
  editorContext: false,
  rename: false,
  lspStatus: false,
  format: false,
};

interface Props {
  visible: boolean;
  settings: EditorIntegration | undefined;
  initialScope?: ConfigScope;
  onUpdate: (settings: EditorIntegration, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  onClose: () => void;
}

export function EditorSettings({ visible, settings, initialScope, onUpdate, onClose }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.7));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.7) - CHROME_ROWS);
  const { cursor, setCursor, scrollOffset, adjustScroll } = usePopupScroll(maxVisible);
  const [scope, setScope] = useState<ConfigScope>(initialScope ?? "project");
  const current = settings ?? ALL_ON;

  useEffect(() => {
    if (visible) setScope(initialScope ?? "project");
  }, [visible, initialScope]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setCursor((c) => {
        const next = c > 0 ? c - 1 : ITEMS.length - 1;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => {
        const next = c < ITEMS.length - 1 ? c + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      const item = ITEMS[cursor];
      if (item) {
        onUpdate({ ...current, [item.key]: !current[item.key] }, scope);
      }
      return;
    }
    if (evt.name === "a") {
      onUpdate({ ...ALL_ON }, scope);
      return;
    }
    if (evt.name === "n") {
      onUpdate({ ...ALL_OFF }, scope);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      setScope((prev) => {
        const idx = CONFIG_SCOPES.indexOf(prev);
        const next =
          evt.name === "left"
            ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
            : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
        if (next && next !== prev) {
          onUpdate({ ...current }, next, prev);
        }
        return next ?? prev;
      });
      return;
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
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}></text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            Editor Integrations
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <box flexDirection="column" height={Math.min(ITEMS.length, maxVisible)} overflow="hidden">
          {ITEMS.slice(scrollOffset, scrollOffset + maxVisible).map((item, vi) => {
            const i = vi + scrollOffset;
            const isSelected = i === cursor;
            const isEnabled = current[item.key];
            const bg = isSelected ? POPUP_HL : POPUP_BG;
            return (
              <PopupRow key={item.key} bg={bg} w={innerW}>
                <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                  {isSelected ? "› " : "  "}
                </text>
                <text bg={bg} fg={isEnabled ? "#2d5" : "#555"}>
                  [{isEnabled ? "x" : " "}]
                </text>
                <text bg={bg} fg={isEnabled ? "white" : "#666"}>
                  {" "}
                  {item.label.padEnd(20)}
                </text>
                <text bg={bg} fg="#555" truncate>
                  {item.desc}
                </text>
              </PopupRow>
            );
          })}
        </box>
        {ITEMS.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(ITEMS.length)}
              {scrollOffset + maxVisible < ITEMS.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"Scope: "}
          </text>
          {CONFIG_SCOPES.map((s) => (
            <text
              key={s}
              bg={POPUP_BG}
              fg={s === scope ? "#8B5CF6" : "#444"}
              attributes={s === scope ? TextAttributes.BOLD : undefined}
            >
              {s === scope ? `[${s}]` : ` ${s} `}
              {"  "}
            </text>
          ))}
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"↑↓"} navigate | {"⏎"} toggle | a all on | n all off | {"← →"} scope | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
