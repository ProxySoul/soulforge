import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { decodePasteBytes, type PasteEvent, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCommandDefs } from "../../core/commands/registry.js";
import { HistoryDB } from "../../core/history/db.js";
import { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "../../core/history/fuzzy.js";
import { icon } from "../../core/icons.js";

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

let _commands: Array<{ cmd: string; icon: string; desc: string }> | null = null;
function getCommands() {
  if (!_commands) {
    _commands = getCommandDefs()
      .filter((c) => !c.hidden)
      .map((c) => ({ cmd: c.cmd, icon: icon(c.ic), desc: c.desc }));
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
  // Snapshot visual row at end of each key event — used to gate history on NEXT keypress
  const preKeyVisualRow = useRef(0);
  // Track logical cursor line
  const cursorLineRef = useRef(0);
  const lineCountRef = useRef(1);
  // Guard: when true, handleContentChange skips historyIdx reset (programmatic setText)
  const isNavigatingHistory = useRef(false);
  const pendingCursorEnd = useRef(false);
  // Visual line count (after char-wrapping) for textarea height
  const [visualLines, setVisualLines] = useState(1);
  // Paste blocks: collapsed pasted text regions
  const pasteBlocks = useRef<
    Array<{ id: number; text: string; collapsed: boolean; placeholder: string }>
  >([]);
  const pasteIdCounter = useRef(0);

  const showBusy = isLoading || isCompacting;

  // textarea width = terminal - border(2) - paddingX(2) - prompt(2) = termWidth - 6
  // When busy hint is shown, subtract its width too
  const hintWidth = showBusy ? 8 : 0; // " ^X stop" = 8 chars
  const textareaWidth = Math.max(10, termWidth - 6 - hintWidth);

  // Calculate visual lines manually (virtualLineCount is viewport-constrained — chicken-and-egg)
  const calcVisualLines = useCallback(
    (text: string) => {
      let n = 0;
      for (const line of text.split("\n")) {
        n += line.length === 0 ? 1 : Math.ceil(line.length / textareaWidth);
      }
      return n;
    },
    [textareaWidth],
  );

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
          finalInput = finalInput.replace(block.placeholder, block.text);
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
    if (isNavigatingHistory.current) {
      isNavigatingHistory.current = false;
    } else {
      historyIdx.current = -1;
    }
    setValue(text);
    lineCountRef.current = textareaRef.current?.lineCount ?? 1;
    setVisualLines(calcVisualLines(text));
  }, [calcVisualLines]);

  // Track cursor line for history gating
  const handleCursorChange = useCallback((event: { line: number; visualColumn: number }) => {
    cursorLineRef.current = event.line;
  }, []);

  // After fuzzy history selection, the textarea remounts — move cursor to end
  useEffect(() => {
    if (!fuzzyMode && pendingCursorEnd.current) {
      pendingCursorEnd.current = false;
      const t = setTimeout(() => {
        textareaRef.current?.gotoBufferEnd();
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [fuzzyMode]);

  // Recalculate visual lines on terminal width/busy change
  useEffect(() => {
    setVisualLines(calcVisualLines(valueRef.current));
  }, [calcVisualLines]);

  // Intercept paste — 4+ lines get collapsed inline
  useEffect(() => {
    const handler = (event: PasteEvent) => {
      if (!isFocused) return;
      const text = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const pastedLines = text.split("\n");

      // 1-3 lines: let textarea handle normally
      if (pastedLines.length <= 3) return;

      // 4+ lines: collapse into inline placeholder with preview
      event.preventDefault();
      const id = ++pasteIdCounter.current;
      const firstLine = (pastedLines[0] ?? "").trim();
      const preview = firstLine.length > 30 ? `${firstLine.slice(0, 30)}...` : firstLine;
      const placeholder = `<pasted (${preview} +${pastedLines.length} lines)>`;
      pasteBlocks.current.push({ id, text, collapsed: true, placeholder });
      textareaRef.current?.insertText(placeholder);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [isFocused, renderer]);

  useKeyboard((evt) => {
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

    if (focused) {
      if (evt.ctrl && evt.name === "r") {
        setFuzzyMode((prev) => !prev);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
    }

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
          pendingCursorEnd.current = true;
          lineCountRef.current = (selected.entry.match(/\n/g)?.length ?? 0) + 1;
          cursorLineRef.current = 0;
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

    if (focused && evt.ctrl && evt.name === "c") {
      if (valueRef.current.length > 0) {
        resetInput();
      } else {
        onExit?.();
      }
      evt.preventDefault();
      return;
    }

    // The textarea's onSubmit prop is NOT updated by the React reconciler (TextareaRenderable
    // isn't wired in setProperty), so we handle submit here instead.
    if (focused && evt.name === "return" && !evt.shift && !evt.ctrl && !evt.meta) {
      handleSubmit(valueRef.current);
      evt.preventDefault();
      return;
    }

    if (!focused || hasMatches || fuzzyMode) return;

    // Up arrow — history: only when cursor is on the first visual row (works for both normal + history)
    if (evt.name === "up" && preKeyVisualRow.current === 0) {
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
        textareaRef.current?.gotoBufferEnd();
        lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
      }
      evt.preventDefault();
      return;
    }

    // Down arrow — history: only when cursor is on the last visual row
    const totalVisualRows = calcVisualLines(valueRef.current);
    if (evt.name === "down" && preKeyVisualRow.current >= totalVisualRows - 1) {
      if (historyIdx.current === -1) return;
      isNavigatingHistory.current = true;
      if (historyIdx.current === 0) {
        historyIdx.current = -1;
        const stashed = historyStash.current;
        setValue(stashed);
        textareaRef.current?.setText(stashed);
        textareaRef.current?.gotoBufferEnd();
        lineCountRef.current = (stashed.match(/\n/g)?.length ?? 0) + 1;
      } else {
        historyIdx.current -= 1;
        const entry = historyCacheRef.current[historyIdx.current];
        if (entry != null) {
          setValue(entry);
          textareaRef.current?.setText(entry);
          textareaRef.current?.gotoBufferEnd();
          lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
        }
      }
      evt.preventDefault();
      return;
    }

    // Snapshot document-absolute visual row for next keypress gating
    preKeyVisualRow.current =
      (textareaRef.current?.visualCursor?.visualRow ?? 0) + (textareaRef.current?.scrollY ?? 0);
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
          {fuzzyMode ? (
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
                placeholder={
                  showBusy && !showAutocomplete
                    ? "'/' for commands · or steer by sending a new message"
                    : "speak to the forge..."
                }
                placeholderColor="#555"
                focused={focused}
                wrapMode="char"
                width={textareaWidth}
                height={Math.min(maxInputRows, Math.max(1, visualLines))}
                flexShrink={0}
                backgroundColor="transparent"
                textColor="#ccc"
              />
              {showBusy && !showAutocomplete ? (
                <text fg="#555" flexShrink={0}>
                  {" ^X stop"}
                </text>
              ) : ghost ? (
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
              <span fg="#444">S-⏎</span> newline <span fg="#444">^U</span> del line
            </text>
          </box>
        )}
      </box>
    </box>
  );
});
