import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { QUICK_START } from "../data.js";
import { SectionLabel, StepHeader } from "../primitives.js";
import { ITALIC } from "../theme.js";
import { VSpacer } from "../../../ui/index.js";

export const ReadyStep = memo(function ReadyStep() {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
      <VSpacer />
      <StepHeader ic={icon("ghost")} title="You're All Set" />
      <VSpacer />

      <text bg={t.bgPopup} fg={t.textSecondary}>
        Just type what you want to build, fix, or explore.
      </text>
      <text bg={t.bgPopup} fg={t.textSecondary}>
        SoulForge reads your codebase, plans changes, and edits files —
      </text>
      <text bg={t.bgPopup} fg={t.textSecondary}>
        all from this terminal.
      </text>

      <VSpacer />
      <SectionLabel label="Quick start ideas:" />
      <VSpacer />

      {QUICK_START.map((q) => (
        <text key={q} bg={t.bgPopup} fg={t.textSecondary}>
          {"  "}
          {q}
        </text>
      ))}

      <VSpacer rows={2} />
      <text bg={t.bgPopup}>
        <span fg={t.success}>✓ Ready to forge.</span>
        <span fg={t.textMuted}>{"  "}</span>
        <span fg={t.brandSecondary} attributes={ITALIC}>
          speak to the forge...
        </span>
      </text>

      <VSpacer />
      <text bg={t.bgPopup} fg={t.textFaint}>
        Re-run this wizard anytime with <span fg={t.textMuted}>soulforge --wizard</span> or{" "}
        <span fg={t.textMuted}>/wizard</span>
      </text>
    </box>
  );
});
