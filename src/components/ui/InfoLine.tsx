import { memo } from "react";
import { useTheme } from "../../core/theme/index.js";
import { Divider, ProgressBar, VSpacer } from "./layout.js";

const BOLD = 1;

export type InfoLineKind = "header" | "separator" | "entry" | "text" | "spacer" | "bar";

export interface InfoLineData {
  type: InfoLineKind;
  label?: string;
  desc?: string;
  color?: string;
  descColor?: string;
  /** For "bar" type: 0–100 fill percentage */
  pct?: number;
  /** For "bar" type: bar fill color */
  barColor?: string;
}

export interface InfoLineProps {
  line: InfoLineData;
  /** Content width in cells. */
  width: number;
  /** Label column width for entry/bar rows. */
  labelWidth?: number;
  bg?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Unified renderer for info/help-style mixed-type lines. Use inside a
 * scrollbox for long lists.
 */
export const InfoLine = memo(function InfoLine({
  line,
  width,
  labelWidth = 20,
  bg,
}: InfoLineProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;

  if (line.type === "header") {
    return (
      <box flexDirection="row" height={1} backgroundColor={fill}>
        <text bg={fill} fg={line.color ?? t.brandAlt} attributes={BOLD}>
          {truncate(line.label ?? "", width)}
        </text>
      </box>
    );
  }

  if (line.type === "separator") {
    return <Divider width={width} bg={fill} />;
  }

  if (line.type === "spacer") {
    return <VSpacer bg={fill} />;
  }

  if (line.type === "bar") {
    return (
      <ProgressBar
        label={line.label}
        pct={line.pct ?? 0}
        value={line.desc}
        width={width}
        labelWidth={labelWidth}
        color={line.barColor}
        bg={fill}
      />
    );
  }

  if (line.type === "entry") {
    const descMax = Math.max(0, width - labelWidth - 1);
    return (
      <box flexDirection="row" height={1} backgroundColor={fill}>
        <text bg={fill} fg={line.color ?? t.brandSecondary}>
          {(line.label ?? "").padEnd(labelWidth).slice(0, labelWidth)}
        </text>
        <text bg={fill} fg={line.descColor ?? t.textMuted}>
          {truncate(line.desc ?? "", descMax)}
        </text>
      </box>
    );
  }

  // text
  return (
    <box flexDirection="row" height={1} backgroundColor={fill}>
      <text bg={fill} fg={line.color ?? t.textMuted}>
        {truncate(line.label ?? "", width)}
      </text>
    </box>
  );
});
