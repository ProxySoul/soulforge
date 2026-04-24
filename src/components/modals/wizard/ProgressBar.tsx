import { memo } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { STEP_LABELS, STEPS } from "./data.js";

export const ProgressBar = memo(function ProgressBar({ stepIdx }: { stepIdx: number }) {
  const t = useTheme();
  return (
    <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup} flexShrink={0}>
      <text bg={t.bgPopup}>
        {STEPS.map((s, i) => (
          <span key={s} fg={i <= stepIdx ? (i === stepIdx ? t.brand : t.success) : t.textFaint}>
            {i <= stepIdx ? "●" : "○"}
            {i < STEPS.length - 1 ? " " : ""}
          </span>
        ))}
        <span fg={t.textMuted}>
          {"  "}
          {STEP_LABELS[STEPS[stepIdx] as keyof typeof STEP_LABELS]} ({String(stepIdx + 1)}/
          {String(STEPS.length)})
        </span>
      </text>
    </box>
  );
});
