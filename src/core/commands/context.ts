import type { InfoPopupLine } from "../../components/modals/InfoPopup.js";
import type { TokenUsage } from "../../hooks/useChat.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useUIStore } from "../../stores/ui.js";
import { icon } from "../icons.js";
import { getModelContextInfo, getShortModelLabel } from "../llm/models.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { fmtTokenCount, sysMsg } from "./utils.js";

export function openRepoMapMenu(_ctx: CommandContext): void {
  useUIStore.getState().openModal("repoMapStatus");
}

export function openMemoryMenu(ctx: CommandContext): void {
  const memMgr = ctx.contextManager.getMemoryManager();

  const showMain = () => {
    const config = memMgr.scopeConfig;
    ctx.openCommandPicker({
      title: "Memory",
      icon: icon("memory"),
      options: [
        {
          value: "write-scope",
          label: "Write Scope",
          description: `where Forge saves new memories (current: ${config.writeScope})`,
        },
        {
          value: "read-scope",
          label: "Read Scope",
          description: `which memories Forge can access (current: ${config.readScope})`,
        },
        {
          value: "settings-storage",
          label: "Save Settings To",
          description: `where these scope preferences are stored (current: ${memMgr.settingsScope})`,
        },
        { value: "view", label: "View Memories", description: "browse all stored memories" },
        { value: "clear", label: "Clear Memories", description: "permanently delete memories" },
      ],
      onSelect: (value) => {
        if (value === "write-scope") {
          ctx.openCommandPicker({
            title: "Write Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.writeScope,
            options: [
              {
                value: "global",
                label: "Global",
                description: "shared across all projects (~/.soulforge/)",
              },
              {
                value: "project",
                label: "Project",
                description: "scoped to this project (.soulforge/)",
              },
              { value: "none", label: "None", description: "Forge won't save new memories" },
            ],
            onSelect: (ws) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                writeScope: ws as "global" | "project" | "none",
              };
              sysMsg(ctx, `Memory write scope: ${ws}`);
              showMain();
            },
          });
        } else if (value === "read-scope") {
          ctx.openCommandPicker({
            title: "Read Scope",
            icon: icon("memory"),
            currentValue: memMgr.scopeConfig.readScope,
            options: [
              {
                value: "all",
                label: "All",
                description: "search both project and global memories",
              },
              { value: "global", label: "Global", description: "only access global memories" },
              {
                value: "project",
                label: "Project",
                description: "only access this project's memories",
              },
              {
                value: "none",
                label: "None",
                description: "Forge won't read or auto-recall memories",
              },
            ],
            onSelect: (rs) => {
              memMgr.scopeConfig = {
                ...memMgr.scopeConfig,
                readScope: rs as "global" | "project" | "all" | "none",
              };
              sysMsg(ctx, `Memory read scope: ${rs}`);
              showMain();
            },
          });
        } else if (value === "settings-storage") {
          ctx.openCommandPicker({
            title: "Persist Settings",
            icon: icon("memory"),
            currentValue: memMgr.settingsScope,
            options: [
              {
                value: "project",
                label: "Project",
                description: "scope preferences saved in .soulforge/ (this project only)",
              },
              {
                value: "global",
                label: "Global",
                description: "scope preferences saved in ~/.soulforge/ (apply everywhere)",
              },
            ],
            onSelect: (ss) => {
              memMgr.setSettingsScope(ss as "project" | "global");
              sysMsg(ctx, `Memory settings saved to: ${ss}`);
              showMain();
            },
          });
        } else if (value === "view") {
          const scopes = ["project", "global"] as const;
          const lines: InfoPopupLine[] = [];
          for (const scope of scopes) {
            const memories = memMgr.listByScope(scope);
            lines.push({ type: "header", label: `${scope} (${String(memories.length)})` });
            if (memories.length === 0) {
              lines.push({ type: "text", label: "  (empty)", color: "#444" });
            } else {
              for (const m of memories) {
                lines.push({
                  type: "entry",
                  label: `  ${m.category}`,
                  desc: m.title,
                  color: "#FF8C00",
                });
              }
            }
            lines.push({ type: "spacer" });
          }
          ctx.openInfoPopup({ title: "Memories", icon: icon("memory"), lines, onClose: showMain });
        } else if (value === "clear") {
          ctx.openCommandPicker({
            title: "Clear Memories",
            icon: icon("memory"),
            options: [
              {
                value: "project",
                label: "Project",
                description: "delete all project-scoped memories",
              },
              { value: "global", label: "Global", description: "delete all global memories" },
              { value: "all", label: "All", description: "delete everything from both scopes" },
            ],
            onSelect: (scope) => {
              const cleared = memMgr.clearScope(scope as "project" | "global" | "all");
              sysMsg(ctx, `Cleared ${String(cleared)} ${scope} memories.`);
              showMain();
            },
          });
        }
      },
    });
  };

  showMain();
}

