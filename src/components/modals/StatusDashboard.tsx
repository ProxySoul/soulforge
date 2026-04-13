import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { getNvimInstance } from "../../core/editor/instance.js";
import { icon } from "../../core/icons.js";
import { getIntelligenceStatus } from "../../core/intelligence/index.js";
import { getModelContextInfoSync, getShortModelLabel } from "../../core/llm/models.js";
import { isAnthropicNative } from "../../core/llm/provider-options.js";
import { getProxyPid } from "../../core/proxy/lifecycle.js";
import { getTerminalStats } from "../../core/terminal/manager.js";
import { useTheme } from "../../core/theme/index.js";
import type { UseTabsReturn } from "../../hooks/useTabs.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import {
  computeModelCost,
  computeTotalCostFromBreakdown,
  isModelFree,
  isModelLocal,
  type TokenUsage,
  useStatusBarStore,
  ZERO_USAGE,
} from "../../stores/statusbar.js";
import { useWorkerStore } from "../../stores/workers.js";
import { POPUP_BG, Popup, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 6;
const TABS = ["Context", "System"] as const;
type Tab = (typeof TABS)[number];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${String(b)} B`;
}

function fmtMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(mb)} MB`;
}

function BarRow({
  label,
  pct,
  desc,
  barColor,
  descColor,
  innerW,
  labelW = 18,
  descW = 0,
}: {
  label: string;
  pct: number;
  desc: string;
  barColor: string;
  descColor: string;
  innerW: number;
  labelW?: number;
  descW?: number;
}) {
  const t = useTheme();
  const pad = 2;
  const truncLabel = label.length > labelW ? `${label.slice(0, labelW - 1)}…` : label;
  const effectiveDescW = descW > 0 ? descW : desc.length + 2;
  const barW = Math.max(6, innerW - labelW - effectiveDescW - pad);
  const filled = Math.round((pct / 100) * barW);
  const descStr = descW > 0 ? ` ${desc}`.padStart(effectiveDescW) : ` ${desc}`;
  return (
    <PopupRow w={innerW}>
      <text fg={t.textSecondary} bg={POPUP_BG}>
        {truncLabel.padEnd(labelW)}
      </text>
      <text fg={barColor} bg={POPUP_BG}>
        {"▰".repeat(filled)}
      </text>
      <text fg={t.textSubtle} bg={POPUP_BG}>
        {"▱".repeat(barW - filled)}
      </text>
      <text fg={descColor} bg={POPUP_BG}>
        {descStr}
      </text>
    </PopupRow>
  );
}

function EntryRow({
  label,
  value,
  labelColor,
  valueColor,
  innerW,
  labelW = 14,
  rightAlign,
}: {
  label: string;
  value: string;
  labelColor?: string;
  valueColor?: string;
  innerW: number;
  labelW?: number;
  rightAlign?: boolean;
}) {
  const t = useTheme();
  const pad = 2;
  const valueW = innerW - labelW - pad;
  const displayValue = rightAlign ? value.padStart(valueW) : value;
  return (
    <PopupRow w={innerW}>
      <text fg={labelColor ?? t.textSecondary} bg={POPUP_BG}>
        {label.padEnd(labelW)}
      </text>
      <text fg={valueColor ?? t.textPrimary} bg={POPUP_BG}>
        {displayValue}
      </text>
    </PopupRow>
  );
}

function SectionHeader({
  label,
  color,
  innerW,
}: {
  label: string;
  color?: string;
  innerW: number;
}) {
  const t = useTheme();
  return (
    <PopupRow w={innerW}>
      <text fg={color ?? t.brandAlt} bg={POPUP_BG} attributes={TextAttributes.BOLD}>
        {label}
      </text>
    </PopupRow>
  );
}

function Spacer({ innerW }: { innerW: number }) {
  return (
    <PopupRow w={innerW}>
      <text bg={POPUP_BG}>{""}</text>
    </PopupRow>
  );
}

interface Props {
  visible: boolean;
  initialTab?: Tab;
  onClose: () => void;
  activeModel: string;
  contextManager: ContextManager;
  tabMgr: UseTabsReturn;
  currentMode: string;
  currentModeLabel: string;
}

