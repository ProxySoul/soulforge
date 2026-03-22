import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import { getNvimInstance } from "../editor/instance.js";
import { icon } from "../icons.js";
import { getIntelligenceStatus } from "../intelligence/index.js";
import { getModelContextInfo, getShortModelLabel } from "../llm/models.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { fmtTokenCount, sysMsg } from "./utils.js";

function handleStatus(_input: string, ctx: CommandContext): void {
  const sb = useStatusBarStore.getState();
  const rm = useRepoMapStore.getState();
  const modelInfo = getModelContextInfo(ctx.chat.activeModel);
  const lspStatus = getIntelligenceStatus();
  const lspCount = lspStatus?.lspServers.length ?? 0;
  const rssMB = sb.rssMB;
  const memColor = rssMB < 2048 ? "#4a7" : rssMB < 4096 ? "#b87333" : "#f44";
  const fmtMem = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(mb)} MB`);
  const fmtTokens = fmtTokenCount;
  const fmtBytes = (b: number) => {
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${String(b)} B`;
  };
  const ctxPct =
    modelInfo.tokens > 0
      ? Math.round(
          ((sb.contextTokens || (sb.chatChars + sb.subagentChars) / 4) / modelInfo.tokens) * 100,
        )
      : 0;
  const ctxColor =
    ctxPct < 50 ? "#4a7" : ctxPct < 70 ? "#b87333" : ctxPct < 85 ? "#FF8C00" : "#f44";

  const lines: InfoPopupLine[] = [
    { type: "header", label: "Context" },
    {
      type: "bar",
      label: "Usage",
      pct: ctxPct,
      barColor: ctxColor,
      desc: `${String(ctxPct)}%`,
      descColor: ctxColor,
    },
    { type: "entry", label: "Window", desc: fmtTokens(modelInfo.tokens), descColor: "#888" },
    {
      type: "entry",
      label: "Compaction",
      desc: sb.compacting ? "active" : sb.compactionStrategy,
      descColor: sb.compacting ? "#5af" : "#666",
    },
    { type: "spacer" },
    { type: "header", label: "Tokens (session)" },
    { type: "entry", label: "Input", desc: fmtTokens(sb.tokenUsage.prompt), descColor: "#2d9bf0" },
    {
      type: "entry",
      label: "Output",
      desc: fmtTokens(sb.tokenUsage.completion),
      descColor: "#e0a020",
    },
    {
      type: "entry",
      label: "Cache read",
      desc: fmtTokens(sb.tokenUsage.cacheRead),
      descColor: sb.tokenUsage.cacheRead > 0 ? "#4a7" : "#666",
    },
  ];
  const subTotal = sb.tokenUsage.subagentInput + sb.tokenUsage.subagentOutput;
  if (subTotal > 0) {
    lines.push({
      type: "entry",
      label: "Subagents",
      desc: fmtTokens(subTotal),
      descColor: "#9B30FF",
    });
  }
  lines.push(
    { type: "spacer" },
    { type: "header", label: "Soul Map" },
    {
      type: "entry",
      label: "Status",
      desc: rm.status,
      descColor:
        rm.status === "ready"
          ? "#4a7"
          : rm.status === "scanning"
            ? "#b87333"
            : rm.status === "error"
              ? "#f44"
              : "#666",
    },
    { type: "entry", label: "Files", desc: String(rm.files), descColor: "#888" },
    { type: "entry", label: "Symbols", desc: String(rm.symbols), descColor: "#888" },
    { type: "entry", label: "Edges", desc: String(rm.edges), descColor: "#888" },
    { type: "entry", label: "DB size", desc: fmtBytes(rm.dbSizeBytes), descColor: "#888" },
  );
  if (rm.semanticStatus !== "off") {
    lines.push({
      type: "entry",
      label: "Semantics",
      desc: `${rm.semanticStatus} (${String(rm.semanticCount)})`,
      descColor: rm.semanticStatus === "ready" ? "#4a7" : "#b87333",
    });
  }
  lines.push(
    { type: "spacer" },
    { type: "header", label: "System" },
    { type: "entry", label: "Memory", desc: fmtMem(rssMB), descColor: memColor },
    {
      type: "entry",
      label: "LSP standalone",
      desc: lspCount > 0 ? `${String(lspCount)} active` : "none",
      descColor: lspCount > 0 ? "#2dd4bf" : "#666",
    },
    {
      type: "entry",
      label: "LSP neovim",
      desc: getNvimInstance() ? "active" : "not running",
      descColor: getNvimInstance() ? "#57A143" : "#666",
    },
    {
      type: "entry",
      label: "Model",
      desc: getShortModelLabel(ctx.chat.activeModel),
      descColor: "#888",
    },
    {
      type: "entry",
      label: "Mode",
      desc: ctx.currentModeLabel,
      descColor: ctx.currentMode === "default" ? "#666" : "#FF8C00",
    },
  );
  ctx.openInfoPopup({
    title: "System Status",
    icon: icon("info"),
    lines,
    width: 52,
    labelWidth: 16,
  });
}

function handleDiagnose(_input: string, _ctx: CommandContext): void {
  useUIStore.getState().openModal("diagnosePopup");
}

function handleSetup(_input: string, ctx: CommandContext): void {
  ctx.openSetup();
}

function handleLsp(_input: string, ctx: CommandContext): void {
  ctx.openLspStatus();
}

function handleLspInstall(_input: string, ctx: CommandContext): void {
  ctx.openLspInstall();
}

async function handleLspRestart(input: string, ctx: CommandContext): Promise<void> {
  const filter = input.replace(/^\/lsp-restart\s*/, "").trim() || undefined;
  const { restartLspServers } = await import("../intelligence/index.js");
  const label = filter ?? "all";
  sysMsg(ctx, `Restarting LSP servers (${label})…`);
  const restarted = await restartLspServers(filter);
  if (restarted.length === 0) {
    sysMsg(ctx, "No matching LSP servers to restart.");
  } else {
    sysMsg(ctx, `Restarted ${restarted.length} server(s): ${restarted.join(", ")}. Re-warming…`);
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/status", handleStatus);
  map.set("/diagnose", handleDiagnose);
  map.set("/setup", handleSetup);
  map.set("/lsp", handleLsp);
  map.set("/lsp-install", handleLspInstall);
  map.set("/lsp-restart", handleLspRestart);
}
