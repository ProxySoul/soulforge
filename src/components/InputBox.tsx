import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HistoryDB } from "../core/history/db.js";
import { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "../core/history/fuzzy.js";
import { icon } from "../core/icons.js";

interface Props {
  onSubmit: (value: string) => void;
  isLoading: boolean;
  isCompacting?: boolean;
  isFocused?: boolean;
  onQueue?: (msg: string) => void;
  onExit?: () => void;
  queueCount?: number;
  cwd?: string;
  onDropdownChange?: (visible: boolean) => void;
}

const CMD_DEFS: Array<{ cmd: string; ic: string; desc: string }> = [
  { cmd: "/agent-features", ic: "cog", desc: "Toggle agent features (de-sloppify, tier routing)" },
  { cmd: "/branch", ic: "git", desc: "Show/create branch" },
  { cmd: "/changes", ic: "changes", desc: "Toggle changed files tree" },
  { cmd: "/chat-style", ic: "chat", desc: "Toggle chat layout style" },
  { cmd: "/clear", ic: "clear", desc: "Clear chat history" },
  { cmd: "/close-tab", ic: "tabs", desc: "Close current tab (Alt+W)" },
  { cmd: "/co-author-commits", ic: "git", desc: "Toggle co-author trailer" },
  { cmd: "/commit", ic: "git", desc: "Git commit with message" },
  { cmd: "/compact", ic: "compress", desc: "Compact conversation context" },
  { cmd: "/compact-v2-logs", ic: "plan", desc: "View compaction events" },
  { cmd: "/compaction", ic: "compress", desc: "Switch compaction strategy (v1/v2)" },
  { cmd: "/context", ic: "context", desc: "Show/clear context budget" },
  { cmd: "/continue", ic: "play", desc: "Continue interrupted generation" },
  { cmd: "/diagnose", ic: "brain", desc: "Intelligence health check — probe all backends" },
  { cmd: "/diff", ic: "git", desc: "Open diff in editor" },
  { cmd: "/diff-style", ic: "git", desc: "Change diff display style" },
  { cmd: "/editor", ic: "pencil", desc: "Toggle editor panel" },
  { cmd: "/editor-settings", ic: "cog", desc: "Toggle editor/LSP integrations" },
  { cmd: "/errors", ic: "error", desc: "Browse error log" },
  { cmd: "/export", ic: "changes", desc: "Export chat to markdown" },
  { cmd: "/export json", ic: "changes", desc: "Export chat as JSON" },
  { cmd: "/font", ic: "pencil", desc: "Show/set terminal font" },
  { cmd: "/git", ic: "git", desc: "Git menu" },
  { cmd: "/git-status", ic: "git", desc: "Git status" },
  { cmd: "/help", ic: "help", desc: "Show available commands" },
  { cmd: "/init", ic: "git", desc: "Initialize git repo" },
  { cmd: "/keys", ic: "cog", desc: "Manage LLM provider API keys" },
  { cmd: "/lazygit", ic: "git", desc: "Launch lazygit" },
  { cmd: "/log", ic: "git", desc: "Show recent commits" },
  { cmd: "/lsp", ic: "brain", desc: "Language server status & diagnostics" },
  { cmd: "/lsp-install", ic: "brain", desc: "Install & manage LSP servers (Mason registry)" },
  { cmd: "/memory", ic: "memory", desc: "Manage memory scopes, view & clear" },
  { cmd: "/mode", ic: "cog", desc: "Switch forge mode" },
  { cmd: "/model-scope", ic: "cog", desc: "Set model scope (project/global)" },
  { cmd: "/models", ic: "system", desc: "Switch LLM model (Ctrl+L)" },
  { cmd: "/nerd-font", ic: "ghost", desc: "Toggle Nerd Font icons" },
  { cmd: "/new-tab", ic: "tabs", desc: "Open new tab (Alt+T)" },
  { cmd: "/nvim-config", ic: "pencil", desc: "Switch neovim config mode" },
  { cmd: "/open", ic: "changes", desc: "Open file in editor" },
  { cmd: "/plan", ic: "plan", desc: "Toggle plan mode (research & plan only)" },
  { cmd: "/privacy", ic: "lock", desc: "Manage forbidden file patterns" },
  { cmd: "/provider-settings", ic: "system", desc: "Thinking, effort, speed, context mgmt" },
  { cmd: "/providers", ic: "system", desc: "Provider & Models" },
  { cmd: "/proxy", ic: "proxy", desc: "Proxy status" },
  { cmd: "/proxy install", ic: "proxy", desc: "Install CLIProxyAPI" },
  { cmd: "/proxy login", ic: "proxy", desc: "Authenticate with Claude" },
  { cmd: "/pull", ic: "git", desc: "Pull from remote" },
  { cmd: "/push", ic: "git", desc: "Push to remote" },
  { cmd: "/quit", ic: "quit", desc: "Exit SoulForge" },
  { cmd: "/reasoning", ic: "brain", desc: "Show or hide reasoning content" },
  { cmd: "/rename", ic: "pencil", desc: "Rename current tab" },
  { cmd: "/repo-map", ic: "tree", desc: "Soul map settings (AST index)" },
  { cmd: "/restart", ic: "ghost", desc: "Full restart" },
  { cmd: "/router", ic: "router", desc: "Assign models per task type" },
  { cmd: "/sessions", ic: "clock_alt", desc: "Browse & restore sessions" },
  { cmd: "/setup", ic: "ghost", desc: "Check & install prerequisites" },
  { cmd: "/skills", ic: "skills", desc: "Browse & install skills" },
  { cmd: "/split", ic: "pencil", desc: "Cycle editor/chat split (40/50/60/70)" },
  { cmd: "/stash", ic: "git", desc: "Stash changes" },
  { cmd: "/stash pop", ic: "git", desc: "Pop latest stash" },
  { cmd: "/status", ic: "info", desc: "System status" },
  { cmd: "/storage", ic: "system", desc: "View & manage storage usage" },
  { cmd: "/tabs", ic: "tabs", desc: "List open tabs" },
  { cmd: "/verbose", ic: "cog", desc: "Toggle verbose tool output" },
  { cmd: "/vim-hints", ic: "pencil", desc: "Toggle vim keybinding hints" },
  { cmd: "/web-search", ic: "cog", desc: "Web search keys & settings" },
];

let _commands: Array<{ cmd: string; icon: string; desc: string }> | null = null;
function getCommands() {
  if (!_commands) {
    _commands = CMD_DEFS.map((c) => ({ cmd: c.cmd, icon: icon(c.ic), desc: c.desc }));
  }
  return _commands;
}

const HighlightedText = memo(function HighlightedText({
  text,
  indices,
}: {
  text: string;
  indices: number[];
}) {
  if (indices.length === 0) return <text fg="#ccc">{text}</text>;
  const indexSet = new Set(indices);
  const spans: { text: string; hl: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const hl = indexSet.has(i);
    const last = spans[spans.length - 1];
    if (last && last.hl === hl) {
      last.text += char;
    } else {
      spans.push({ text: char, hl });
    }
  }
  return (
    <text>
      {spans.map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: stable span order
          key={i}
          fg={s.hl ? "#FF0040" : "#ccc"}
          attributes={s.hl ? TextAttributes.BOLD : undefined}
        >
          {s.text}
        </span>
      ))}
    </text>
  );
});

