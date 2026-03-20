import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES, Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 52;
const CHROME_ROWS = 7;

export interface CommandPickerOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  disabled?: boolean;
}

export interface CommandPickerConfig {
  title: string;
  icon?: string;
  options: CommandPickerOption[];
  currentValue?: string;
  scopeEnabled?: boolean;
  initialScope?: ConfigScope;
  maxWidth?: number;
  keepOpen?: boolean;
  onSelect: (value: string, scope?: ConfigScope) => void;
  onScopeMove?: (value: string, fromScope: ConfigScope, toScope: ConfigScope) => void;
}

interface Props {
  visible: boolean;
  config: CommandPickerConfig | null;
  onClose: () => void;
}

export function CommandPicker({ visible, config, onClose }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const maxW = config?.maxWidth ?? MAX_POPUP_WIDTH;
  const popupWidth = Math.min(maxW, Math.floor(termCols * 0.7));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.7) - CHROME_ROWS);
  const { cursor, setCursor, scrollOffset, setScrollOffset, adjustScroll } =
    usePopupScroll(maxVisible);
  const [scope, setScope] = useState<ConfigScope>("project");

  const prevVisibleRef = useRef(false);
  const prevOptionsRef = useRef<CommandPickerOption[] | null>(null);
  useEffect(() => {
    if (!visible || !config) {
      prevVisibleRef.current = visible;
      prevOptionsRef.current = null;
      return;
    }
    const justOpened = !prevVisibleRef.current;
    prevVisibleRef.current = true;
    if (justOpened) {
      let idx = config.options.findIndex((o) => o.value === config.currentValue);
      if (idx < 0) idx = config.options.findIndex((o) => !o.disabled);
      setCursor(idx >= 0 ? idx : 0);
      setScrollOffset(0);
      if (config.scopeEnabled) setScope(config.initialScope ?? "project");
    } else if (prevOptionsRef.current && prevOptionsRef.current !== config.options) {
      setCursor((prev) => {
        const prevValue = prevOptionsRef.current?.[prev]?.value;
        if (prevValue) {
          const newIdx = config.options.findIndex((o) => o.value === prevValue);
          if (newIdx >= 0) return newIdx;
        }
        return Math.min(prev, Math.max(0, config.options.length - 1));
      });
    }
    prevOptionsRef.current = config.options;
  }, [visible, config, setCursor, setScrollOffset]);

  useKeyboard((evt) => {
    if (!visible || !config) return;

    if (evt.name === "escape") {
      onClose();
      return;
    }

    if (evt.name === "up" || evt.name === "k") {
      setCursor((prev) => {
        let next = prev > 0 ? prev - 1 : config.options.length - 1;
        const start = next;
        while (config.options[next]?.disabled) {
          next = next > 0 ? next - 1 : config.options.length - 1;
          if (next === start) break;
        }
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "down" || evt.name === "j") {
      setCursor((prev) => {
        let next = prev < config.options.length - 1 ? prev + 1 : 0;
        const start = next;
        while (config.options[next]?.disabled) {
          next = next < config.options.length - 1 ? next + 1 : 0;
          if (next === start) break;
        }
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "return") {
      const option = config.options[cursor];
      if (option && !option.disabled) {
        const cb = config.onSelect;
        const val = option.value;
        const s = config.scopeEnabled ? scope : undefined;
        if (!config.keepOpen) onClose();
        cb(val, s);
      }
      return;
    }

    if (config.scopeEnabled) {
      if (evt.name === "left" || evt.name === "right") {
        setScope((prev) => {
          const idx = CONFIG_SCOPES.indexOf(prev);
          const next =
            evt.name === "left"
              ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
              : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
          const val = config.options[cursor]?.value;
          if (next !== prev && val && config.onScopeMove) {
            config.onScopeMove(val, prev, next as ConfigScope);
          }
          return next as ConfigScope;
        });
        return;
      }
    }
  });

  if (!visible || !config) return null;

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
          {config.icon && (
            <text fg="#9B30FF" bg={POPUP_BG}>
              {config.icon}{" "}
            </text>
          )}
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {config.title}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        <box
          flexDirection="column"
          height={Math.min(
            config.options.reduce((sum, o) => sum + 1 + (o.description ? 1 : 0), 0) || 1,
            maxVisible,
          )}
          overflow="hidden"
        >
          {config.options.slice(scrollOffset, scrollOffset + maxVisible).map((option, vi) => {
            const i = vi + scrollOffset;
            const isActive = i === cursor;
            const isCurrent = option.value === config.currentValue;
            const isDisabled = option.disabled === true;
            const bg = isActive && !isDisabled ? POPUP_HL : POPUP_BG;
            const activeColor = option.color ?? "#FF0040";
            const labelFg = isDisabled
              ? "#444"
              : isActive
                ? activeColor
                : isCurrent
                  ? "#00FF00"
                  : "#aaa";

            return (
              <box key={option.value} flexDirection="column">
                <PopupRow bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive && !isDisabled ? activeColor : "#555"}>
                    {isActive && !isDisabled ? "› " : "  "}
                  </text>
                  {option.icon && (
                    <text bg={bg} fg={isDisabled ? "#333" : isActive ? activeColor : "#777"}>
                      {option.icon}{" "}
                    </text>
                  )}
                  <text
                    bg={bg}
                    fg={labelFg}
                    attributes={isActive && !isDisabled ? TextAttributes.BOLD : undefined}
                  >
                    {option.label}
                  </text>
                  {isCurrent && !isDisabled && (
                    <text bg={bg} fg="#00FF00">
                      {" "}
                      ✓
                    </text>
                  )}
                </PopupRow>
                {option.description && (
                  <PopupRow bg={bg} w={innerW}>
                    <text bg={bg} fg={isDisabled ? "#333" : isActive ? "#888" : "#555"} truncate>
                      {"    "}
                      {option.icon ? "  " : ""}
                      {option.description.length > innerW - 10
                        ? `${option.description.slice(0, innerW - 13)}…`
                        : option.description}
                    </text>
                  </PopupRow>
                )}
              </box>
            );
          })}
        </box>
        {config.options.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(config.options.length)}
              {scrollOffset + maxVisible < config.options.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        {config.scopeEnabled && (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#555">
              {"Save to: "}
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
        )}

        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {"↑↓"} navigate | {"⏎"} select{config.scopeEnabled ? " | ← → scope" : ""} | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
