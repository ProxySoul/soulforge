import { useTheme } from "../../../core/theme/index.js";
import { PopupRow, usePopupColors } from "../../layout/shared.js";
import { BOLD } from "./theme.js";

export function Gap({ iw, n = 1 }: { iw: number; n?: number }) {
  const { bg } = usePopupColors();
  const rows = [];
  for (let i = 0; i < n; i++)
    rows.push(
      <PopupRow key={i} w={iw}>
        <text bg={bg}> </text>
      </PopupRow>,
    );
  return <>{rows}</>;
}

export function Hr({ iw }: { iw: number }) {
  const t = useTheme();
  const { bg } = usePopupColors();
  return (
    <PopupRow w={iw}>
      <text fg={t.textFaint} bg={bg}>
        {"─".repeat(iw - 4)}
      </text>
    </PopupRow>
  );
}

export function StepHeader({ iw, ic, title }: { iw: number; ic: string; title: string }) {
  const t = useTheme();
  const { bg } = usePopupColors();
  return (
    <PopupRow w={iw}>
      <text fg={t.brand} attributes={BOLD} bg={bg}>
        {ic}
      </text>
      <text fg={t.textPrimary} attributes={BOLD} bg={bg}>
        {" "}
        {title}
      </text>
    </PopupRow>
  );
}

export function SectionLabel({ iw, label }: { iw: number; label: string }) {
  const t = useTheme();
  const { bg } = usePopupColors();
  return (
    <PopupRow w={iw}>
      <text fg={t.textMuted} attributes={BOLD} bg={bg}>
        {label}
      </text>
    </PopupRow>
  );
}

export function Feat({
  iw,
  ic,
  title,
  keys,
  desc,
}: {
  iw: number;
  ic: string;
  title: string;
  keys: string;
  desc: string;
}) {
  const t = useTheme();
  const { bg } = usePopupColors();
  return (
    <PopupRow w={iw}>
      <text fg={t.brand} bg={bg}>
        {"  "}
        {ic}{" "}
      </text>
      <text fg={t.textPrimary} attributes={BOLD} bg={bg}>
        {title}
      </text>
      <text fg={t.info} bg={bg}>
        {" "}
        ({keys})
      </text>
      <text fg={t.textDim} bg={bg}>
        {" — "}
        {desc}
      </text>
    </PopupRow>
  );
}
