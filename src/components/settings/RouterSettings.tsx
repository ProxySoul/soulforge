import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { icon } from "../../core/icons.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { TaskRouter } from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES, Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 70;
const CHROME_ROWS = 10;

interface SlotItem {
  key: keyof TaskRouter;
  label: string;
  desc: string;
}

const SLOTS: SlotItem[] = [
  { key: "planning", label: "Planning", desc: "[PLAN MODE] & plan tool" },
  { key: "coding", label: "Coding", desc: "code subagent" },
  { key: "exploration", label: "Exploration", desc: "explore subagent" },
  { key: "webSearch", label: "Web Search", desc: "browser & web search tasks" },
  { key: "compact", label: "Compact", desc: "context compaction summarizer" },
  { key: "semantic", label: "Semantic", desc: "soul map summary generation" },
  { key: "trivial", label: "Trivial", desc: "single-file reads, small edits (fast/cheap)" },
  { key: "desloppify", label: "De-sloppify", desc: "cleanup pass after code agents" },
  { key: "verify", label: "Verify", desc: "adversarial review after code agents" },
  { key: "editing", label: "Editing", desc: "main agent edit steps (switches after first edit)" },
  { key: "default", label: "Default", desc: "everything else" },
];

interface Props {
  visible: boolean;
  router: TaskRouter | undefined;
  activeModel: string;
  scope: ConfigScope;
  onScopeChange: (toScope: ConfigScope, fromScope: ConfigScope) => void;
  onPickSlot: (slot: keyof TaskRouter) => void;
  onClearSlot: (slot: keyof TaskRouter) => void;
  onClose: () => void;
}

export function RouterSettings({
  visible,
  router,
  activeModel,
  scope,
  onScopeChange,
  onPickSlot,
  onClearSlot,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.8));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS);
  const { cursor, setCursor, scrollOffset, adjustScroll } = usePopupScroll(maxVisible);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "up") {
      setCursor((c) => {
        const next = c > 0 ? c - 1 : SLOTS.length - 1;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => {
        const next = c < SLOTS.length - 1 ? c + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "return") {
      const slot = SLOTS[cursor];
      if (slot) onPickSlot(slot.key);
      return;
    }
    if (evt.name === "d" || evt.name === "delete" || evt.name === "backspace") {
      const slot = SLOTS[cursor];
      if (slot) onClearSlot(slot.key);
      return;
    }
    if (evt.name === "left" || evt.name === "right") {
      const idx = CONFIG_SCOPES.indexOf(scope);
      const next =
        evt.name === "left"
          ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
          : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
      if (next !== scope) onScopeChange(next as ConfigScope, scope);
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
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
            {icon("router")}
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            Task Router
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <box flexDirection="column" height={Math.min(SLOTS.length, maxVisible)} overflow="hidden">
          {SLOTS.slice(scrollOffset, scrollOffset + maxVisible).map((slot, vi) => {
            const i = vi + scrollOffset;
            const isSelected = i === cursor;
            const bg = isSelected ? POPUP_HL : POPUP_BG;
            const modelId = router?.[slot.key] ?? null;
            const displayModel = modelId ?? `(${activeModel})`;
            const isDefault = !modelId;
            return (
              <PopupRow key={slot.key} bg={bg} w={innerW}>
                <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                  {isSelected ? "› " : "  "}
                </text>
                <text
                  bg={bg}
                  fg={isSelected ? "white" : "#aaa"}
                  attributes={isSelected ? TextAttributes.BOLD : undefined}
                >
                  {slot.label.padEnd(14)}
                </text>
                <text bg={bg} fg={isDefault ? "#555" : "#2d5"}>
                  {displayModel.length > 28 ? `${displayModel.slice(0, 25)}...` : displayModel}
                </text>
              </PopupRow>
            );
          })}
        </box>
        {SLOTS.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(SLOTS.length)}
              {scrollOffset + maxVisible < SLOTS.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text bg={POPUP_BG}>{""}</text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {SLOTS[cursor]?.desc ?? ""}
          </text>
        </PopupRow>

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
            {"↑↓"} navigate | {"⏎"} pick model | d default | {"← →"} scope | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
