import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core";
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

interface CollapsedBlock {
  start: number;
  end: number;
  id: number;
}

function findBlock(blocks: CollapsedBlock[], line: number): CollapsedBlock | undefined {
  return blocks.find((b) => line >= b.start && line <= b.end);
}

function shiftBlocks(blocks: CollapsedBlock[], afterLine: number, delta: number): CollapsedBlock[] {
  return blocks.map((b) =>
    b.start > afterLine ? { ...b, start: b.start + delta, end: b.end + delta } : b,
  );
}

/** Wrap a string into visual rows of `width` characters. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    rows.push(text.slice(i, i + width));
  }
  return rows.length > 0 ? rows : [""];
}

/** Rendered visual rows for the entire multiline buffer with wrapping. */
interface VisualRow {
  text: string;
  lineIdx: number;
  wrapIdx: number;
  isLastWrap: boolean;
}

function buildVisualRows(lines: string[], width: number): VisualRow[] {
  const rows: VisualRow[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    const wrapped = wrapText(line, width);
    for (let wi = 0; wi < wrapped.length; wi++) {
      rows.push({
        text: wrapped[wi] ?? "",
        lineIdx: li,
        wrapIdx: wi,
        isLastWrap: wi === wrapped.length - 1,
      });
    }
  }
  return rows;
}