function handleContextClear(input: string, ctx: CommandContext): void {
  const cmd = input.trim().toLowerCase();
  const what = cmd.includes("git")
    ? "git"
    : cmd.includes("skills")
      ? "skills"
      : cmd.includes("memory")
        ? "memory"
        : "all";
  const cleared = ctx.contextManager.clearContext(what as "git" | "memory" | "skills" | "all");
  sysMsg(ctx, cleared.length > 0 ? `Cleared: ${cleared.join(", ")}` : "Nothing to clear.");
}

function handleContext(_input: string, ctx: CommandContext): void {
  const breakdown = ctx.contextManager.getContextBreakdown();
  const totalChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
  const modelId = ctx.chat.activeModel;
  const storeWindow = useStatusBarStore.getState().contextWindow;
  const ctxWindow = storeWindow > 0 ? storeWindow : getModelContextInfo(modelId).tokens;
  const tu: TokenUsage = ctx.chat.tokenUsage;
  const apiCtx = ctx.chat.contextTokens;
  const usedTokens = apiCtx > 0 ? apiCtx : Math.ceil(totalChars / 4);
  const fillPct = Math.min(100, Math.round((usedTokens / ctxWindow) * 100));

  const fmtT = fmtTokenCount;

  const popupLines: InfoPopupLine[] = [
    {
      type: "bar",
      label: "Context window",
      pct: fillPct,
      desc: `${fmtT(usedTokens)} / ${fmtT(ctxWindow)} (${String(fillPct)}%)`,
      descColor: fillPct > 75 ? "#FF0040" : fillPct > 50 ? "#FF8C00" : "#888",
    },
    {
      type: "entry",
      label: "Model",
      desc: getShortModelLabel(modelId),
      color: "#888",
      descColor: "#ccc",
    },
    { type: "separator" },
    { type: "header", label: "System Prompt Breakdown" },
  ];

  const activeSections = breakdown.filter((s) => s.active && s.chars > 0);
  const totalSysChars = activeSections.reduce((sum, s) => sum + s.chars, 0);
  for (const s of activeSections) {
    const sTokens = Math.ceil(s.chars / 4);
    const sPct = totalSysChars > 0 ? Math.round((s.chars / totalSysChars) * 100) : 0;
    popupLines.push({
      type: "bar",
      label: s.section,
      pct: sPct,
      desc: `~${fmtT(sTokens)}`,
      color: "#ccc",
      descColor: "#666",
      barColor: sPct > 40 ? "#FF8C00" : "#555",
    });
  }

  popupLines.push(
    { type: "separator" },
    { type: "header", label: "Token Usage (session)" },
    {
      type: "entry",
      label: "Input",
      desc: fmtT(tu.prompt),
      color: "#2d9bf0",
      descColor: "#2d9bf0",
    },
    {
      type: "entry",
      label: "Output",
      desc: fmtT(tu.completion),
      color: "#e0a020",
      descColor: "#e0a020",
    },
    { type: "entry", label: "Total", desc: fmtT(tu.total), color: "#ccc", descColor: "#ccc" },
  );
  if (tu.subagentInput > 0 || tu.subagentOutput > 0) {
    popupLines.push({
      type: "entry",
      label: "  Dispatch Agents",
      desc: `${fmtT(tu.subagentInput)}↑ ${fmtT(tu.subagentOutput)}↓ (included in total)`,
      color: "#9B30FF",
      descColor: "#666",
    });
  }

  // Per-tab usage breakdown (only when multiple tabs exist)
  const allTabs = ctx.tabMgr.tabs;
  if (allTabs.length > 1) {
    let grandInput = 0;
    let grandOutput = 0;
    let grandTotal = 0;
    const tabEntries: { label: string; usage: TokenUsage }[] = [];
    for (const tab of allTabs) {
      const chat = ctx.tabMgr.getChat(tab.id);
      const usage = chat
        ? chat.tokenUsage
        : { prompt: 0, completion: 0, total: 0, cacheRead: 0, subagentInput: 0, subagentOutput: 0 };
      tabEntries.push({ label: tab.label, usage });
      grandInput += usage.prompt;
      grandOutput += usage.completion;
      grandTotal += usage.total;
    }

    popupLines.push(
      { type: "separator" },
      { type: "header", label: `All Tabs (${String(allTabs.length)})` },
    );
    for (let i = 0; i < tabEntries.length; i++) {
      const entry = tabEntries[i];
      if (!entry) continue;
      const isActive = entry.usage === tu;
      const label = isActive ? `▸ Tab ${String(i + 1)}` : `  Tab ${String(i + 1)}`;
      popupLines.push({
        type: "entry",
        label,
        desc:
          entry.usage.total > 0
            ? `${fmtT(entry.usage.prompt)}↑ ${fmtT(entry.usage.completion)}↓ = ${fmtT(entry.usage.total)}`
            : "—",
        color: isActive ? "#2d9bf0" : "#888",
        descColor: isActive ? "#ccc" : "#666",
      });
    }
    popupLines.push({
      type: "entry",
      label: "  All tabs total",
      desc: `${fmtT(grandInput)}↑ ${fmtT(grandOutput)}↓ = ${fmtT(grandTotal)}`,
      color: "#ccc",
      descColor: "#ccc",
    });
  }

  if (tu.cacheRead > 0) {
    const cachePct = tu.prompt > 0 ? Math.round((tu.cacheRead / tu.prompt) * 100) : 0;
    const newTokens = tu.prompt - tu.cacheRead;
    popupLines.push(
      { type: "separator" },
      { type: "header", label: "⚡ Cache Savings" },
      {
        type: "bar",
        label: "Cache hit rate",
        pct: cachePct,
        desc: `${String(cachePct)}%`,
        barColor: "#2d5",
        descColor: "#2d5",
      },
      {
        type: "entry",
        label: "Cached",
        desc: `${fmtT(tu.cacheRead)} tokens (reused from cache)`,
        color: "#2d5",
        descColor: "#2d5",
      },
      {
        type: "entry",
        label: "New input",
        desc: `${fmtT(newTokens)} tokens (fresh processing)`,
        color: "#888",
        descColor: "#888",
      },
    );
  }

  popupLines.push(
    { type: "separator" },
    { type: "text", label: "/context clear [git|skills|memory|all]" },
  );
  ctx.openInfoPopup({
    title: "Context Budget",
    icon: icon("budget"),
    lines: popupLines,
    labelWidth: 22,
    width: 72,
  });
}

function handleMemory(_input: string, ctx: CommandContext): void {
  openMemoryMenu(ctx);
}

function handleRepoMap(_input: string, ctx: CommandContext): void {
  openRepoMapMenu(ctx);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/context", handleContext);
  map.set("/memory", handleMemory);
  map.set("/repo-map", handleRepoMap);
}

export function matchContextPrefix(cmd: string): CommandHandler | null {
  if (cmd.startsWith("/context clear") || cmd === "/context reset") return handleContextClear;
  return null;
}
