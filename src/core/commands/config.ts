import type { ConfigScope } from "../../components/layout/shared.js";
import { useUIStore } from "../../stores/ui.js";
import type { AgentFeatures } from "../../types/index.js";
import { icon, setNerdFont } from "../icons.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

type ToggleConfig = {
  configKey: string;
  title: string;
  iconName: string;
  onValue: string;
  offValue: string;
  onLabel: string;
  offLabel: string;
  onDescription: string;
  offDescription: string;
  messageTemplate: (value: string, scope: string) => string;
};

function createTogglePicker(config: ToggleConfig): CommandHandler {
  return (_input: string, ctx: CommandContext) => {
    const currentVal = ctx[config.configKey as keyof CommandContext];
    const patch = (v: string) => ({ [config.configKey]: v === config.onValue });
    ctx.openCommandPicker({
      title: config.title,
      icon: icon(config.iconName),
      currentValue: currentVal ? config.onValue : config.offValue,
      scopeEnabled: true,
      initialScope: ctx.detectScope(config.configKey),
      options: [
        { value: config.onValue, label: config.onLabel, description: config.onDescription },
        { value: config.offValue, label: config.offLabel, description: config.offDescription },
      ],
      onSelect: (value, scope) => {
        ctx.saveToScope(patch(value), scope ?? "project");
        sysMsg(ctx, config.messageTemplate(value, scope ?? "project"));
      },
      onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
    });
  };
}

