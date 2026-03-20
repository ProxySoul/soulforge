import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { icon } from "../icons.js";
import { SessionManager } from "../sessions/manager.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { computeStorageSizes, fileSize, formatBytes, sysMsg } from "./utils.js";

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
          label: pad("Soul Map", formatBytes(s.repoMap)),
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
          sysMsg(ctx, `Cleared soul map (freed ~${formatBytes(s.repoMap)}).`);
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

function handleStorage(_input: string, ctx: CommandContext): void {
  openStorageMenu(ctx);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/storage", handleStorage);
}
