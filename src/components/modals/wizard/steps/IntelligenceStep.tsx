import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { VSpacer } from "../../../ui/index.js";
import { INTELLIGENCE_ITEMS } from "../data.js";
import { StepHeader } from "../primitives.js";
import { BOLD } from "../theme.js";

export const IntelligenceStep = memo(function IntelligenceStep() {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
      <VSpacer />
      <StepHeader ic={icon("brain")} title="Codebase Intelligence" />
      <VSpacer />

      <text bg={t.bgPopup} fg={t.textSecondary}>
        SoulForge understands your code before the AI even reads it:
      </text>

      {INTELLIGENCE_ITEMS.map((item) => (
        <box key={item.cmd} flexDirection="column" backgroundColor={t.bgPopup}>
          <VSpacer />
          <text bg={t.bgPopup}>
            <span fg={t.brand}>{icon(item.ic)} </span>
            <span fg={t.textPrimary} attributes={BOLD}>
              {item.title}
            </span>
            <span fg={t.info}>
              {"  "}
              {item.cmd}
            </span>
          </text>
          <text bg={t.bgPopup} fg={t.textSecondary}>
            {"    "}
            {item.desc}
          </text>
          {item.bullets.map((b) => (
            <text key={b} bg={t.bgPopup} fg={t.textDim}>
              {"    "}
              <span fg={t.textFaint}>•</span> {b}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
});