async function handleFont(input: string, ctx: CommandContext): Promise<void> {
  const trimmed = input.trim();
  const { detectInstalledFonts, NERD_FONTS } = await import("../setup/install.js");
  const { detectTerminal, getCurrentFont, setTerminalFont } = await import(
    "../setup/terminal-font.js"
  );

  const fontArg = trimmed.replace(/^\/(fonts?)\s*/i, "").trim();
  const found = detectInstalledFonts();
  const term = detectTerminal();

  if (fontArg === "set" || fontArg.startsWith("set ")) {
    const fontName = fontArg.slice(4).trim().toLowerCase();

    const applyFont = (fontId: string) => {
      const match = NERD_FONTS.find(
        (f) =>
          f.id === fontId || f.name.toLowerCase() === fontId || f.family.toLowerCase() === fontId,
      );
      if (!match) {
        sysMsg(
          ctx,
          `Unknown font "${fontId}". Available:\n${NERD_FONTS.map((f) => `  ${f.id.padEnd(18)} ${f.family}`).join("\n")}`,
        );
      } else if (!term.canAutoSet) {
        sysMsg(ctx, `Can't auto-set font in ${term.name}.\n${term.instructions} → ${match.family}`);
      } else {
        const result = setTerminalFont(match.family);
        sysMsg(ctx, result.message + (result.configPath ? `\nConfig: ${result.configPath}` : ""));
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
    for (const f of found) fontLines.push(`  ✓ ${f.family}`);
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
  sysMsg(ctx, fontLines.join("\n"));
}

function handleChatStyle(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.slice(12).trim().toLowerCase();
  const patch = (v: string) => ({ chatStyle: v as "accent" | "bubble" });

  const applyChatStyle = (style: "accent" | "bubble", scope?: ConfigScope) => {
    ctx.setChatStyle(style);
    ctx.saveToScope(patch(style), scope ?? "project");
    sysMsg(ctx, `Chat style: ${style} (${scope ?? "project"})`);
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
        { value: "accent", label: "Accent", description: "colored left-border for messages" },
        { value: "bubble", label: "Bubble", description: "rounded bubble chat layout" },
      ],
      onSelect: (value, scope) => applyChatStyle(value as "accent" | "bubble", scope),
      onScopeMove: (value, from, to) => {
        ctx.setChatStyle(value as "accent" | "bubble");
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleMode(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const modeName = trimmed.slice(5).trim().toLowerCase();
  const validModes = ["default", "architect", "socratic", "challenge", "plan", "auto"] as const;
  type Mode = (typeof validModes)[number];
  const patch = (v: string) => ({ defaultForgeMode: v as Mode });

  const applyMode = (mode: Mode, scope?: ConfigScope) => {
    ctx.setForgeMode(mode);
    ctx.saveToScope(patch(mode), scope ?? "project");
    sysMsg(ctx, `Forge mode set to: ${mode} (${scope ?? "project"})`);
  };

  const matched = validModes.find((m) => m === modeName);
  if (matched) {
    applyMode(matched);
  } else if (modeName && !matched) {
    sysMsg(
      ctx,
      `Unknown mode: ${modeName}. Available: default, architect, socratic, challenge, plan, auto`,
    );
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
        {
          value: "auto",
          label: "Auto",
          description: "autonomous execution — minimal questions, action over planning",
          color: "#2d5",
        },
      ],
      onSelect: (value, scope) => applyMode(value as Mode, scope),
      onScopeMove: (value, from, to) => {
        ctx.setForgeMode(value as Mode);
        ctx.saveToScope(patch(value), to, from);
      },
    });
  }
}

function handleNvimConfig(input: string, ctx: CommandContext): void {
  const trimmed = input.trim();
  const arg = trimmed.slice(13).trim().toLowerCase();
  const validModes = ["default", "user", "none"] as const;
  const matched = validModes.find((m) => m === arg);

  const applyNvimConfig = (mode: (typeof validModes)[number], scope?: ConfigScope) => {
    ctx.saveToScope({ nvimConfig: mode }, scope ?? "project");
    sysMsg(
      ctx,
      `Neovim config set to: ${mode} (${scope ?? "project"})\nReopen the editor (Ctrl+E twice) for changes to take effect.`,
    );
  };

  if (matched) {
    applyNvimConfig(matched);
  } else {
    ctx.openCommandPicker({
      title: "Neovim Config",
      icon: icon("nvim"),
      currentValue: ctx.effectiveNvimConfig ?? "default",
      scopeEnabled: true,
      initialScope: ctx.detectScope("nvimConfig"),
      options: [
        {
          value: "default",
          label: "Default",
          description: "always use SoulForge's shipped init.lua",
        },
        { value: "user", label: "User", description: "always use your own nvim config" },
        { value: "none", label: "None", description: "bare neovim, no config at all" },
      ],
      onSelect: (value, scope) => applyNvimConfig(value as (typeof validModes)[number], scope),
      onScopeMove: (value, from, to) =>
        ctx.saveToScope({ nvimConfig: value as (typeof validModes)[number] }, to, from),
    });
  }
}

const handleVerbose = createTogglePicker({
  configKey: "verbose",
  title: "Verbose Mode",
  iconName: "verbose",
  onValue: "on",
  offValue: "off",
  onLabel: "On",
  offLabel: "Off",
  onDescription: "show full tool call output in chat",
  offDescription: "show compact tool call summaries",
  messageTemplate: (v, s) => `Verbose mode ${v === "on" ? "on" : "off"} (${s})`,
});

function handleReasoning(_input: string, ctx: CommandContext): void {
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
      sysMsg(ctx, `Reasoning ${value === "on" ? "visible" : "hidden"} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => {
      ctx.setShowReasoning(value === "on");
      ctx.saveToScope(patch(value), to, from);
    },
  });
}

function handleCompaction(_input: string, ctx: CommandContext): void {
  type Strategy = import("../compaction/types.js").CompactionStrategy;
  let localStrategy = ctx.compactionStrategy as Strategy;
  let localPruning = !ctx.disablePruning;

  const buildOptions = () => [
    {
      value: "v1",
      label: `V1 — LLM Summarization${localStrategy === "v1" ? " ●" : ""}`,
      description: "batch summarize with LLM when context is full",
    },
    {
      value: "v2",
      label: `V2 — Incremental Extraction${localStrategy === "v2" ? " ●" : ""}`,
      description: "extract structured state as-you-go, cheap gap-fill on compact (default)",
    },
    {
      value: "disabled",
      label: `Disabled${localStrategy === "disabled" ? " ●" : ""}`,
      description: "no auto-compaction — context will fill until the model's limit",
    },
    {
      value: "pruning",
      label: `Subagent Pruning: ${localPruning ? "on" : "off"}`,
      description: "semantic pruning of old tool results in subagent context windows",
    },
  ];

  ctx.openCommandPicker({
    title: "Compaction & Pruning",
    icon: icon("compact"),
    keepOpen: true,
    currentValue: localStrategy,
    scopeEnabled: true,
    initialScope: ctx.detectScope("compaction"),
    options: buildOptions(),
    onSelect: (value, scope) => {
      if (value === "pruning") {
        localPruning = !localPruning;
        ctx.saveToScope({ compaction: { disablePruning: !localPruning } }, scope ?? "project");
        sysMsg(
          ctx,
          `Subagent pruning ${localPruning ? "enabled" : "disabled"} (${scope ?? "project"})`,
        );
      } else {
        localStrategy = value as Strategy;
        ctx.saveToScope({ compaction: { strategy: localStrategy } }, scope ?? "project");
        sysMsg(ctx, `Compaction strategy: ${value} (${scope ?? "project"})`);
      }
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (value, from, to) => {
      if (value === "pruning") {
        ctx.saveToScope({ compaction: { disablePruning: !localPruning } }, to, from);
      } else {
        ctx.saveToScope({ compaction: { strategy: localStrategy } }, to, from);
      }
    },
  });
}

function handleAgentFeatures(_input: string, ctx: CommandContext): void {
  const featureDesc: Record<string, string> = {
    desloppify: "cleanup pass after code agents (needs model in /router)",
    verifyEdits: "adversarial review after code agents (needs exploration model)",
    tierRouting: "auto-route trivial tasks to cheaper models",
    dispatchCache: "cache file reads across dispatch boundaries",
    targetFileValidation: "require file paths on dispatch tasks",
  };
  const featureLabel: Record<string, string> = {
    desloppify: "De-sloppify",
    verifyEdits: "Verify Edits",
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
}

async function handleInstructions(_input: string, ctx: CommandContext): Promise<void> {
  const { INSTRUCTION_SOURCES, loadInstructions, buildInstructionPrompt } = await import(
    "../instructions.js"
  );
  const currentEnabled = new Set<string>(
    ctx.instructionFiles ??
      INSTRUCTION_SOURCES.filter((s: { defaultEnabled: boolean }) => s.defaultEnabled).map(
        (s: { id: string }) => s.id,
      ),
  );
  const loaded = loadInstructions(ctx.cwd, [...currentEnabled]);
  const loadedIds = new Set(loaded.map((l: { source: string }) => l.source));

  const buildOptions = () =>
    INSTRUCTION_SOURCES.map((s: { id: string; label: string; files: string[] }) => {
      const enabled = currentEnabled.has(s.id);
      const found = loadedIds.has(s.id);
      const status = enabled ? (found ? "on (loaded)" : "on (file not found)") : "off";
      return {
        value: s.id,
        label: `${s.label}: ${status}`,
        description: s.files.join(", "),
      };
    });

  ctx.openCommandPicker({
    title: "Instruction Files",
    icon: icon("system"),
    keepOpen: true,
    currentValue: "",
    options: buildOptions(),
    scopeEnabled: true,
    initialScope: ctx.detectScope("instructionFiles"),
    onSelect: (value, scope) => {
      if (currentEnabled.has(value)) {
        currentEnabled.delete(value);
      } else {
        currentEnabled.add(value);
      }
      const ids = [...currentEnabled];
      ctx.saveToScope({ instructionFiles: ids }, scope ?? "project");

      const freshLoaded = loadInstructions(ctx.cwd, ids);
      loadedIds.clear();
      for (const l of freshLoaded) loadedIds.add(l.source);

      ctx.contextManager.setProjectInstructions(buildInstructionPrompt(freshLoaded));

      sysMsg(
        ctx,
        `Instruction file "${value}" ${currentEnabled.has(value) ? "enabled" : "disabled"} (${scope ?? "project"})`,
      );
      useUIStore.getState().updatePickerOptions(buildOptions());
    },
    onScopeMove: (_value, from, to) => {
      ctx.saveToScope({ instructionFiles: [...currentEnabled] }, to, from);
    },
  });
}

function handleDiffStyle(_input: string, ctx: CommandContext): void {
  const patch = (v: string) => ({ diffStyle: v as "default" | "sidebyside" | "compact" });
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
      sysMsg(ctx, `Diff style: ${value} (${scope ?? "project"})`);
    },
    onScopeMove: (value, from, to) => ctx.saveToScope(patch(value), to, from),
  });
}

function handleSplit(_input: string, ctx: CommandContext): void {
  const { cycleEditorSplit } = useUIStore.getState();
  cycleEditorSplit();
  const newSplit = useUIStore.getState().editorSplit;
  ctx.saveToScope({ editorSplit: newSplit }, "global");
  sysMsg(ctx, `Editor split: ${String(newSplit)}/${String(100 - newSplit)}`);
}

const handleVimHints = createTogglePicker({
  configKey: "vimHints",
  title: "Vim Hints",
  iconName: "nvim",
  onValue: "visible",
  offValue: "hidden",
  onLabel: "Visible",
  offLabel: "Hidden",
  onDescription: "show vim keybinding hints in editor",
  offDescription: "hide vim keybinding hints",
  messageTemplate: (v, s) => `Vim hints ${v === "visible" ? "visible" : "hidden"} (${s})`,
});

function handleModelScope(_input: string, ctx: CommandContext): void {
  ctx.openCommandPicker({
    title: "Model Scope",
    icon: icon("settings"),
    currentValue: ctx.detectScope("defaultModel"),
    options: [
      { value: "global", label: "Global", description: "model choice applies to all projects" },
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
      sysMsg(ctx, `Model scope: ${value}`);
    },
  });
}

function handleNerdFont(_input: string, ctx: CommandContext): void {
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
      sysMsg(
        ctx,
        `Nerd Font ${value === "yes" ? "enabled" : "disabled"} (global). Restart for full effect.`,
      );
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/chat-style", handleChatStyle);
  map.set("/mode", handleMode);
  map.set("/nvim-config", handleNvimConfig);
  map.set("/verbose", handleVerbose);
  map.set("/reasoning", handleReasoning);
  map.set("/compaction", handleCompaction);
  map.set("/agent-features", handleAgentFeatures);
  map.set("/instructions", handleInstructions);
  map.set("/diff-style", handleDiffStyle);
  map.set("/split", handleSplit);
  map.set("/vim-hints", handleVimHints);
  map.set("/model-scope", handleModelScope);
  map.set("/nerd-font", handleNerdFont);
  map.set("/nerdfont", handleNerdFont);
}

export function matchConfigPrefix(cmd: string): CommandHandler | null {
  if (cmd === "/font" || cmd === "/fonts" || cmd.startsWith("/font ") || cmd.startsWith("/fonts "))
    return handleFont;
  if (cmd === "/chat-style" || cmd.startsWith("/chat-style ")) return handleChatStyle;
  if (cmd === "/mode" || cmd.startsWith("/mode ")) return handleMode;
  if (cmd === "/nvim-config" || cmd.startsWith("/nvim-config ")) return handleNvimConfig;
  return null;
}
