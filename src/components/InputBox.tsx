import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { SPINNER_FRAMES_FILLED as SPINNER_FRAMES } from "./shared.js";

interface Props {
  onSubmit: (value: string) => void;
  isLoading: boolean;
  isFocused?: boolean;
  onQueue?: (msg: string) => void;
  queueCount?: number;
}

const MAX_HISTORY = 100;

const COMMANDS = [
  { cmd: "/help", icon: "\uF059", desc: "Show available commands" },
  { cmd: "/clear", icon: "\uF01B4", desc: "Clear chat history" },
  { cmd: "/editor", icon: "\uF044", desc: "Toggle editor panel" },
  { cmd: "/open", icon: "\uF07C", desc: "Open file in editor" },
  { cmd: "/skills", icon: "\uDB82\uDD2A", desc: "Browse & install skills" },
  { cmd: "/sessions", icon: "\uF017", desc: "Browse & restore sessions" },
  { cmd: "/errors", icon: "\uF06A", desc: "Browse error log" },
  { cmd: "/commit", icon: "󰊢", desc: "AI-assisted git commit" },
  { cmd: "/diff", icon: "󰊢", desc: "Open diff in editor" },
  { cmd: "/status", icon: "󰊢", desc: "Git status" },
  { cmd: "/branch", icon: "󰊢", desc: "Show/create branch" },
  { cmd: "/init", icon: "󰊢", desc: "Initialize git repo" },
  { cmd: "/summarize", icon: "\uF066", desc: "Compress conversation" },
  { cmd: "/context", icon: "\uF1C0", desc: "Show/clear context budget" },
  { cmd: "/chat-style", icon: "󰗀", desc: "Toggle chat layout style" },
  { cmd: "/mode", icon: "\uF013", desc: "Switch forge mode" },
  { cmd: "/plan", icon: "\uF0CB", desc: "Toggle plan mode (research & plan only)" },
  { cmd: "/plan-panel", icon: "\uF0CB", desc: "Toggle plan sidebar panel" },
  { cmd: "/continue", icon: "\uF04E", desc: "Continue interrupted generation" },
  { cmd: "/git", icon: "󰊢", desc: "Git menu" },
  { cmd: "/lazygit", icon: "󰊢", desc: "Launch lazygit" },
  { cmd: "/proxy", icon: "󰌆", desc: "Proxy status" },
  { cmd: "/proxy login", icon: "󰌆", desc: "Authenticate with Claude" },
  { cmd: "/proxy install", icon: "󰌆", desc: "Install CLIProxyAPI" },
  { cmd: "/push", icon: "󰊢", desc: "Push to remote" },
  { cmd: "/pull", icon: "󰊢", desc: "Pull from remote" },
  { cmd: "/stash", icon: "󰊢", desc: "Stash changes" },
  { cmd: "/log", icon: "󰊢", desc: "Show recent commits" },
  { cmd: "/editor-settings", icon: "\uF013", desc: "Toggle editor/LSP integrations" },
  { cmd: "/router", icon: "󰓹", desc: "Assign models per task type" },
  { cmd: "/privacy", icon: "\uF023", desc: "Manage forbidden file patterns" },
  { cmd: "/setup", icon: "󰊠", desc: "Check & install prerequisites" },
  { cmd: "/font", icon: "", desc: "Show/set terminal font" },
  { cmd: "/nvim-config", icon: "\uF044", desc: "Switch neovim config mode" },
  { cmd: "/co-author-commits", icon: "󰊢", desc: "Toggle co-author trailer" },
  { cmd: "/stash pop", icon: "󰊢", desc: "Pop latest stash" },
  { cmd: "/quit", icon: "\uF08B", desc: "Exit SoulForge" },
];

function CtrlGuard({
  flagRef,
  isActive,
}: {
  flagRef: React.RefObject<boolean>;
  isActive: boolean;
}) {
  useInput(
    (_input, key) => {
      if (key.ctrl) {
        flagRef.current = true;
      }
    },
    { isActive },
  );
  return null;
}

