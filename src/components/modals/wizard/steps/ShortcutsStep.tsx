import { memo } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { VSpacer } from "../../../ui/index.js";
import { SHORTCUTS } from "../data.js";
import { BOLD } from "../theme.js";

export const ShortcutsStep = memo(function ShortcutsStep() {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
      <text bg={t.bgPopup}>
        <span fg={t.brand} attributes={BOLD}>
          {icon("sparkle")} Keyboard & Commands
        </span>
      </text>
      <text bg={t.bgPopup} fg={t.textMuted}>
        A compact cheatsheet — Ctrl+K opens the full palette anytime.
      </text>

      {SHORTCUTS.map((group) => (
        <box key={group.section} flexDirection="column" backgroundColor={t.bgPopup} marginTop={1}>
          <text bg={t.bgPopup} fg={t.textMuted} attributes={BOLD}>
            {group.section}
          </text>
          {group.items.map((s) => (
            <box key={s.keys} flexDirection="row" backgroundColor={t.bgPopup}>
              <text bg={t.bgPopup}>
                <span fg={t.textFaint}>[</span>
                <span fg={s.slash ? t.brand : t.brandSecondary} attributes={BOLD}>
                  {s.keys.padEnd(14)}
                </span>
                <span fg={t.textFaint}>]</span>
                <span fg={t.textSecondary}> {s.desc}</span>
              </text>
            </box>
          ))}
        </box>
      ))}

      <VSpacer />
      <text bg={t.bgPopup} fg={t.textFaint}>
        Type <span fg={t.brand}>/help</span> or press{" "}
        <span fg={t.brandSecondary} attributes={BOLD}>
          Ctrl+K
        </span>{" "}
        for all 100 commands.
      </text>
    </box>
  );
});
