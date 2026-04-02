import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type {
  AppConfig,
  ContextManagementConfig,
  EffortLevel,
  PerformanceConfig,
  ThinkingMode,
} from "../../types/index.js";
import type { ConfigScope } from "../layout/shared.js";
import { CONFIG_SCOPES, Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 88;
const CHROME_ROWS = 7;

type ItemType = "cycle" | "toggle" | "budget";

interface SettingItem {
  key: string;
  label: string;
  desc: string;
  type: ItemType;
  options?: string[];
}

type ProviderTab = "claude" | "openai" | "general";
const TABS: ProviderTab[] = ["claude", "openai", "general"];
const TAB_LABELS: Record<ProviderTab, string> = {
  claude: "Claude",
  openai: "OpenAI",
  general: "General",
};
const TAB_ICONS: Record<ProviderTab, string> = {
  claude: "󱜙",
  openai: "󰧑",
  general: "󰒍",
};

const CLAUDE_ITEMS: SettingItem[] = [
  {
    key: "thinkingMode",
    label: "Thinking",
    desc: "off | auto (adaptive) | enabled (fixed budget)",
    type: "cycle",
    options: ["off", "disabled", "auto", "adaptive", "enabled"],
  },
  {
    key: "budgetTokens",
    label: "Budget Tokens",
    desc: "Token budget for enabled thinking mode",
    type: "budget",
    options: ["1024", "2048", "5000", "10000", "20000"],
  },
  {
    key: "effort",
    label: "Effort",
    desc: "Reasoning depth — affects thinking, text, and tool calls",
    type: "cycle",
    options: ["off", "low", "medium", "high", "max"],
  },
  {
    key: "speed",
    label: "Speed",
    desc: "Opus 4.6 — 2.5x faster output (standard | fast)",
    type: "cycle",
    options: ["off", "standard", "fast"],
  },
  {
    key: "codeExecution",
    label: "Code Execution",
    desc: "Programmatic tool calling — batches reads in Python, saves tokens",
    type: "toggle",
  },
  {
    key: "computerUse",
    label: "Computer Use",
    desc: "Keyboard/mouse/screenshot control",
    type: "toggle",
  },
  {
    key: "anthropicTextEditor",
    label: "Anthropic Text Editor",
    desc: "Anthropic's str_replace editor tool",
    type: "toggle",
  },
  {
    key: "toolStreaming",
    label: "Tool Streaming",
    desc: "Stream tool call args incrementally (disable to debug)",
    type: "toggle",
  },
  {
    key: "sendReasoning",
    label: "Send Reasoning",
    desc: "Include reasoning content in multi-turn requests",
    type: "toggle",
  },
  {
    key: "compact",
    label: "Server Compaction",
    desc: "Anthropic server-side context compaction (200K+ models)",
    type: "toggle",
  },
  {
    key: "clearToolUses",
    label: "Clear Tool Uses",
    desc: "Server-side — clear old tool results at 65% context. ⚠️ Busts prompt cache when triggered",
    type: "toggle",
  },
  {
    key: "clearThinking",
    label: "Clear Thinking",
    desc: "Server-side — preserve all thinking blocks (maximizes cache hits)",
    type: "toggle",
  },
];

const OPENAI_ITEMS: SettingItem[] = [
  {
    key: "openaiReasoningEffort",
    label: "Reasoning Effort",
    desc: "For o3, o4, gpt-5 — controls reasoning depth",
    type: "cycle",
    options: ["off", "none", "minimal", "low", "medium", "high", "xhigh"],
  },
  {
    key: "serviceTier",
    label: "Service Tier",
    desc: "flex = 50% cheaper | priority = fastest (Enterprise)",
    type: "cycle",
    options: ["off", "auto", "default", "flex", "priority"],
  },
];

const GENERAL_ITEMS: SettingItem[] = [
  {
    key: "disableParallelToolUse",
    label: "Sequential Tools",
    desc: "One tool at a time instead of parallel (all providers)",
    type: "toggle",
  },
  {
    key: "webSearch",
    label: "Web Search",
    desc: "Allow web search tool",
    type: "toggle",
  },
  {
    key: "pruning",
    label: "Tool Result Pruning",
    desc: "Client-side — compact old tool results: main | subagents | both | none",
    type: "cycle",
    options: ["none", "main", "subagents", "both"],
  },
];

const TAB_ITEMS: Record<ProviderTab, SettingItem[]> = {
  claude: CLAUDE_ITEMS,
  openai: OPENAI_ITEMS,
  general: GENERAL_ITEMS,
};

interface CurrentValues {
  thinkingMode: ThinkingMode;
  budgetTokens: number;
  effort: string;
  speed: "off" | "standard" | "fast";
  sendReasoning: boolean;
  toolStreaming: boolean;
  disableParallelToolUse: boolean;
  openaiReasoningEffort: string;
  serviceTier: string;
  codeExecution: boolean;
  computerUse: boolean;
  anthropicTextEditor: boolean;
  webSearch: boolean;
  compact: boolean;
  clearToolUses: boolean;
  clearThinking: boolean;
  pruning: string;
}

const DEFAULTS: CurrentValues = {
  thinkingMode: "off",
  budgetTokens: 10000,
  effort: "off",
  speed: "off",
  sendReasoning: false,
  toolStreaming: true,
  disableParallelToolUse: false,
  openaiReasoningEffort: "off",
  serviceTier: "off",
  codeExecution: true,
  computerUse: false,
  anthropicTextEditor: false,
  webSearch: true,
  compact: false,
  clearToolUses: false,
  clearThinking: true,
  pruning: "none",
};

function readValuesFromLayer(layer: Partial<AppConfig> | null): Partial<CurrentValues> {
  if (!layer) return {};
  const v: Partial<CurrentValues> = {};
  if (layer.thinking?.mode !== undefined) v.thinkingMode = layer.thinking.mode;
  if (layer.thinking?.budgetTokens !== undefined) v.budgetTokens = layer.thinking.budgetTokens;
  if (layer.performance?.effort !== undefined) v.effort = layer.performance.effort;
  if (layer.performance?.speed !== undefined) v.speed = layer.performance.speed;
  if (layer.performance?.sendReasoning !== undefined)
    v.sendReasoning = layer.performance.sendReasoning;
  if (layer.performance?.toolStreaming !== undefined)
    v.toolStreaming = layer.performance.toolStreaming;
  if (layer.performance?.disableParallelToolUse !== undefined)
    v.disableParallelToolUse = layer.performance.disableParallelToolUse;
  if (layer.performance?.openaiReasoningEffort !== undefined)
    v.openaiReasoningEffort = layer.performance.openaiReasoningEffort;
  if (layer.performance?.serviceTier !== undefined) v.serviceTier = layer.performance.serviceTier;
  if (layer.codeExecution !== undefined) v.codeExecution = layer.codeExecution;
  if (layer.computerUse !== undefined) v.computerUse = layer.computerUse;
  if (layer.anthropicTextEditor !== undefined) v.anthropicTextEditor = layer.anthropicTextEditor;
  if (layer.webSearch !== undefined) v.webSearch = layer.webSearch;
  if (layer.contextManagement?.compact !== undefined) v.compact = layer.contextManagement.compact;
  if (layer.contextManagement?.clearToolUses !== undefined)
    v.clearToolUses = layer.contextManagement.clearToolUses;
  if (layer.contextManagement?.clearThinking !== undefined)
    v.clearThinking = layer.contextManagement.clearThinking;
  if (layer.contextManagement?.pruningTarget !== undefined)
    v.pruning = layer.contextManagement.pruningTarget;
  else if (layer.contextManagement?.disablePruning !== undefined)
    v.pruning = layer.contextManagement.disablePruning ? "none" : "subagents";
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
    case "sendReasoning":
      return { performance: { sendReasoning: value as boolean } as PerformanceConfig };
    case "toolStreaming":
      return { performance: { toolStreaming: value as boolean } as PerformanceConfig };
    case "disableParallelToolUse":
      return { performance: { disableParallelToolUse: value as boolean } as PerformanceConfig };
    case "openaiReasoningEffort":
      return { performance: { openaiReasoningEffort: value as string } as PerformanceConfig };
    case "serviceTier":
      return { performance: { serviceTier: value as string } as PerformanceConfig };
    case "codeExecution":
      return { codeExecution: value as boolean };
    case "computerUse":
      return { computerUse: value as boolean };
    case "anthropicTextEditor":
      return { anthropicTextEditor: value as boolean };
    case "webSearch":
      return { webSearch: value as boolean };
    case "compact":
      return { contextManagement: { compact: value as boolean } as ContextManagementConfig };
    case "clearToolUses":
      return { contextManagement: { clearToolUses: value as boolean } as ContextManagementConfig };
    case "clearThinking":
      return { contextManagement: { clearThinking: value as boolean } as ContextManagementConfig };
    case "pruning":
      return {
        contextManagement: { pruningTarget: value as string } as ContextManagementConfig,
      };
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
  onUpdate: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
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
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.85) - CHROME_ROWS);

  const t = useTheme();
  const [tab, setTab] = useState<ProviderTab>("claude");
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);
  const [scope, setScope] = useState<ConfigScope>(() => detectInitialScope(projectConfig));
  const vals = effectiveValues(globalConfig, projectConfig);

  const items = TAB_ITEMS[tab];
  const tabIdx = TABS.indexOf(tab);

  useEffect(() => {
    if (visible) setScope(detectInitialScope(projectConfig));
  }, [visible, projectConfig]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tab triggers scroll reset on tab change
  useEffect(() => {
    resetScroll();
  }, [tab, resetScroll]);

  const isBudgetDisabled = vals.thinkingMode !== "enabled";

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
    if (evt.name === "tab" || (evt.shift && evt.name === "tab")) {
      const dir = evt.shift ? -1 : 1;
      const next = (tabIdx + dir + TABS.length) % TABS.length;
      setTab(TABS[next] as ProviderTab);
      return;
    }
    if (evt.name === "up") {
      setCursor((c) => {
        const next = c > 0 ? c - 1 : items.length - 1;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => {
        const next = c < items.length - 1 ? c + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "return" || evt.name === " ") {
      const item = items[cursor];
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
            onUpdate(patch, next as ConfigScope, prev);
          }
        }
        return next ?? prev;
      });
      return;
    }
  });

  if (!visible) return null;

  const labelW = 20;
  const valW = 10;

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={t.brandAlt}
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.brand} attributes={TextAttributes.BOLD}>
            {icon("system")}
          </text>
          <text bg={POPUP_BG} fg={t.textPrimary} attributes={TextAttributes.BOLD}>
            {" "}
            Provider Options
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          {TABS.map((tabItem, i) => (
            <text key={tabItem} bg={POPUP_BG}>
              {i > 0 ? (
                <span fg={t.textFaint} bg={POPUP_BG}>
                  {" │ "}
                </span>
              ) : (
                ""
              )}
              <span
                fg={tabItem === tab ? t.brandSecondary : t.textMuted}
                attributes={tabItem === tab ? TextAttributes.BOLD : undefined}
                bg={POPUP_BG}
              >
                {TAB_ICONS[tabItem]} {TAB_LABELS[tabItem]}
              </span>
            </text>
          ))}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg={t.textFaint} bg={POPUP_BG}>
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          {items.slice(scrollOffset, scrollOffset + maxVisible).map((item, vi) => {
            const i = vi + scrollOffset;
            const isSelected = i === cursor;
            const disabled = item.key === "budgetTokens" && isBudgetDisabled;
            const bg = isSelected ? POPUP_HL : POPUP_BG;
            const raw = vals[item.key as keyof CurrentValues];

            const valColor = disabled
              ? t.textFaint
              : item.type === "toggle"
                ? raw
                  ? t.success
                  : t.textMuted
                : raw === "off"
                  ? t.textMuted
                  : t.brandAlt;

            const displayVal =
              item.type === "toggle" ? (raw ? "x" : " ") : String(raw).padStart(valW - 2);

            const srcScope = detectValueScope(item.key, projectConfig);
            const srcTag = srcScope === "project" ? "proj" : "glob";
            const srcColor = srcScope === "project" ? t.info : t.textMuted;

            return (
              <box key={item.key} flexDirection="column" flexShrink={0}>
                <PopupRow bg={bg} w={innerW}>
                  <text bg={bg} fg={isSelected ? t.brandSecondary : t.textMuted}>
                    {isSelected ? "› " : "  "}
                  </text>
                  <text
                    bg={bg}
                    fg={disabled ? t.textFaint : "white"}
                    attributes={TextAttributes.BOLD}
                  >
                    {item.label.padEnd(labelW)}
                  </text>
                  <text bg={bg} fg={valColor}>
                    [{displayVal}]
                  </text>
                  <text bg={bg} fg={srcColor}>
                    {" "}
                    {srcTag}
                  </text>
                </PopupRow>
                <PopupRow bg={bg} w={innerW}>
                  <text bg={bg} fg={t.textDim}>
                    {"    "}
                    {item.desc}
                  </text>
                </PopupRow>
              </box>
            );
          })}
          {items.length === 0 && (
            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg={t.textMuted}>
                {"  "}No options for this provider yet.
              </text>
            </PopupRow>
          )}
        </box>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textFaint}>
            {"─".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textMuted}>
            {"Scope: "}
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

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg={t.textMuted}>
            tab switch | {"↑↓"} nav | {"⏎"} cycle | {"← →"} scope | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
