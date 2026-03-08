import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import type {
  AppConfig,
  ContextManagementConfig,
  EffortLevel,
  PerformanceConfig,
  ThinkingMode,
} from "../types/index.js";
import type { ConfigScope } from "./shared.js";
import { CONFIG_SCOPES, POPUP_BG, POPUP_HL, PopupRow } from "./shared.js";

const MAX_POPUP_WIDTH = 60;
const CHROME_ROWS = 9;

export type ProviderScope = ConfigScope;

type ItemType = "cycle" | "toggle" | "budget";

interface SettingItem {
  key: string;
  label: string;
  desc: string;
  type: ItemType;
  section?: string;
  options?: string[];
}

const ITEMS: SettingItem[] = [
  {
    key: "thinkingMode",
    label: "Mode",
    desc: "off = not sent to API",
    type: "cycle",
    section: "THINKING",
    options: ["off", "disabled", "auto", "adaptive", "enabled"],
  },
  {
    key: "budgetTokens",
    label: "Budget Tokens",
    desc: "enabled mode only",
    type: "budget",
    options: ["1024", "2048", "5000", "10000", "20000"],
  },
  {
    key: "effort",
    label: "Effort",
    desc: "off = not sent to API",
    type: "cycle",
    section: "PERFORMANCE",
    options: ["off", "low", "medium", "high", "max"],
  },
  {
    key: "speed",
    label: "Speed",
    desc: "opus only • off = not sent",
    type: "cycle",
    options: ["off", "standard", "fast"],
  },
  {
    key: "codeExecution",
    label: "Code Execution",
    desc: "sandboxed code eval",
    type: "toggle",
    section: "TOOLS",
  },
  {
    key: "webSearch",
    label: "Web Search",
    desc: "allow web search tool",
    type: "toggle",
  },
  {
    key: "compact",
    label: "Prompt Cache",
    desc: "API-level prompt caching (200K+ models)",
    type: "toggle",
    section: "CONTEXT MANAGEMENT",
  },
  {
    key: "clearToolUses",
    label: "Clear Tool Uses",
    desc: "keep last 10",
    type: "toggle",
  },
  {
    key: "clearThinking",
    label: "Clear Thinking",
    desc: "keep last 5 turns",
    type: "toggle",
  },
];

interface CurrentValues {
  thinkingMode: ThinkingMode;
  budgetTokens: number;
  effort: string;
  speed: "off" | "standard" | "fast";
  codeExecution: boolean;
  webSearch: boolean;
  compact: boolean;
  clearToolUses: boolean;
  clearThinking: boolean;
}

const DEFAULTS: CurrentValues = {
  thinkingMode: "off",
  budgetTokens: 10000,
  effort: "off",
  speed: "off",
  codeExecution: false,
  webSearch: true,
  compact: false,
  clearToolUses: false,
  clearThinking: false,
};

function readValuesFromLayer(layer: Partial<AppConfig> | null): Partial<CurrentValues> {
  if (!layer) return {};
  const v: Partial<CurrentValues> = {};
  if (layer.thinking?.mode !== undefined) v.thinkingMode = layer.thinking.mode;
  if (layer.thinking?.budgetTokens !== undefined) v.budgetTokens = layer.thinking.budgetTokens;
  if (layer.performance?.effort !== undefined) v.effort = layer.performance.effort;
  if (layer.performance?.speed !== undefined) v.speed = layer.performance.speed;
  if (layer.codeExecution !== undefined) v.codeExecution = layer.codeExecution;
  if (layer.webSearch !== undefined) v.webSearch = layer.webSearch;
  if (layer.contextManagement?.compact !== undefined) v.compact = layer.contextManagement.compact;
  if (layer.contextManagement?.clearToolUses !== undefined)
    v.clearToolUses = layer.contextManagement.clearToolUses;
  if (layer.contextManagement?.clearThinking !== undefined)
    v.clearThinking = layer.contextManagement.clearThinking;
  return v;
}

function effectiveValues(global: AppConfig, project: Partial<AppConfig> | null): CurrentValues {
  const g = { ...DEFAULTS, ...readValuesFromLayer(global) };
  const p = readValuesFromLayer(project);
  return { ...g, ...p };
}

function buildPatch(key: string, value: string | number | boolean): Partial<AppConfig> {
  switch (key) {
    case "thinkingMode":
      return { thinking: { mode: value as ThinkingMode } };
    case "budgetTokens":
      return { thinking: { mode: "enabled", budgetTokens: value as number } };
    case "effort":
      return { performance: { effort: value as EffortLevel | "off" } as PerformanceConfig };
    case "speed":
      return { performance: { speed: value as "off" | "standard" | "fast" } as PerformanceConfig };
    case "codeExecution":
      return { codeExecution: value as boolean };
    case "webSearch":
      return { webSearch: value as boolean };
    case "compact":
      return { contextManagement: { compact: value as boolean } as ContextManagementConfig };
    case "clearToolUses":
      return { contextManagement: { clearToolUses: value as boolean } as ContextManagementConfig };
    case "clearThinking":
      return { contextManagement: { clearThinking: value as boolean } as ContextManagementConfig };
    default:
      return {};
  }
}

function detectValueScope(key: string, project: Partial<AppConfig> | null): ConfigScope {
  const pv = readValuesFromLayer(project);
  if (key in pv) return "project";
  return "global";
}

