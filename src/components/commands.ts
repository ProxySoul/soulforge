import type { ModelMessage } from "ai";
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
import type {
  AppConfig,
  ChatMessage,
  ChatStyle,
  ForgeMode,
  NvimConfigMode,
} from "../types/index.js";

export interface CommandContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setCoreMessages: React.Dispatch<React.SetStateAction<ModelMessage[]>>;
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
  summarizeConversation: () => Promise<void>;
  coAuthorCommits: boolean;
  setCoAuthorCommits: React.Dispatch<React.SetStateAction<boolean>>;
  chatStyle: ChatStyle;
  setChatStyle: React.Dispatch<React.SetStateAction<ChatStyle>>;
  handleSuspend: (opts: { command: string; args?: string[]; noAltScreen?: boolean }) => void;
  openGitMenu: () => void;
  openEditorWithFile: (file: string) => void;
  setSessionConfig: React.Dispatch<React.SetStateAction<Partial<AppConfig> | null>>;
  effectiveNvimConfig: NvimConfigMode | undefined;
  openSetup: () => void;
  openEditorSettings: () => void;
  openRouterSettings: () => void;
  togglePlanPanel: () => void;
}

export function handleCommand(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const cmd = trimmed.toLowerCase();

  if (
    cmd === "/font" ||
    cmd === "/fonts" ||
    cmd.startsWith("/font ") ||
    cmd.startsWith("/fonts ")
  ) {
    const { detectInstalledFonts, NERD_FONTS } =
      require("../core/setup/install.js") as typeof import("../core/setup/install.js");
    const { detectTerminal, getCurrentFont, setTerminalFont } =
      require("../core/setup/terminal-font.js") as typeof import("../core/setup/terminal-font.js");

    const fontArg = trimmed.replace(/^\/(fonts?)\s*/i, "").trim();
    const found = detectInstalledFonts();
    const term = detectTerminal();

    // /font set <name> — auto-configure terminal
    if (fontArg.startsWith("set ")) {
      const fontName = fontArg.slice(4).trim().toLowerCase();
      const match = NERD_FONTS.find(
        (f) =>
          f.id === fontName ||
          f.name.toLowerCase() === fontName ||
          f.family.toLowerCase() === fontName,
      );
      if (!match) {
        ctx.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `Unknown font "${fontArg.slice(4).trim()}". Available:\n${NERD_FONTS.map((f) => `  ${f.id.padEnd(18)} ${f.family}`).join("\n")}`,
            timestamp: Date.now(),
          },
        ]);
      } else if (!term.canAutoSet) {
        ctx.setMessages((prev) => [
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
        ctx.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: result.message + (result.configPath ? `\nConfig: ${result.configPath}` : ""),
            timestamp: Date.now(),
          },
        ]);
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
    ctx.setMessages((prev) => [
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
    if (arg === "accent" || arg === "bubble") {
      ctx.setChatStyle(arg);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Chat style: ${arg}`,
          timestamp: Date.now(),
        },
      ]);
    } else {
      const next = ctx.chatStyle === "accent" ? "bubble" : "accent";
      ctx.setChatStyle(next);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Chat style: ${next}`,
          timestamp: Date.now(),
        },
      ]);
    }
    return;
  }

  if (cmd.startsWith("/open ")) {
    const filePath = trimmed.slice(6).trim();
    if (!filePath) {
      ctx.setMessages((prev) => [
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
    ctx.nvimOpen(filePath).catch(() => {});
    ctx.setMessages((prev) => [
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

  if (cmd.startsWith("/mode ")) {
    const modeName = trimmed.slice(6).trim().toLowerCase();
    const validModes = ["default", "architect", "socratic", "challenge", "plan"] as const;
    const matched = validModes.find((m) => m === modeName);
    if (matched) {
      ctx.setForgeMode(matched);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Forge mode set to: ${matched}`,
          timestamp: Date.now(),
        },
      ]);
    } else {
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Unknown mode: ${modeName}. Available: default, architect, socratic, challenge, plan`,
          timestamp: Date.now(),
        },
      ]);
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
    ctx.setMessages((prev) => [
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
      ctx.setMessages((prev) => [
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
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const proc = spawn("git", ["checkout", "-b", branchName], { cwd: ctx.cwd });
      const chunks: string[] = [];
      proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      proc.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
      proc.on("close", (code) => {
        ctx.refreshGit();
        ctx.setMessages((prev) => [
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
    if (arg === "enable" || arg === "on") {
      ctx.setCoAuthorCommits(true);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Co-author commits enabled.",
          timestamp: Date.now(),
        },
      ]);
    } else if (arg === "disable" || arg === "off") {
      ctx.setCoAuthorCommits(false);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Co-author commits disabled.",
          timestamp: Date.now(),
        },
      ]);
    } else {
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Co-author commits: ${ctx.coAuthorCommits ? "enabled" : "disabled"}\nUsage: /co-author-commits enable | disable`,
          timestamp: Date.now(),
        },
      ]);
    }
    return;
  }

  switch (cmd) {
    case "/quit":
    case "/exit":
      ctx.exit();
      break;
    case "/clear":
      ctx.setMessages([]);
      ctx.setCoreMessages([]);
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
    case "/plan-panel":
      ctx.togglePlanPanel();
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
    case "/summarize":
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "Summarizing conversation...",
          timestamp: Date.now(),
        },
      ]);
      ctx.summarizeConversation();
      break;
    case "/commit":
      ctx.openGitCommit();
      break;
    case "/diff":
      getGitDiff(ctx.cwd).then(async (diff) => {
        if (!diff) {
          ctx.setMessages((prev) => [
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
        ctx.setMessages((prev) => [
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
          ctx.setMessages((prev) => [
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
        const lines = [
          `Branch: ${status.branch ?? "(detached)"}`,
          `Staged: ${String(status.staged.length)} file(s)`,
          `Modified: ${String(status.modified.length)} file(s)`,
          `Untracked: ${String(status.untracked.length)} file(s)`,
        ];
        if (status.ahead > 0) lines.push(`Ahead: ${String(status.ahead)}`);
        if (status.behind > 0) lines.push(`Behind: ${String(status.behind)}`);
        ctx.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: lines.join("\n"),
            timestamp: Date.now(),
          },
        ]);
      });
      break;
    case "/branch":
      getGitStatus(ctx.cwd).then((status) => {
        ctx.setMessages((prev) => [
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
      const total = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const lines = breakdown
        .filter((s) => s.active)
        .map((s) => {
          const kb = (s.chars / 1024).toFixed(1);
          const pct = total > 0 ? Math.round((s.chars / total) * 100) : 0;
          return `  ${String(pct).padStart(3)}%  ${kb.padStart(5)}k  ${s.section}`;
        });
      const totalKb = (total / 1024).toFixed(1);
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: [
            `System prompt context: ${totalKb}k chars`,
            "",
            ...lines,
            "",
            "Clear with: /context clear [git|skills|memory]",
          ].join("\n"),
          timestamp: Date.now(),
        },
      ]);
      break;
    }
    case "/mode":
      ctx.setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Current mode: ${ctx.currentModeLabel} (${ctx.currentMode})\nAvailable: /mode default | architect | socratic | challenge | plan`,
          timestamp: Date.now(),
        },
      ]);
      break;
    case "/git":
      ctx.openGitMenu();
      break;
    case "/lazygit":
      ctx.handleSuspend({ command: "lazygit" });
      break;
    case "/proxy":
    case "/proxy status": {
      const { getProxyBinary, isProxyRunning } =
        require("../core/proxy/lifecycle.js") as typeof import("../core/proxy/lifecycle.js");
      const binary = getProxyBinary();
      isProxyRunning().then((running: boolean) => {
        const lines = [
          "── Proxy Status ──",
          "",
          `Installed: ${binary ? `yes (${binary})` : "no"}`,
          `Running:   ${running ? "yes" : "no"}`,
          "",
          "Commands:",
          "  /proxy login   — authenticate with Claude (browser OAuth)",
          "  /proxy install — manually install CLIProxyAPI",
        ];
        ctx.setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: lines.join("\n"),
            timestamp: Date.now(),
          },
        ]);
      });
      break;
    }
    case "/proxy login": {
      const { proxyLogin } =
        require("../core/proxy/lifecycle.js") as typeof import("../core/proxy/lifecycle.js");
      const loginCmd = proxyLogin();
      ctx.handleSuspend({ command: loginCmd.command, args: loginCmd.args, noAltScreen: true });
      break;
    }
    case "/proxy install": {
      const { installProxy } =
        require("../core/setup/install.js") as typeof import("../core/setup/install.js");
      ctx.setMessages((prev) => [
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
          ctx.setMessages((prev) => [
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
          ctx.setMessages((prev) => [
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
      ctx.setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", content: "Pushing...", timestamp: Date.now() },
      ]);
      gitPush(ctx.cwd).then((result) => {
        ctx.setMessages((prev) => [
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
      ctx.setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", content: "Pulling...", timestamp: Date.now() },
      ]);
      gitPull(ctx.cwd).then((result) => {
        ctx.setMessages((prev) => [
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
        ctx.setMessages((prev) => [
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
        ctx.setMessages((prev) => [
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
          ctx.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: "No commits found.",
              timestamp: Date.now(),
            },
          ]);
        } else {
          const logText = entries.map((e) => `${e.hash} ${e.subject} (${e.date})`).join("\n");
          ctx.setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "system", content: logText, timestamp: Date.now() },
          ]);
        }
      });
      break;
    case "/setup":
      ctx.openSetup();
      break;
    default:
      if (cmd === "/nvim-config" || cmd.startsWith("/nvim-config ")) {
        const arg = trimmed.slice(13).trim().toLowerCase();
        const validModes = ["auto", "default", "user", "none"] as const;
        const matched = validModes.find((m) => m === arg);
        if (matched) {
          ctx.setSessionConfig((prev) => ({ ...prev, nvimConfig: matched }));
          ctx.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Neovim config set to: ${matched}\nReopen the editor (Ctrl+E twice) for changes to take effect.`,
              timestamp: Date.now(),
            },
          ]);
        } else {
          ctx.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: [
                `Current nvim config: ${ctx.effectiveNvimConfig ?? "auto"}`,
                "",
                "Usage: /nvim-config <mode>",
                "  auto    — use user config if found, else shipped config",
                "  default — always use SoulForge's shipped init.lua",
                "  user    — always use your own nvim config",
                "  none    — bare neovim, no config at all",
              ].join("\n"),
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      if (cmd === "/privacy" || cmd.startsWith("/privacy ")) {
        const { getAllPatterns, addProjectPattern, removeProjectPattern, addSessionPattern } =
          require("../core/security/forbidden.js") as typeof import("../core/security/forbidden.js");
        const arg = trimmed.slice(9).trim();

        if (arg.startsWith("add ")) {
          const pattern = arg.slice(4).trim();
          if (!pattern) {
            ctx.setMessages((prev) => [
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
            ctx.setMessages((prev) => [
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
          ctx.setMessages((prev) => [
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
            ctx.setMessages((prev) => [
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
          const lines: string[] = ["Forbidden File Patterns", ""];
          lines.push(`Built-in (${String(patterns.builtin.length)}):`);
          for (const p of patterns.builtin.slice(0, 8)) lines.push(`  ${p}`);
          if (patterns.builtin.length > 8)
            lines.push(`  ... and ${String(patterns.builtin.length - 8)} more`);

          if (patterns.aiignore.length > 0) {
            lines.push("", `.aiignore (${String(patterns.aiignore.length)}):`);
            for (const p of patterns.aiignore) lines.push(`  ${p}`);
          }
          if (patterns.global.length > 0) {
            lines.push("", `Global (${String(patterns.global.length)}):`);
            for (const p of patterns.global) lines.push(`  ${p}`);
          }
          if (patterns.project.length > 0) {
            lines.push("", `Project (${String(patterns.project.length)}):`);
            for (const p of patterns.project) lines.push(`  ${p}`);
          }
          if (patterns.session.length > 0) {
            lines.push("", `Session (${String(patterns.session.length)}):`);
            for (const p of patterns.session) lines.push(`  ${p}`);
          }
          lines.push(
            "",
            "Commands:",
            "  /privacy add <pattern>     — add to project config",
            "  /privacy remove <pattern>  — remove from project config",
            "  /privacy session <pattern> — add for this session only",
          );
          ctx.setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: lines.join("\n"),
              timestamp: Date.now(),
            },
          ]);
        }
        break;
      }
      ctx.setMessages((prev) => [
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
