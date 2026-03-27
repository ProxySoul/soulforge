import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { type RepoMapStatus, useRepoMapStore } from "../../stores/repomap.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow, SPINNER_FRAMES } from "../layout/shared.js";

const LABEL_W = 18;
const POPUP_W = 72;

const SEMANTIC_MODES = ["off", "ast", "synthetic", "llm", "full"] as const;
type SemanticMode = (typeof SEMANTIC_MODES)[number];

const MODE_DESCRIPTIONS: Record<SemanticMode, string> = {
  off: "disabled",
  ast: "extracts existing docstrings (0 cost)",
  synthetic: "ast + names \u2192 words (0 cost, instant)",
  llm: "ast + AI summaries (top N by PageRank)",
  full: "llm + synthetic fill (best search quality)",
};

const MODE_LABELS: Record<SemanticMode, string> = {
  off: "off",
  ast: "ast",
  synthetic: "synthetic",
  llm: "llm",
  full: "full",
};

const LLM_LIMIT_PRESETS = [100, 200, 300, 500, 1000];

const TOKEN_BUDGET_PRESETS = [2000, 4000, 8000, 16000] as const;

function statusColor(status: RepoMapStatus): string {
  switch (status) {
    case "scanning":
      return "#FF8C00";
    case "ready":
      return "#2d5";
    case "error":
      return "#FF0040";
    default:
      return "#555";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

type ConfigScope = "project" | "global";

interface Props {
  visible: boolean;
  onClose: () => void;
  enabled?: boolean;
  currentMode?: string;
  currentLimit?: number;
  currentAutoRegen?: boolean;
  currentTokenBudget?: number;
  currentScope?: ConfigScope;
  onToggle?: (enabled: boolean, scope: ConfigScope) => void;
  onRefresh?: () => void;
  onClear?: (scope: ConfigScope) => void;
  onRegenerate?: () => void;
  onClearSummaries?: () => void;
  onLspEnrich?: () => void;
  onApply?: (
    mode: string,
    limit: number,
    autoRegen: boolean,
    scope: ConfigScope,
    tokenBudget: number | undefined,
  ) => void;
}

enum FocusRow {
  Mode = 0,
  Limit = 1,
  Budget = 2,
}

export function RepoMapStatusPopup({
  visible,
  onClose,
  enabled = true,
  currentMode,
  currentLimit,
  currentAutoRegen,
  currentTokenBudget,
  currentScope,
  onToggle,
  onRefresh,
  onClear,
  onRegenerate,
  onClearSummaries,
  onLspEnrich,
  onApply,
}: Props) {
  const { width: termCols } = useTerminalDimensions();
  const popupWidth = Math.min(POPUP_W, Math.floor(termCols * 0.8));
  const innerW = popupWidth - 2;

  const stateRef = useRef(useRepoMapStore.getState());
  const [, setRenderTick] = useState(0);
  const spinnerRef = useRef(0);

  const initialMode = (currentMode ?? "off") as SemanticMode;
  const initialLimit = currentLimit ?? 300;

  const [selectedMode, setSelectedMode] = useState<SemanticMode>(initialMode);
  const [selectedLimit, setSelectedLimit] = useState(initialLimit);
  const [selectedAutoRegen, setSelectedAutoRegen] = useState(currentAutoRegen ?? false);
  const [selectedTokenBudget, setSelectedTokenBudget] = useState<number | undefined>(
    currentTokenBudget,
  );
  const [selectedScope, setSelectedScope] = useState<ConfigScope>(currentScope ?? "project");
  const [focusRow, setFocusRow] = useState<FocusRow>(FocusRow.Mode);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setSelectedMode((currentMode ?? "off") as SemanticMode);
    setSelectedLimit(currentLimit ?? 300);
    setSelectedAutoRegen(currentAutoRegen ?? false);
    setSelectedTokenBudget(currentTokenBudget);
    setSelectedScope(currentScope ?? "project");
    setFocusRow(FocusRow.Mode);
    setConfirmClear(false);
  }, [visible, currentMode, currentLimit, currentAutoRegen, currentTokenBudget, currentScope]);

  useEffect(() => {
    if (!visible) return;
    stateRef.current = useRepoMapStore.getState();
    setRenderTick((n) => n + 1);
    return useRepoMapStore.subscribe((s) => {
      stateRef.current = s;
      setRenderTick((n) => n + 1);
    });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      const { status, semanticStatus } = stateRef.current;
      if (status === "scanning" || semanticStatus === "generating") {
        spinnerRef.current++;
        setRenderTick((n) => n + 1);
      }
    }, 150);
    return () => clearInterval(timer);
  }, [visible]);

  const hasConfig = onApply !== undefined;
  const isModified =
    selectedMode !== (currentMode ?? "off") ||
    selectedLimit !== (currentLimit ?? 300) ||
    selectedAutoRegen !== (currentAutoRegen ?? false) ||
    selectedTokenBudget !== currentTokenBudget ||
    selectedScope !== (currentScope ?? "project");

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }
    if (!hasConfig) {
      if (evt.name === "backspace") onClose();
      return;
    }

    // Tab toggles scope
    if (evt.name === "tab") {
      setSelectedScope((s) => (s === "project" ? "global" : "project"));
      return;
    }

    if (evt.name === "up" || evt.name === "down") {
      const dir = evt.name === "down" ? 1 : -1;
      const showLimit = selectedMode === "llm" || selectedMode === "full";
      const rows = [FocusRow.Mode, ...(showLimit ? [FocusRow.Limit] : []), FocusRow.Budget];
      setFocusRow((r) => {
        const idx = rows.indexOf(r);
        const next = (idx + dir + rows.length) % rows.length;
        return rows[next] as FocusRow;
      });
      return;
    }

    if (evt.name === "left" || evt.name === "right") {
      const dir = evt.name === "right" ? 1 : -1;
      if (focusRow === FocusRow.Mode) {
        setSelectedMode((m) => {
          const idx = SEMANTIC_MODES.indexOf(m);
          const next = (idx + dir + SEMANTIC_MODES.length) % SEMANTIC_MODES.length;
          return SEMANTIC_MODES[next] as SemanticMode;
        });
      } else if (focusRow === FocusRow.Limit) {
        setSelectedLimit((lim) => {
          const idx = LLM_LIMIT_PRESETS.indexOf(lim);
          if (idx < 0) return LLM_LIMIT_PRESETS[0] as number;
          const next = (idx + dir + LLM_LIMIT_PRESETS.length) % LLM_LIMIT_PRESETS.length;
          return LLM_LIMIT_PRESETS[next] as number;
        });
      } else {
        setSelectedTokenBudget((b) => {
          if (b === undefined)
            return dir > 0
              ? TOKEN_BUDGET_PRESETS[0]
              : TOKEN_BUDGET_PRESETS[TOKEN_BUDGET_PRESETS.length - 1];
          const idx = TOKEN_BUDGET_PRESETS.indexOf(b as (typeof TOKEN_BUDGET_PRESETS)[number]);
          if (idx < 0) return TOKEN_BUDGET_PRESETS[0];
          const next = idx + dir;
          if (next < 0) return undefined;
          if (next >= TOKEN_BUDGET_PRESETS.length) return undefined;
          return TOKEN_BUDGET_PRESETS[next];
        });
      }
      return;
    }

    const numKey = Number.parseInt(evt.sequence ?? "", 10);
    if (numKey >= 1 && numKey <= SEMANTIC_MODES.length) {
      setSelectedMode(SEMANTIC_MODES[numKey - 1] as SemanticMode);
      return;
    }

    if (evt.name === "return" && isModified) {
      onApply(selectedMode, selectedLimit, selectedAutoRegen, selectedScope, selectedTokenBudget);
      return;
    }

    // Action shortcuts
    if (evt.ctrl) return; // Ignore Ctrl+letter combos (Ctrl+C to quit, etc.)
    // Reset confirm state on any key that isn't 'c'
    if (evt.sequence !== "c" && confirmClear) setConfirmClear(false);
    if (evt.sequence === "r" && onRefresh && enabled) {
      onRefresh();
      return;
    }
    if (evt.sequence === "x" && onClear && enabled) {
      onClear(selectedScope);
      return;
    }
    if (evt.sequence === "g" && onRegenerate && enabled) {
      onRegenerate();
      return;
    }
    if (evt.sequence === "c" && onClearSummaries && enabled) {
      if (confirmClear) {
        setConfirmClear(false);
        onClearSummaries();
      } else {
        setConfirmClear(true);
      }
      return;
    }
    if (evt.sequence === "a" && hasConfig && enabled) {
      setSelectedAutoRegen((v) => !v);
      return;
    }
    if (evt.sequence === "l" && onLspEnrich && enabled) {
      onLspEnrich();
      return;
    }
    if (evt.sequence === "e" && onToggle) {
      onToggle(!enabled, selectedScope);
      return;
    }
  });

  if (!visible) return null;

  const {
    status,
    files,
    symbols,
    edges,
    dbSizeBytes: dbSize,
    scanProgress,
    scanError,
    semanticStatus,
    semanticCount,
    semanticProgress,
    semanticModel,
    semanticTokensIn,
    semanticTokensOut,
  } = stateRef.current;
  const frame = SPINNER_FRAMES[spinnerRef.current % SPINNER_FRAMES.length] ?? "\u280B";

  const statusLabel =
    status === "scanning"
      ? `${frame} scanning${scanProgress ? ` (${scanProgress})` : ""}`
      : status === "ready"
        ? "\u25CF active"
        : status === "error"
          ? "\u25CF error"
          : "\u25CF off";

  const semanticLabel =
    semanticStatus === "generating"
      ? `${frame} ${semanticProgress || "generating..."}`
      : semanticStatus === "ready"
        ? `\u25CF ${semanticProgress || `${String(semanticCount)} cached`}`
        : semanticStatus === "error"
          ? "\u25CF error"
          : "\u25CF off";

  const semanticColor =
    semanticStatus === "generating"
      ? "#FF8C00"
      : semanticStatus === "ready"
        ? "#2d5"
        : semanticStatus === "error"
          ? "#FF0040"
          : "#555";

  const rows: Array<{ label: string; value: string; valueColor?: string }> = [
    { label: "Status", value: statusLabel, valueColor: statusColor(status) },
    { label: "Files", value: String(files) },
    { label: "Symbols", value: String(symbols) },
    { label: "Edges", value: String(edges) },
    { label: "DB Size", value: formatBytes(dbSize) },
    { label: "Semantic", value: semanticLabel, valueColor: semanticColor },
    ...(semanticModel && semanticStatus !== "off"
      ? [{ label: "Semantic Model", value: semanticModel, valueColor: "#8B5CF6" }]
      : []),
    ...(semanticTokensIn > 0 || semanticTokensOut > 0
      ? [
          {
            label: "LLM Tokens",
            value: `\u2191${formatTokens(semanticTokensIn)} \u2193${formatTokens(semanticTokensOut)} (${formatTokens(semanticTokensIn + semanticTokensOut)} total)`,
            valueColor: "#FF8C00",
          },
        ]
      : []),
    ...(scanError ? [{ label: "Error", value: scanError, valueColor: "#FF0040" }] : []),
  ];

  const modeChips = SEMANTIC_MODES.map((m) => {
    const active = m === selectedMode;
    return { mode: m, label: MODE_LABELS[m] as string, active };
  });

  const limitPresetChips = LLM_LIMIT_PRESETS.map((v) => ({
    value: v,
    active: v === selectedLimit,
  }));

  const budgetChips = [
    {
      value: undefined as number | undefined,
      label: "auto",
      active: selectedTokenBudget === undefined,
    },
    ...TOKEN_BUDGET_PRESETS.map((v) => ({
      value: v as number | undefined,
      label: `${String(v / 1000)}k`,
      active: selectedTokenBudget === v,
    })),
  ];

  const showLimitRow = selectedMode === "llm" || selectedMode === "full";
  const modeBg = focusRow === FocusRow.Mode ? POPUP_HL : POPUP_BG;
  const limitBg = focusRow === FocusRow.Limit ? POPUP_HL : POPUP_BG;
  const budgetBg = focusRow === FocusRow.Budget ? POPUP_HL : POPUP_BG;

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
          <text bg={POPUP_BG} fg="#9B30FF">
            {`${icon("repomap")} `}
          </text>
          <text bg={POPUP_BG} fg="white" attributes={TextAttributes.BOLD}>
            Soul Map
          </text>
          {hasConfig && (
            <text bg={POPUP_BG} fg={selectedScope === "project" ? "#5CBBF6" : "#FF8C00"}>
              {`  [${selectedScope}]`}
            </text>
          )}
          {isModified && (
            <text bg={POPUP_BG} fg="#FF8C00">
              {" [modified]"}
            </text>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG} fg="#333">
            {"\u2500".repeat(innerW - 2)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text bg={POPUP_BG}>{""}</text>
        </PopupRow>

        {rows.map((row) => (
          <PopupRow key={row.label} w={innerW}>
            <text bg={POPUP_BG} fg="#FF0040" attributes={TextAttributes.BOLD}>
              {row.label.padEnd(LABEL_W).slice(0, LABEL_W)}
            </text>
            <text bg={POPUP_BG} fg={row.valueColor ?? "#666"}>
              {row.value}
            </text>
          </PopupRow>
        ))}

        {(onToggle || onRefresh || onClear) && (
          <>
            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>
            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>
                {"  "}
                {onToggle && (
                  <span fg={enabled ? "#FF0040" : "#2d5"}>
                    {enabled ? "[E] disable" : "[E] enable"}
                    {"   "}
                  </span>
                )}
                {enabled && <span fg="#5CBBF6">{"[R] refresh"}</span>}
                {enabled && <span fg="#FF8C00">{"   [X] clear index"}</span>}
              </text>
            </PopupRow>
            {!enabled && (
              <PopupRow w={innerW}>
                <text bg={POPUP_BG} fg="#FF8C00">
                  {"  Soul map disabled — soul tools inactive, saves ~4-8k prompt tokens"}
                </text>
              </PopupRow>
            )}
          </>
        )}

        {hasConfig && enabled && (
          <>
            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#333">
                {"\u2500".repeat(innerW - 2)}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
                Semantic Summaries
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow bg={modeBg} w={innerW}>
              <text bg={modeBg} fg={focusRow === FocusRow.Mode ? "#FF0040" : "#555"}>
                {focusRow === FocusRow.Mode ? "\u203A " : "  "}
              </text>
              <text
                bg={modeBg}
                fg={focusRow === FocusRow.Mode ? "white" : "#aaa"}
                attributes={focusRow === FocusRow.Mode ? TextAttributes.BOLD : undefined}
              >
                {"Mode  "}
              </text>
              {modeChips.map((chip) => (
                <text
                  key={chip.mode}
                  bg={modeBg}
                  fg={chip.active ? "#2d5" : "#555"}
                  attributes={chip.active ? TextAttributes.BOLD : undefined}
                >
                  {chip.active ? `[${chip.label}]` : ` ${chip.label} `}{" "}
                </text>
              ))}
            </PopupRow>

            {showLimitRow && (
              <PopupRow bg={limitBg} w={innerW}>
                <text bg={limitBg} fg={focusRow === FocusRow.Limit ? "#FF0040" : "#555"}>
                  {focusRow === FocusRow.Limit ? "\u203A " : "  "}
                </text>
                <text
                  bg={limitBg}
                  fg={focusRow === FocusRow.Limit ? "white" : "#aaa"}
                  attributes={focusRow === FocusRow.Limit ? TextAttributes.BOLD : undefined}
                >
                  {"LLM Limit  "}
                </text>
                {limitPresetChips.map((chip) => (
                  <text
                    key={chip.value}
                    bg={limitBg}
                    fg={chip.active ? "#2d5" : "#555"}
                    attributes={chip.active ? TextAttributes.BOLD : undefined}
                  >
                    {chip.active ? `[${String(chip.value)}]` : ` ${String(chip.value)} `}{" "}
                  </text>
                ))}
                <text bg={limitBg} fg="#555">
                  symbols
                </text>
              </PopupRow>
            )}

            {showLimitRow && (
              <PopupRow w={innerW}>
                <text bg={POPUP_BG}>
                  {"    "}
                  <span fg="#555">{"Auto-regen  "}</span>
                  <span fg={selectedAutoRegen ? "#2d5" : "#555"} attributes={TextAttributes.BOLD}>
                    {selectedAutoRegen ? "[on]" : "[off]"}
                  </span>
                  <span fg="#444">{" (a toggle) — costs tokens on each file change"}</span>
                </text>
              </PopupRow>
            )}

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#555">
                {`  ${selectedMode.padEnd(11)}\u2014 ${MODE_DESCRIPTIONS[selectedMode]}`}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>
                {"  "}
                <span fg="#5CBBF6">{"[G] regenerate"}</span>
                {confirmClear ? (
                  <span fg="#FF0040" attributes={TextAttributes.BOLD}>
                    {"   [C] CONFIRM clear (includes LLM)"}
                  </span>
                ) : (
                  <span fg="#FF8C00">{"   [C] clear summaries"}</span>
                )}
                {onLspEnrich ? <span fg="#2d5">{"   [L] lsp enrich"}</span> : null}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#333">
                {"\u2500".repeat(innerW - 2)}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#9B30FF" attributes={TextAttributes.BOLD}>
                Map Token Budget
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow bg={budgetBg} w={innerW}>
              <text bg={budgetBg} fg={focusRow === FocusRow.Budget ? "#FF0040" : "#555"}>
                {focusRow === FocusRow.Budget ? "\u203A " : "  "}
              </text>
              <text
                bg={budgetBg}
                fg={focusRow === FocusRow.Budget ? "white" : "#aaa"}
                attributes={focusRow === FocusRow.Budget ? TextAttributes.BOLD : undefined}
              >
                {"Budget  "}
              </text>
              {budgetChips.map((chip) => (
                <text
                  key={chip.label}
                  bg={budgetBg}
                  fg={chip.active ? "#2d5" : "#555"}
                  attributes={chip.active ? TextAttributes.BOLD : undefined}
                >
                  {chip.active ? `[${chip.label}]` : ` ${chip.label} `}{" "}
                </text>
              ))}
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#444">
                {"    "}
                {selectedTokenBudget === undefined
                  ? "scales with conversation length (1.5k\u20134k)"
                  : `fixed ${String(selectedTokenBudget / 1000)}k tokens — more files visible, higher prompt cost`}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG}>{""}</text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#333">
                {"\u2500".repeat(innerW - 2)}
              </text>
            </PopupRow>

            <PopupRow w={innerW}>
              <text bg={POPUP_BG} fg="#555">
                {"\u2191\u2193 focus | \u2190\u2192 change | tab scope | 1-5 mode | "}
                {isModified ? (
                  <span fg="#2d5" attributes={TextAttributes.BOLD}>
                    {"\u23CE apply"}
                  </span>
                ) : (
                  <span fg="#555">{"\u23CE apply"}</span>
                )}
                <span fg="#555">{" | esc close"}</span>
              </text>
            </PopupRow>
          </>
        )}

        {!hasConfig && (
          <PopupRow w={innerW}>
            <text bg={POPUP_BG} fg="#555">
              {`  [E] ${enabled ? "disable" : "enable"} | [R] refresh | [X] clear | tab scope | esc close`}
            </text>
          </PopupRow>
        )}
      </box>
    </Overlay>
  );
}