/** Override textarea defaults: Enter=submit, Shift+Enter=newline */
const INPUT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
];

export const InputBox = memo(function InputBox({
  onSubmit,
  isLoading,
  isCompacting,
  isFocused,
  onQueue,
  onExit,
  cwd,
  onDropdownChange,
}: Props) {
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const renderer = useRenderer();
  const { height: termRows, width: termWidth } = useTerminalDimensions();
  const acScrollRef = useRef<ScrollBoxRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const containerRef = useRef<BoxRenderable>(null);
  // Track logical cursor line for history gating (up on first line / down on last line)
  const cursorLineRef = useRef(0);
  const lineCountRef = useRef(1);
  // Guard: when true, handleContentChange skips historyIdx reset (programmatic setText)
  const isNavigatingHistory = useRef(false);
  // Visual line count (after char-wrapping) for textarea height
  const [visualLines, setVisualLines] = useState(1);
  // Paste blocks: collapsed pasted text regions
  const pasteBlocks = useRef<Array<{ id: number; text: string; collapsed: boolean }>>([]);
  const pasteIdCounter = useRef(0);

  const showBusy = isLoading || isCompacting;

  const historyDBRef = useRef<HistoryDB | null>(null);
  const historyCacheRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const historyStash = useRef("");

  const getHistoryDB = useCallback(() => {
    if (!historyDBRef.current) {
      historyDBRef.current = new HistoryDB(join(homedir(), ".soulforge", "history.db"));
    }
    return historyDBRef.current;
  }, []);

  const refreshHistoryCache = useCallback(() => {
    try {
      historyCacheRef.current = getHistoryDB().recent(500);
    } catch {
      historyCacheRef.current = [];
    }
  }, [getHistoryDB]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init + cleanup
  useEffect(() => {
    refreshHistoryCache();
    return () => {
      historyDBRef.current?.close();
      historyDBRef.current = null;
    };
  }, []);

  const [fuzzyMode, setFuzzyMode] = useState(false);
  const [fuzzyQuery, setFuzzyQuery] = useState("");
  const [fuzzyResults, setFuzzyResults] = useState<FuzzyMatch[]>([]);
  const [fuzzyCursor, setFuzzyCursor] = useState(0);
  const fuzzyScrollRef = useRef<ScrollBoxRenderable>(null);
  const fuzzyScrollOffset = useRef(0);

  useEffect(() => {
    if (!fuzzyMode) return;
    try {
      const candidates = getHistoryDB().recent(500);
      setFuzzyResults(fuzzyFilter(fuzzyQuery, candidates, 50));
      setFuzzyCursor(0);
      fuzzyScrollOffset.current = 0;
      fuzzyScrollRef.current?.scrollTo(0);
    } catch {
      setFuzzyResults([]);
    }
  }, [fuzzyQuery, fuzzyMode, getHistoryDB]);

  const focused = isFocused ?? true;

  // Refresh history when input gains focus (covers tab switches, session restores)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh on focus gain
  useEffect(() => {
    if (focused) refreshHistoryCache();
  }, [focused]);

  const showAutocomplete =
    value.startsWith("/") && focused && !fuzzyMode && historyIdx.current === -1;
  const query = value.toLowerCase();
  const matches = useMemo(() => {
    if (!showAutocomplete) return [];
    const cmds = getCommands();
    const results: Array<{
      cmd: string;
      icon: string;
      desc: string;
      score: number;
      indices: number[];
    }> = [];
    for (const c of cmds) {
      const m = fuzzyMatch(query, c.cmd);
      if (m) results.push({ ...c, score: m.score, indices: m.indices });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }, [showAutocomplete, query]);
  const hasMatches = matches.length > 0;

  const ghost =
    hasMatches && matches[selectedIdx]?.cmd.startsWith(query)
      ? matches[selectedIdx].cmd.slice(value.length)
      : "";

  const maxVisible = Math.min(8, Math.max(4, Math.floor(termRows * 0.25)));
  const acScrollOffset = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when input changes
  useEffect(() => {
    setSelectedIdx(0);
    acScrollOffset.current = 0;
    acScrollRef.current?.scrollTo(0);
  }, [value]);

  useEffect(() => {
    if (!hasMatches) return;
    const offset = acScrollOffset.current;
    if (selectedIdx < offset) {
      acScrollOffset.current = selectedIdx;
      acScrollRef.current?.scrollTo(selectedIdx);
    } else if (selectedIdx >= offset + maxVisible) {
      const newOffset = selectedIdx - maxVisible + 1;
      acScrollOffset.current = newOffset;
      acScrollRef.current?.scrollTo(newOffset);
    }
  }, [selectedIdx, hasMatches, maxVisible]);

  const acceptCompletion = useCallback(() => {
    const completed = matches[selectedIdx]?.cmd;
    if (!completed) return;
    isNavigatingHistory.current = true;
    setValue(completed);
    textareaRef.current?.setText(completed);
    lineCountRef.current = (completed.match(/\n/g)?.length ?? 0) + 1;
    cursorLineRef.current = 0;
    isNavigatingHistory.current = false;
  }, [matches, selectedIdx]);

  const pushHistory = useCallback(
    (input: string) => {
      try {
        getHistoryDB().push(input, cwd);
        refreshHistoryCache();
      } catch {}
    },
    [getHistoryDB, refreshHistoryCache, cwd],
  );

  const resetInput = useCallback(() => {
    isNavigatingHistory.current = true;
    setValue("");
    textareaRef.current?.setText("");
    cursorLineRef.current = 0;
    lineCountRef.current = 1;
    historyIdx.current = -1;
    pasteBlocks.current = [];
    setVisualLines(1);
    isNavigatingHistory.current = false;
  }, []);

  const handleSubmit = useCallback(
    (input: string) => {
      // Autocomplete match — complete or submit the command
      if (hasMatches && matches[selectedIdx]) {
        const completed = matches[selectedIdx].cmd;
        if (completed === "/open" || completed === "/branch") {
          const withSpace = `${completed} `;
          isNavigatingHistory.current = true;
          setValue(withSpace);
          textareaRef.current?.setText(withSpace);
          lineCountRef.current = 1;
          cursorLineRef.current = 0;
          isNavigatingHistory.current = false;
        } else {
          pushHistory(completed);
          onSubmit(completed);
          resetInput();
        }
        return;
      }

      if (input.trim() === "") return;

      // Expand any collapsed paste blocks before submitting
      let finalInput = input;
      for (const block of pasteBlocks.current) {
        if (block.collapsed) {
          const pastedLines = block.text.split("\n");
          const placeholder = `📋 [Pasted ${pastedLines.length} lines — ^E to expand]`;
          finalInput = finalInput.replace(placeholder, block.text);
        }
      }

      // During loading or compacting: slash commands execute immediately, messages queue
      if ((isLoading || isCompacting) && !finalInput.trim().startsWith("/")) {
        onQueue?.(finalInput.trim());
        resetInput();
        return;
      }

      pushHistory(finalInput.trim());
      onSubmit(finalInput.trim());
      resetInput();
    },
    [
      hasMatches,
      matches,
      selectedIdx,
      pushHistory,
      onSubmit,
      resetInput,
      isLoading,
      isCompacting,
      onQueue,
    ],
  );

  // Sync textarea content → React state
  const handleContentChange = useCallback(() => {
    const text = textareaRef.current?.plainText ?? "";
    // Don't reset historyIdx when we're programmatically setting text (history nav, reset, etc.)
    if (!isNavigatingHistory.current) {
      historyIdx.current = -1;
    }
    setValue(text);
    lineCountRef.current = textareaRef.current?.lineCount ?? 1;
    // Update visual line count for height calculation (accounts for char-wrapping)
    const vLines = textareaRef.current?.virtualLineCount ?? 1;
    setVisualLines(vLines);
  }, []);

  // Track cursor line for history gating
  const handleCursorChange = useCallback((event: { line: number; visualColumn: number }) => {
    cursorLineRef.current = event.line;
  }, []);

  // Intercept paste — 4+ lines get collapsed like Claude Code
  useEffect(() => {
    const handler = (event: { text: string; preventDefault: () => void }) => {
      if (!isFocused) return;
      const text = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const pastedLines = text.split("\n");

      // 1-3 lines: let textarea handle normally
      if (pastedLines.length <= 3) return;

      // 4+ lines: store as a collapsible block, insert placeholder on its own line
      event.preventDefault();
      const id = ++pasteIdCounter.current;
      pasteBlocks.current.push({ id, text, collapsed: true });
      const placeholder = `📋 [Pasted ${pastedLines.length} lines — ^E to expand]`;
      const current = textareaRef.current?.plainText ?? "";
      // Put placeholder on its own line so user can write before/after
      const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      textareaRef.current?.insertText(`${prefix}${placeholder}\n`);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [isFocused, renderer]);

  useKeyboard((evt) => {
    // ── Autocomplete navigation ──
    if (hasMatches) {
      if (evt.name === "down") {
        setSelectedIdx((prev) => (prev + 1) % matches.length);
        evt.preventDefault();
        return;
      }
      if (evt.name === "up") {
        setSelectedIdx((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
        evt.preventDefault();
        return;
      }
      if ((evt.name === "tab" || evt.name === "right") && ghost) {
        acceptCompletion();
        evt.preventDefault();
        return;
      }
    }

    // ── Ctrl+R: toggle fuzzy history search ──
    if (focused) {
      if (evt.ctrl && evt.name === "r") {
        setFuzzyMode((prev) => !prev);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
    }

    // ── Fuzzy mode key handling ──
    if (fuzzyMode) {
      if (evt.name === "escape") {
        setFuzzyMode(false);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
      if (evt.name === "return") {
        const selected = fuzzyResults[fuzzyCursor];
        if (selected) {
          isNavigatingHistory.current = true;
          setValue(selected.entry);
          textareaRef.current?.setText(selected.entry);
          lineCountRef.current = (selected.entry.match(/\n/g)?.length ?? 0) + 1;
          cursorLineRef.current = 0;
          isNavigatingHistory.current = false;
        }
        setFuzzyMode(false);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
      if (evt.name === "up") {
        setFuzzyCursor((prev) => (prev > 0 ? prev - 1 : Math.max(0, fuzzyResults.length - 1)));
        evt.preventDefault();
        return;
      }
      if (evt.name === "down") {
        setFuzzyCursor((prev) => (prev + 1) % Math.max(1, fuzzyResults.length));
        evt.preventDefault();
        return;
      }
      if (evt.name === "backspace" || evt.name === "delete") {
        setFuzzyQuery((prev) => prev.slice(0, -1));
        evt.preventDefault();
        return;
      }
      if (evt.ctrl || evt.meta || evt.name === "tab") return;
      if (evt.name && evt.name.length === 1) {
        setFuzzyQuery((prev) => prev + evt.name);
        evt.preventDefault();
        return;
      }
      return;
    }

    // ── Ctrl+C — clear input if non-empty, otherwise exit ──
    if (focused && evt.ctrl && evt.name === "c") {
      if (valueRef.current.length > 0) {
        resetInput();
      } else {
        onExit?.();
      }
      evt.preventDefault();
      return;
    }

    // ── Enter (without shift) — submit from useKeyboard so closure stays fresh ──
    // The textarea's onSubmit prop is NOT updated by the React reconciler (TextareaRenderable
    // isn't wired in setProperty), so we handle submit here instead.
    if (focused && evt.name === "return" && !evt.shift && !evt.ctrl && !evt.meta) {
      handleSubmit(valueRef.current);
      evt.preventDefault();
      return;
    }

    // ── Ctrl+E — toggle expand/collapse paste blocks ──
    if (focused && evt.name === "e" && evt.ctrl) {
      const blocks = pasteBlocks.current;
      if (blocks.length > 0) {
        const currentText = textareaRef.current?.plainText ?? "";
        let newText = currentText;
        for (const block of blocks) {
          const pastedLines = block.text.split("\n");
          const placeholder = `📋 [Pasted ${pastedLines.length} lines — ^E to expand]`;
          if (block.collapsed && newText.includes(placeholder)) {
            // Expand: replace placeholder with full text
            newText = newText.replace(placeholder, block.text);
            block.collapsed = false;
          } else if (!block.collapsed && newText.includes(block.text)) {
            // Collapse: replace full text with placeholder
            newText = newText.replace(block.text, placeholder);
            block.collapsed = true;
          }
        }
        if (newText !== currentText) {
          isNavigatingHistory.current = true;
          setValue(newText);
          textareaRef.current?.setText(newText);
          lineCountRef.current = (newText.match(/\n/g)?.length ?? 0) + 1;
          isNavigatingHistory.current = false;
        }
      }
      evt.preventDefault();
      return;
    }

    // ── Normal editing mode — textarea handles most keys natively ──
    if (!focused || hasMatches || fuzzyMode) return;

    const lineCount = lineCountRef.current;
    const curLine = cursorLineRef.current;

    // Up arrow — history: first press requires cursor on first line, subsequent presses always work
    if (evt.name === "up" && (historyIdx.current !== -1 || curLine === 0)) {
      const history = historyCacheRef.current;
      if (history.length === 0) return;
      if (historyIdx.current === -1) {
        historyStash.current = valueRef.current;
        historyIdx.current = 0;
      } else if (historyIdx.current < history.length - 1) {
        historyIdx.current += 1;
      } else {
        // Already at oldest entry — nothing to do
        evt.preventDefault();
        return;
      }
      const entry = history[historyIdx.current];
      if (entry != null) {
        isNavigatingHistory.current = true;
        setValue(entry);
        textareaRef.current?.setText(entry);
        lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
        cursorLineRef.current = 0;
        isNavigatingHistory.current = false;
      }
      evt.preventDefault();
      return;
    }

    // Down arrow — history: when navigating, always allow; otherwise only on last line
    if (evt.name === "down" && (historyIdx.current !== -1 || curLine >= lineCount - 1)) {
      if (historyIdx.current === -1) return;
      isNavigatingHistory.current = true;
      if (historyIdx.current === 0) {
        historyIdx.current = -1;
        const stashed = historyStash.current;
        setValue(stashed);
        textareaRef.current?.setText(stashed);
        lineCountRef.current = (stashed.match(/\n/g)?.length ?? 0) + 1;
        cursorLineRef.current = 0;
      } else {
        historyIdx.current -= 1;
        const entry = historyCacheRef.current[historyIdx.current];
        if (entry != null) {
          setValue(entry);
          textareaRef.current?.setText(entry);
          lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
          cursorLineRef.current = 0;
        }
      }
      isNavigatingHistory.current = false;
      evt.preventDefault();
      return;
    }
  });

  const fuzzyMaxVisible = Math.min(8, Math.max(3, Math.floor(termRows * 0.2)));

  const dropdownVisible = hasMatches || (fuzzyMode && fuzzyResults.length > 0);
  useEffect(() => {
    onDropdownChange?.(dropdownVisible);
    return () => onDropdownChange?.(false);
  }, [dropdownVisible, onDropdownChange]);

  useEffect(() => {
    if (!fuzzyMode || fuzzyResults.length === 0) return;
    const offset = fuzzyScrollOffset.current;
    if (fuzzyCursor < offset) {
      fuzzyScrollOffset.current = fuzzyCursor;
      fuzzyScrollRef.current?.scrollTo(fuzzyCursor);
    } else if (fuzzyCursor >= offset + fuzzyMaxVisible) {
      const newOffset = fuzzyCursor - fuzzyMaxVisible + 1;
      fuzzyScrollOffset.current = newOffset;
      fuzzyScrollRef.current?.scrollTo(newOffset);
    }
  }, [fuzzyCursor, fuzzyMode, fuzzyResults.length, fuzzyMaxVisible]);

  // ── Rendering ──

  // Max rows for the textarea before it scrolls internally
  const maxInputRows = Math.max(4, Math.floor(termRows * 0.4));

  // Border color per state
  const slashMode = value.startsWith("/") && focused;
  const borderColor = fuzzyMode
    ? "#FF8C00"
    : slashMode
      ? "#3a7bd5"
      : showBusy
        ? "#59122a"
        : focused
          ? "#FF0040"
          : "#333";

  const lines = value.split("\n");
  const isMultiline = lines.length > 1;

  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box flexDirection="column" width="100%" flexShrink={0}>
        {/* ── Autocomplete dropdown (floating overlay) ── */}
        {hasMatches && (
          <box position="absolute" bottom="100%" width="100%" zIndex={10}>
            <box
              flexDirection="column"
              borderStyle="rounded"
              border={true}
              borderColor="#3a7bd5"
              width="100%"
            >
              <box flexDirection="column" backgroundColor="#0d1520">
                <scrollbox ref={acScrollRef} height={Math.min(matches.length, maxVisible)}>
                  {matches.map((match, i) => {
                    const isSelected = i === selectedIdx;
                    return (
                      <box key={match.cmd} gap={1} paddingX={1} height={1} flexDirection="row">
                        <text fg={isSelected ? "#3a7bd5" : "#333"}>{isSelected ? "›" : " "}</text>
                        <text
                          fg={isSelected ? "#5a9bf5" : "#3a7bd5"}
                          attributes={isSelected ? TextAttributes.BOLD : undefined}
                        >
                          {match.cmd}
                        </text>
                        <text fg={isSelected ? "#666" : "#444"} truncate>
                          {match.desc}
                        </text>
                      </box>
                    );
                  })}
                </scrollbox>
                {matches.length > maxVisible && (
                  <box paddingX={1} height={1}>
                    <text fg="#444">
                      {selectedIdx + 1}/{String(matches.length)}
                    </text>
                  </box>
                )}
              </box>
            </box>
          </box>
        )}

        {/* ── Fuzzy history results (floating overlay) ── */}
        {fuzzyMode && fuzzyResults.length > 0 && (
          <box position="absolute" bottom="100%" width="100%" zIndex={10}>
            <box
              flexDirection="column"
              borderStyle="rounded"
              border={true}
              borderColor="#FF8C00"
              width="100%"
            >
              <box flexDirection="column" backgroundColor="#111">
                <box paddingX={1} height={1} flexDirection="row">
                  <text fg="#FF8C00" attributes={TextAttributes.BOLD}>
                    {icon("clock_alt")} history
                  </text>
                  <text fg="#555">
                    {"  "}
                    {String(fuzzyResults.length)} match{fuzzyResults.length === 1 ? "" : "es"}
                  </text>
                </box>
                <scrollbox
                  ref={fuzzyScrollRef}
                  height={Math.min(fuzzyResults.length, fuzzyMaxVisible)}
                >
                  {fuzzyResults.map((result, i) => {
                    const isSelected = i === fuzzyCursor;
                    const maxChars = Math.max(20, termWidth - 8);
                    const displayText = (result.entry.split("\n")[0] ?? "").slice(0, maxChars);
                    const displayMatch = fuzzyQuery
                      ? fuzzyFilter(fuzzyQuery, [displayText], 1)[0]
                      : null;
                    return (
                      <box
                        key={`${result.entry.slice(0, 40)}-${String(i)}`}
                        paddingX={1}
                        height={Math.min(maxInputRows, Math.max(1, visualLines))}
                        flexDirection="row"
                      >
                        <text fg={isSelected ? "#FF0040" : "#333"}>{isSelected ? "› " : "  "}</text>
                        {displayMatch ? (
                          <HighlightedText text={displayText} indices={displayMatch.indices} />
                        ) : (
                          <text fg={isSelected ? "#fff" : "#ccc"} truncate>
                            {displayText}
                          </text>
                        )}
                      </box>
                    );
                  })}
                </scrollbox>
              </box>
            </box>
          </box>
        )}

        {/* ── Bordered input area ── */}
        <box
          ref={containerRef}
          flexDirection="column"
          width="100%"
          borderStyle="rounded"
          border={true}
          borderColor={borderColor}
          paddingX={1}
        >
          {showBusy && !showAutocomplete ? (
            <box
              flexDirection="row"
              alignItems="center"
              width="100%"
              justifyContent="space-between"
            >
              <box flexGrow={1} flexDirection="row">
                <text fg="#FF0040" attributes={TextAttributes.BOLD} flexShrink={0}>
                  {">"}{" "}
                </text>
                <textarea
                  ref={textareaRef}
                  initialValue={value}
                  onContentChange={handleContentChange}
                  onCursorChange={handleCursorChange}
                  keyBindings={INPUT_KEY_BINDINGS}
                  placeholder="'/' for commands · or interrupt by sending a new message"
                  placeholderColor="#555"
                  focused={focused}
                  wrapMode="char"
                  height={1}
                  flexGrow={1}
                  backgroundColor="transparent"
                  textColor="#ccc"
                />
              </box>
              <text fg="#555"> ^X stop</text>
            </box>
          ) : fuzzyMode ? (
            <box flexDirection="row">
              <text fg="#FF8C00" attributes={TextAttributes.BOLD}>
                {"search: "}
              </text>
              <text fg="#fff">{fuzzyQuery}</text>
              <text fg="#FF8C00">▌</text>
            </box>
          ) : (
            <box flexDirection="row" width="100%">
              <text fg="#FF0040" attributes={TextAttributes.BOLD} flexShrink={0}>
                {">"}{" "}
              </text>
              <textarea
                ref={textareaRef}
                initialValue={value}
                onContentChange={handleContentChange}
                onCursorChange={handleCursorChange}
                keyBindings={INPUT_KEY_BINDINGS}
                placeholder="speak to the forge..."
                placeholderColor="#555"
                focused={focused}
                wrapMode="char"
                height={Math.min(maxInputRows, Math.max(1, visualLines))}
                flexGrow={1}
                backgroundColor="transparent"
                textColor="#ccc"
              />
              {ghost ? (
                <text fg="#444" flexShrink={0}>
                  {ghost}
                </text>
              ) : null}
            </box>
          )}
        </box>

        {/* ── Hints bar ── */}
        {focused && !fuzzyMode && isMultiline && (
          <box paddingX={2} height={1}>
            <text fg="#333">
              <span fg="#444">S-⏎</span> newline <span fg="#444">^U</span> del line{" "}
              <span fg="#444">^K</span> cut to EOL
            </text>
          </box>
        )}
      </box>
    </box>
  );
});
