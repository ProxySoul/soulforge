import { useTheme } from "../../../core/theme/index.js";
import { VSpacer } from "../../ui/index.js";
import { BOLD } from "./theme.js";

export function Gap({ n = 1, iw: _iw }: { n?: number; iw?: number }) {
  return <VSpacer rows={n} />;
}

export function Hr({ iw: _iw }: { iw?: number } = {}) {
  const t = useTheme();
  return (
    <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup} flexShrink={0}>
      <box flexGrow={1} height={1} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textFaint}>
          {"─".repeat(120)}
        </text>
      </box>
    </box>
  );
}

export function StepHeader({ ic, title, iw: _iw }: { ic: string; title: string; iw?: number }) {
  const t = useTheme();
  return (
    <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup} flexShrink={0}>
      <text bg={t.bgPopup} fg={t.brand} attributes={BOLD}>
        {ic}
      </text>
      <text bg={t.bgPopup} fg={t.textPrimary} attributes={BOLD}>
        {" "}
        {title}
      </text>
    </box>
  );
}

/** Muted bold label — used to label groups inside a step. */
export function SectionLabel({ label }: { label: string }) {
  const t = useTheme();
  return (
    <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup} flexShrink={0}>
      <text bg={t.bgPopup} fg={t.textMuted} attributes={BOLD}>
        {label}
      </text>
    </box>
  );
}

/** Feature row: icon + bold title + (keys) + — desc. */
export function Feat({
  ic,
  title,
  keys,
  desc,
}: {
  ic: string;
  title: string;
  keys: string;
  desc: string;
}) {
  const t = useTheme();
  return (
    <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup} flexShrink={0}>
      <text bg={t.bgPopup}>
        <span fg={t.brand}>
          {"  "}
          {ic}{" "}
        </span>
        <span fg={t.textPrimary} attributes={BOLD}>
          {title}
        </span>
        <span fg={t.info}> ({keys})</span>
        <span fg={t.textDim}>
          {" — "}
          {desc}
        </span>
      </text>
    </box>
  );
}
