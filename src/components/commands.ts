import { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextManager } from "../core/context/manager.js";
import {
  getGitDiff,
  getGitLog,
  getGitStatus,
  gitInit,
  gitPull,
  gitPush,
  gitStash,
  gitStashPop,
} from "../core/git/status.js";
import { icon, setNerdFont } from "../core/icons.js";
import { getModelContextInfo, getShortModelLabel } from "../core/llm/models.js";
import { SessionManager } from "../core/sessions/manager.js";
import type { ChatInstance, TokenUsage } from "../hooks/useChat.js";
import type { UseTabsReturn } from "../hooks/useTabs.js";
import { restart } from "../index.js";
import { useRepoMapStore } from "../stores/repomap.js";
import { useUIStore } from "../stores/ui.js";
import type {
  AgentFeatures,
  AppConfig,
  ChatStyle,
  ForgeMode,
  NvimConfigMode,
} from "../types/index.js";
import type { CommandPickerConfig } from "./CommandPicker.js";
import type { InfoPopupConfig } from "./InfoPopup.js";
import type { ConfigScope } from "./shared.js";

export interface CommandContext {
  chat: ChatInstance;
  tabMgr: UseTabsReturn;
  toggleFocus: () => void;
  nvimOpen: (path: string) => Promise<void>;
  exit: () => void;
  openSkills: () => void;
  openGitCommit: () => void;
  openSessions: () => void;
  openHelp: () => void;
  openErrorLog: () => void;
  cwd: string;
  refreshGit: () => void;
  setForgeMode: (mode: ForgeMode) => void;
  currentMode: ForgeMode;
  currentModeLabel: string;
  contextManager: ContextManager;
  chatStyle: ChatStyle;
  setChatStyle: (style: ChatStyle) => void;
  handleSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  openGitMenu: () => void;
  openEditorWithFile: (file: string) => void;
  effectiveNvimConfig: NvimConfigMode | undefined;
  vimHints: boolean;
  verbose: boolean;
  diffStyle: "default" | "sidebyside" | "compact";
  compactionStrategy: "v1" | "v2";
  showReasoning: boolean;
  setShowReasoning: (v: boolean) => void;
  openSetup: () => void;
  openEditorSettings: () => void;
  openRouterSettings: () => void;
  openProviderSettings: () => void;
  openWebSearchSettings: () => void;
  openLspStatus: () => void;
  openCommandPicker: (config: CommandPickerConfig) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  toggleChanges: () => void;
  saveToScope: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  detectScope: (key: string) => ConfigScope;
  agentFeatures: AgentFeatures | undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sysMsg(ctx: CommandContext, content: string): void {
  ctx.chat.setMessages((prev) => [
    ...prev,
    { id: crypto.randomUUID(), role: "system", content, timestamp: Date.now() },
  ]);
}

function applyRepoMapToggle(
  ctx: CommandContext,
  nowEnabled: boolean,
  toScope: ConfigScope,
  fromScope?: ConfigScope,
): void {
  const cm = ctx.contextManager;
  cm.setRepoMapEnabled(nowEnabled);
  ctx.saveToScope({ repoMap: nowEnabled }, toScope, fromScope);

  if (nowEnabled) {
    if (!cm.isRepoMapReady()) cm.refreshRepoMap().catch(() => {});
  } else {
    if (cm.isSemanticEnabled()) {
      cm.setSemanticSummaries("off");
      ctx.saveToScope({ semanticSummaries: "off" }, toScope);
    }
    cm.clearRepoMap();
  }

  sysMsg(ctx, `Repo map ${nowEnabled ? "enabled" : "disabled"} (${toScope}).`);
}

function triggerSemanticGeneration(ctx: CommandContext, cm: ContextManager): void {
  const modelId = cm.getSemanticModelId(ctx.chat.activeModel);
  const label = getShortModelLabel(modelId);
  useRepoMapStore.getState().setSemanticStatus("generating");
  sysMsg(ctx, `Generating semantic summaries [${label}]...`);
  cm.generateSemanticSummaries(modelId)
    .then((count) => {
      sysMsg(
        ctx,
        count > 0
          ? `Generated ${String(count)} semantic summaries [${label}].`
          : `All ${String(cm.getRepoMap().getStats().summaries)} summaries up to date.`,
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sysMsg(ctx, `Failed to generate semantic summaries: ${msg}`);
    });
}

function openRepoMapMenu(ctx: CommandContext): void {
  const cm = ctx.contextManager;
  const repoMap = cm.getRepoMap();
  const enabled = cm.isRepoMapEnabled();
  const ready = cm.isRepoMapReady();
  const stats = repoMap.getStats();
  const size = repoMap.dbSizeBytes();

  const statusDesc = enabled
    ? ready
      ? `${String(stats.files)} files, ${String(stats.symbols)} sym, ${String(stats.edges)} edges (${formatBytes(size)})`
      : "scanning..."
    : "off — using file tree";

  ctx.openCommandPicker({
    title: "Repo Map",
    icon: icon("repomap"),
    currentValue: enabled ? "enable" : "disable",
    keepOpen: true,
    scopeEnabled: true,
    initialScope: ctx.detectScope("repoMap"),
    options: [
      {
        value: "enable",
        label: "Enable (recommended)",
        description: `AST-ranked codebase map — ${statusDesc}`,
      },
      {
        value: "disable",
        label: "Disable",
        description: "fall back to static file tree",
      },
      {
        value: "refresh",
        label: "Refresh",
        description: "rescan all files and rebuild index",
      },
      {
        value: "clear",
        label: "Clear Index",
        description: `delete index data (${formatBytes(size)})`,
      },
      {
        value: "semantic",
        label: cm.getSemanticMode() === "llm" ? "LLM Summaries ✓" : "LLM Summaries",
        description:
          !enabled || !ready
            ? "requires repo map to be active"
            : cm.getSemanticMode() === "llm"
              ? `ON — ${String(stats.summaries)} cached [${getShortModelLabel(cm.getSemanticModelId(ctx.chat.activeModel))}]`
              : "generate AI descriptions for top symbols",
      },
      {
        value: "semantic-ast",
        label: cm.getSemanticMode() === "ast" ? "AST Docstrings ✓" : "AST Docstrings",
        description:
          !enabled || !ready
            ? "requires repo map to be active"
            : cm.getSemanticMode() === "ast"
              ? `ON — ${String(stats.summaries)} extracted from comments`
              : "extract summaries from JSDoc/docstrings (free, instant)",
      },
      ...(cm.isSemanticEnabled() && enabled && ready
        ? [
            ...(cm.getSemanticMode() === "llm"
              ? [
                  {
                    value: "semantic-regen",
                    label: "Regenerate Summaries",
                    description: "clear cache and regenerate all summaries",
                  },
                ]
              : []),
            {
              value: "semantic-clear",
              label: "Clear Summaries",
              description: `delete ${String(stats.summaries)} cached summaries`,
            },
          ]
        : []),
      {
        value: "info",
        label: "Status",
        description: statusDesc,
      },
    ],
    onSelect: (value, scope) => {
      if (value === "enable" || value === "disable") {
        applyRepoMapToggle(ctx, value === "enable", scope ?? "project");
      } else if (value === "refresh") {
        sysMsg(ctx, "Rebuilding repo map...");
        cm.refreshRepoMap().catch(() => {});
      } else if (value === "clear") {
        if (cm.isSemanticEnabled()) {
          cm.setSemanticSummaries("off");
          ctx.saveToScope({ semanticSummaries: "off" }, scope ?? "project");
        }
        cm.setRepoMapEnabled(false);
        cm.clearRepoMap();
        ctx.saveToScope({ repoMap: false }, scope ?? "project");
        sysMsg(ctx, `Repo map disabled and index cleared (${scope ?? "project"}).`);
      } else if (value === "semantic") {
        if (!cm.isRepoMapEnabled() || !cm.isRepoMapReady()) {
          sysMsg(ctx, "Enable repo map first — semantic summaries depend on the symbol index.");
          return;
        }
        const current = cm.getSemanticMode();
        const next = current === "llm" ? "off" : "llm";
        cm.setSemanticSummaries(next);
        ctx.saveToScope({ semanticSummaries: next }, scope ?? "project");
        if (next === "llm") {
          triggerSemanticGeneration(ctx, cm);
        } else {
          sysMsg(ctx, `LLM summaries disabled (${scope ?? "project"}).`);
        }
      } else if (value === "semantic-ast") {
        if (!cm.isRepoMapEnabled() || !cm.isRepoMapReady()) {
          sysMsg(ctx, "Enable repo map first — semantic summaries depend on the symbol index.");
          return;
        }
        const current = cm.getSemanticMode();
        const next = current === "ast" ? "off" : "ast";
        cm.setSemanticSummaries(next);
        ctx.saveToScope({ semanticSummaries: next }, scope ?? "project");
        sysMsg(
          ctx,
          next === "ast"
            ? `AST docstring summaries enabled (${scope ?? "project"}). Rebuilding index...`
            : `Semantic summaries disabled (${scope ?? "project"}).`,
        );
      } else if (value === "semantic-regen") {
        cm.clearSemanticSummaries();
        sysMsg(ctx, "Cleared cached summaries.");
        triggerSemanticGeneration(ctx, cm);
      } else if (value === "semantic-clear") {
        cm.clearSemanticSummaries();
        sysMsg(ctx, `Cleared ${String(stats.summaries)} cached summaries.`);
      } else if (value === "info") {
        useUIStore.getState().openModal("repoMapStatus");
      }
    },
    onScopeMove: (value, from, to) => {
      applyRepoMapToggle(ctx, value === "enable", to, from);
    },
  });
}

function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath)) {
    const fp = join(dirPath, entry);
    try {
      const s = statSync(fp);
      total += s.isDirectory() ? dirSize(fp) : s.size;
    } catch {
      // skip
    }
  }
  return total;
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function computeStorageSizes(cwd: string) {
  const home = homedir();
  const projectDir = join(cwd, ".soulforge");
  const globalDir = join(home, ".soulforge");

  const repoMap =
    fileSize(join(projectDir, "repomap.db")) +
    fileSize(join(projectDir, "repomap.db-wal")) +
    fileSize(join(projectDir, "repomap.db-shm"));
  const projectMemory =
    fileSize(join(projectDir, "memory.db")) + fileSize(join(projectDir, "memory.db-wal"));
  const sessions = dirSize(join(projectDir, "sessions"));
  const plans = dirSize(join(projectDir, "plans"));
  const projectConfig =
    fileSize(join(projectDir, "config.json")) + fileSize(join(projectDir, "forbidden.json"));
  const projectTotal = repoMap + projectMemory + sessions + plans + projectConfig;

  const history =
    fileSize(join(globalDir, "history.db")) + fileSize(join(globalDir, "history.db-wal"));
  const globalMemory =
    fileSize(join(globalDir, "memory.db")) + fileSize(join(globalDir, "memory.db-wal"));
  const globalConfig =
    fileSize(join(globalDir, "config.json")) + fileSize(join(globalDir, "secrets.json"));
  const bins = dirSize(join(globalDir, "bin"));
  const fonts = dirSize(join(globalDir, "fonts"));
  const globalTotal = history + globalMemory + globalConfig + bins + fonts;

  return {
    projectDir,
    globalDir,
    repoMap,
    projectMemory,
    sessions,
    plans,
    projectConfig,
    projectTotal,
    history,
    globalMemory,
    globalConfig,
    bins,
    fonts,
    globalTotal,
  };
}

