import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { VSpacer } from "../../../ui/index.js";
import { SHORTCUTS } from "../data.js";
import { SectionLabel, StepHeader } from "../primitives.js";
import { BOLD } from "../theme.js";

export const ShortcutsStep = memo(function ShortcutsStep() {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
      <VSpacer />
      <StepHeader ic={icon("sparkle")} title="Keyboard Shortcuts & Commands" />

      {SHORTCUTS.map((group) => (
        <box key={group.section} flexDirection="column" backgroundColor={t.bgPopup}>
          <VSpacer />
          <SectionLabel label={group.section} />
          {group.items.map((s) => (
            <text key={s.keys} bg={t.bgPopup}>
              <span fg={s.slash ? t.brand : t.info} attributes={BOLD}>
                {s.keys.padEnd(12)}
              </span>
              <span fg={t.textSecondary}>{s.desc}</span>
            </text>
          ))}
        </box>
      ))}

      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textFaint}>
        These are just the highlights — type <span fg={t.brand}>/help</span> or press{" "}
        <span fg={t.info} attributes={BOLD}>
          Ctrl+K
        </span>{" "}
        to browse all commands
      </text>
    </box>
  );
});
