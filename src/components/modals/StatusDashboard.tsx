import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { getNvimInstance } from "../../core/editor/instance.js";
import { icon } from "../../core/icons.js";
import { getIntelligenceStatus } from "../../core/intelligence/index.js";
import { getModelContextInfo, getShortModelLabel } from "../../core/llm/models.js";
import { getProxyPid } from "../../core/proxy/lifecycle.js";
import type { ChatInstance } from "../../hooks/useChat.js";
import type { UseTabsReturn } from "../../hooks/useTabs.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import { computeCost, useStatusBarStore } from "../../stores/statusbar.js";
import { useWorkerStore } from "../../stores/workers.js";
import { Overlay, POPUP_BG, PopupRow } from "../layout/shared.js";

const CHROME_ROWS = 6;
const TABS = ["Context", "System"] as const;
type Tab = (typeof TABS)[number];

const TAB_COLORS: Record<Tab, string> = {
  Context: "#2d9bf0",
  System: "#9B30FF",
};

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
}: {
  label: string;
  pct: number;
  desc: string;
  barColor: string;
  descColor: string;
  innerW: number;
  labelW?: number;
}) {
  const truncLabel = label.length > labelW ? `${label.slice(0, labelW - 1)}…` : label;
  const barW = Math.max(6, innerW - labelW - desc.length - 6);
  const filled = Math.round((pct / 100) * barW);
  return (
    <PopupRow w={innerW}>
      <text fg="#888" bg={POPUP_BG}>
        {truncLabel.padEnd(labelW)}
      </text>
      <text fg={barColor} bg={POPUP_BG}>
        {"▰".repeat(filled)}
      </text>
      <text fg="#222" bg={POPUP_BG}>
        {"▱".repeat(barW - filled)}
      </text>
      <text fg={descColor} bg={POPUP_BG}>
        {" "}
        {desc}
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
}: {
  label: string;
  value: string;
  labelColor?: string;
  valueColor?: string;
  innerW: number;
  labelW?: number;
}) {
  return (
    <PopupRow w={innerW}>
      <text fg={labelColor ?? "#888"} bg={POPUP_BG}>
        {label.padEnd(labelW)}
      </text>
      <text fg={valueColor ?? "#ccc"} bg={POPUP_BG}>
        {value}
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
  return (
    <PopupRow w={innerW}>
      <text fg={color ?? "#8B5CF6"} bg={POPUP_BG} attributes={TextAttributes.BOLD}>
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
  chat: ChatInstance | null;
  contextManager: ContextManager;
  tabMgr: UseTabsReturn;
  currentMode: string;
  currentModeLabel: string;
}

export function StatusDashboard({
  visible,
  initialTab,
  onClose,
  chat,
  contextManager,
  tabMgr,
  currentMode,
  currentModeLabel,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupWidth = Math.min(82, Math.floor(termCols * 0.85));
  const innerW = popupWidth - 2;
  const maxVisible = Math.max(6, Math.floor((termRows - 2) * 0.8) - CHROME_ROWS);
  const [tab, setTab] = useState<Tab>(initialTab ?? "Context");
  const [scrollOffset, setScrollOffset] = useState(0);

  const sb = useStatusBarStore();
  const rm = useRepoMapStore();
  const wk = useWorkerStore();

  useEffect(() => {
    if (visible) {
      setTab(initialTab ?? "Context");
      setScrollOffset(0);
    }
  }, [visible, initialTab]);

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

  const modelId = chat?.activeModel ?? "none";
  const tu = sb.tokenUsage;

  const contextLines = useMemo(() => {
    const breakdown = contextManager.getContextBreakdown();
    const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
    const ctxWindow = sb.contextWindow > 0 ? sb.contextWindow : getModelContextInfo(modelId).tokens;
    const isApi = sb.contextTokens > 0;
    const charEstimate = (systemChars + sb.chatChars + sb.subagentChars) / 4;
    const usedTokens = Math.round(isApi ? sb.contextTokens + sb.subagentChars / 4 : charEstimate);
    const fillPct =
      usedTokens > 0 ? Math.min(100, Math.max(1, Math.round((usedTokens / ctxWindow) * 100))) : 0;
    const activeSections = breakdown.filter((s) => s.active && s.chars > 0);
    const totalSysChars = activeSections.reduce((sum, s) => sum + s.chars, 0);

    const lines: React.ReactNode[] = [];

    const pctLabel = isApi ? `${String(fillPct)}%` : `~${String(fillPct)}%`;
    lines.push(
      <BarRow
        key="ctx-bar"
        label="Context Window"
        pct={fillPct}
        desc={`${fmtTokens(usedTokens)} / ${fmtTokens(ctxWindow)} (${pctLabel})`}
        barColor={fillPct > 75 ? "#FF0040" : fillPct > 50 ? "#FF8C00" : "#1a6"}
        descColor={fillPct > 75 ? "#FF0040" : fillPct > 50 ? "#FF8C00" : "#888"}
        innerW={innerW}
      />,
    );
    lines.push(
      <EntryRow key="model" label="Model" value={getShortModelLabel(modelId)} innerW={innerW} />,
    );
    lines.push(<Spacer key="s1" innerW={innerW} />);

    if (activeSections.length > 0) {
      const sysLabelW = Math.min(
        22,
        Math.max(18, ...activeSections.map((s) => s.section.length + 4)),
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
            barColor={sPct > 40 ? "#FF8C00" : "#555"}
            descColor="#666"
            innerW={innerW}
            labelW={sysLabelW}
          />,
        );
      }
      lines.push(<Spacer key="s2" innerW={innerW} />);
    }

    lines.push(<SectionHeader key="h-tok" label="Token Usage (session)" innerW={innerW} />);
    {
      const uncachedInput = tu.prompt + tu.subagentInput;
      const allInput = uncachedInput + tu.cacheRead + tu.cacheWrite;
      const totalOutput = tu.completion + tu.subagentOutput;
      const hasSub = tu.subagentInput > 0 || tu.subagentOutput > 0;
      const cachePct =
        allInput > 0 ? Math.min(100, Math.round((tu.cacheRead / allInput) * 100)) : 0;

      lines.push(
        <EntryRow
          key="t-in"
          label="  Input"
          value={fmtTokens(uncachedInput)}
          valueColor="#2d9bf0"
          innerW={innerW}
        />,
      );
      if (hasSub) {
        lines.push(
          <EntryRow
            key="t-in-main"
            label="    Main"
            value={fmtTokens(tu.prompt)}
            valueColor="#5a8abf"
            innerW={innerW}
          />,
        );
        lines.push(
          <EntryRow
            key="t-in-sub"
            label="    Dispatch"
            value={fmtTokens(tu.subagentInput)}
            valueColor="#9B30FF"
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <EntryRow
          key="t-out"
          label="  Output"
          value={fmtTokens(totalOutput)}
          valueColor="#e0a020"
          innerW={innerW}
        />,
      );
      if (hasSub) {
        lines.push(
          <EntryRow
            key="t-out-main"
            label="    Main"
            value={fmtTokens(tu.completion)}
            valueColor="#b89030"
            innerW={innerW}
          />,
        );
        lines.push(
          <EntryRow
            key="t-out-sub"
            label="    Dispatch"
            value={fmtTokens(tu.subagentOutput)}
            valueColor="#9B30FF"
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <BarRow
          key="t-cache"
          label="  Cache Read"
          pct={cachePct}
          desc={tu.cacheRead > 0 ? `${fmtTokens(tu.cacheRead)} (${String(cachePct)}%)` : "—"}
          barColor={tu.cacheRead > 0 ? "#2d5" : "#333"}
          descColor={tu.cacheRead > 0 ? "#2d5" : "#444"}
          innerW={innerW}
        />,
      );
      if (tu.cacheWrite > 0) {
        lines.push(
          <EntryRow
            key="t-cache-write"
            label="  Cache Write"
            value={fmtTokens(tu.cacheWrite)}
            valueColor="#e0a020"
            innerW={innerW}
          />,
        );
      }
      if (tu.cacheRead > 0) {
        lines.push(
          <EntryRow
            key="t-uncached"
            label="    Uncached"
            value={fmtTokens(uncachedInput)}
            valueColor="#888"
            innerW={innerW}
          />,
        );
      }

      lines.push(
        <EntryRow key="t-total" label="  Total" value={fmtTokens(tu.total)} innerW={innerW} />,
      );

      const cost = computeCost(tu, modelId);
      if (cost > 0) {
        const costStr = cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
        lines.push(
          <EntryRow
            key="t-cost"
            label="  Cost"
            value={costStr}
            valueColor="#ccc"
            innerW={innerW}
          />,
        );
      }
    }

    const allTabs = tabMgr.tabs;
    if (allTabs.length > 1) {
      lines.push(<Spacer key="s3" innerW={innerW} />);
      lines.push(
        <SectionHeader
          key="h-tabs"
          label={`All Tabs (${String(allTabs.length)})`}
          innerW={innerW}
        />,
      );
      let grandTotal = 0;
      for (let i = 0; i < allTabs.length; i++) {
        const t = allTabs[i];
        if (!t) continue;
        const c = tabMgr.getChat(t.id);
        const u = c?.tokenUsage ?? {
          prompt: 0,
          completion: 0,
          total: 0,
          cacheRead: 0,
          subagentInput: 0,
          subagentOutput: 0,
          lastStepInput: 0,
          lastStepOutput: 0,
          lastStepCacheRead: 0,
        };
        grandTotal += u.total;
        const isActive = t.id === tabMgr.activeTabId;
        lines.push(
          <EntryRow
            key={`tab-${t.id}`}
            label={`  ${isActive ? "▸" : " "} Tab ${String(i + 1)}`}
            value={
              u.total > 0
                ? `${fmtTokens(u.prompt)}↑ ${fmtTokens(u.completion)}↓ = ${fmtTokens(u.total)}`
                : "—"
            }
            labelColor={isActive ? "#2d9bf0" : "#888"}
            valueColor={isActive ? "#ccc" : "#666"}
            innerW={innerW}
          />,
        );
      }
      lines.push(
        <EntryRow key="tab-total" label="  Total" value={fmtTokens(grandTotal)} innerW={innerW} />,
      );
    }

    return lines;
  }, [
    contextManager,
    sb.contextWindow,
    modelId,
    tu,
    tabMgr,
    innerW,
    sb.chatChars,
    sb.contextTokens,
    sb.subagentChars,
  ]);

  const systemLines = useMemo(() => {
    const lspStatus = getIntelligenceStatus();
    const lspCount = lspStatus?.lspServers.length ?? 0;
    const rssMB = sb.rssMB;
    const memColor = rssMB < 2048 ? "#4a7" : rssMB < 4096 ? "#b87333" : "#f44";

    const lines: React.ReactNode[] = [];

    const rmStatusColor =
      rm.status === "ready"
        ? "#4a7"
        : rm.status === "scanning"
          ? "#b87333"
          : rm.status === "error"
            ? "#f44"
            : "#666";
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
        <text fg="#666" bg={POPUP_BG}>
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
        ? "#4a7"
        : s === "starting" || s === "restarting"
          ? "#b87333"
          : s === "crashed"
            ? "#f44"
            : "#666";

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
        color: "#57A143",
        detail: nvimMem,
      });
    }

    if (lspCount > 0) {
      const lspMem = pr.lspMB > 0 ? ` · ${fmtMem(pr.lspMB)} rss` : "";
      externals.push({
        key: "proc-lsp",
        label: `${icon("worker")} lsp  ${String(lspCount)} server${lspCount > 1 ? "s" : ""}`,
        color: "#2dd4bf",
        detail: lspMem,
      });
    }

    if (hasProxy) {
      const proxyMem = pr.proxyMB > 0 ? ` · ${fmtMem(pr.proxyMB)} rss` : "";
      externals.push({
        key: "proc-proxy",
        label: `${icon("worker")} proxy  active`,
        color: "#9B30FF",
        detail: proxyMem,
      });
    }

    lines.push(<SectionHeader key="h-sys" label="Process Tree" innerW={innerW} />);

    // Main process with workers nested underneath
    const hasExternals = externals.length > 0;
    const mainMemColor = pr.mainMB < 1024 ? "#4a7" : pr.mainMB < 2048 ? "#b87333" : "#f44";
    lines.push(
      <PopupRow key="sys-main" w={innerW}>
        <text fg="#888" bg={POPUP_BG}>
          {hasExternals ? "  ├─ " : "  └─ "}
        </text>
        <text fg="#888" bg={POPUP_BG}>
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
          <text fg="#555" bg={POPUP_BG}>
            {isLast ? `${treePad}└─ ` : `${treePad}├─ `}
          </text>
          <text fg={wkEntry.color} bg={POPUP_BG}>
            {wkEntry.label}
          </text>
          <text fg="#666" bg={POPUP_BG}>
            {wkEntry.detail}
          </text>
        </PopupRow>,
      );
    }

    // External processes as siblings of main
    for (let i = 0; i < externals.length; i++) {
      const ext = externals[i];
      if (!ext) continue;
      const isLast = i === externals.length - 1;
      lines.push(
        <PopupRow key={ext.key} w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {isLast ? "  └─ " : "  ├─ "}
          </text>
          <text fg={ext.color} bg={POPUP_BG}>
            {ext.label}
          </text>
          <text fg="#666" bg={POPUP_BG}>
            {ext.detail}
          </text>
        </PopupRow>,
      );
    }

    if (wk.intelligence.lastError || wk.io.lastError) {
      const errMsg = wk.intelligence.lastError ?? wk.io.lastError ?? "";
      lines.push(
        <PopupRow key="wk-err" w={innerW}>
          <text fg="#f44" bg={POPUP_BG}>
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
        <text fg="#555" bg={POPUP_BG}>
          {"  total  "}
        </text>
        <text fg={memColor} bg={POPUP_BG}>
          {`${fmtMem(rssMB)} rss`}
        </text>
        <text fg="#666" bg={POPUP_BG}>
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
        valueColor={currentMode === "default" ? "#666" : "#FF8C00"}
        innerW={innerW}
      />,
    );

    return lines;
  }, [sb, rm, wk, currentMode, currentModeLabel, innerW]);

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

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={TAB_COLORS[tab]}
        width={popupWidth}
      >
        {/* Title + tabs */}
        <PopupRow w={innerW}>
          <text fg={TAB_COLORS[tab]} bg={POPUP_BG}>
            {icon("gauge")}{" "}
          </text>
          {TABS.map((t, i) => {
            const isActive = t === tab;
            const color = TAB_COLORS[t];
            return (
              <text
                key={t}
                fg={isActive ? color : "#555"}
                bg={POPUP_BG}
                attributes={isActive ? TextAttributes.BOLD : undefined}
              >
                {i > 0 ? " │ " : ""}
                {isActive ? `▸ ${t}` : `  ${t}`}
              </text>
            );
          })}
        </PopupRow>

        {/* Separator */}
        <PopupRow w={innerW}>
          <text fg="#222" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>

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
            <text fg="#444" bg={POPUP_BG}>
              {clampedScroll > 0 ? "↑ " : "  "}
              {String(clampedScroll + 1)}-
              {String(Math.min(clampedScroll + maxVisible, activeLines.length))}/
              {String(activeLines.length)}
              {clampedScroll + maxVisible < activeLines.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        {/* Footer */}
        <PopupRow w={innerW}>
          <text fg="#444" bg={POPUP_BG}>
            ⇥ switch tab | ↑↓ scroll | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
}
