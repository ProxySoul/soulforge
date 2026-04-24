import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { type RepoMapStatus, useRepoMapStore } from "../../stores/repomap.js";
import { SPINNER_FRAMES } from "../layout/shared.js";
import {
  Divider,
  Field,
  Hint,
  KeyCap,
  PremiumPopup,
  Section,
  SegmentedControl,
  Toggle,
  VSpacer,
} from "../ui/index.js";

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

const LLM_LIMIT_PRESETS = [100, 200, 300, 500];

const TOKEN_BUDGET_PRESETS = [2000, 4000, 8000, 16000] as const;

function statusColor(status: RepoMapStatus, t: ThemeTokens): string {
  switch (status) {
    case "scanning":
      return t.warning;
    case "ready":
      return t.success;
    case "error":
      return t.error;
    default:
      return t.textMuted;
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
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
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
      const { status, semanticStatus, lspStatus: ls } = stateRef.current;
      if (status === "scanning" || semanticStatus === "generating" || ls === "generating") {
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
    semanticTokensCache,
    lspStatus,
    lspProgress,
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
          ? `\u25CF error${semanticProgress ? ` (${semanticProgress})` : ""}`
          : `\u25CF ${semanticProgress || "off"}`;

  const semanticColor =
    semanticStatus === "generating"
      ? t.warning
      : semanticStatus === "ready"
        ? t.success
        : semanticStatus === "error"
          ? t.error
          : t.textMuted;

  const lspLabel =
    lspStatus === "generating"
      ? `${frame} ${lspProgress || "enriching..."}`
      : lspStatus === "ready"
        ? `\u25CF ${lspProgress || "ready"}`
        : lspStatus === "error"
          ? `\u25CF ${lspProgress || "error"}`
          : "\u25CF off";

  const lspColor =
    lspStatus === "generating"
      ? t.warning
      : lspStatus === "ready"
        ? t.success
        : lspStatus === "error"
          ? t.error
          : t.textMuted;

  const rows: Array<{ label: string; value: string; valueColor?: string }> = [
    { label: "Status", value: statusLabel, valueColor: statusColor(status, t) },
    { label: "Files", value: String(files) },
    { label: "Symbols", value: String(symbols) },
    { label: "Edges", value: String(edges) },
    { label: "DB Size", value: formatBytes(dbSize) },
    { label: "Semantic", value: semanticLabel, valueColor: semanticColor },
    ...(semanticModel && semanticStatus !== "off"
      ? [{ label: "Semantic Model", value: semanticModel, valueColor: t.brandAlt }]
      : []),
    ...(semanticTokensIn > 0 || semanticTokensOut > 0
      ? [
          {
            label: "LLM Tokens",
            value: `\u2191${formatTokens(semanticTokensIn)} \u2193${formatTokens(semanticTokensOut)}${semanticTokensCache > 0 ? ` (${String(Math.round((semanticTokensCache / semanticTokensIn) * 100))}% cached)` : ""}`,
            valueColor: t.warning,
          },
        ]
      : []),
    { label: "LSP", value: lspLabel, valueColor: lspColor },
    ...(scanError ? [{ label: "Error", value: scanError, valueColor: t.error }] : []),
  ];

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

  const popupH = Math.min(Math.max(18, Math.floor(termRows * 0.85)), termRows - 2);
  const headerBlurb = hasConfig
    ? `Soul Map · ${selectedScope}${isModified ? " (modified)" : ""}`
    : `Soul Map · ${status}`;
  const footerHints = hasConfig
    ? [
        { key: "↑↓", label: "focus" },
        { key: "←→", label: "change" },
        { key: "Tab", label: "scope" },
        { key: "1-5", label: "mode" },
        { key: "Enter", label: "apply" },
        { key: "Esc", label: "close" },
      ]
    : [
        { key: "E", label: enabled ? "disable" : "enable" },
        { key: "R", label: "refresh" },
        { key: "X", label: "clear" },
        { key: "Tab", label: "scope" },
        { key: "Esc", label: "close" },
      ];

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={popupH}
      title="Soul Map"
      titleIcon="repomap"
      blurb={headerBlurb}
      footerHints={footerHints}
    >
      <box flexDirection="column" paddingX={1}>
        <VSpacer />

        <Section>
          {rows.map((row) => (
            <Field
              key={row.label}
              label={row.label}
              labelWidth={LABEL_W}
              value={
                <text bg={t.bgPopup} fg={row.valueColor ?? t.textMuted}>
                  {row.value.length > innerW - LABEL_W
                    ? `${row.value.slice(0, innerW - LABEL_W - 1)}\u2026`
                    : row.value}
                </text>
              }
            />
          ))}
        </Section>

        {(onToggle || onRefresh || onClear) && (
          <>
            <VSpacer />
            <box flexDirection="row" paddingX={1} backgroundColor={t.bgPopup}>
              {onToggle ? (
                <KeyCap
                  keyName="E"
                  label={enabled ? "disable" : "enable"}
                  accent={enabled ? t.brandSecondary : t.success}
                />
              ) : null}
              {onToggle && enabled ? <text bg={t.bgPopup}>{"   "}</text> : null}
              {enabled && onRefresh ? <KeyCap keyName="R" label="refresh" accent={t.info} /> : null}
              {enabled && onRefresh && onClear ? <text bg={t.bgPopup}>{"   "}</text> : null}
              {enabled && onClear ? (
                <KeyCap keyName="X" label="clear index" accent={t.warning} />
              ) : null}
            </box>
            {!enabled && (
              <Hint kind="warn">
                Soul map disabled — soul tools inactive, saves ~4-8k prompt tokens
              </Hint>
            )}
          </>
        )}

        {hasConfig && enabled && (
          <>
            <VSpacer />
            <Divider width={innerW - 2} />
            <Section title="Semantic Summaries">
              <SegmentedControl
                label="Mode"
                options={SEMANTIC_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
                value={selectedMode}
                focused={focusRow === FocusRow.Mode}
              />

              {showLimitRow ? (
                <>
                  <SegmentedControl
                    label="LLM Limit"
                    options={LLM_LIMIT_PRESETS.map((v) => ({ value: v, label: String(v) }))}
                    value={selectedLimit}
                    focused={focusRow === FocusRow.Limit}
                    suffix="symbols"
                  />
                  <Toggle
                    label="Auto-regen  [A]"
                    description="costs tokens on each file change"
                    on={selectedAutoRegen}
                  />
                </>
              ) : null}

              <Hint>
                {selectedMode} — {MODE_DESCRIPTIONS[selectedMode]}
              </Hint>

              <VSpacer />
              <box flexDirection="row" paddingX={1} backgroundColor={t.bgPopup}>
                {onRegenerate ? <KeyCap keyName="G" label="regenerate" accent={t.info} /> : null}
                {onRegenerate && onClearSummaries ? <text bg={t.bgPopup}>{"   "}</text> : null}
                {onClearSummaries ? (
                  confirmClear ? (
                    <KeyCap
                      keyName="C"
                      label="CONFIRM clear (preserves LLM)"
                      accent={t.brandSecondary}
                    />
                  ) : (
                    <KeyCap keyName="C" label="clear summaries" accent={t.warning} />
                  )
                ) : null}
                {onLspEnrich ? <text bg={t.bgPopup}>{"   "}</text> : null}
                {onLspEnrich ? <KeyCap keyName="L" label="lsp enrich" accent={t.success} /> : null}
              </box>
            </Section>

            <Divider width={innerW - 2} />
            <Section title="Map Token Budget">
              <SegmentedControl
                label="Budget"
                options={budgetChips.map((c) => ({
                  value: c.value ?? "auto",
                  label: c.label,
                }))}
                value={selectedTokenBudget ?? "auto"}
                focused={focusRow === FocusRow.Budget}
              />
              <Hint>
                {selectedTokenBudget === undefined
                  ? "scales with conversation length (1.5k\u20134k)"
                  : `fixed ${String(selectedTokenBudget / 1000)}k tokens — more files visible, higher prompt cost`}
              </Hint>
            </Section>
          </>
        )}
      </box>
    </PremiumPopup>
  );
}
