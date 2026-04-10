import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES, Popup, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 60;
const CHROME_ROWS = 7;

export interface CommandPickerOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
  disabled?: boolean;
}

interface PickerToggle {
  key: string;
  label: string;
  value: boolean;
  /** Return a new label string to update the toggle label dynamically */
  onToggle: () => string | undefined;
}

interface PickerSelector {
  key: string;
  label: string;
  options: string[];
  value: number;
  onChange: (index: number) => void;
}

interface PickerInput {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  activateFromOptionValue?: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
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
  searchable?: boolean;
  toggles?: PickerToggle[];
  selectors?: PickerSelector[];
  input?: PickerInput;
  onSelect: (value: string, scope?: ConfigScope) => void;
  onScopeMove?: (value: string, fromScope: ConfigScope, toScope: ConfigScope) => void;
  onCursorChange?: (value: string) => void;
  onCancel?: () => void;
}

interface Props {
  visible: boolean;
  config: CommandPickerConfig | null;
  onClose: () => void;
}

/** Simple fuzzy match — returns score and matched indices, or null if no match */
function fuzzyScore(query: string, target: string): { score: number; indices: number[] } | null {
  if (query.length === 0) return { score: 0, indices: [] };
  const lower = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  const indices: number[] = [];
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      indices.push(i);
      qi++;
    }
  }
  if (qi < q.length) return null;
  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    if (indices[k] === 0) score += 10;
    if (k > 0 && (indices[k] as number) === (indices[k - 1] as number) + 1) score += 5;
  }
  score -= indices.length > 0 ? (indices[0] as number) : 0;
  return { score, indices };
}

/** Focus zone: -1 = options list, 0+ = index into combined toggles+selectors */
const ZONE_LIST = -1;

interface OptionRowProps {
  option: CommandPickerOption;
  isActive: boolean;
  isCurrent: boolean;
  innerW: number;
  popupBg: string;
  popupHl: string;
  brandSecondary: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  textFaint: string;
  successColor: string;
}

