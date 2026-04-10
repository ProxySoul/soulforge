import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { icon } from "../core/icons.js";
import { useTheme } from "../core/theme/index.js";
import type { ThemeTokens } from "../core/theme/tokens.js";
import type { PendingQuestion } from "../types/index.js";
import { Markdown } from "./chat/Markdown.js";
import { PopupFooterHints } from "./layout/shared.js";

interface Props {
  question: PendingQuestion;
  isActive: boolean;
  onAnswer?: (answer: string) => void;
}

const OTHER_IDX = -1;

function OptionRow({
  label,
  isSelected,
  t,
}: {
  label: string;
  isSelected: boolean;
  t: ThemeTokens;
}) {
  return (
    <text>
      <span fg={isSelected ? t.brand : t.textMuted}>{isSelected ? " › " : "   "}</span>
      <span
        fg={isSelected ? t.textPrimary : t.textSecondary}
        attributes={isSelected ? TextAttributes.BOLD : undefined}
      >
        {label}
      </span>
    </text>
  );
}

export function QuestionPrompt({ question, isActive, onAnswer }: Props) {
  const t = useTheme();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [typing, setTyping] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const showOther = !question.hideOther;
  const totalOptions = question.options.length + (showOther ? 1 : 0);

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!isActive) return;

    if (typing) {
      if (evt.name === "escape") {
        setTyping(false);
        evt.stopPropagation();
      }
      return;
    }

    if (evt.name === "up" || evt.name === "left") {
      if (totalOptions <= 1) return;
      setSelectedIdx((prev) => {
        const cur = prev === OTHER_IDX ? totalOptions - 1 : prev;
        const next = cur > 0 ? cur - 1 : totalOptions - 1;
        return showOther && next === totalOptions - 1 ? OTHER_IDX : next;
      });
      evt.stopPropagation();
      return;
    }
    if (evt.name === "down" || evt.name === "right") {
      if (totalOptions <= 1) return;
      setSelectedIdx((prev) => {
        const cur = prev === OTHER_IDX ? totalOptions - 1 : prev;
        const next = (cur + 1) % totalOptions;
        return showOther && next === totalOptions - 1 ? OTHER_IDX : next;
      });
      evt.stopPropagation();
      return;
    }
    if (evt.name === "return") {
      evt.stopPropagation();
      if (selectedIdx === OTHER_IDX) {
        setTyping(true);
        setInputValue("");
        return;
      }
      const selected = question.options[selectedIdx];
      if (selected) {
        onAnswer?.(selected.label);
        question.resolve(selected.value);
      }
      return;
    }
    if (evt.name === "escape" && question.allowSkip) {
      question.resolve("__skipped__");
      evt.stopPropagation();
    }
  };

  useKeyboard(handleKeyboard);

  const handleInputSubmit = () => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onAnswer?.(trimmed);
      question.resolve(trimmed);
    }
  };

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={t.brand}
      paddingX={1}
      width="100%"
    >
      <box>
        <text fg={t.brand} attributes={TextAttributes.BOLD}>
          {icon("question")} Question
        </text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <Markdown text={question.question} />
      </box>
      {typing ? (
        <box flexDirection="row" gap={1} backgroundColor={t.bgInput} paddingX={1}>
          <text fg={t.brand}>{" ›"}</text>
          <input
            value={inputValue}
            onInput={setInputValue}
            onSubmit={handleInputSubmit}
            focused={isActive}
            flexGrow={1}
            placeholder="type your answer..."
          />
        </box>
      ) : (
        <box flexDirection="column">
          {question.options.map((opt, i) => (
            <OptionRow key={opt.value} label={opt.label} isSelected={i === selectedIdx} t={t} />
          ))}
          {showOther && <OptionRow label="Other" isSelected={selectedIdx === OTHER_IDX} t={t} />}
          {(totalOptions > 1 || question.allowSkip) && (
            <box paddingLeft={1}>
              <PopupFooterHints
                w={40}
                hints={[
                  ...(totalOptions > 1 ? [{ key: "↑↓", label: "select" }] : []),
                  { key: "⏎", label: "confirm" },
                  ...(question.allowSkip ? [{ key: "esc", label: "skip" }] : []),
                ]}
              />
            </box>
          )}
        </box>
      )}
    </box>
  );
}
