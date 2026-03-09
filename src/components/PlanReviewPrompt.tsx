import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { icon } from "../core/icons.js";
import type { Plan } from "../types/index.js";

interface Props {
  onAccept: () => void;
  onClearAndImplement: () => void;
  onRevise: (feedback: string) => void;
  onCancel: () => void;
  isActive: boolean;
  plan: Plan;
  planFile: string;
}

const ACCENT = "#00BFFF";
const STEP_COLOR = "#8B5CF6";
const DIM = "#555";
const CANCEL_COLOR = "#FF0040";

interface Option {
  id: string;
  label: string;
  icon: string;
  color: string;
  description?: string;
}

const ALL_OPTIONS: Option[] = [
  {
    id: "implement",
    label: "Implement",
    icon: "\u23CE",
    color: ACCENT,
    description: "execute the plan as-is",
  },
  {
    id: "clear_implement",
    label: "Clear & Implement",
    icon: "\u21BB",
    color: "#FF8C00",
    description: "clear context, then execute",
  },
  {
    id: "revise",
    label: "Revise",
    icon: "\uF040",
    color: STEP_COLOR,
    description: "provide feedback to improve the plan",
  },
  {
    id: "cancel",
    label: "Cancel",
    icon: "\uF00D",
    color: CANCEL_COLOR,
    description: "discard the plan",
  },
];

export function PlanReviewPrompt({
  onAccept,
  onClearAndImplement,
  onRevise,
  onCancel,
  isActive,
  plan,
  planFile,
}: Props) {
  const options = useMemo(() => {
    if (plan.depth === "light") {
      return ALL_OPTIONS.filter((o) => o.id !== "clear_implement");
    }
    return ALL_OPTIONS;
  }, [plan.depth]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [reviseInput, setReviseInput] = useState("");
  const [typing, setTyping] = useState(false);

  useKeyboard((evt) => {
    if (!isActive) return;

    if (typing) {
      if (evt.name === "escape") {
        setTyping(false);
      }
      return;
    }

    if (evt.name === "escape") {
      onCancel();
      return;
    }

    if (evt.name === "up") {
      setSelectedIdx((prev) => (prev > 0 ? prev - 1 : options.length - 1));
      return;
    }
    if (evt.name === "down" || evt.name === "tab") {
      setSelectedIdx((prev) => (prev + 1) % options.length);
      return;
    }

    if (evt.name === "return") {
      const opt = options[selectedIdx];
      if (!opt) return;
      switch (opt.id) {
        case "implement":
          onAccept();
          break;
        case "clear_implement":
          onClearAndImplement();
          break;
        case "revise":
          setTyping(true);
          setReviseInput("");
          break;
        case "cancel":
          onCancel();
          break;
      }
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      border={true}
      borderColor={ACCENT}
      paddingX={1}
      width="100%"
    >
      <box gap={1} flexDirection="row">
        <text fg={ACCENT} attributes={TextAttributes.BOLD}>
          {icon("plan")} {plan.title}
        </text>
        <text fg="#333">{"\u2502"}</text>
        <text fg="#444">{String(plan.steps.length)} steps</text>
        <text fg="#333">{"\u2502"}</text>
        <text fg="#444">{planFile}</text>
      </box>

      {plan.steps.map((step) => (
        <box key={step.id} height={1} flexShrink={0}>
          <text truncate>
            <span fg="#555">{"  "}○ </span>
            <span fg="#999">{step.label}</span>
          </text>
        </box>
      ))}

      <box height={1} />

      {typing ? (
        <box flexDirection="row" gap={1}>
          <text fg={STEP_COLOR}>{" \u203A"}</text>
          <input
            value={reviseInput}
            onInput={setReviseInput}
            onSubmit={() => {
              if (reviseInput.trim()) {
                onRevise(reviseInput.trim());
                setReviseInput("");
              }
            }}
            focused={isActive}
            flexGrow={1}
            placeholder="what should change..."
          />
        </box>
      ) : (
        options.map((opt, i) => {
          const selected = i === selectedIdx;
          return (
            <box key={opt.id} gap={1} flexDirection="row">
              <text fg={selected ? opt.color : "#333"}>{selected ? " \u203A" : "  "}</text>
              <text fg={selected ? opt.color : DIM}>{opt.icon}</text>
              <text
                fg={selected ? "#eee" : "#888"}
                attributes={selected ? TextAttributes.BOLD : undefined}
              >
                {opt.label}
              </text>
              {opt.description && <text fg={selected ? "#777" : "#444"}>{opt.description}</text>}
            </box>
          );
        })
      )}

      <box>
        <text fg="#555">
          {typing
            ? "  \u23CE submit  esc back"
            : "  \u2191\u2193 select  \u23CE confirm  esc cancel"}
        </text>
      </box>
    </box>
  );
}