function openStorageMenu(ctx: CommandContext): void {
  const show = () => {
    const s = computeStorageSizes(ctx.cwd);
    const sm = new SessionManager(ctx.cwd);
    const sessionCount = sm.sessionCount();
    const memMgr = ctx.contextManager.getMemoryManager();
    const projectMemCount = memMgr.listByScope("project").length;
    const globalMemCount = memMgr.listByScope("global").length;

    const pad = (label: string, size: string, width = 28) => {
      const gap = Math.max(1, width - label.length - size.length);
      return `${label}${" ".repeat(gap)}${size}`;
    };

    ctx.openCommandPicker({
      title: `Storage — ${formatBytes(s.projectTotal + s.globalTotal)}`,
      icon: icon("storage"),
      maxWidth: 64,
      options: [
        {
          value: "_h_project",
          label: `Project ${formatBytes(s.projectTotal)}`,
          color: "#9B30FF",
          disabled: true,
        },
        {
          value: "clear-repomap",
          label: pad("Repo Map", formatBytes(s.repoMap)),
          description: s.repoMap > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "clear-sessions",
          label: pad("Sessions", formatBytes(s.sessions)),
          description:
            sessionCount > 0
              ? `${String(sessionCount)} saved · ${icon("delete_all")} clear`
              : undefined,
        },
        {
          value: "_pmem",
          label: pad(
            "Memory",
            `${formatBytes(s.projectMemory)}  ${String(projectMemCount)} entries`,
          ),
          disabled: true,
        },
        {
          value: "clear-plans",
          label: pad("Plans", formatBytes(s.plans)),
          description: s.plans > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "_pconfig",
          label: pad("Config", formatBytes(s.projectConfig)),
          disabled: true,
        },
        {
          value: "_h_global",
          label: `Global ${formatBytes(s.globalTotal)}`,
          color: "#00BFFF",
          disabled: true,
        },
        {
          value: "clear-history",
          label: pad("History", formatBytes(s.history)),
          description: s.history > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "_gmem",
          label: pad("Memory", `${formatBytes(s.globalMemory)}  ${String(globalMemCount)} entries`),
          disabled: true,
        },
        {
          value: "_gconfig",
          label: pad("Config", formatBytes(s.globalConfig)),
          disabled: true,
        },
        {
          value: "_bins",
          label: pad("Binaries", formatBytes(s.bins)),
          disabled: true,
        },
        {
          value: "_fonts",
          label: pad("Fonts", formatBytes(s.fonts)),
          disabled: true,
        },
        {
          value: "vacuum",
          label: "Vacuum Databases",
          description: "reclaim space from deleted rows",
        },
      ],
      onSelect: (value) => {
        if (value === "clear-repomap") {
          if (s.repoMap === 0) return;
          ctx.contextManager.clearRepoMap();
          sysMsg(ctx, `Cleared repo map (freed ~${formatBytes(s.repoMap)}).`);
        } else if (value === "clear-sessions") {
          if (sessionCount === 0) return;
          const cleared = sm.clearAllSessions();
          sysMsg(ctx, `Cleared ${String(cleared)} sessions (freed ~${formatBytes(s.sessions)}).`);
        } else if (value === "clear-history") {
          const historyPath = join(s.globalDir, "history.db");
          if (existsSync(historyPath) && s.history > 0) {
            try {
              const db = new Database(historyPath);
              db.run("DELETE FROM history");
              db.run("VACUUM");
              db.close();
              sysMsg(ctx, `Cleared search history (freed ~${formatBytes(s.history)}).`);
            } catch {
              sysMsg(ctx, "Failed to clear history database.");
            }
          }
        } else if (value === "clear-plans") {
          const plansDir = join(s.projectDir, "plans");
          if (existsSync(plansDir) && s.plans > 0) {
            rmSync(plansDir, { recursive: true });
            sysMsg(ctx, `Cleared plans (freed ~${formatBytes(s.plans)}).`);
          }
        } else if (value === "vacuum") {
          let freed = 0;
          const dbs = [
            join(s.projectDir, "repomap.db"),
            join(s.projectDir, "memory.db"),
            join(s.globalDir, "history.db"),
            join(s.globalDir, "memory.db"),
          ];
          for (const dbPath of dbs) {
            if (!existsSync(dbPath)) continue;
            try {
              const before = fileSize(dbPath);
              const db = new Database(dbPath);
              db.run("VACUUM");
              db.close();
              freed += Math.max(0, before - fileSize(dbPath));
            } catch {
              // skip
            }
          }
          sysMsg(
            ctx,
            freed > 0
              ? `Vacuumed databases (reclaimed ~${formatBytes(freed)}).`
              : "Vacuumed databases (no space to reclaim).",
          );
        }
        setTimeout(show, 50);
      },
    });
  };
  show();
}