export function InputBox({ onSubmit, isLoading, isFocused, onQueue, queueCount }: Props) {
  const [value, setValue] = useState("");
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const skipNextChange = useRef(false);
  // Incrementing key forces TextInput remount → cursor resets to end of value
  const [inputKey, setInputKey] = useState(0);

  // ─── History ───
  const historyRef = useRef<string[]>([]);
  // -1 = not browsing history, 0 = most recent, etc.
  const historyIdx = useRef(-1);
  // Stash the in-progress input when entering history mode
  const historyStash = useRef("");

  const focused = isFocused ?? true;

  // Filter commands based on current input
  const showAutocomplete = value.startsWith("/") && !isLoading && focused;
  const query = value.toLowerCase();
  const matches = showAutocomplete ? COMMANDS.filter((c) => c.cmd.startsWith(query)) : [];
  const hasMatches = matches.length > 0 && value !== matches[0]?.cmd;

  // Ghost text: the completion hint shown inline after the cursor
  const ghost =
    hasMatches && matches[selectedIdx] ? matches[selectedIdx].cmd.slice(value.length) : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when input changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [value]);

  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [isLoading]);

  useEffect(() => {
    skipNextChange.current = false;
  });

  // Accept the current autocomplete suggestion, resetting cursor to end
  const acceptCompletion = useCallback(() => {
    const completed = matches[selectedIdx]?.cmd;
    if (!completed) return;
    setValue(completed);
    // Remount TextInput so its internal cursor resets to end of new value
    setInputKey((k) => k + 1);
  }, [matches, selectedIdx]);

  // Handle autocomplete navigation
  useInput(
    (_input, key) => {
      if (!hasMatches) return;

      if (key.downArrow) {
        setSelectedIdx((prev) => (prev + 1) % matches.length);
        return;
      }
      if (key.upArrow) {
        setSelectedIdx((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
        return;
      }
      // Tab or Right arrow: accept inline ghost completion
      if ((key.tab || key.rightArrow) && ghost) {
        acceptCompletion();
      }
    },
    { isActive: hasMatches },
  );

  // History navigation (only when autocomplete is NOT showing)
  useInput(
    (_input, key) => {
      const history = historyRef.current;
      if (history.length === 0) return;

      if (key.upArrow) {
        if (historyIdx.current === -1) {
          historyStash.current = value;
          historyIdx.current = 0;
        } else if (historyIdx.current < history.length - 1) {
          historyIdx.current += 1;
        }
        const entry = history[historyIdx.current];
        if (entry != null) {
          setValue(entry);
          setInputKey((k) => k + 1);
        }
        return;
      }

      if (key.downArrow) {
        if (historyIdx.current <= 0) {
          historyIdx.current = -1;
          setValue(historyStash.current);
          setInputKey((k) => k + 1);
        } else {
          historyIdx.current -= 1;
          const entry = history[historyIdx.current];
          if (entry != null) {
            setValue(entry);
            setInputKey((k) => k + 1);
          }
        }
      }
    },
    { isActive: focused && !isLoading && !hasMatches },
  );

  // Ctrl+U clears the input line
  useInput(
    (input, key) => {
      if (key.ctrl && input === "u") {
        setValue("");
        historyIdx.current = -1;
      }
    },
    { isActive: focused && !isLoading },
  );

  const handleChange = useCallback((newValue: string) => {
    if (skipNextChange.current) {
      skipNextChange.current = false;
      return;
    }
    // Reset history browsing when user types
    historyIdx.current = -1;
    setValue(newValue);
  }, []);

  const pushHistory = useCallback((input: string) => {
    const history = historyRef.current;
    // Deduplicate: remove if same as most recent
    if (history[0] === input) return;
    history.unshift(input);
    if (history.length > MAX_HISTORY) history.pop();
  }, []);

  const handleSubmit = (input: string) => {
    // During loading, queue the message instead
    if (isLoading) {
      if (input.trim() === "") return;
      onQueue?.(input.trim());
      setValue("");
      return;
    }

    // If autocomplete is showing and user hits enter, complete the command
    if (hasMatches && matches[selectedIdx]) {
      const completed = matches[selectedIdx].cmd;
      // If command takes args (like /open), add a space
      if (completed === "/open" || completed === "/branch") {
        setValue(`${completed} `);
      } else {
        pushHistory(completed);
        onSubmit(completed);
        setValue("");
      }
      historyIdx.current = -1;
      return;
    }

    if (input.trim() === "") return;
    pushHistory(input.trim());
    onSubmit(input.trim());
    setValue("");
    historyIdx.current = -1;
  };

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {/* Autocomplete dropdown — renders above input */}
      {hasMatches && (
        <Box flexDirection="column" marginBottom={0}>
          <Box paddingX={1} height={1}>
            <Text color="#333">{"─".repeat(40)}</Text>
          </Box>
          {matches.map((match, i) => {
            const isSelected = i === selectedIdx;
            return (
              <Box key={match.cmd} gap={1} paddingX={1}>
                <Text color={isSelected ? "#FF0040" : "#333"}>{isSelected ? "›" : " "}</Text>
                <Text color={isSelected ? "#FF0040" : "#9B30FF"} bold={isSelected}>
                  {match.cmd}
                </Text>
                <Text color={isSelected ? "#666" : "#444"}>{match.desc}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Input */}
      <Box
        borderStyle="round"
        borderColor={focused ? "#6A0DAD" : "#333"}
        paddingX={1}
        flexDirection="row"
        alignItems="center"
        width="100%"
      >
        {isLoading ? (
          <Box flexDirection="row" alignItems="center" width="100%" justifyContent="space-between">
            <Box gap={0}>
              <Text color="#FF0040" bold>
                {SPINNER_FRAMES[spinnerIdx]}
              </Text>
              <Text color="#666"> forging...</Text>
              {queueCount != null && queueCount > 0 && (
                <Text color="#555"> ({String(queueCount)} queued)</Text>
              )}
            </Box>
            <Box flexGrow={1} marginLeft={1}>
              <CtrlGuard flagRef={skipNextChange} isActive={focused} />
              <TextInput
                key={inputKey}
                value={value}
                onChange={handleChange}
                onSubmit={handleSubmit}
                placeholder="queue a message..."
                focus={focused}
              />
            </Box>
            <Text color="#555"> ^X stop</Text>
          </Box>
        ) : (
          <>
            <Text color="#FF0040" bold>
              {">"}{" "}
            </Text>
            <CtrlGuard flagRef={skipNextChange} isActive={focused} />
            <TextInput
              key={inputKey}
              value={value}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder="speak to the forge..."
              focus={focused}
            />
            {ghost ? <Text color="#444">{ghost}</Text> : null}
          </>
        )}
      </Box>
    </Box>
  );
}