function detectInitialScope(project: Partial<AppConfig> | null): ConfigScope {
  const pv = readValuesFromLayer(project);
  if (Object.keys(pv).length > 0) return "project";
  return "global";
}

interface Props {
  visible: boolean;
  globalConfig: AppConfig;
  projectConfig: Partial<AppConfig> | null;
  onUpdate: (patch: Partial<AppConfig>, toScope: ProviderScope, fromScope?: ProviderScope) => void;
  onClose: () => void;
}

export function ProviderSettings({
  visible,
  globalConfig,
  projectConfig,
  onUpdate,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.7));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.7) - CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scope, setScope] = useState<ConfigScope>(() => detectInitialScope(projectConfig));
  const vals = effectiveValues(globalConfig, projectConfig);

  useEffect(() => {
    if (visible) setScope(detectInitialScope(projectConfig));
  }, [visible, projectConfig]);

  const isBudgetDisabled = vals.thinkingMode !== "enabled";

  const adjustScroll = (next: number) => {
    setScrollOffset((prev) => {
      if (next < prev) return next;
      if (next >= prev + maxVisible) return next - maxVisible + 1;
      return prev;
    });
  };

  const cycleValue = (item: SettingItem) => {
    if (item.type === "toggle") {
      const current = vals[item.key as keyof CurrentValues] as boolean;
      onUpdate(buildPatch(item.key, !current), scope);
      return;
    }

    if (item.type === "budget") {
      if (isBudgetDisabled) return;
      const opts = item.options ?? [];
      const currentIdx = opts.indexOf(String(vals.budgetTokens));
      const nextIdx = (currentIdx + 1) % opts.length;
      onUpdate(buildPatch(item.key, Number(opts[nextIdx])), scope);
      return;
    }

    if (item.type === "cycle" && item.options) {
      const current = String(vals[item.key as keyof CurrentValues]);
      const currentIdx = item.options.indexOf(current);
      const nextIdx = (currentIdx + 1) % item.options.length;
      onUpdate(buildPatch(item.key, item.options[nextIdx] as string), scope);
    }
  };

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
      if (item) cycleValue(item);
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
          const layer = prev === "project" ? projectConfig : globalConfig;
          const layerVals = readValuesFromLayer(layer);
          if (Object.keys(layerVals).length > 0) {
            const patch: Partial<AppConfig> = {};
            for (const [k, v] of Object.entries(layerVals)) {
              Object.assign(patch, buildPatch(k, v as string | number | boolean));
            }
            onUpdate(patch, next as ProviderScope, prev);
          }
        }
        return next ?? prev;
      });
      return;
    }
  });

  if (!visible) return null;

  const labelW = 18;
  const valW = 10;

  return (
    <box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
            󰒓
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            {" "}
            Provider Options
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#555">
            {"  "}⚠ Claude-only — "off" = not sent to API
          </text>
        </PopupRow>

        <box
          flexDirection="column"
          height={Math.min(ITEMS.length + 3, maxVisible)}
          overflow="hidden"
        >
          {(() => {
            const rows: React.ReactNode[] = [];
            let renderedSections = 0;

            for (let i = 0; i < ITEMS.length; i++) {
              const item = ITEMS[i] as SettingItem;

              if (item.section) {
                const sectionRow = renderedSections + i;
                if (sectionRow >= scrollOffset && rows.length < maxVisible) {
                  rows.push(
                    <PopupRow key={`section-${item.section}`} w={innerW}>
                      <text bg={POPUP_BG} fg="#555" attributes={TextAttributes.BOLD}>
                        {item.section}
                      </text>
                    </PopupRow>,
                  );
                }
                renderedSections++;
              }

              const itemRow = renderedSections + i;
              if (itemRow < scrollOffset || rows.length >= maxVisible) {
                continue;
              }

              const isSelected = i === cursor;
              const disabled = item.key === "budgetTokens" && isBudgetDisabled;
              const bg = isSelected ? POPUP_HL : POPUP_BG;
              const raw = vals[item.key as keyof CurrentValues];

              const valColor = disabled
                ? "#333"
                : item.type === "toggle"
                  ? raw
                    ? "#2d5"
                    : "#555"
                  : raw === "off"
                    ? "#555"
                    : "#8B5CF6";

              const displayVal =
                item.type === "toggle" ? (raw ? "x" : " ") : String(raw).padStart(valW - 2);

              const srcScope = detectValueScope(item.key, projectConfig);
              const srcTag = srcScope === "project" ? "[project]" : "[global]";
              const srcColor = srcScope === "project" ? "#00BFFF" : "#666";

              rows.push(
                <PopupRow key={item.key} bg={bg} w={innerW}>
                  <text bg={bg} fg={isSelected ? "#FF0040" : "#555"}>
                    {isSelected ? "› " : "  "}
                  </text>
                  <text bg={bg} fg={disabled ? "#333" : "white"}>
                    {item.label.padEnd(labelW)}
                  </text>
                  <text bg={bg} fg={valColor}>
                    [{displayVal}]
                  </text>
                  <text bg={bg} fg={srcColor}>
                    {` ${srcTag}`}
                  </text>
                  <text bg={bg} fg="#555" truncate>
                    {" "}
                    {item.desc}
                  </text>
                </PopupRow>,
              );
            }
            return rows;
          })()}
        </box>

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
            {"↑↓"} nav | {"⏎"} cycle | {"← →"} scope | esc close
          </text>
        </PopupRow>
      </box>
    </box>
  );
}
