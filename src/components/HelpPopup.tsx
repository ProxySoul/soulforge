import { Box, Text, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { useEffect, useRef } from "react";
import { POPUP_BG, PopupRow } from "./shared.js";

const POPUP_WIDTH = 78;
const MAX_VISIBLE = 28;
const innerW = POPUP_WIDTH - 2;

interface HelpLine {
  type: "header" | "separator" | "entry" | "text" | "spacer";
  label?: string;
  desc?: string;
  color?: string;
}

const LINES: HelpLine[] = [
  // ── Commands ──
  { type: "header", label: "Commands" },
  { type: "entry", label: "/help", desc: "show this help" },
  { type: "entry", label: "/clear", desc: "clear chat history" },
  { type: "entry", label: "/editor", desc: "toggle editor panel" },
  { type: "entry", label: "/open <path>", desc: "open file in editor" },
  { type: "entry", label: "/editor-settings", desc: "toggle editor/LSP integrations" },
  { type: "entry", label: "/router", desc: "assign different models per task type" },
  { type: "entry", label: "/skills", desc: "browse & install skills" },
  { type: "entry", label: "/sessions", desc: "browse & restore past sessions" },
  { type: "entry", label: "/errors", desc: "browse tool call & error log" },
  { type: "entry", label: "/commit", desc: "AI-assisted git commit" },
  { type: "entry", label: "/diff", desc: "open diff in editor" },
  { type: "entry", label: "/status", desc: "git status overview" },
  { type: "entry", label: "/branch [name]", desc: "show or create branch" },
  { type: "entry", label: "/init", desc: "initialize git repo" },
  { type: "entry", label: "/git", desc: "open git menu" },
  { type: "entry", label: "/lazygit", desc: "launch lazygit fullscreen" },
  { type: "entry", label: "/proxy", desc: "show proxy status (installed, running)" },
  { type: "entry", label: "/proxy login", desc: "authenticate with Claude (browser OAuth)" },
  { type: "entry", label: "/proxy install", desc: "manually install CLIProxyAPI" },
  { type: "entry", label: "/push", desc: "push to remote" },
  { type: "entry", label: "/pull", desc: "pull from remote" },
  { type: "entry", label: "/stash", desc: "stash changes" },
  { type: "entry", label: "/stash pop", desc: "pop latest stash" },
  { type: "entry", label: "/log", desc: "show recent commits" },
  { type: "entry", label: "/summarize", desc: "compress conversation to save context" },
  { type: "entry", label: "/context", desc: "show context budget breakdown" },
  { type: "entry", label: "/context clear", desc: "reset context (git|skills|memory|all)" },
  {
    type: "entry",
    label: "/nvim-config [mode]",
    desc: "switch neovim config (auto|default|user|none)",
  },
  { type: "entry", label: "/mode [name]", desc: "show or switch forge mode" },
  { type: "entry", label: "/chat-style", desc: "toggle chat layout (accent/bubble)" },
  { type: "entry", label: "/plan [task]", desc: "toggle plan mode — research & plan, no edits" },
  { type: "entry", label: "/plan-panel", desc: "toggle plan sidebar panel" },
  { type: "entry", label: "/continue", desc: "continue interrupted generation" },
  { type: "entry", label: "/co-author-commits", desc: "toggle co-author trailer on commits" },
  { type: "entry", label: "/privacy", desc: "manage forbidden file patterns" },
  { type: "entry", label: "/privacy add <pat>", desc: "block a pattern (project)" },
  { type: "entry", label: "/setup", desc: "check & install prerequisites" },
  { type: "entry", label: "/font", desc: "show installed fonts & current terminal font" },
  { type: "entry", label: "/font set <name>", desc: "auto-set terminal font (e.g. fira-code)" },
  { type: "entry", label: "/quit", desc: "exit soulforge" },

  { type: "spacer" },
  { type: "separator" },

  // ── Keybindings ──
  { type: "header", label: "Keybindings" },
  { type: "entry", label: "Ctrl+X", desc: "stop/abort generation" },
  { type: "entry", label: "Ctrl+D", desc: "cycle forge mode" },
  { type: "entry", label: "Ctrl+E", desc: "toggle editor / focus" },
  { type: "entry", label: "Ctrl+G", desc: "git menu" },
  { type: "entry", label: "Ctrl+H", desc: "show help" },
  { type: "entry", label: "Ctrl+K", desc: "clear chat" },
  { type: "entry", label: "Ctrl+L", desc: "switch LLM model" },
  { type: "entry", label: "Ctrl+P", desc: "browse sessions" },
  { type: "entry", label: "Ctrl+R", desc: "error log" },
  { type: "entry", label: "Ctrl+S", desc: "browse skills" },
  { type: "entry", label: "Ctrl+T", desc: "toggle plan sidebar" },
  { type: "entry", label: "Shift+Click", desc: "select text (bypasses mouse capture)" },
  { type: "entry", label: "Ctrl+C", desc: "exit" },

  { type: "spacer" },
  { type: "separator" },

  // ── Forge Modes ──
  { type: "header", label: "Forge Modes" },
  { type: "text", label: "Switch with /mode <name> or Ctrl+D to cycle." },
  { type: "spacer" },
  {
    type: "entry",
    label: "default",
    desc: "standard assistant — implements directly",
    color: "#555",
  },
  {
    type: "entry",
    label: "architect",
    desc: "design only — outlines, tradeoffs, no code",
    color: "#9B30FF",
  },
  {
    type: "entry",
    label: "socratic",
    desc: "asks probing questions before implementing",
    color: "#FF8C00",
  },
  {
    type: "entry",
    label: "challenge",
    desc: "devil's advocate — challenges every assumption",
    color: "#FF0040",
  },
  {
    type: "entry",
    label: "plan",
    desc: "research & plan only — no file edits or shell",
    color: "#00BFFF",
  },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function HelpPopup({ visible, onClose }: Props) {
  const scrollRef = useRef<ScrollViewRef>(null);

  useEffect(() => {
    if (visible) scrollRef.current?.scrollToTop();
  }, [visible]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        scrollRef.current?.scrollBy(-1);
        return;
      }
      if (key.downArrow) {
        scrollRef.current?.scrollBy(1);
      }
    },
    { isActive: visible },
  );

  if (!visible) return null;

  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box flexDirection="column" borderStyle="round" borderColor="#8B5CF6" width={POPUP_WIDTH}>
        {/* Title */}
        <PopupRow w={innerW}>
          <Text backgroundColor={POPUP_BG} color="#9B30FF" bold>
            󰋖
          </Text>
          <Text backgroundColor={POPUP_BG} color="white" bold>
            {" "}
            SoulForge Help
          </Text>
          <Text backgroundColor={POPUP_BG} color="#555">
            {"  "}↑↓ scroll
          </Text>
        </PopupRow>

        {/* Separator */}
        <PopupRow w={innerW}>
          <Text backgroundColor={POPUP_BG} color="#333">
            {"─".repeat(innerW - 2)}
          </Text>
        </PopupRow>

        {/* Content */}
        <ScrollView ref={scrollRef} height={Math.min(LINES.length, MAX_VISIBLE)}>
          {LINES.map((line, i) => {
            const key = String(i);
            switch (line.type) {
              case "header":
                return (
                  <PopupRow key={key} w={innerW}>
                    <Text backgroundColor={POPUP_BG} color="#8B5CF6" bold>
                      {line.label}
                    </Text>
                  </PopupRow>
                );
              case "separator":
                return (
                  <PopupRow key={key} w={innerW}>
                    <Text backgroundColor={POPUP_BG} color="#333">
                      {"─".repeat(innerW - 2)}
                    </Text>
                  </PopupRow>
                );
              case "entry":
                return (
                  <PopupRow key={key} w={innerW}>
                    <Text backgroundColor={POPUP_BG} color={line.color ?? "#FF0040"}>
                      {(line.label ?? "").padEnd(20)}
                    </Text>
                    <Text backgroundColor={POPUP_BG} color="#666">
                      {line.desc}
                    </Text>
                  </PopupRow>
                );
              case "text":
                return (
                  <PopupRow key={key} w={innerW}>
                    <Text backgroundColor={POPUP_BG} color="#555">
                      {line.label}
                    </Text>
                  </PopupRow>
                );
              case "spacer":
                return (
                  <PopupRow key={key} w={innerW}>
                    <Text backgroundColor={POPUP_BG}>{""}</Text>
                  </PopupRow>
                );
              default:
                return null;
            }
          })}
        </ScrollView>

        {/* Spacer */}
        <PopupRow w={innerW}>
          <Text backgroundColor={POPUP_BG}>{""}</Text>
        </PopupRow>

        {/* Hints */}
        <PopupRow w={innerW}>
          <Text backgroundColor={POPUP_BG} color="#555">
            {"↑↓"} scroll esc close
          </Text>
        </PopupRow>
      </Box>
    </Box>
  );
}