function OptionRow({
  option,
  isActive,
  isCurrent,
  innerW,
  popupBg,
  popupHl,
  brandSecondary,
  textPrimary,
  textSecondary,
  textMuted,
  textDim,
  textFaint,
  successColor,
}: OptionRowProps) {
  const isDisabled = option.disabled === true;
  const bg = isActive && !isDisabled ? popupHl : popupBg;
  const activeColor = option.color ?? brandSecondary;
  const labelFg = isDisabled
    ? textDim
    : isActive
      ? activeColor
      : isCurrent
        ? successColor
        : textPrimary;

  return (
    <box flexDirection="column">
      <PopupRow bg={bg} w={innerW}>
        <text bg={bg} fg={isActive && !isDisabled ? activeColor : textMuted}>
          {isActive && !isDisabled ? "› " : "  "}
        </text>
        {option.icon && (
          <text bg={bg} fg={isDisabled ? textFaint : isActive ? activeColor : textSecondary}>
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
          <text bg={bg} fg={successColor}>
            {" "}
            ✓
          </text>
        )}
      </PopupRow>
      {option.description && (
        <PopupRow bg={bg} w={innerW}>
          <text bg={bg} fg={isDisabled ? textFaint : isActive ? textSecondary : textMuted} truncate>
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
}

export function CommandPicker({ visible, config, onClose }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const maxW = config?.maxWidth ?? MAX_POPUP_WIDTH;
  const popupWidth = Math.min(maxW, Math.floor(termCols * 0.8));
  const innerW = popupWidth - 2;
  const controlRows = (config?.toggles?.length ?? 0) + (config?.selectors?.length ?? 0);
  const extraChrome = controlRows > 0 ? controlRows + 1 : 0; // +1 for separator
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS - extraChrome);
  const { cursor, setCursor, scrollOffset, setScrollOffset, adjustScroll } =
    usePopupScroll(maxVisible);
  const [scope, setScope] = useState<ConfigScope>("project");
  const [search, setSearch] = useState("");
  const [toggleState, setToggleState] = useState<Record<string, boolean>>({});
  const [toggleLabels, setToggleLabels] = useState<Record<string, string>>({});
  const [selectorState, setSelectorState] = useState<Record<string, number>>({});
  const [inputValue, setInputValue] = useState("");
  const [focusZone, setFocusZone] = useState(ZONE_LIST);

  const controls = (() => {
    const list: Array<
      | { type: "toggle"; key: string }
      | { type: "selector"; key: string }
      | { type: "input"; key: string }
    > = [];
    if (config?.toggles)
      for (const tg of config.toggles) list.push({ type: "toggle", key: tg.key });
    if (config?.selectors)
      for (const sel of config.selectors) list.push({ type: "selector", key: sel.key });
    if (config?.input) list.push({ type: "input", key: config.input.key });
    return list;
  })();

  const hasControls = controls.length > 0;

  const filteredOptions = (() => {
    if (!config?.searchable || search.length === 0) return config?.options ?? [];
    const scored: Array<{ option: CommandPickerOption; score: number }> = [];
    for (const option of config.options) {
      const hit =
        fuzzyScore(search, option.label) ??
        fuzzyScore(search, option.value) ??
        (option.description ? fuzzyScore(search, option.description) : null);
      if (hit) scored.push({ option, score: hit.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.option);
  })();

  const prevVisibleRef = useRef(false);
  const prevOptionsRef = useRef<CommandPickerOption[] | null>(null);
  useEffect(() => {
    if (!visible || !config) {
      prevVisibleRef.current = visible;
      prevOptionsRef.current = null;
      setSearch("");
      return;
    }
    const justOpened = !prevVisibleRef.current;
    prevVisibleRef.current = true;
    if (justOpened) {
      setSearch("");
      if (config.toggles) {
        const initial: Record<string, boolean> = {};
        const initialLabels: Record<string, string> = {};
        for (const tg of config.toggles) {
          initial[tg.key] = tg.value;
          initialLabels[tg.key] = tg.label;
        }
        setToggleState(initial);
        setToggleLabels(initialLabels);
      }
      if (config.selectors) {
        const initial: Record<string, number> = {};
        for (const sel of config.selectors) initial[sel.key] = sel.value;
        setSelectorState(initial);
      }
      setInputValue(config.input?.value ?? "");
      let idx = filteredOptions.findIndex((o) => o.value === config.currentValue);
      if (idx < 0) idx = filteredOptions.findIndex((o) => !o.disabled);
      const startIdx = idx >= 0 ? idx : 0;
      setCursor(startIdx);
      setScrollOffset(Math.max(0, startIdx - Math.floor(maxVisible / 2)));
      if (config.scopeEnabled) setScope(config.initialScope ?? "project");
      setFocusZone(ZONE_LIST);
    } else if (prevOptionsRef.current && prevOptionsRef.current !== filteredOptions) {
      setCursor((prev) => {
        const prevValue = prevOptionsRef.current?.[prev]?.value;
        if (prevValue) {
          const newIdx = filteredOptions.findIndex((o) => o.value === prevValue);
          if (newIdx >= 0) return newIdx;
        }
        return Math.min(prev, Math.max(0, filteredOptions.length - 1));
      });
    }
    prevOptionsRef.current = filteredOptions;
  }, [visible, config, filteredOptions, setCursor, setScrollOffset, maxVisible]);

  // Reset cursor when search text changes (not on initial open)
  const prevSearch = useRef("");
  useEffect(() => {
    if (!config?.searchable) return;
    if (search !== prevSearch.current) {
      prevSearch.current = search;
      if (search.length > 0) {
        setCursor(0);
        setScrollOffset(0);
      }
    }
  }, [search, config?.searchable, setCursor, setScrollOffset]);

  // Fire onCursorChange for live preview
  const prevCursorValue = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !config?.onCursorChange) return;
    const val = filteredOptions[cursor]?.value;
    if (val && val !== prevCursorValue.current) {
      prevCursorValue.current = val;
      config.onCursorChange(val);
    }
  }, [cursor, visible, config, filteredOptions]);

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!visible || !config) return;

    if (evt.name === "escape") {
      config.onCancel?.();
      onClose();
      return;
    }

    // Shortcut keys for toggles/selectors still work from anywhere
    if (config.toggles) {
      for (const toggle of config.toggles) {
        if (evt.name === toggle.key) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
          return;
        }
      }
    }
    if (config.selectors) {
      for (const sel of config.selectors) {
        if (evt.name === sel.key) {
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + 1) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
          return;
        }
      }
    }

    if (config.input && focusZone >= 0 && controls[focusZone]?.type === "input") {
      if (evt.name === "backspace" || evt.name === "delete") {
        const next = inputValue.slice(0, -1);
        setInputValue(next);
        config.input.onChange(next);
        return;
      }
      if (evt.name === "return") {
        config.input.onSubmit?.(inputValue);
        return;
      }
      if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        const next = inputValue + evt.name;
        setInputValue(next);
        config.input.onChange(next);
        return;
      }
    }

    if (
      config.input &&
      focusZone === ZONE_LIST &&
      filteredOptions[cursor]?.value === config.input.activateFromOptionValue
    ) {
      if (evt.name === "return") {
        const inputIndex = controls.findIndex((ctrl) => ctrl.type === "input");
        if (inputIndex >= 0) setFocusZone(inputIndex);
        return;
      }
      if (evt.name === "backspace" || evt.name === "delete") {
        const next = inputValue.slice(0, -1);
        setInputValue(next);
        config.input.onChange(next);
        const inputIndex = controls.findIndex((ctrl) => ctrl.type === "input");
        if (inputIndex >= 0) setFocusZone(inputIndex);
        return;
      }
      if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        const next = inputValue + evt.name;
        setInputValue(next);
        config.input.onChange(next);
        const inputIndex = controls.findIndex((ctrl) => ctrl.type === "input");
        if (inputIndex >= 0) setFocusZone(inputIndex);
        return;
      }
    }

    // Search input handling
    if (config.searchable && focusZone === ZONE_LIST) {
      if (evt.name === "backspace" || evt.name === "delete") {
        setSearch((prev) => prev.slice(0, -1));
        return;
      }
      if (
        evt.name &&
        evt.name.length === 1 &&
        !evt.ctrl &&
        !evt.meta &&
        evt.name !== "j" &&
        evt.name !== "k"
      ) {
        setSearch((prev) => prev + evt.name);
        return;
      }
    }

    // Up/down navigation — moves between list items and control zones
    if (evt.name === "up" || evt.name === "k") {
      if (focusZone > 0) {
        // Move up within controls
        setFocusZone(focusZone - 1);
      } else if (focusZone === 0) {
        // Move from first control back to list (last item)
        setFocusZone(ZONE_LIST);
        const lastIdx = filteredOptions.length - 1;
        setCursor(lastIdx);
        adjustScroll(lastIdx);
      } else {
        // In list — move up, or wrap to last control
        setCursor((prev) => {
          if (prev > 0) {
            let next = prev - 1;
            const start = next;
            while (filteredOptions[next]?.disabled) {
              next = next > 0 ? next - 1 : filteredOptions.length - 1;
              if (next === start) break;
            }
            adjustScroll(next);
            return next;
          }
          // At top of list — wrap to last control if available
          if (hasControls) {
            setFocusZone(controls.length - 1);
          }
          return prev;
        });
      }
      return;
    }

    if (evt.name === "down" || evt.name === "j") {
      if (focusZone === ZONE_LIST) {
        // In list — move down, or enter controls
        setCursor((prev) => {
          if (prev < filteredOptions.length - 1) {
            let next = prev + 1;
            const start = next;
            while (filteredOptions[next]?.disabled) {
              next = next < filteredOptions.length - 1 ? next + 1 : 0;
              if (next === start) break;
            }
            adjustScroll(next);
            return next;
          }
          // At bottom of list — enter first control
          if (hasControls) {
            setFocusZone(0);
          }
          return prev;
        });
      } else if (focusZone < controls.length - 1) {
        // Move down within controls
        setFocusZone(focusZone + 1);
      } else {
        // At last control — wrap to top of list
        setFocusZone(ZONE_LIST);
        setCursor(0);
        adjustScroll(0);
      }
      return;
    }

    // Left/right in control zones changes values
    if ((evt.name === "left" || evt.name === "right") && focusZone >= 0) {
      const ctrl = controls[focusZone];
      if (ctrl?.type === "toggle") {
        const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
        if (toggle) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
        }
      } else if (ctrl?.type === "selector") {
        const sel = config.selectors?.find((s) => s.key === ctrl.key);
        if (sel) {
          const dir = evt.name === "right" ? 1 : -1;
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + dir + sel.options.length) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
        }
      }
      return;
    }

    // Enter in control zone activates the control
    if (evt.name === "return" && focusZone >= 0) {
      const ctrl = controls[focusZone];
      if (ctrl?.type === "toggle") {
        const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
        if (toggle) {
          const newLabel = toggle.onToggle();
          if (typeof newLabel === "string") {
            setToggleLabels((prev) => ({ ...prev, [toggle.key]: newLabel }));
          } else {
            setToggleState((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }));
          }
        }
      } else if (ctrl?.type === "selector") {
        // Enter on selector cycles forward
        const sel = config.selectors?.find((s) => s.key === ctrl.key);
        if (sel) {
          setSelectorState((prev) => {
            const cur = prev[sel.key] ?? sel.value;
            const next = (cur + 1) % sel.options.length;
            sel.onChange(next);
            return { ...prev, [sel.key]: next };
          });
        }
      }
      return;
    }

    // Enter in list zone selects the option
    if (evt.name === "return" && focusZone === ZONE_LIST) {
      const option = filteredOptions[cursor];
      if (option && !option.disabled) {
        const cb = config.onSelect;
        const val = option.value;
        const s = config.scopeEnabled ? scope : undefined;
        if (!config.keepOpen) onClose();
        cb(val, s);
      }
      return;
    }

    // Left/right in list zone changes scope
    if (config.scopeEnabled && focusZone === ZONE_LIST) {
      if (evt.name === "left" || evt.name === "right") {
        setScope((prev) => {
          const idx = CONFIG_SCOPES.indexOf(prev);
          const next =
            evt.name === "left"
              ? CONFIG_SCOPES[(idx - 1 + CONFIG_SCOPES.length) % CONFIG_SCOPES.length]
              : CONFIG_SCOPES[(idx + 1) % CONFIG_SCOPES.length];
          const val = filteredOptions[cursor]?.value;
          if (next !== prev && val && config.onScopeMove) {
            config.onScopeMove(val, prev, next as ConfigScope);
          }
          return next as ConfigScope;
        });
        return;
      }
    }
  };

  useKeyboard(handleKeyboard);

  if (!visible || !config) return null;

  // Clamp scrollOffset so the visible window is always full
  const maxOffset = Math.max(0, filteredOptions.length - maxVisible);
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  const POPUP_BG = t.bgPopup;
  const POPUP_HL = t.bgPopupHighlight;

  return (
    <Popup
      width={popupWidth}
      title={config.title}
      icon={config.icon}
      footer={[
        { key: "\u2191\u2193", label: "navigate" },
        ...(hasControls ? [{ key: "\u2190\u2192", label: "adjust" }] : []),
        { key: "\u23CE", label: "select" },
        ...(config.searchable ? [{ key: "type", label: "filter" }] : []),
        ...(config.scopeEnabled ? [{ key: "\u2190\u2192", label: "scope" }] : []),
        { key: "esc", label: "close" },
      ]}
    >
      {config.searchable && (
        <PopupRow w={innerW}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {"🔍 "}
          </text>
          <text fg={t.textPrimary} bg={POPUP_BG}>
            {search || ""}
          </text>
          <text fg={t.brand} bg={POPUP_BG}>
            {"▌"}
          </text>
          {search.length === 0 && (
            <text fg={t.textDim} bg={POPUP_BG}>
              {" type to filter..."}
            </text>
          )}
        </PopupRow>
      )}

      <PopupRow w={innerW}>
        <text fg={t.textFaint} bg={POPUP_BG}>
          {"─".repeat(innerW - 4)}
        </text>
      </PopupRow>

      <box
        flexDirection="column"
        height={Math.min(
          filteredOptions.reduce((sum, o) => sum + 1 + (o.description ? 1 : 0), 0) || 1,
          maxVisible,
        )}
        overflow="hidden"
      >
        {filteredOptions.length === 0 ? (
          <PopupRow w={innerW}>
            <text fg={t.textMuted} bg={POPUP_BG}>
              {"  No matches"}
            </text>
          </PopupRow>
        ) : (
          filteredOptions
            .slice(clampedOffset, clampedOffset + maxVisible)
            .map((option, vi) => (
              <OptionRow
                key={option.value}
                option={option}
                isActive={vi + clampedOffset === cursor}
                isCurrent={option.value === config.currentValue}
                innerW={innerW}
                popupBg={POPUP_BG}
                popupHl={POPUP_HL}
                brandSecondary={t.brandSecondary}
                textPrimary={t.textPrimary}
                textSecondary={t.textSecondary}
                textMuted={t.textMuted}
                textDim={t.textDim}
                textFaint={t.textFaint}
                successColor={t.success}
              />
            ))
        )}
      </box>
      {filteredOptions.length > maxVisible && (
        <PopupRow w={innerW}>
          <text fg={t.textSecondary} bg={POPUP_BG}>
            {clampedOffset > 0 ? "↑ " : "  "}
            {String(cursor + 1)}/{String(filteredOptions.length)}
            {clampedOffset + maxVisible < filteredOptions.length ? " ↓" : ""}
          </text>
        </PopupRow>
      )}

      <PopupRow w={innerW}>
        <text>{""}</text>
      </PopupRow>

      {hasControls && (
        <>
          <PopupRow w={innerW}>
            <text fg={t.textFaint} bg={POPUP_BG}>
              {"─".repeat(innerW - 4)}
            </text>
          </PopupRow>
          {controls.map((ctrl, ci) => {
            const focused = focusZone === ci;
            const bg = focused ? POPUP_HL : POPUP_BG;
            if (ctrl.type === "toggle") {
              const toggle = config.toggles?.find((tg) => tg.key === ctrl.key);
              if (!toggle) return null;
              const on = toggleState[toggle.key] ?? toggle.value;
              return (
                <PopupRow key={ctrl.key} bg={bg} w={innerW}>
                  <text bg={bg} fg={focused ? t.brandAlt : on ? t.success : t.textDim}>
                    {focused ? "› " : "  "}
                    {on ? "◉" : "◯"}{" "}
                  </text>
                  <text
                    bg={bg}
                    fg={focused ? t.textPrimary : on ? t.textPrimary : t.textMuted}
                    attributes={focused ? TextAttributes.BOLD : undefined}
                  >
                    {toggleLabels[toggle.key] ?? toggle.label}
                  </text>
                  <text bg={bg} fg={t.textMuted}>
                    {"  "}
                    <span fg={on ? t.success : t.textDim} attributes={TextAttributes.BOLD}>
                      {"<"}
                      {toggle.key === "tab" ? "TAB" : toggle.key}
                      {">"}
                    </span>
                  </text>
                </PopupRow>
              );
            }
            if (ctrl.type === "input") {
              const input = config.input;
              if (!input) return null;
              const activatedFromList =
                !!input.activateFromOptionValue &&
                filteredOptions[cursor]?.value === input.activateFromOptionValue;
              return (
                <PopupRow key={ctrl.key} bg={bg} w={innerW}>
                  <text bg={bg} fg={focused || activatedFromList ? t.brandAlt : t.textMuted}>
                    {focused ? "› " : "  "}
                    {input.label}
                    {"  "}
                  </text>
                  <text bg={bg} fg={t.textPrimary}>
                    {inputValue || ""}
                  </text>
                  {(focused || activatedFromList) && (
                    <text bg={bg} fg={t.brand}>
                      ▌
                    </text>
                  )}
                  {!inputValue && input.placeholder && (
                    <text bg={bg} fg={t.textDim}>
                      {` ${input.placeholder}`}
                    </text>
                  )}
                </PopupRow>
              );
            }
            // selector
            const sel = config.selectors?.find((s) => s.key === ctrl.key);
            if (!sel) return null;
            const cur = selectorState[sel.key] ?? sel.value;
            return (
              <PopupRow key={ctrl.key} bg={bg} w={innerW}>
                <text bg={bg} fg={focused ? t.brandAlt : t.textMuted}>
                  {focused ? "› " : "  "}
                  {sel.label}
                  {"  "}
                </text>
                {sel.options.map((opt, i) => (
                  <text
                    key={opt}
                    bg={bg}
                    fg={i === cur ? t.brandAlt : t.textDim}
                    attributes={i === cur ? TextAttributes.BOLD : undefined}
                  >
                    {i === cur ? `[${opt}]` : ` ${opt} `}
                  </text>
                ))}
                {!focused && (
                  <text bg={bg} fg={t.textDim}>
                    {"  "}
                    <span fg={t.textFaint} attributes={TextAttributes.BOLD}>
                      {"<"}
                      {sel.key.toUpperCase()}
                      {">"}
                    </span>
                  </text>
                )}
                {focused && (
                  <text bg={bg} fg={t.textDim}>
                    {"  ← →"}
                  </text>
                )}
              </PopupRow>
            );
          })}
        </>
      )}

      {config.scopeEnabled && (
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textMuted}>
            {"Save to: "}
          </text>
          {CONFIG_SCOPES.map((s) => (
            <text
              key={s}
              bg={POPUP_BG}
              fg={s === scope ? t.brandAlt : t.textDim}
              attributes={s === scope ? TextAttributes.BOLD : undefined}
            >
              {s === scope ? `[${s}]` : ` ${s} `}
              {"  "}
            </text>
          ))}
        </PopupRow>
      )}
    </Popup>
  );
}