export function StatusDashboard({
  visible,
  initialTab,
  onClose,
  activeModel: activeModelProp,
  contextManager,
  tabMgr,
  currentMode,
  currentModeLabel,
}: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.min(82, Math.floor(termCols * 0.85));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor((termRows - 2) * 0.8) - CHROME_ROWS);
  const [tab, setTab] = useState<Tab>(initialTab ?? "Context");
  const TAB_COLORS: Record<Tab, string> = { Context: t.info, System: t.brand };
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scopeTabId, setScopeTabId] = useState<string | "all">(tabMgr.activeTabId);

  const sb = useStatusBarStore();
  const rm = useRepoMapStore();
  const wk = useWorkerStore();

  useEffect(() => {
    if (visible) {
      setTab(initialTab ?? "Context");
      setScrollOffset(0);
      setScopeTabId(tabMgr.activeTabId);
    }
  }, [visible, initialTab, tabMgr.activeTabId]);

  const pollWorkerMemory = useCallback(async () => {
    const store = useWorkerStore.getState();
    try {
      const intel = contextManager.getRepoMap();
      const res = await intel.queryMemory();
      store.setWorkerMemory(
        "intelligence",
        Math.round(res.heapUsed / 1024 / 1024),
        Math.round(res.rss / 1024 / 1024),
      );
    } catch {}
    try {
      const { getIOClient } = await import("../../core/workers/io-client.js");
      const res = await getIOClient().queryMemory();
      store.setWorkerMemory(
        "io",
        Math.round(res.heapUsed / 1024 / 1024),
        Math.round(res.rss / 1024 / 1024),
      );
    } catch {}
  }, [contextManager]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (visible && tab === "System") {
      pollWorkerMemory();
      pollRef.current = setInterval(pollWorkerMemory, 5_000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [visible, tab, pollWorkerMemory]);

  const modelId = activeModelProp;
  const tu = sb.tokenUsage;

  const allTabs = tabMgr.tabs;
  const isMultiTab = allTabs.length > 1;
  const isAllScope = scopeTabId === "all";

  const getTabUsage = useCallback(
    (tabId: string): TokenUsage => {
      if (tabId === tabMgr.activeTabId) return tu;
      return tabMgr.getChat(tabId)?.tokenUsage ?? ZERO_USAGE;
    },
    [tu, tabMgr],
  );

  const scopedUsage = useMemo((): TokenUsage => {
    if (!isAllScope) return getTabUsage(scopeTabId);
    const agg = { ...ZERO_USAGE, modelBreakdown: {} as TokenUsage["modelBreakdown"] };
    for (const tabEntry of allTabs) {
      const u = getTabUsage(tabEntry.id);
      agg.prompt += u.prompt;
      agg.completion += u.completion;
      agg.total += u.total;
      agg.cacheRead += u.cacheRead;
      agg.cacheWrite += u.cacheWrite;
      agg.subagentInput += u.subagentInput;
      agg.subagentOutput += u.subagentOutput;
      for (const [mid, usage] of Object.entries(u.modelBreakdown ?? {})) {
        const prev = agg.modelBreakdown[mid] ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
        agg.modelBreakdown[mid] = {
          input: prev.input + usage.input,
          output: prev.output + usage.output,
          cacheRead: prev.cacheRead + usage.cacheRead,
          cacheWrite: prev.cacheWrite + usage.cacheWrite,
        };
      }
    }
    return agg;
  }, [isAllScope, scopeTabId, getTabUsage, allTabs]);

  const contextLines = useMemo(() => {
    const lines: React.ReactNode[] = [];

    // ── Scope selector (multi-tab only) ──
    if (isMultiTab) {
      const scopeIds = [...allTabs.map((tb) => tb.id), "all" as const];
      lines.push(
        <PopupRow key="scope" w={innerW}>
          {scopeIds.map((sid, i) => {
            const isSelected = sid === scopeTabId;
            const label =
              sid === "all" ? "All" : `Tab ${String(allTabs.findIndex((tb) => tb.id === sid) + 1)}`;
            return (
              <text
                key={sid}
                fg={isSelected ? t.info : t.textMuted}
                bg={POPUP_BG}
                attributes={isSelected ? TextAttributes.BOLD : undefined}
              >
                {i > 0 ? " │ " : " "}
                {isSelected ? `▸ ${label}` : `  ${label}`}
              </text>
            );
          })}
        </PopupRow>,
      );
      lines.push(
        <PopupRow key="scope-sep" w={innerW}>
          <text fg={t.textSubtle} bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>,
      );
    }

    // ── Context Window / Model / Compaction / System Prompt ──
    // Shown for any individual tab scope (hidden in "All" aggregate view)
    if (!isAllScope) {
      const breakdown = contextManager.getContextBreakdown();
      const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const ctxWindow =
        sb.contextWindow > 0 ? sb.contextWindow : getModelContextInfoSync(modelId).tokens;
      const isApi = sb.contextTokens > 0;
      const charEstimate = (systemChars + sb.chatChars + sb.subagentChars) / 4;
      const chatCharsDelta = Math.max(0, sb.chatChars - (sb.chatCharsAtSnapshot ?? 0));
      const usedTokens = Math.round(
        isApi ? sb.contextTokens + (chatCharsDelta + sb.subagentChars) / 4 : charEstimate,
      );
      const fillPct =
        usedTokens > 0 ? Math.min(100, Math.max(1, Math.round((usedTokens / ctxWindow) * 100))) : 0;
      const activeSections = breakdown.filter((s) => s.active && s.chars > 0);
      const totalSysChars = activeSections.reduce((sum, s) => sum + s.chars, 0);

      const pctLabel = isApi ? `${String(fillPct)}%` : `~${String(fillPct)}%`;
      lines.push(
        <BarRow
          key="ctx-bar"
          label="Context Window"
          pct={fillPct}
          desc={`${fmtTokens(usedTokens)} / ${fmtTokens(ctxWindow)} (${pctLabel})`}
          barColor={fillPct > 75 ? t.brandSecondary : fillPct > 50 ? t.warning : t.success}
          descColor={fillPct > 75 ? t.brandSecondary : fillPct > 50 ? t.warning : t.textSecondary}
          innerW={innerW}
        />,
      );
      lines.push(
        <EntryRow
          key="model"
          label="Model"
          value={getShortModelLabel(modelId)}
          labelW={18}
          innerW={innerW}
        />,
      );

      const isAnthropic = isAnthropicNative(modelId);
      const clientTriggerPct = 70;
      const clientTrigger = Math.floor(ctxWindow * (clientTriggerPct / 100));
      lines.push(<Spacer key="s-thresh-pre" innerW={innerW} />);
      lines.push(<SectionHeader key="h-thresh" label="Compaction Thresholds" innerW={innerW} />);
      if (isAnthropic) {
        const clearPct = 30;
        const clearTrigger = Math.max(80_000, Math.floor(ctxWindow * (clearPct / 100)));
        const serverPct = 80;
        const serverTrigger = Math.max(160_000, Math.floor(ctxWindow * (serverPct / 100)));
        lines.push(
          <EntryRow
            key="th-clear"
            label="  Tool clearing"
            value={`${String(clearPct)}% — ${fmtTokens(clearTrigger)}`}
            valueColor={t.textMuted}
            labelW={18}
            innerW={innerW}
          />,
        );
        lines.push(
          <EntryRow
            key="th-server"
            label="  Server compact"
            value={`${String(serverPct)}% — ${fmtTokens(serverTrigger)}`}
            valueColor={t.textMuted}
            labelW={18}
            innerW={innerW}
          />,
        );
      }
      lines.push(
        <EntryRow
          key="th-client"
          label="  Client compact"
          value={`${String(clientTriggerPct)}% — ${fmtTokens(clientTrigger)}`}
          valueColor={t.textMuted}
          labelW={18}
          innerW={innerW}
        />,
      );
      lines.push(<Spacer key="s1" innerW={innerW} />);

      if (activeSections.length > 0) {
        const sysLabelW = Math.min(
          22,
          Math.max(18, ...activeSections.map((s) => s.section.length + 4)),
        );
        const maxDescLen = Math.max(
          ...activeSections.map((s) => `~${fmtTokens(Math.ceil(s.chars / 4))}`.length + 2),
        );
        lines.push(<SectionHeader key="h-sys" label="System Prompt" innerW={innerW} />);
        for (const s of activeSections) {
          const sTokens = Math.ceil(s.chars / 4);
          const sPct = totalSysChars > 0 ? Math.round((s.chars / totalSysChars) * 100) : 0;
          lines.push(
            <BarRow
              key={`sp-${s.section}`}
              label={`  ${s.section}`}
              pct={sPct}
              desc={`~${fmtTokens(sTokens)}`}
              barColor={sPct > 40 ? t.warning : t.textMuted}
              descColor={t.textMuted}
              innerW={innerW}
              labelW={sysLabelW}
              descW={maxDescLen}
            />,
          );
        }
        lines.push(<Spacer key="s2" innerW={innerW} />);
      }
    }

    // ── Token Usage section header ──
    const tokHeader = isAllScope
      ? `Token Usage — All Tabs (${String(allTabs.length)})`
      : isMultiTab
        ? `Token Usage — Tab ${String(allTabs.findIndex((tb) => tb.id === scopeTabId) + 1)}`
        : "Token Usage (session)";
    lines.push(<SectionHeader key="h-tok" label={tokHeader} innerW={innerW} />);

    // ── Token breakdown (same for any scope, uses scopedUsage) ──
    {
      const su = scopedUsage;
      const uncachedInput = su.prompt + su.subagentInput;
      const allInput = uncachedInput + su.cacheRead + su.cacheWrite;
      const totalOutput = su.completion + su.subagentOutput;
      const hasSub = su.subagentInput > 0 || su.subagentOutput > 0;
      const cachePct =
        allInput > 0 ? Math.min(100, Math.round((su.cacheRead / allInput) * 100)) : 0;

      const tokLabelW = 18;
      lines.push(
        <EntryRow
          key="t-in"
          label="  Input"
          value={fmtTokens(uncachedInput)}
          valueColor={t.info}
          labelW={tokLabelW}
          rightAlign
          innerW={innerW}
        />,
      );
      if (hasSub) {
        lines.push(
          <EntryRow
            key="t-in-main"
            label="    Main"
            value={fmtTokens(su.prompt)}
            valueColor={t.info}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
        lines.push(
          <EntryRow
            key="t-in-sub"
            label="    Dispatch"
            value={fmtTokens(su.subagentInput)}
            valueColor={t.brand}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <EntryRow
          key="t-out"
          label="  Output"
          value={fmtTokens(totalOutput)}
          valueColor={t.warning}
          labelW={tokLabelW}
          rightAlign
          innerW={innerW}
        />,
      );
      if (hasSub) {
        lines.push(
          <EntryRow
            key="t-out-main"
            label="    Main"
            value={fmtTokens(su.completion)}
            valueColor={t.warning}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
        lines.push(
          <EntryRow
            key="t-out-sub"
            label="    Dispatch"
            value={fmtTokens(su.subagentOutput)}
            valueColor={t.brand}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <BarRow
          key="t-cache"
          label="  Cache Read"
          pct={cachePct}
          desc={su.cacheRead > 0 ? `${fmtTokens(su.cacheRead)} (${String(cachePct)}%)` : "—"}
          barColor={su.cacheRead > 0 ? t.success : t.textFaint}
          descColor={su.cacheRead > 0 ? t.success : t.textDim}
          innerW={innerW}
        />,
      );
      if (su.cacheWrite > 0) {
        lines.push(
          <EntryRow
            key="t-cache-write"
            label="  Cache Write"
            value={fmtTokens(su.cacheWrite)}
            valueColor={t.warning}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
      }
      if (su.cacheRead > 0) {
        lines.push(
          <EntryRow
            key="t-uncached"
            label="    Uncached"
            value={fmtTokens(uncachedInput)}
            valueColor={t.textSecondary}
            labelW={tokLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <EntryRow
          key="t-total"
          label="  Total"
          value={fmtTokens(su.total)}
          labelW={tokLabelW}
          rightAlign
          innerW={innerW}
        />,
      );

      // ── Cost Breakdown ──
      const sortedBd = Object.entries(su.modelBreakdown ?? {}).sort(
        ([midA, a], [midB, b]) => computeModelCost(midB, b) - computeModelCost(midA, a),
      );
      const allLocal = sortedBd.length > 0 && sortedBd.every(([mid]) => isModelLocal(mid));
      const allFree =
        !allLocal && sortedBd.length > 0 && sortedBd.every(([mid]) => isModelFree(mid));
      const totalCost =
        sortedBd.length > 0 ? computeTotalCostFromBreakdown(su.modelBreakdown ?? {}) : 0;
      if (totalCost > 0 || allFree || allLocal) {
        const fmtCost = (c: number) => (c < 0.01 ? `${c.toFixed(3)}` : `${c.toFixed(2)}`);
        lines.push(<Spacer key="s-cost" innerW={innerW} />);
        const costHeader = isAllScope ? "Cost Breakdown — All Tabs" : "Cost Breakdown";
        lines.push(<SectionHeader key="h-cost" label={costHeader} innerW={innerW} />);
        const costLabelW = Math.min(30, innerW - 20);
        for (const [mid, usage] of sortedBd) {
          const local = isModelLocal(mid);
          const free = !local && isModelFree(mid);
          const c = computeModelCost(mid, usage);
          if (c <= 0 && !free && !local) continue;
          const pct = totalCost > 0 ? Math.round((c / totalCost) * 100) : 0;
          const maxModelW = costLabelW - 4;
          const shortId = mid.length > maxModelW ? `${mid.slice(0, maxModelW - 1)}…` : mid;
          lines.push(
            <EntryRow
              key={`cost-${mid}`}
              label={`  ${shortId}`}
              value={local ? "Local" : free ? "FREE" : `${fmtCost(c)}  (${String(pct)}%)`}
              valueColor={local || free ? t.success : t.textPrimary}
              labelW={costLabelW}
              rightAlign
              innerW={innerW}
            />,
          );
        }
        lines.push(
          <EntryRow
            key="cost-total"
            label="  Total"
            value={allLocal ? "Local" : allFree ? "FREE" : fmtCost(totalCost)}
            valueColor={allLocal || allFree ? t.success : t.warning}
            labelW={costLabelW}
            rightAlign
            innerW={innerW}
          />,
        );
      }
    }

    // ── Per-Tab summary table (only in "All" scope) ──
    if (isAllScope && isMultiTab) {
      lines.push(<Spacer key="s-tabs" innerW={innerW} />);
      lines.push(<SectionHeader key="h-tabs" label="Per Tab" innerW={innerW} />);

      const fmtCost = (c: number, modelIds?: string[]) => {
        if (modelIds && modelIds.length > 0 && modelIds.every((mid) => isModelLocal(mid)))
          return "Local";
        if (modelIds && modelIds.length > 0 && modelIds.every((mid) => isModelFree(mid)))
          return "FREE";
        return c <= 0 ? "—" : c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`;
      };

      // Column header
      const colLabelW = Math.min(24, Math.floor(innerW * 0.35));
      const colW = innerW - colLabelW - 2;
      const colStr = (s: string, w: number) => s.padStart(w);
      const cw = Math.floor(colW / 4);
      lines.push(
        <PopupRow key="tab-hdr" w={innerW}>
          <text fg={t.textDim} bg={POPUP_BG}>
            {"".padEnd(colLabelW)}
            {colStr("Input", cw)}
            {colStr("Output", cw)}
            {colStr("Cache%", cw)}
            {colStr("Cost", cw)}
          </text>
        </PopupRow>,
      );

      for (let i = 0; i < allTabs.length; i++) {
        const tabEntry = allTabs[i];
        if (!tabEntry) continue;
        const u = getTabUsage(tabEntry.id);
        const isActive = tabEntry.id === tabMgr.activeTabId;
        const uncached = u.prompt + u.subagentInput;
        const allIn = uncached + u.cacheRead + u.cacheWrite;
        const cachePct = allIn > 0 ? Math.round((u.cacheRead / allIn) * 100) : 0;
        const cost = computeTotalCostFromBreakdown(u.modelBreakdown ?? {});
        const totalOut = u.completion + u.subagentOutput;

        const prefix = isActive ? " ▸ " : "   ";
        const label = `${prefix}Tab ${String(i + 1)}`;

        lines.push(
          <PopupRow key={`tab-${tabEntry.id}`} w={innerW}>
            <text fg={isActive ? t.info : t.textSecondary} bg={POPUP_BG}>
              {label.padEnd(colLabelW)}
            </text>
            <text fg={t.textPrimary} bg={POPUP_BG}>
              {colStr(fmtTokens(uncached), cw)}
              {colStr(fmtTokens(totalOut), cw)}
              {colStr(cachePct > 0 ? `${String(cachePct)}%` : "—", cw)}
              {colStr(fmtCost(cost, Object.keys(u.modelBreakdown ?? {})), cw)}
            </text>
          </PopupRow>,
        );
      }
    }

    return lines;
  }, [
    contextManager,
    sb.contextWindow,
    modelId,
    scopedUsage,
    scopeTabId,
    isMultiTab,
    isAllScope,
    allTabs,
    getTabUsage,
    tabMgr,
    innerW,
    sb.chatChars,
    sb.contextTokens,
    sb.subagentChars,
    sb.chatCharsAtSnapshot,
    t,
  ]);

  const [lspCount, setLspCount] = useState(0);
  useEffect(() => {
    getIntelligenceStatus().then((s) => setLspCount(s?.lspServers.length ?? 0));
  }, []);

  const systemLines = useMemo(() => {
    const rssMB = sb.rssMB;
    const memColor = rssMB < 2048 ? t.success : rssMB < 4096 ? t.amber : t.error;

    const lines: React.ReactNode[] = [];

    const rmStatusColor =
      rm.status === "ready"
        ? t.success
        : rm.status === "scanning"
          ? t.amber
          : rm.status === "error"
            ? t.error
            : t.textMuted;
    const semLabel =
      rm.semanticStatus !== "off"
        ? ` · sem: ${rm.semanticStatus} (${String(rm.semanticCount)})`
        : "";

    lines.push(<SectionHeader key="h-map" label="Soul Map" innerW={innerW} />);
    lines.push(
      <PopupRow key="rm-status" w={innerW}>
        <text fg={rmStatusColor} bg={POPUP_BG}>
          {"  "}
          {rm.status}
        </text>
        <text fg={t.textMuted} bg={POPUP_BG}>
          {` · ${String(rm.files)} files · ${String(rm.symbols)} symbols · ${String(rm.edges)} edges · ${fmtBytes(rm.dbSizeBytes)}${semLabel}`}
        </text>
      </PopupRow>,
    );
    lines.push(<Spacer key="s3" innerW={innerW} />);

    const wkIcon = (s: string) =>
      s === "busy"
        ? icon("worker_busy")
        : s === "crashed"
          ? icon("worker_crash")
          : s === "restarting"
            ? icon("worker_restart")
            : icon("worker");
    const wkColor = (s: string) =>
      s === "ready" || s === "busy"
        ? t.success
        : s === "starting" || s === "restarting"
          ? t.amber
          : s === "crashed"
            ? t.error
            : t.textMuted;

    const totalWorkerHeap = wk.intelligence.heapMB + wk.io.heapMB;
    const pr = sb.processRss;
    const hasNvim = getNvimInstance() != null;
    const hasProxy = getProxyPid() != null;

    // Workers are threads inside main — nest them under main.
    const workers: Array<{ key: string; label: string; color: string; detail: string }> = [];

    const intelStatus =
      wk.intelligence.status === "busy"
        ? `busy (${String(wk.intelligence.rpcInFlight)} rpc)`
        : wk.intelligence.status;
    const intelCalls =
      wk.intelligence.totalCalls > 0 ? ` · ${String(wk.intelligence.totalCalls)} calls` : "";
    const intelErrors =
      wk.intelligence.totalErrors > 0 ? ` · ${String(wk.intelligence.totalErrors)} err` : "";
    const intelMem = wk.intelligence.heapMB > 0 ? ` · ${fmtMem(wk.intelligence.heapMB)} heap` : "";
    const intelRestarts =
      wk.intelligence.restarts > 0 ? ` · ${String(wk.intelligence.restarts)} restart` : "";
    workers.push({
      key: "wk-intel",
      label: `${wkIcon(wk.intelligence.status)} intelligence  ${intelStatus}`,
      color: wkColor(wk.intelligence.status),
      detail: `${intelCalls}${intelErrors}${intelRestarts}${intelMem}`,
    });

    const ioStatus =
      wk.io.status === "busy" ? `busy (${String(wk.io.rpcInFlight)} rpc)` : wk.io.status;
    const ioCalls = wk.io.totalCalls > 0 ? ` · ${String(wk.io.totalCalls)} calls` : "";
    const ioMem = wk.io.heapMB > 0 ? ` · ${fmtMem(wk.io.heapMB)} heap` : "";
    const ioRestarts = wk.io.restarts > 0 ? ` · ${String(wk.io.restarts)} restart` : "";
    workers.push({
      key: "wk-io",
      label: `${wkIcon(wk.io.status)} io (smol)  ${ioStatus}`,
      color: wkColor(wk.io.status),
      detail: `${ioCalls}${ioRestarts}${ioMem}`,
    });

    // External processes — siblings of main, not children
    const externals: Array<{ key: string; label: string; color: string; detail: string }> = [];

    if (hasNvim) {
      const nvimMem = pr.nvimMB > 0 ? ` · ${fmtMem(pr.nvimMB)} rss` : "";
      externals.push({
        key: "proc-nvim",
        label: `${icon("worker")} neovim  active`,
        color: t.success,
        detail: nvimMem,
      });
    }

    if (lspCount > 0) {
      const lspMem = pr.lspMB > 0 ? ` · ${fmtMem(pr.lspMB)} rss` : "";
      externals.push({
        key: "proc-lsp",
        label: `${icon("worker")} lsp  ${String(lspCount)} server${lspCount > 1 ? "s" : ""}`,
        color: t.info,
        detail: lspMem,
      });
    }

    if (hasProxy) {
      const proxyMem = pr.proxyMB > 0 ? ` · ${fmtMem(pr.proxyMB)} rss` : "";
      externals.push({
        key: "proc-proxy",
        label: `${icon("worker")} proxy  active`,
        color: t.brand,
        detail: proxyMem,
      });
    }

    lines.push(<SectionHeader key="h-sys" label="Process Tree" innerW={innerW} />);

    // Main process with workers nested underneath
    const hasExternals = externals.length > 0;
    const mainMemColor = pr.mainMB < 1024 ? t.success : pr.mainMB < 2048 ? t.amber : t.error;
    lines.push(
      <PopupRow key="sys-main" w={innerW}>
        <text fg={t.textSecondary} bg={POPUP_BG}>
          {hasExternals ? "  ├─ " : "  └─ "}
        </text>
        <text fg={t.textSecondary} bg={POPUP_BG}>
          {"main"}
        </text>
        <text fg={mainMemColor} bg={POPUP_BG}>
          {`  ${fmtMem(pr.mainMB)} rss`}
        </text>
      </PopupRow>,
    );

    // Workers nested under main
    for (let i = 0; i < workers.length; i++) {
      const wkEntry = workers[i];
      if (!wkEntry) continue;
      const isLast = i === workers.length - 1;
      const treePad = hasExternals ? "  │  " : "     ";
      lines.push(
        <PopupRow key={wkEntry.key} w={innerW}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {isLast ? `${treePad}└─ ` : `${treePad}├─ `}
          </text>
          <text fg={wkEntry.color} bg={POPUP_BG}>
            {wkEntry.label}
          </text>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {wkEntry.detail}
          </text>
        </PopupRow>,
      );
    }

    // Terminals — PTY subprocesses
    const termStats = getTerminalStats();
    if (termStats.count > 0) {
      const termBufKB = Math.round(termStats.totalBufferBytes / 1024);
      externals.push({
        key: "proc-terminals",
        label: `${icon("terminal")} terminals  ${String(termStats.activeCount)}/${String(termStats.count)} active`,
        color: termStats.activeCount > 0 ? t.success : t.textDim,
        detail: ` · ${String(termBufKB)} KB buffer`,
      });
    }

    // External processes as siblings of main
    for (let i = 0; i < externals.length; i++) {
      const ext = externals[i];
      if (!ext) continue;
      const isLast = i === externals.length - 1;
      lines.push(
        <PopupRow key={ext.key} w={innerW}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {isLast ? "  └─ " : "  ├─ "}
          </text>
          <text fg={ext.color} bg={POPUP_BG}>
            {ext.label}
          </text>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {ext.detail}
          </text>
        </PopupRow>,
      );
    }

    if (wk.intelligence.lastError || wk.io.lastError) {
      const errMsg = wk.intelligence.lastError ?? wk.io.lastError ?? "";
      lines.push(
        <PopupRow key="wk-err" w={innerW}>
          <text fg={t.error} bg={POPUP_BG}>
            {`  ${icon("error")} ${errMsg.slice(0, innerW - 6)}`}
          </text>
        </PopupRow>,
      );
    }

    // rssMB = main + nvim + proxy + lsp (all separate processes).
    // Workers are threads in the main process — their RSS is already included in main.
    // Only worker heap is a meaningful separate metric.
    lines.push(
      <PopupRow key="sys-total" w={innerW}>
        <text fg={t.textMuted} bg={POPUP_BG}>
          {"  total  "}
        </text>
        <text fg={memColor} bg={POPUP_BG}>
          {`${fmtMem(rssMB)} rss`}
        </text>
        <text fg={t.textMuted} bg={POPUP_BG}>
          {totalWorkerHeap > 0 ? ` · ${fmtMem(totalWorkerHeap)} worker heap` : ""}
        </text>
      </PopupRow>,
    );
    lines.push(<Spacer key="s4" innerW={innerW} />);

    lines.push(<SectionHeader key="h-env" label="Environment" innerW={innerW} />);
    lines.push(
      <EntryRow
        key="sys-mode"
        label="  Mode"
        value={currentModeLabel}
        valueColor={currentMode === "default" ? t.textMuted : t.warning}
        innerW={innerW}
      />,
    );

    return lines;
  }, [sb, rm, wk, currentMode, currentModeLabel, innerW, t, lspCount]);

  const activeLines = tab === "Context" ? contextLines : systemLines;
  const clampedScroll = Math.min(scrollOffset, Math.max(0, activeLines.length - maxVisible));
  const visibleLines = activeLines.slice(clampedScroll, clampedScroll + maxVisible);

  useKeyboard((evt) => {
    if (!visible) return;

    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "tab") {
      const idx = TABS.indexOf(tab);
      setTab(TABS[(idx + 1) % TABS.length] as Tab);
      setScrollOffset(0);
      return;
    }
    if (isMultiTab && tab === "Context" && (evt.name === "left" || evt.name === "right")) {
      const scopeIds = [...allTabs.map((tb) => tb.id), "all" as const];
      setScopeTabId((prev) => {
        const idx = scopeIds.indexOf(prev as string);
        const next =
          evt.name === "right"
            ? (idx + 1) % scopeIds.length
            : (idx - 1 + scopeIds.length) % scopeIds.length;
        return scopeIds[next] ?? prev;
      });
      setScrollOffset(0);
      return;
    }
    if (evt.name === "up") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (evt.name === "down") {
      setScrollOffset((prev) => Math.min(Math.max(0, activeLines.length - maxVisible), prev + 1));
      return;
    }
  });

  if (!visible) return null;

  const footerHints = [
    { key: "tab", label: "panel" },
    ...(isMultiTab && tab === "Context" ? [{ key: "←→", label: "scope" }] : []),
    { key: "↑↓", label: "scroll" },
    { key: "esc", label: "close" },
  ];

  return (
    <Popup
      width={popupWidth}
      title=""
      icon={icon("gauge")}
      borderColor={TAB_COLORS[tab]}
      headerRight={TABS.map((tabName, i) => {
        const isActive = tabName === tab;
        const color = TAB_COLORS[tabName];
        return (
          <text
            key={tabName}
            fg={isActive ? color : t.textMuted}
            bg={POPUP_BG}
            attributes={isActive ? TextAttributes.BOLD : undefined}
          >
            {i > 0 ? " │ " : ""}
            {isActive ? `▸ ${tabName}` : `  ${tabName}`}
          </text>
        );
      })}
      footer={footerHints}
    >
      {/* Content */}
      <box
        flexDirection="column"
        height={Math.min(activeLines.length, maxVisible)}
        overflow="hidden"
      >
        {visibleLines}
      </box>

      {/* Scroll */}
      {activeLines.length > maxVisible && (
        <PopupRow w={innerW}>
          <text fg={t.textDim} bg={POPUP_BG}>
            {clampedScroll > 0 ? "↑ " : "  "}
            {String(clampedScroll + 1)}-
            {String(Math.min(clampedScroll + maxVisible, activeLines.length))}/
            {String(activeLines.length)}
            {clampedScroll + maxVisible < activeLines.length ? " ↓" : ""}
          </text>
        </PopupRow>
      )}
    </Popup>
  );
}
