import { memo } from "react";
import { useTheme } from "../../core/theme/index.js";

const BOLD = 1;

export interface KeyCapProps {
  /** Key name (Enter, Esc, ↑↓, Ctrl+S, a). Kept short — 1–6 chars renders best. */
  keyName: string;
  /** Optional label rendered after the cap, in muted text. */
  label?: string;
  /** Background color (defaults to bgPopup). */
  bg?: string;
  /** Accent color for the key (defaults to brandSecondary). */
  accent?: string;
}

export const KeyCap = memo(function KeyCap({ keyName, label, bg, accent }: KeyCapProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const keyColor = accent ?? t.brandSecondary;
  return (
    <text bg={fill} fg={t.textMuted}>
      <span fg={t.textFaint}>[</span>
      <span fg={keyColor} attributes={BOLD}>
        {keyName}
      </span>
      <span fg={t.textFaint}>]</span>
      {label ? <span fg={t.textMuted}> {label}</span> : null}
    </text>
  );
});

export interface KeyCapsProps {
  hints: { key: string; label: string }[];
  bg?: string;
  /** Separator rendered between hints (default: `·`). */
  sep?: string;
}

export const KeyCaps = memo(function KeyCaps({ hints, bg, sep = "·" }: KeyCapsProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <text bg={fill}>
      {hints.map((h, i) => (
        <span key={h.key + h.label} bg={fill}>
          {i > 0 ? <span fg={t.textFaint}>{`  ${sep}  `}</span> : null}
          <span fg={t.textFaint}>[</span>
          <span fg={t.brandSecondary} attributes={BOLD}>
            {h.key}
          </span>
          <span fg={t.textFaint}>]</span>
          <span fg={t.textMuted}> {h.label}</span>
        </span>
      ))}
    </text>
  );
});
