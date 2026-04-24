import { memo } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { KeyCaps } from "../../ui/index.js";
import { STEPS, type Step } from "./data.js";

export const FooterNav = memo(function FooterNav({
  stepIdx,
  step,
}: {
  stepIdx: number;
  step: Step;
}) {
  const t = useTheme();
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === STEPS.length - 1;
  const actionLabel = step === "setup" ? "next step" : isLast ? "start forging" : "next";
  const actionKey = step === "setup" ? "→" : "Enter";

  return (
    <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
      <KeyCaps
        hints={[
          ...(isFirst ? [] : [{ key: "←", label: "back" }]),
          { key: actionKey, label: actionLabel },
          { key: "Esc", label: "close" },
        ]}
      />
    </box>
  );
});
