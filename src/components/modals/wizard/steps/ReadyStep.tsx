import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { VSpacer } from "../../../ui/index.js";
import { QUICK_START } from "../data.js";
import { BOLD, ITALIC } from "../theme.js";

export const ReadyStep = memo(function ReadyStep() {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={3} paddingY={2} backgroundColor={t.bgPopup}>
      <text bg={t.bgPopup}>
        <span fg={t.brand} attributes={BOLD}>
          {icon("success")} You're all set
        </span>
      </text>
      <text bg={t.bgPopup} fg={t.textSecondary} attributes={ITALIC}>
        Forge is ready. Just describe what you want.
      </text>

      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textMuted} attributes={BOLD}>
        Try asking:
      </text>
      <VSpacer />
      {QUICK_START.map((q) => (
        <text key={q} bg={t.bgPopup}>
          <span fg={t.brandSecondary}>{" › "}</span>
          <span fg={t.textSecondary}>{q}</span>
        </text>
      ))}

      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textMuted} attributes={BOLD}>
        If you get stuck:
      </text>
      <VSpacer />
      <text bg={t.bgPopup}>
        <span fg={t.textFaint}>[</span>
        <span fg={t.brandSecondary} attributes={BOLD}>
          Ctrl+K
        </span>
        <span fg={t.textFaint}>]</span>
        <span fg={t.textSecondary}> command palette </span>
        <span fg={t.textFaint}>[</span>
        <span fg={t.brand} attributes={BOLD}>
          /help
        </span>
        <span fg={t.textFaint}>]</span>
        <span fg={t.textSecondary}> all commands </span>
        <span fg={t.textFaint}>[</span>
        <span fg={t.brand} attributes={BOLD}>
          /wizard
        </span>
        <span fg={t.textFaint}>]</span>
        <span fg={t.textSecondary}> replay this</span>
      </text>

      <VSpacer rows={2} />
      <text bg={t.bgPopup}>
        <span fg={t.success} attributes={BOLD}>
          {icon("smithy")} Speak to the forge...
        </span>
      </text>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textFaint}>
        Docs: <span fg={t.info}>https://soulforge.dev</span>
      </text>
    </box>
  );
});