export function InputBox({
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
  const [inputKey, setInputKey] = useState(0);
  const renderer = useRenderer();
  const { height: termRows, width: termWidth } = useTerminalDimensions();
  const acScrollRef = useRef<ScrollBoxRenderable>(null);
  const inputRef = useRef<InputRenderable>(null);
  const containerRef = useRef<BoxRenderable>(null);
  const [cursorLine, setCursorLine] = useState(0);
  const [collapsedBlocks, setCollapsedBlocks] = useState<CollapsedBlock[]>([]);
  const pasteCounter = useRef(0);

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
    setValue(completed);
    setInputKey((k) => k + 1);
  }, [matches, selectedIdx]);

  const insertNewline = useCallback(() => {
    const currentLines = valueRef.current.split("\n");
    const block = findBlock(collapsedBlocks, cursorLine);
    if (block) {
      const updated = [...currentLines];
      updated.splice(block.start, 0, "");
      setValue(updated.join("\n"));
      setCollapsedBlocks(shiftBlocks(collapsedBlocks, cursorLine - 1, 1));
      setInputKey((k) => k + 1);
      return;
    }
    const line = currentLines[cursorLine] ?? "";
    const offset = inputRef.current?.cursorOffset ?? line.length;
    const before = line.slice(0, offset);
    const after = line.slice(offset);
    const updated = [...currentLines];
    updated.splice(cursorLine, 1, before, after);
    setValue(updated.join("\n"));
    setCollapsedBlocks(shiftBlocks(collapsedBlocks, cursorLine, 1));
    setCursorLine((prev) => prev + 1);
    setInputKey((k) => k + 1);
  }, [cursorLine, collapsedBlocks]);

  const handleBlockInput = useCallback(
    (typed: string) => {
      const block = findBlock(collapsedBlocks, cursorLine);
      if (!block) return;
      const currentLines = valueRef.current.split("\n");
      const updated = [...currentLines];
      updated.splice(block.start, 0, typed);
      setValue(updated.join("\n"));
      setCollapsedBlocks(shiftBlocks(collapsedBlocks, cursorLine - 1, 1));
      setInputKey((k) => k + 1);
    },
    [collapsedBlocks, cursorLine],
  );

  const handleChange = useCallback((newValue: string) => {
    historyIdx.current = -1;
    setValue(newValue);
  }, []);

  // Intercept paste — 3+ lines get collapsed on their own line, 1-2 lines paste inline
  useEffect(() => {
    const handler = (event: { text: string; preventDefault: () => void }) => {
      if (!isFocused) return;
      const text = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const pastedLines = text.split("\n");

      // 1-3 lines: let <input> handle it normally
      if (pastedLines.length <= 3) return;

      event.preventDefault();

      const currentLines = valueRef.current.split("\n");
      const activeLine = currentLines[cursorLine] ?? "";
      const cursor = inputRef.current?.cursorOffset ?? activeLine.length;
      const before = activeLine.slice(0, cursor);
      const after = activeLine.slice(cursor);

      // Keep existing text on its own line, pasted block always on a new line
      const hasTextBefore = before.length > 0;
      const insertAt = hasTextBefore ? cursorLine + 1 : cursorLine;
      const collapseStart = insertAt;
      const collapseEnd = collapseStart + pastedLines.length - 1;

      const newLines = [
        ...currentLines.slice(0, cursorLine),
        ...(hasTextBefore ? [before] : []),
        ...pastedLines,
        after || "", // trailing line for cursor
        ...currentLines.slice(cursorLine + 1),
      ];

      // Shift existing blocks that come after the insert point
      const linesAdded =
        pastedLines.length +
        (hasTextBefore ? 1 : 0) +
        (after || !currentLines[cursorLine + 1] ? 1 : 0) -
        1;
      const shifted = shiftBlocks(collapsedBlocks, cursorLine - 1, linesAdded);

      pasteCounter.current += 1;
      setValue(newLines.join("\n"));
      setCollapsedBlocks([
        ...shifted,
        { start: collapseStart, end: collapseEnd, id: pasteCounter.current },
      ]);
      setCursorLine(collapseEnd + 1);
      setInputKey((k) => k + 1);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [isFocused, cursorLine, renderer, collapsedBlocks]);

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
    setValue("");
    setCursorLine(0);
    setCollapsedBlocks([]);
    pasteCounter.current = 0;
    historyIdx.current = -1;
    setInputKey((k) => k + 1);
  }, []);

  const handleSubmit = (input: string) => {
    // Autocomplete match — complete or submit the command
    if (hasMatches && matches[selectedIdx]) {
      const completed = matches[selectedIdx].cmd;
      if (completed === "/open" || completed === "/branch") {
        setValue(`${completed} `);
        setInputKey((k) => k + 1);
      } else {
        pushHistory(completed);
        onSubmit(completed);
        resetInput();
      }
      return;
    }

    if (input.trim() === "") return;

    // During loading or compacting: slash commands execute immediately, messages queue
    if ((isLoading || isCompacting) && !input.trim().startsWith("/")) {
      onQueue?.(input.trim());
      resetInput();
      return;
    }

    pushHistory(input.trim());
    onSubmit(input.trim());
    resetInput();
  };

  // Compute available width for text content (inside padding, no border)
  // Read ref width as state so layout changes trigger re-render
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const measuredWidthRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure layout width when terminal resizes
  useEffect(() => {
    const w = containerRef.current?.width ?? 0;
    if (w > 0 && w !== measuredWidthRef.current) {
      measuredWidthRef.current = w;
      setMeasuredWidth(w);
    }
  }, [termWidth]);
  const contentWidth = useMemo(
    () => Math.max(10, measuredWidth > 0 ? measuredWidth - 6 : termWidth - 8),
    [measuredWidth, termWidth],
  );

  // Build visual rows for display
  const lines = useMemo(() => value.split("\n"), [value]);
  const isMultiline = lines.length > 1;
  const visualRows = useMemo(() => buildVisualRows(lines, contentWidth), [lines, contentWidth]);

  // Max rows for the input area before it scrolls
  const maxInputRows = Math.max(4, Math.floor(termRows * 0.4));

  // Find which visual row the active input sits on (last wrap of cursorLine)
  const activeVisualIdx = useMemo(() => {
    for (let i = visualRows.length - 1; i >= 0; i--) {
      if (visualRows[i]?.lineIdx === cursorLine && visualRows[i]?.isLastWrap) return i;
    }
    return visualRows.length - 1;
  }, [visualRows, cursorLine]);

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
          setValue(selected.entry);
          setCursorLine(0);
          setInputKey((k) => k + 1);
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

    // ── Shift+Left/Right — word skip ──
    if (focused && evt.shift && (evt.name === "left" || evt.name === "right")) {
      if (evt.name === "left") inputRef.current?.moveWordBackward();
      else inputRef.current?.moveWordForward();
      evt.preventDefault();
      return;
    }

    // ── Shift+Enter / Meta+Enter — insert newline ──
    // Terminals send linefeed (\n) for Shift+Enter, not return (\r)
    if (
      focused &&
      (evt.name === "linefeed" || (evt.name === "return" && (evt.shift || evt.meta)))
    ) {
      insertNewline();
      evt.preventDefault();
      return;
    }

    // ── Normal editing mode ──
    if (!focused || hasMatches || fuzzyMode) return;

    // Left/Right on collapsed block — move cursor before/after it
    const curBlock = findBlock(collapsedBlocks, cursorLine);
    if (curBlock && (evt.name === "right" || evt.name === "left")) {
      const target = evt.name === "right" ? curBlock.end + 1 : Math.max(0, curBlock.start - 1);
      const currentLines = valueRef.current.split("\n");
      if (target >= 0 && target < currentLines.length) {
        setCursorLine(target);
        setInputKey((k) => k + 1);
      }
      evt.preventDefault();
      return;
    }

    const currentLines = valueRef.current.split("\n");
    const multiline = currentLines.length > 1;

    // Ctrl+U — clear line (single-line: clear all; multiline: delete current line or collapsed block)
    if (evt.ctrl && evt.name === "u") {
      if (!multiline) {
        resetInput();
      } else if (findBlock(collapsedBlocks, cursorLine)) {
        const block = findBlock(collapsedBlocks, cursorLine) as CollapsedBlock;
        const count = block.end - block.start + 1;
        const updated = [...currentLines];
        updated.splice(block.start, count);
        if (updated.length === 0) {
          resetInput();
        } else {
          const newCursor = Math.min(block.start, updated.length - 1);
          setValue(updated.join("\n"));
          setCursorLine(newCursor);
          setCollapsedBlocks(
            collapsedBlocks
              .filter((b) => b !== block)
              .map((b) =>
                b.start > block.start ? { ...b, start: b.start - count, end: b.end - count } : b,
              ),
          );
          setInputKey((k) => k + 1);
        }
      } else {
        const updated = [...currentLines];
        updated.splice(cursorLine, 1);
        if (updated.length === 0) {
          resetInput();
        } else {
          const newCursor = Math.min(cursorLine, updated.length - 1);
          setValue(updated.join("\n"));
          setCursorLine(newCursor);
          setInputKey((k) => k + 1);
        }
      }
      evt.preventDefault();
      return;
    }

    // Ctrl+W — delete word backward
    if (evt.ctrl && evt.name === "w") {
      const curLine = currentLines[cursorLine] ?? "";
      const offset = inputRef.current?.cursorOffset ?? curLine.length;
      const before = curLine.slice(0, offset);
      const after = curLine.slice(offset);
      // Delete trailing spaces, then word chars
      const trimmed = before.replace(/\s+$/, "");
      const wordRemoved = trimmed.replace(/[^\s]+$/, "");
      const updated = [...currentLines];
      updated[cursorLine] = wordRemoved + after;
      setValue(updated.join("\n"));
      setInputKey((k) => k + 1);
      evt.preventDefault();
      return;
    }

    // Ctrl+A — move cursor to start of line
    if (evt.ctrl && evt.name === "a") {
      // Remount input to reset cursor to position 0
      setInputKey((k) => k + 1);
      evt.preventDefault();
      return;
    }

    // Ctrl+K — delete from cursor to end of line
    if (evt.ctrl && evt.name === "k") {
      const curLine = currentLines[cursorLine] ?? "";
      const offset = inputRef.current?.cursorOffset ?? curLine.length;
      const updated = [...currentLines];
      updated[cursorLine] = curLine.slice(0, offset);
      setValue(updated.join("\n"));
      setInputKey((k) => k + 1);
      evt.preventDefault();
      return;
    }

    // Up arrow — multiline cursor navigation
    if (evt.name === "up" && multiline && cursorLine > 0) {
      let target = cursorLine - 1;
      const hitBlock = findBlock(collapsedBlocks, target);
      if (hitBlock) {
        const onBlock = findBlock(collapsedBlocks, cursorLine);
        target = onBlock === hitBlock ? hitBlock.start - 1 : hitBlock.start;
      }
      if (target >= 0) {
        setCursorLine(target);
        setInputKey((k) => k + 1);
      }
      evt.preventDefault();
      return;
    }

    // Up arrow — single-line history navigation
    if (evt.name === "up" && !multiline) {
      const history = historyCacheRef.current;
      if (history.length === 0) return;
      if (historyIdx.current === -1) {
        historyStash.current = valueRef.current;
        historyIdx.current = 0;
      } else if (historyIdx.current < history.length - 1) {
        historyIdx.current += 1;
      }
      const entry = history[historyIdx.current];
      if (entry != null) {
        setValue(entry);
        setCursorLine(0);
        setInputKey((k) => k + 1);
      }
      evt.preventDefault();
      return;
    }

    // Down arrow — multiline cursor navigation
    if (evt.name === "down" && multiline && cursorLine < currentLines.length - 1) {
      let target = cursorLine + 1;
      const hitBlock = findBlock(collapsedBlocks, target);
      if (hitBlock) {
        const onBlock = findBlock(collapsedBlocks, cursorLine);
        target = onBlock === hitBlock ? hitBlock.end + 1 : hitBlock.start;
      }
      if (target < currentLines.length) {
        setCursorLine(target);
        setInputKey((k) => k + 1);
      }
      evt.preventDefault();
      return;
    }

    // Down arrow — single-line history navigation
    if (evt.name === "down" && !multiline) {
      if (historyIdx.current === -1) return;
      if (historyIdx.current === 0) {
        historyIdx.current = -1;
        setValue(historyStash.current);
        setCursorLine(0);
        setInputKey((k) => k + 1);
      } else {
        historyIdx.current -= 1;
        const entry = historyCacheRef.current[historyIdx.current];
        if (entry != null) {
          setValue(entry);
          setCursorLine(0);
          setInputKey((k) => k + 1);
        }
      }
      evt.preventDefault();
      return;
    }

    // Backspace — delete collapsed block or merge with previous line
    if (evt.name === "backspace" && multiline) {
      const deleteBlock = (block: CollapsedBlock) => {
        const count = block.end - block.start + 1;
        const updated = [...currentLines];
        updated.splice(block.start, count);
        if (updated.length === 0) {
          resetInput();
        } else {
          const newCursor = Math.min(block.start, updated.length - 1);
          setValue(updated.join("\n"));
          setCursorLine(newCursor);
          setCollapsedBlocks(
            collapsedBlocks
              .filter((b) => b !== block)
              .map((b) =>
                b.start > block.start ? { ...b, start: b.start - count, end: b.end - count } : b,
              ),
          );
          setInputKey((k) => k + 1);
        }
        evt.preventDefault();
      };
      // Cursor is on a collapsed block → delete it
      const onBlock = findBlock(collapsedBlocks, cursorLine);
      if (onBlock) {
        deleteBlock(onBlock);
        return;
      }
      // Backspacing from line after a collapsed block → delete it
      const aboveBlock = findBlock(collapsedBlocks, cursorLine - 1);
      if (aboveBlock && aboveBlock.end === cursorLine - 1) {
        const atStart = !inputRef.current || inputRef.current.cursorOffset === 0;
        if (atStart) {
          deleteBlock(aboveBlock);
          return;
        }
      }
      // Normal: merge with previous line at start of line
      if (cursorLine > 0) {
        const atStart = !inputRef.current || inputRef.current.cursorOffset === 0;
        if (atStart) {
          const prevLine = currentLines[cursorLine - 1] ?? "";
          const curLine = currentLines[cursorLine] ?? "";
          const updated = [...currentLines];
          updated[cursorLine - 1] = prevLine + curLine;
          updated.splice(cursorLine, 1);
          setValue(updated.join("\n"));
          setCursorLine((prev) => prev - 1);
          setInputKey((k) => k + 1);
          evt.preventDefault();
          return;
        }
      }
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
                        height={1}
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
              <box flexGrow={1}>
                <input
                  ref={inputRef}
                  key={inputKey}
                  value={value}
                  onInput={handleChange}
                  onSubmit={() => handleSubmit(value)}
                  placeholder="'/' for commands · or interrupt by sending a new messages"
                  placeholderColor="#555"
                  focused={focused}
                  scrollMargin={0.01}
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
            <InputEditor
              visualRows={visualRows}
              lines={lines}
              cursorLine={cursorLine}
              activeVisualIdx={activeVisualIdx}
              maxInputRows={maxInputRows}
              inputRef={inputRef}
              inputKey={inputKey}
              value={value}
              ghost={ghost}
              focused={focused}
              collapsedBlocks={collapsedBlocks}
              handleChange={handleChange}
              handleBlockInput={handleBlockInput}
              handleSubmit={handleSubmit}
            />
          )}
        </box>

        {/* ── Hints bar ── */}
        {focused && !fuzzyMode && isMultiline && (
          <box paddingX={2} height={1}>
            <text fg="#333">
              <span fg="#444">^U</span> del <span fg="#444">^K</span> cut <span fg="#444">S-⏎</span>{" "}
              newline
              {collapsedBlocks.length > 0 ? (
                <>
                  {" "}
                  <span fg="#444">BS</span> rm paste
                </>
              ) : null}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

/** The actual text editor area — handles all 3 cases: single, wrapped, multiline */
const InputEditor = memo(function InputEditor({
  visualRows,
  lines,
  cursorLine,
  activeVisualIdx,
  maxInputRows,
  inputRef,
  inputKey,
  value,
  ghost,
  focused,
  collapsedBlocks,
  handleChange,
  handleBlockInput,
  handleSubmit,
}: {
  visualRows: VisualRow[];
  lines: string[];
  cursorLine: number;
  activeVisualIdx: number;
  maxInputRows: number;
  inputRef: React.RefObject<InputRenderable | null>;
  inputKey: number;
  value: string;
  ghost: string;
  focused: boolean;
  collapsedBlocks: CollapsedBlock[];
  handleChange: (v: string) => void;
  handleBlockInput: (typed: string) => void;
  handleSubmit: (v: string) => void;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const activeRenderedRef = useRef(0);
  const renderedCountRef = useRef(0);
  const isSingleRow = visualRows.length === 1 && lines.length === 1;

  // Keep active row visible in scrollbox
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active row change
  useEffect(() => {
    if (renderedCountRef.current <= maxInputRows) return;
    scrollRef.current?.scrollTo(activeRenderedRef.current);
  }, [activeVisualIdx, maxInputRows]);

  // Simple single-line (most common case — optimized path)
  if (isSingleRow) {
    return (
      <box flexDirection="row" width="100%">
        <text fg="#FF0040" attributes={TextAttributes.BOLD} flexShrink={0}>
          {">"}{" "}
        </text>
        <input
          ref={inputRef}
          key={inputKey}
          value={value}
          onInput={handleChange}
          onSubmit={() => handleSubmit(value)}
          placeholder="speak to the forge..."
          placeholderColor="#555"
          focused={focused}
          flexGrow={1}
          scrollMargin={0.01}
        />
        {ghost ? (
          <text fg="#444" flexShrink={0}>
            {ghost}
          </text>
        ) : null}
      </box>
    );
  }

  // Build rendered rows array, tracking active row's rendered index
  // biome-ignore lint/suspicious/noExplicitAny: JSX elements from map
  const renderedRows: any[] = [];
  const renderedBlockIds = new Set<number>();

  for (let vi = 0; vi < visualRows.length; vi++) {
    const row = visualRows[vi] as VisualRow;

    // Check if this row belongs to a collapsed block
    const block = findBlock(collapsedBlocks, row.lineIdx);
    if (block) {
      if (!renderedBlockIds.has(block.id)) {
        renderedBlockIds.add(block.id);
        const firstLine = lines[block.start] ?? "";
        const count = block.end - block.start + 1;
        const isOnBlock = cursorLine >= block.start && cursorLine <= block.end;
        if (isOnBlock) activeRenderedRef.current = renderedRows.length;
        const preview = firstLine.length > 40 ? `${firstLine.slice(0, 37)}…` : firstLine;
        const blockIdx = collapsedBlocks.indexOf(block) + 1;
        const label = `clipboard [${String(blockIdx)}] `;
        const suffix = ` +${String(count)} line${count === 1 ? "" : "s"}`;
        renderedRows.push(
          <box key={vi} flexDirection="row" width="100%">
            <text
              fg={isOnBlock ? "#FF0040" : "#555"}
              attributes={isOnBlock ? TextAttributes.BOLD : undefined}
              flexShrink={0}
            >
              {isOnBlock ? "› " : "… "}
            </text>
            {isOnBlock ? (
              <input
                ref={inputRef}
                key={inputKey}
                value=""
                onInput={handleBlockInput}
                onSubmit={() => handleSubmit(value)}
                focused={focused}
                flexShrink={0}
              />
            ) : null}
            <text fg="#6A0DAD" flexShrink={0}>
              {label}
            </text>
            <text fg={isOnBlock ? "#fff" : "#666"} flexShrink={1}>
              {preview}
            </text>
            <text fg="#555" flexShrink={0}>
              {suffix}
            </text>
          </box>,
        );
      }
      continue;
    }

    const isFirstRow = renderedRows.length === 0;
    const isActiveRow = vi === activeVisualIdx;
    if (isActiveRow) activeRenderedRef.current = renderedRows.length;
    const prefix = isFirstRow ? ">" : "…";
    const prefixColor = isFirstRow ? "#FF0040" : "#555";
    const prefixAttrs = isFirstRow ? TextAttributes.BOLD : undefined;

    if (isActiveRow) {
      const activeLine = lines[cursorLine] ?? "";
      const wrapOffset = row.wrapIdx;
      const charsBeforeThisWrap = visualRows
        .filter((r) => r.lineIdx === cursorLine && r.wrapIdx < wrapOffset)
        .reduce((sum, r) => sum + r.text.length, 0);

      renderedRows.push(
        <box key={vi} flexDirection="row" width="100%">
          <text fg={prefixColor} attributes={prefixAttrs} flexShrink={0}>
            {prefix}{" "}
          </text>
          <input
            ref={inputRef}
            key={inputKey}
            value={row.isLastWrap ? activeLine.slice(charsBeforeThisWrap) : row.text}
            scrollMargin={0.01}
            onInput={
              row.isLastWrap && lines.length === 1
                ? (newVal: string) => {
                    handleChange(activeLine.slice(0, charsBeforeThisWrap) + newVal);
                  }
                : row.isLastWrap
                  ? (newVal: string) => {
                      const updated = [...lines];
                      updated[cursorLine] = activeLine.slice(0, charsBeforeThisWrap) + newVal;
                      handleChange(updated.join("\n"));
                    }
                  : handleChange
            }
            onSubmit={() => handleSubmit(value)}
            focused={focused}
            flexGrow={1}
          />
        </box>,
      );
    } else {
      renderedRows.push(
        <box key={vi} flexDirection="row" width="100%">
          <text fg={prefixColor} attributes={prefixAttrs} flexShrink={0}>
            {prefix}{" "}
          </text>
          <text fg="#ccc">{row.text || " "}</text>
        </box>,
      );
    }
  }

  renderedCountRef.current = renderedRows.length;

  if (renderedRows.length > maxInputRows) {
    return (
      <scrollbox ref={scrollRef} height={maxInputRows}>
        {renderedRows}
      </scrollbox>
    );
  }

  return <box flexDirection="column">{renderedRows}</box>;
});