function openMemoryMenu(ctx: CommandContext): void {
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
              ctx.chat.setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Memory write scope: ${ws}`,
                  timestamp: Date.now(),
                },
              ]);
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
              ctx.chat.setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Memory read scope: ${rs}`,
                  timestamp: Date.now(),
                },
              ]);
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
              ctx.chat.setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Memory settings saved to: ${ss}`,
                  timestamp: Date.now(),
                },
              ]);
              showMain();
            },
          });
        } else if (value === "view") {
          const scopes = ["project", "global"] as const;
          const lines: import("./InfoPopup.js").InfoPopupLine[] = [];
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
              ctx.chat.setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "system",
                  content: `Cleared ${String(cleared)} ${scope} memories.`,
                  timestamp: Date.now(),
                },
              ]);
              showMain();
            },
          });
        }
      },
    });
  };

  showMain();
}

export async function handleCommand(input: string, ctx: CommandContext): Promise<void> {
  try {
    await handleCommandInner(input, ctx);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    sysMsg(ctx, `Error: command ${input.trim().split(" ")[0]} failed — ${msg}`);
  }
}

async function handleCommandInner(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const cmd = trimmed.toLowerCase();

  if (
    cmd === "/font" ||
    cmd === "/fonts" ||
    cmd.startsWith("/font ") ||
    cmd.startsWith("/fonts ")
  ) {
    const { detectInstalledFonts, NERD_FONTS } = await import("../core/setup/install.js");
    const { detectTerminal, getCurrentFont, setTerminalFont } = await import(
      "../core/setup/terminal-font.js"
    );

    const fontArg = trimmed.replace(/^\/(fonts?)\s*/i, "").trim();
    const found = detectInstalledFonts();
    const term = detectTerminal();

    // /font set <name> — auto-configure terminal
    if (fontArg === "set" || fontArg.startsWith("set ")) {
      const fontName = fontArg.slice(4).trim().toLowerCase();

      const applyFont = (fontId: string) => {
        const match = NERD_FONTS.find(
          (f) =>
            f.id === fontId || f.name.toLowerCase() === fontId || f.family.toLowerCase() === fontId,
        );
        if (!match) {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Unknown font "${fontId}". Available:\n${NERD_FONTS.map((f) => `  ${f.id.padEnd(18)} ${f.family}`).join("\n")}`,
              timestamp: Date.now(),
            },
          ]);
        } else if (!term.canAutoSet) {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Can't auto-set font in ${term.name}.\n${term.instructions} → ${match.family}`,
              timestamp: Date.now(),
            },
          ]);
        } else {
          const result = setTerminalFont(match.family);
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: result.message + (result.configPath ? `\nConfig: ${result.configPath}` : ""),
              timestamp: Date.now(),
            },
          ]);
        }
      };

      if (fontName) {
        applyFont(fontName);
      } else {
        const currentFont = getCurrentFont();
        ctx.openCommandPicker({
          title: "Set Terminal Font",
          icon: icon("memory_alt"),
          currentValue: found.find((f) => currentFont?.includes(f.family))?.id,
          options: NERD_FONTS.map((f) => {
            const installed = found.some((i) => i.id === f.id);
            return {
              value: f.id,
              label: `${installed ? "✓" : "○"} ${f.name}`,
              description: f.description,
            };
          }),
          onSelect: applyFont,
        });
      }
      return;
    }

    // /font — show status
    const currentFont = getCurrentFont();
    const fontLines: string[] = [
      "── Fonts ──",
      "",
      `Terminal: ${term.name}${term.canAutoSet ? " (auto-set ✓)" : ""}`,
      `Current:  ${currentFont ?? "unknown"}`,
      "",
      "Installed Nerd Fonts:",
    ];
    if (found.length > 0) {
      for (const f of found) {
        fontLines.push(`  ✓ ${f.family}`);
      }
    } else {
      fontLines.push("  ✗ None — run /setup → [2] Fonts to install");
    }
    fontLines.push("");
    fontLines.push("Available:");
    for (const f of NERD_FONTS) {
      const installed = found.some((i) => i.id === f.id);
      fontLines.push(`  ${installed ? "✓" : "○"} ${f.id.padEnd(18)} ${f.description}`);
    }
    fontLines.push("");
    if (term.canAutoSet) {
      fontLines.push("Set: /font set <name>    e.g. /font set fira-code");
    } else {
      fontLines.push(`Manual: ${term.instructions}`);
    }
    ctx.chat.setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: fontLines.join("\n"),
        timestamp: Date.now(),
      },
    ]);
    return;
  }

  if (cmd === "/chat-style" || cmd.startsWith("/chat-style ")) {
    const arg = trimmed.slice(12).trim().toLowerCase();
    const patch = (v: string) => ({ chatStyle: v as "accent" | "bubble" });

    const applyChatStyle = (style: "accent" | "bubble", scope?: ConfigScope) => {
      ctx.setChatStyle(style);
      ctx.saveToScope(patch(style), scope ?? "project");
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Chat style: ${style} (${scope ?? "project"})`,
          timestamp: Date.now(),
        },
      ]);
    };

    if (arg === "accent" || arg === "bubble") {
      applyChatStyle(arg);
    } else {
      ctx.openCommandPicker({
        title: "Chat Style",
        icon: icon("chat_style"),
        currentValue: ctx.chatStyle,
        scopeEnabled: true,
        initialScope: ctx.detectScope("chatStyle"),
        options: [
          {
            value: "accent",
            label: "Accent",
            description: "colored left-border for messages",
          },
          {
            value: "bubble",
            label: "Bubble",
            description: "rounded bubble chat layout",
          },
        ],
        onSelect: (value, scope) => applyChatStyle(value as "accent" | "bubble", scope),
        onScopeMove: (value, from, to) => {
          ctx.setChatStyle(value as "accent" | "bubble");
          ctx.saveToScope(patch(value), to, from);
        },
      });
    }
    return;
  }

  if (cmd.startsWith("/open ")) {
    const filePath = trimmed.slice(6).trim();
    if (!filePath) {
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Usage: /open <file-path>",
          timestamp: Date.now(),
        },
      ]);
      return;
    }
    ctx.openEditorWithFile(filePath);
    ctx.chat.setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: `Opening ${filePath} in editor...`,
        timestamp: Date.now(),
      },
    ]);
    return;
  }

  if (cmd === "/mode" || cmd.startsWith("/mode ")) {
    const modeName = trimmed.slice(5).trim().toLowerCase();
    const validModes = ["default", "architect", "socratic", "challenge", "plan"] as const;
    type Mode = (typeof validModes)[number];
    const patch = (v: string) => ({ defaultForgeMode: v as Mode });

    const applyMode = (mode: Mode, scope?: ConfigScope) => {
      ctx.setForgeMode(mode);
      ctx.saveToScope(patch(mode), scope ?? "project");
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Forge mode set to: ${mode} (${scope ?? "project"})`,
          timestamp: Date.now(),
        },
      ]);
    };

    const matched = validModes.find((m) => m === modeName);
    if (matched) {
      applyMode(matched);
    } else if (modeName && !matched) {
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Unknown mode: ${modeName}. Available: default, architect, socratic, challenge, plan`,
          timestamp: Date.now(),
        },
      ]);
    } else {
      ctx.openCommandPicker({
        title: "Forge Mode",
        icon: icon("ai"),
        currentValue: ctx.currentMode,
        scopeEnabled: true,
        initialScope: ctx.detectScope("defaultForgeMode"),
        options: [
          {
            value: "default",
            label: "Default",
            description: "standard assistant — implements directly",
            color: "#aaa",
          },
          {
            value: "architect",
            label: "Architect",
            description: "design only — outlines, tradeoffs, no code",
            color: "#9B30FF",
          },
          {
            value: "socratic",
            label: "Socratic",
            description: "asks probing questions before implementing",
            color: "#FF8C00",
          },
          {
            value: "challenge",
            label: "Challenge",
            description: "devil's advocate — challenges every assumption",
            color: "#FF0040",
          },
          {
            value: "plan",
            label: "Plan",
            description: "research & plan only — no file edits or shell",
            color: "#00BFFF",
          },
        ],
        onSelect: (value, scope) => applyMode(value as Mode, scope),
        onScopeMove: (value, from, to) => {
          ctx.setForgeMode(value as Mode);
          ctx.saveToScope(patch(value), to, from);
        },
      });
    }
    return;
  }

  if (cmd.startsWith("/context clear") || cmd === "/context reset") {
    const what = cmd.includes("git")
      ? "git"
      : cmd.includes("skills")
        ? "skills"
        : cmd.includes("memory")
          ? "memory"
          : "all";
    const cleared = ctx.contextManager.clearContext(what as "git" | "memory" | "skills" | "all");
    ctx.chat.setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: cleared.length > 0 ? `Cleared: ${cleared.join(", ")}` : "Nothing to clear.",
        timestamp: Date.now(),
      },
    ]);
    return;
  }

  if (cmd === "/git init" || cmd === "/init") {
    gitInit(ctx.cwd).then((ok) => {
      ctx.refreshGit();
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: ok ? "Initialized git repository." : "Failed to initialize git repository.",
          timestamp: Date.now(),
        },
      ]);
    });
    return;
  }

  if (cmd.startsWith("/branch ")) {
    const branchName = trimmed.slice(8).trim();
    if (branchName) {
      const { spawn } = await import("node:child_process");
      const proc = spawn("git", ["checkout", "-b", branchName], { cwd: ctx.cwd });
      const chunks: string[] = [];
      proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
      proc.on("close", (code) => {
        ctx.refreshGit();
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: code === 0 ? `Switched to new branch '${branchName}'` : chunks.join("").trim(),
            timestamp: Date.now(),
          },
        ]);
      });
    }
    return;
  }

  if (cmd === "/co-author-commits" || cmd.startsWith("/co-author-commits ")) {
    const arg = trimmed.slice(19).trim().toLowerCase();
    const patch = (v: string) => ({ coAuthorCommits: v === "enable" });

    const applyCoAuthor = (enabled: boolean, scope?: ConfigScope) => {
      ctx.chat.setCoAuthorCommits(enabled);
      ctx.saveToScope(patch(enabled ? "enable" : "disable"), scope ?? "project");
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Co-author commits ${enabled ? "enabled" : "disabled"} (${scope ?? "project"}).`,
          timestamp: Date.now(),
        },
      ]);
    };

    if (arg === "enable" || arg === "on") {
      applyCoAuthor(true);
    } else if (arg === "disable" || arg === "off") {
      applyCoAuthor(false);
    } else {
      ctx.openCommandPicker({
        title: "Co-Author Commits",
        icon: icon("git"),
        currentValue: ctx.chat.coAuthorCommits ? "enable" : "disable",
        scopeEnabled: true,
        initialScope: ctx.detectScope("coAuthorCommits"),
        options: [
          {
            value: "enable",
            label: "Enable",
            description: "add co-author trailer on AI-assisted commits",
          },
          {
            value: "disable",
            label: "Disable",
            description: "no co-author trailer on commits",
          },
        ],
        onSelect: (value, scope) => applyCoAuthor(value === "enable", scope),
        onScopeMove: (value, from, to) => {
          ctx.chat.setCoAuthorCommits(value === "enable");
          ctx.saveToScope(patch(value), to, from);
        },
      });
    }
    return;
  }

  if (cmd === "/memory") {
    openMemoryMenu(ctx);
    return;
  }

  if (cmd === "/repo-map") {
    openRepoMapMenu(ctx);
    return;
  }

  if (cmd === "/plan" || cmd.startsWith("/plan ")) {
    const arg = trimmed.slice(5).trim();
    if (arg) {
      ctx.chat.setPlanMode(true);
      ctx.chat.setPlanRequest(arg);
      sysMsg(ctx, `Plan mode enabled. Task: ${arg}`);
    } else {
      const newState = !ctx.chat.planMode;
      ctx.chat.setPlanMode(newState);
      if (!newState) ctx.chat.setPlanRequest(null);
      sysMsg(ctx, `Plan mode ${newState ? "enabled" : "disabled"}.`);
    }
    return;
  }

  if (cmd === "/continue") {
    if (ctx.chat.isLoading) {
      sysMsg(ctx, "Generation already in progress.");
    } else {
      ctx.chat.handleSubmit("Continue from where you left off.");
    }
    return;
  }

  switch (cmd) {
    case "/quit":
    case "/exit":
      ctx.exit();
      break;
    case "/restart":
      ctx.chat.abort();
      restart();
      break;
    case "/clear":
      ctx.chat.setMessages([]);
      ctx.chat.setCoreMessages([]);
      ctx.chat.setTokenUsage({
        prompt: 0,
        completion: 0,
        total: 0,
        cacheRead: 0,
        subagentInput: 0,
        subagentOutput: 0,
      });
      ctx.chat.setMessageQueue([]);
      break;
    case "/editor":
    case "/edit":
      ctx.toggleFocus();
      break;
    case "/help":
      ctx.openHelp();
      break;
    case "/editor-settings":
      ctx.openEditorSettings();
      break;
    case "/router":
      ctx.openRouterSettings();
      break;
    case "/provider-settings":
    case "/provider":
    case "/providers":
    case "/perf":
      ctx.openProviderSettings();
      break;
    case "/models":
    case "/model":
      useUIStore.getState().openModal("llmSelector");
      break;
    case "/web-search":
      ctx.openWebSearchSettings();
      break;
    case "/changes":
    case "/files":
      ctx.toggleChanges();
      break;
    case "/errors":
      ctx.openErrorLog();
      break;
    case "/skills":
      ctx.openSkills();
      break;
    case "/sessions":
    case "/session":
      ctx.openSessions();
      break;
    case "/compact":
      ctx.chat.summarizeConversation();
      break;
    case "/commit":
      ctx.openGitCommit();
      break;
    case "/diff":
      getGitDiff(ctx.cwd).then(async (diff) => {
        if (!diff) {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: "No unstaged changes.",
              timestamp: Date.now(),
            },
          ]);
          return;
        }
        const tmpPath = `/tmp/soulforge-diff-${Date.now()}.diff`;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(tmpPath, diff);
        ctx.openEditorWithFile(tmpPath);
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Diff opened in editor.",
            timestamp: Date.now(),
          },
        ]);
      });
      break;
    case "/status":
      getGitStatus(ctx.cwd).then((status) => {
        if (!status.isRepo) {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: "Not a git repository. Use /init to initialize.",
              timestamp: Date.now(),
            },
          ]);
          return;
        }
        const lines: import("./InfoPopup.js").InfoPopupLine[] = [
          {
            type: "entry",
            label: "Branch",
            desc: status.branch ?? "(detached)",
            descColor: "#8B5CF6",
          },
          { type: "spacer" },
          {
            type: "entry",
            label: "Staged",
            desc: String(status.staged.length),
            descColor: status.staged.length > 0 ? "#2d5" : "#666",
          },
          {
            type: "entry",
            label: "Modified",
            desc: String(status.modified.length),
            descColor: status.modified.length > 0 ? "#FF8C00" : "#666",
          },
          {
            type: "entry",
            label: "Untracked",
            desc: String(status.untracked.length),
            descColor: status.untracked.length > 0 ? "#FF0040" : "#666",
          },
        ];
        if (status.ahead > 0)
          lines.push({
            type: "entry",
            label: "Ahead",
            desc: String(status.ahead),
            descColor: "#2d5",
          });
        if (status.behind > 0)
          lines.push({
            type: "entry",
            label: "Behind",
            desc: String(status.behind),
            descColor: "#FF8C00",
          });
        if (status.staged.length > 0) {
          lines.push({ type: "spacer" }, { type: "header", label: "Staged Files" });
          for (const f of status.staged)
            lines.push({ type: "text", label: `  ${f}`, color: "#2d5" });
        }
        if (status.modified.length > 0) {
          lines.push({ type: "spacer" }, { type: "header", label: "Modified Files" });
          for (const f of status.modified)
            lines.push({ type: "text", label: `  ${f}`, color: "#FF8C00" });
        }
        if (status.untracked.length > 0) {
          lines.push({ type: "spacer" }, { type: "header", label: "Untracked Files" });
          for (const f of status.untracked)
            lines.push({ type: "text", label: `  ${f}`, color: "#FF0040" });
        }
        ctx.openInfoPopup({ title: "Git Status", icon: icon("git"), lines });
      });
      break;
    case "/branch":
      getGitStatus(ctx.cwd).then((status) => {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: status.branch
              ? `Current branch: ${status.branch}`
              : "Not on a branch (detached HEAD)",
            timestamp: Date.now(),
          },
        ]);
      });
      break;
    case "/context": {
      const breakdown = ctx.contextManager.getContextBreakdown();
      const totalChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const modelId = ctx.chat.activeModel;
      const ctxInfo = getModelContextInfo(modelId);
      const ctxWindow = ctxInfo.tokens;
      const tu: TokenUsage = ctx.chat.tokenUsage;
      const apiCtx = ctx.chat.contextTokens;
      const usedTokens = apiCtx > 0 ? apiCtx : Math.ceil(totalChars / 4);
      const fillPct = Math.min(100, Math.round((usedTokens / ctxWindow) * 100));

      const fmtT = (n: number) => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
        return String(n);
      };

      const popupLines: import("./InfoPopup.js").InfoPopupLine[] = [
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
        {
          type: "entry",
          label: "Total",
          desc: fmtT(tu.total),
          color: "#ccc",
          descColor: "#ccc",
        },
      );
      if (tu.subagentInput > 0 || tu.subagentOutput > 0) {
        popupLines.push({
          type: "entry",
          label: "  Subagents",
          desc: `${fmtT(tu.subagentInput)}↑ ${fmtT(tu.subagentOutput)}↓ (included above)`,
          color: "#9B30FF",
          descColor: "#666",
        });
      }

      // Cache savings — the big highlight
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
      break;
    }
    case "/git":
      ctx.openGitMenu();
      break;
    case "/lazygit":
      ctx.handleSuspend({ command: "lazygit" });
      break;
    case "/proxy":
    case "/proxy status": {
      const { fetchProxyStatus } = await import("../core/proxy/lifecycle.js");
      type Line = import("./InfoPopup.js").InfoPopupLine;

      const buildLines = (s: Awaited<ReturnType<typeof fetchProxyStatus>>): Line[] => {
        const lines: Line[] = [
          {
            type: "entry",
            label: "Status",
            desc: s.running ? "● running" : "○ stopped",
            descColor: s.running ? "#2d5" : "#FF0040",
          },
          {
            type: "entry",
            label: "Endpoint",
            desc: s.endpoint,
            descColor: "#888",
          },
          {
            type: "entry",
            label: "Binary",
            desc: s.binaryPath ?? "not installed",
            descColor: s.installed ? "#888" : "#FF0040",
          },
        ];
        if (s.pid) {
          lines.push({ type: "entry", label: "PID", desc: String(s.pid), descColor: "#888" });
        }
        if (s.models.length > 0) {
          lines.push({ type: "spacer" }, { type: "separator" }, { type: "spacer" });
          lines.push({ type: "header", label: `Models (${s.models.length})` });
          for (const m of s.models) {
            lines.push({ type: "text", label: `  ${m}`, color: "#888" });
          }
        }
        lines.push(
          { type: "spacer" },
          { type: "separator" },
          { type: "spacer" },
          { type: "header", label: "Commands" },
          { type: "entry", label: "/proxy login", desc: "authenticate with Claude" },
          { type: "entry", label: "/proxy install", desc: "manually install CLIProxyAPI" },
        );
        return lines;
      };

      ctx.openInfoPopup({
        title: "Proxy Status",
        icon: icon("proxy"),
        lines: [{ type: "text", label: "Loading...", color: "#888" }],
      });

      let pollActive = true;
      const poll = async () => {
        while (pollActive) {
          const status = await fetchProxyStatus();
          if (!pollActive) break;
          ctx.openInfoPopup({
            title: "Proxy Status",
            icon: icon("proxy"),
            lines: buildLines(status),
            onClose: () => {
              pollActive = false;
            },
          });
          await new Promise((r) => setTimeout(r, 3000));
        }
      };
      poll();
      break;
    }
    case "/proxy login": {
      const { runProxyLogin } = await import("../core/proxy/lifecycle.js");
      type Line = import("./InfoPopup.js").InfoPopupLine;

      const loginLines: Line[] = [
        { type: "text", label: "Opening browser for authentication...", color: "#888" },
      ];

      const updatePopup = (extraLines: Line[], closeCb?: () => void) => {
        ctx.openInfoPopup({
          title: "Proxy Login",
          icon: icon("proxy"),
          lines: extraLines,
          onClose: closeCb,
        });
      };

      let handle: ReturnType<typeof runProxyLogin> | null = null;

      const onClose = () => {
        handle?.abort();
      };

      updatePopup(loginLines, onClose);

      handle = runProxyLogin((line) => {
        loginLines.push({ type: "text", label: line, color: "#ccc" });
        updatePopup([...loginLines], onClose);
      });

      handle.promise
        .then(({ ok }) => {
          loginLines.push({
            type: "text",
            label: ok ? "Authentication complete." : "Authentication failed.",
            color: ok ? "#2d5" : "#FF0040",
          });
          updatePopup([...loginLines]);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          loginLines.push({ type: "text", label: `Error: ${msg}`, color: "#FF0040" });
          updatePopup([...loginLines]);
        });
      break;
    }
    case "/proxy install": {
      const { installProxy } = await import("../core/setup/install.js");
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Installing CLIProxyAPI...",
          timestamp: Date.now(),
        },
      ]);
      installProxy()
        .then((path: string) => {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `CLIProxyAPI installed at ${path}`,
              timestamp: Date.now(),
            },
          ]);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Install failed: ${msg}`,
              timestamp: Date.now(),
            },
          ]);
        });
      break;
    }
    case "/push":
      ctx.chat.setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", content: "Pushing...", timestamp: Date.now() },
      ]);
      gitPush(ctx.cwd).then((result) => {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: result.ok ? "Push complete." : `Push failed: ${result.output}`,
            timestamp: Date.now(),
          },
        ]);
        ctx.refreshGit();
      });
      break;
    case "/pull":
      ctx.chat.setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", content: "Pulling...", timestamp: Date.now() },
      ]);
      gitPull(ctx.cwd).then((result) => {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: result.ok ? "Pull complete." : `Pull failed: ${result.output}`,
            timestamp: Date.now(),
          },
        ]);
        ctx.refreshGit();
      });
      break;
    case "/stash":
      gitStash(ctx.cwd).then((result) => {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: result.ok ? "Changes stashed." : `Stash failed: ${result.output}`,
            timestamp: Date.now(),
          },
        ]);
        ctx.refreshGit();
      });
      break;
    case "/stash pop":
      gitStashPop(ctx.cwd).then((result) => {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: result.ok ? "Stash popped." : `Stash pop failed: ${result.output}`,
            timestamp: Date.now(),
          },
        ]);
        ctx.refreshGit();
      });
      break;
    case "/log":
      getGitLog(ctx.cwd, 20).then((entries) => {
        if (entries.length === 0) {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: "No commits found.",
              timestamp: Date.now(),
            },
          ]);
        } else {
          const popupLines: import("./InfoPopup.js").InfoPopupLine[] = entries.map((e) => ({
            type: "entry" as const,
            label: e.hash,
            desc: `${e.subject} (${e.date})`,
            color: "#FF8C00",
          }));
          ctx.openInfoPopup({
            title: "Git Log",
            icon: icon("git"),
            lines: popupLines,
            width: 78,
            labelWidth: 10,
          });
        }
      });
      break;
    case "/setup":
      ctx.openSetup();
      break;
    case "/lsp":
      ctx.openLspStatus();
      break;
    case "/storage": {
      openStorageMenu(ctx);
      break;
    }
    case "/tabs": {
      const tabOptions: import("./CommandPicker.js").CommandPickerOption[] = ctx.tabMgr.tabs.map(
        (tab, i) => ({
          value: tab.id,
          label: `${String(i + 1)}. ${tab.label}`,
          icon: tab.id === ctx.tabMgr.activeTabId ? "▸" : " ",
          color: tab.id === ctx.tabMgr.activeTabId ? "#9B30FF" : undefined,
        }),
      );
      ctx.openCommandPicker({
        title: "Switch Tab",
        icon: icon("tabs"),
        options: tabOptions,
        currentValue: ctx.tabMgr.activeTabId,
        onSelect: (tabId) => ctx.tabMgr.switchTab(tabId),
      });
      break;
    }
    case "/new-tab":
      ctx.tabMgr.createTab();
      break;
    case "/close-tab":
      if (ctx.tabMgr.tabCount <= 1) {
        ctx.chat.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: "Can't close the last tab.",
            timestamp: Date.now(),
          },
        ]);
      } else {
        ctx.tabMgr.closeTab(ctx.tabMgr.activeTabId);
      }
      break;
    default:
      if (cmd.startsWith("/rename ")) {
        const newName = trimmed.slice(8).trim();
        if (newName) {
          ctx.tabMgr.renameTab(ctx.tabMgr.activeTabId, newName);
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Tab renamed to: ${newName}`,
              timestamp: Date.now(),
            },
          ]);
        } else {
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: "Usage: /rename <name>",
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      if (cmd === "/nvim-config" || cmd.startsWith("/nvim-config ")) {
        const arg = trimmed.slice(13).trim().toLowerCase();
        const validModes = ["auto", "default", "user", "none"] as const;
        const matched = validModes.find((m) => m === arg);

        const applyNvimConfig = (mode: (typeof validModes)[number], scope?: ConfigScope) => {
          ctx.saveToScope({ nvimConfig: mode }, scope ?? "project");
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Neovim config set to: ${mode} (${scope ?? "project"})\nReopen the editor (Ctrl+E twice) for changes to take effect.`,
              timestamp: Date.now(),
            },
          ]);
        };

        if (matched) {
          applyNvimConfig(matched);
        } else {
          ctx.openCommandPicker({
            title: "Neovim Config",
            icon: icon("nvim"),
            currentValue: ctx.effectiveNvimConfig ?? "auto",
            scopeEnabled: true,
            initialScope: ctx.detectScope("nvimConfig"),
            options: [
              {
                value: "auto",
                label: "Auto",
                description: "use user config if found, else shipped config",
              },
              {
                value: "default",
                label: "Default",
                description: "always use SoulForge's shipped init.lua",
              },
              {
                value: "user",
                label: "User",
                description: "always use your own nvim config",
              },
              {
                value: "none",
                label: "None",
                description: "bare neovim, no config at all",
              },
            ],
            onSelect: (value, scope) =>
              applyNvimConfig(value as (typeof validModes)[number], scope),
            onScopeMove: (value, from, to) =>
              ctx.saveToScope({ nvimConfig: value as (typeof validModes)[number] }, to, from),
          });
        }
        break;
      }
      if (cmd === "/verbose") {
        const patch = (v: string) => ({ verbose: v === "on" });
        ctx.openCommandPicker({
          title: "Verbose Mode",
          icon: icon("verbose"),
          currentValue: ctx.verbose ? "on" : "off",
          scopeEnabled: true,
          initialScope: ctx.detectScope("verbose"),
          options: [
            { value: "on", label: "On", description: "show full tool call output in chat" },
            { value: "off", label: "Off", description: "show compact tool call summaries" },
          ],
          onSelect: (value, scope) => {
            ctx.saveToScope(patch(value), scope ?? "project");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Verbose mode ${value === "on" ? "on" : "off"} (${scope ?? "project"})`,
                timestamp: Date.now(),
              },
            ]);
          },
          onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
        });
        break;
      }
      if (cmd === "/reasoning") {
        const patch = (v: string) => ({ showReasoning: v === "on" });
        ctx.openCommandPicker({
          title: "Reasoning Display",
          icon: icon("brain"),
          currentValue: ctx.showReasoning ? "on" : "off",
          scopeEnabled: true,
          initialScope: ctx.detectScope("showReasoning"),
          options: [
            { value: "on", label: "On", description: "show reasoning content in chat" },
            { value: "off", label: "Off", description: "show thinking status only" },
          ],
          onSelect: (value, scope) => {
            ctx.setShowReasoning(value === "on");
            ctx.saveToScope(patch(value), scope ?? "project");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Reasoning ${value === "on" ? "visible" : "hidden"} (${scope ?? "project"})`,
                timestamp: Date.now(),
              },
            ]);
          },
          onScopeMove: (value, from, to) => {
            ctx.setShowReasoning(value === "on");
            ctx.saveToScope(patch(value), to, from);
          },
        });
        break;
      }
      if (cmd === "/compaction") {
        const patch = (v: string) => ({
          compaction: { strategy: v as "v1" | "v2" },
        });
        ctx.openCommandPicker({
          title: "Compaction Strategy",
          icon: icon("compact"),
          currentValue: ctx.compactionStrategy,
          scopeEnabled: true,
          initialScope: ctx.detectScope("compaction"),
          options: [
            {
              value: "v1",
              label: "V1 — LLM Summarization",
              description: "batch summarize with LLM when context is full (default)",
            },
            {
              value: "v2",
              label: "V2 — Incremental Extraction",
              description: "extract structured state as-you-go, cheap gap-fill on compact",
            },
          ],
          onSelect: (value, scope) => {
            ctx.saveToScope(patch(value), scope ?? "project");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Compaction strategy: ${value} (${scope ?? "project"})`,
                timestamp: Date.now(),
              },
            ]);
          },
          onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
        });
        break;
      }
      if (cmd === "/agent-features") {
        const featureDesc: Record<string, string> = {
          desloppify: "cleanup pass after code agents (needs model in /router)",
          tierRouting: "auto-route trivial tasks to cheaper models",
          dispatchCache: "cache file reads across dispatch boundaries",
          targetFileValidation: "require file paths on dispatch tasks",
        };
        const featureLabel: Record<string, string> = {
          desloppify: "De-sloppify",
          tierRouting: "Tier Routing",
          dispatchCache: "Dispatch Cache",
          targetFileValidation: "Target File Validation",
        };
        const localState = { ...ctx.agentFeatures };
        const buildOptions = () =>
          Object.entries(featureLabel).map(([key, label]) => ({
            value: key,
            label: `${label}: ${(localState as Record<string, unknown>)[key] !== false ? "on" : "off"}`,
            description: featureDesc[key] ?? "",
          }));
        ctx.openCommandPicker({
          title: "Agent Features",
          icon: icon("system"),
          keepOpen: true,
          currentValue: "",
          options: buildOptions(),
          scopeEnabled: true,
          initialScope: ctx.detectScope("agentFeatures"),
          onSelect: (value, scope) => {
            const key = value as keyof AgentFeatures;
            const current = (localState as Record<string, unknown>)[key] !== false;
            (localState as Record<string, unknown>)[key] = !current;
            ctx.saveToScope({ agentFeatures: { [key]: !current } }, scope ?? "project");
            sysMsg(
              ctx,
              `Agent feature "${key}" ${!current ? "enabled" : "disabled"} (${scope ?? "project"})`,
            );
            useUIStore.getState().updatePickerOptions(buildOptions());
          },
          onScopeMove: (value, from, to) => {
            const key = value as keyof AgentFeatures;
            const current = (localState as Record<string, unknown>)[key] !== false;
            ctx.saveToScope({ agentFeatures: { [key]: current } }, to, from);
          },
        });
        break;
      }
      if (cmd === "/diff-style") {
        const patch = (v: string) => ({
          diffStyle: v as "default" | "sidebyside" | "compact",
        });
        ctx.openCommandPicker({
          title: "Diff Style",
          icon: icon("git"),
          scopeEnabled: true,
          initialScope: ctx.detectScope("diffStyle"),
          options: [
            {
              value: "default",
              label: "Default",
              description: "Full inline diff with syntax highlighting",
              icon: "📄",
            },
            {
              value: "sidebyside",
              label: "Side by Side",
              description: "Old and new shown in columns",
              icon: "📊",
            },
            {
              value: "compact",
              label: "Compact",
              description: "File name + line count summary only",
              icon: "📝",
            },
          ],
          currentValue: ctx.diffStyle,
          onSelect: (value, scope) => {
            ctx.saveToScope(patch(value), scope ?? "project");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Diff style: ${value} (${scope ?? "project"})`,
                timestamp: Date.now(),
              },
            ]);
          },
          onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
        });
        break;
      }
      if (cmd === "/vim-hints") {
        const patch = (v: string) => ({ vimHints: v === "visible" });
        ctx.openCommandPicker({
          title: "Vim Hints",
          icon: icon("nvim"),
          currentValue: ctx.vimHints ? "visible" : "hidden",
          scopeEnabled: true,
          initialScope: ctx.detectScope("vimHints"),
          options: [
            {
              value: "visible",
              label: "Visible",
              description: "show vim keybinding hints in editor",
            },
            { value: "hidden", label: "Hidden", description: "hide vim keybinding hints" },
          ],
          onSelect: (value, scope) => {
            ctx.saveToScope(patch(value), scope ?? "project");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Vim hints ${value === "visible" ? "visible" : "hidden"} (${scope ?? "project"})`,
                timestamp: Date.now(),
              },
            ]);
          },
          onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
        });
        break;
      }
      if (cmd === "/model-scope") {
        ctx.openCommandPicker({
          title: "Model Scope",
          icon: icon("settings"),
          currentValue: ctx.detectScope("defaultModel"),
          options: [
            {
              value: "global",
              label: "Global",
              description: "model choice applies to all projects",
            },
            {
              value: "project",
              label: "Project",
              description: "model choice is specific to this project",
            },
          ],
          onSelect: (value, _scope) => {
            const current = ctx.chat.activeModel;
            if (current !== "none") {
              const from = ctx.detectScope("defaultModel");
              const to = value as ConfigScope;
              if (from !== to) {
                ctx.saveToScope({ defaultModel: current }, to, from);
              }
            }
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Model scope: ${value}`,
                timestamp: Date.now(),
              },
            ]);
          },
        });
        break;
      }
      if (cmd === "/nerd-font" || cmd === "/nerdfont") {
        ctx.openCommandPicker({
          title: "Nerd Font",
          icon: icon("ghost"),
          options: [
            { value: "yes", label: "Yes", description: "Terminal uses a Nerd Font" },
            { value: "no", label: "No", description: "Use ASCII fallback icons" },
          ],
          onSelect: (value) => {
            setNerdFont(value === "yes");
            ctx.saveToScope({ nerdFont: value === "yes" }, "global");
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Nerd Font ${value === "yes" ? "enabled" : "disabled"} (global). Restart for full effect.`,
                timestamp: Date.now(),
              },
            ]);
          },
        });
        break;
      }
      if (cmd === "/privacy" || cmd.startsWith("/privacy ")) {
        const { getAllPatterns, addProjectPattern, removeProjectPattern, addSessionPattern } =
          await import("../core/security/forbidden.js");
        const arg = trimmed.slice(9).trim();

        if (arg.startsWith("add ")) {
          const pattern = arg.slice(4).trim();
          if (!pattern) {
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: "Usage: /privacy add <pattern>",
                timestamp: Date.now(),
              },
            ]);
          } else {
            addProjectPattern(ctx.cwd, pattern);
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Added forbidden pattern: ${pattern} (saved to .soulforge/forbidden.json)`,
                timestamp: Date.now(),
              },
            ]);
          }
        } else if (arg.startsWith("remove ")) {
          const pattern = arg.slice(7).trim();
          removeProjectPattern(ctx.cwd, pattern);
          ctx.chat.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Removed pattern: ${pattern}`,
              timestamp: Date.now(),
            },
          ]);
        } else if (arg.startsWith("session ")) {
          const pattern = arg.slice(8).trim();
          if (pattern) {
            addSessionPattern(pattern);
            ctx.chat.setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "system",
                content: `Added session pattern: ${pattern} (lost on restart)`,
                timestamp: Date.now(),
              },
            ]);
          }
        } else {
          const patterns = getAllPatterns();
          const popupLines: import("./InfoPopup.js").InfoPopupLine[] = [];

          const addCategory = (name: string, items: string[], max?: number) => {
            popupLines.push({ type: "header", label: `${name} (${String(items.length)})` });
            const show = max ? items.slice(0, max) : items;
            for (const p of show) popupLines.push({ type: "text", label: `  ${p}` });
            if (max && items.length > max)
              popupLines.push({
                type: "text",
                label: `  ... and ${String(items.length - max)} more`,
                color: "#444",
              });
            popupLines.push({ type: "spacer" });
          };

          addCategory("Built-in", patterns.builtin, 8);
          if (patterns.aiignore.length > 0) addCategory(".aiignore", patterns.aiignore);
          if (patterns.global.length > 0) addCategory("Global", patterns.global);
          if (patterns.project.length > 0) addCategory("Project", patterns.project);
          if (patterns.session.length > 0) addCategory("Session", patterns.session);

          popupLines.push(
            { type: "separator" },
            { type: "spacer" },
            { type: "header", label: "Commands" },
            { type: "entry", label: "/privacy add <pat>", desc: "add to project config" },
            { type: "entry", label: "/privacy remove <pat>", desc: "remove from project config" },
            { type: "entry", label: "/privacy session <pat>", desc: "add for this session only" },
          );
          ctx.openInfoPopup({ title: "Forbidden Patterns", icon: icon("ban"), lines: popupLines });
        }
        break;
      }
      ctx.chat.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Unknown command: ${cmd}. Type /help for available commands.`,
          timestamp: Date.now(),
        },
      ]);
  }
}
