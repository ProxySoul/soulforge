import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useState } from "react";
import { CORE_TOOL_NAMES, DEFERRED_TOOL_CATALOG } from "../../core/tools/constants.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 100;
const CHROME_ROWS = 5;

interface ToolEntry {
  name: string;
  desc: string;
  core: boolean;
}

const ALL_TOOLS: ToolEntry[] = [
  ...CORE_TOOL_NAMES.map((name) => ({
    name,
    desc: DEFERRED_TOOL_CATALOG[name] ?? "Core tool",
    core: true,
  })),
  ...Object.entries(DEFERRED_TOOL_CATALOG)
    .filter(([name]) => !CORE_TOOL_NAMES.includes(name))
    .map(([name, desc]) => ({ name, desc, core: false })),
];

interface Props {
  visible: boolean;
  disabledTools: Set<string>;
  agentManaged: boolean;
  onToggleTool: (name: string) => void;
  onToggleAgentManaged: () => void;
  onClose: () => void;
}

const ToolRow = memo(function ToolRow({
  tool,
  enabled,
  selected,
  w,
}: {
  tool: ToolEntry;
  enabled: boolean;
  selected: boolean;
  w: number;
}) {
  const bg = selected ? POPUP_HL : POPUP_BG;
  const check = enabled ? "x" : " ";
  const nameColor = enabled ? (tool.core ? "#2d9bf0" : "#ccc") : "#555";
  const descColor = enabled ? "#666" : "#444";
  const tag = tool.core ? " core" : "";
  const tagColor = "#444";
  const maxDesc = Math.max(0, w - tool.name.length - tag.length - 10);
  const desc = tool.desc.length > maxDesc ? `${tool.desc.slice(0, maxDesc - 1)}…` : tool.desc;

  return (
    <PopupRow bg={bg} w={w}>
      <text bg={bg} fg={enabled ? "#2d5" : "#555"}>
        [{check}]
      </text>
      <text bg={bg} fg={nameColor}>
        {" "}
        {tool.name}
      </text>
      <text bg={bg} fg={tagColor}>
        {tag}
      </text>
      <text bg={bg} fg={descColor}>
        {" "}
        {desc}
      </text>
    </PopupRow>
  );
});

export function ToolsPopup({
  visible,
  disabledTools,
  agentManaged,
  onToggleTool,
  onToggleAgentManaged,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupW = Math.min(MAX_POPUP_WIDTH, termCols - 4);
  const innerW = popupW - 2;
  const maxVisible = Math.max(5, termRows - CHROME_ROWS - 4);

  const items = ALL_TOOLS;
  const totalItems = items.length + 1;

  const { cursor, setCursor, scrollOffset, adjustScroll } = usePopupScroll(maxVisible);
  const [initialized, setInitialized] = useState(false);
  if (visible && !initialized) {
    setCursor(0);
    adjustScroll(0);
    setInitialized(true);
  }
  if (!visible && initialized) setInitialized(false);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      const next = Math.max(0, cursor - 1);
      setCursor(next);
      adjustScroll(next);
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      const next = Math.min(totalItems - 1, cursor + 1);
      setCursor(next);
      adjustScroll(next);
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      if (cursor < items.length) {
        onToggleTool(items[cursor]?.name);
      } else {
        onToggleAgentManaged();
      }
    }
  });

  if (!visible) return null;

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);
  const agentRowVisible = scrollOffset + maxVisible > items.length;

  return (
    <Overlay>
      <box borderStyle="rounded" border borderColor="#8B5CF6" flexDirection="column" width={popupW}>
        <PopupRow w={innerW}>
          <text fg="#8B5CF6" attributes={TextAttributes.BOLD}>
            Tools
          </text>
          <text fg="#555"> — space to toggle, esc to close</text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#333">{"─".repeat(innerW)}</text>
        </PopupRow>

        {visibleItems.map((tool, i) => {
          const idx = scrollOffset + i;
          return (
            <ToolRow
              key={tool.name}
              tool={tool}
              enabled={!disabledTools.has(tool.name)}
              selected={cursor === idx}
              w={innerW}
            />
          );
        })}

        {agentRowVisible && (
          <>
            <PopupRow w={innerW}>
              <text fg="#333">{"─".repeat(innerW)}</text>
            </PopupRow>
            <PopupRow bg={cursor === items.length ? POPUP_HL : POPUP_BG} w={innerW}>
              <text
                bg={cursor === items.length ? POPUP_HL : POPUP_BG}
                fg={agentManaged ? "#2d5" : "#555"}
              >
                [{agentManaged ? "x" : " "}]
              </text>
              <text bg={cursor === items.length ? POPUP_HL : POPUP_BG} fg="#e0a020">
                {" "}
                Agent-managed tools
              </text>
              <text bg={cursor === items.length ? POPUP_HL : POPUP_BG} fg="#666">
                {" "}
                allow agent to request/release tools
              </text>
            </PopupRow>
          </>
        )}
      </box>
    </Overlay>
  );
}
