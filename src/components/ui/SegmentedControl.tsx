import { memo, type ReactNode } from "react";
import { useTheme } from "../../core/theme/index.js";

const BOLD = 1;

export interface Segment<V extends string | number = string | number> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string | number = string | number> {
  label?: string;
  /** Narrow prefix column; omit label to skip. */
  labelWidth?: number;
  options: Segment<V>[];
  value: V;
  focused?: boolean;
  /** Trailing text rendered after the segments in muted. */
  suffix?: string;
  bg?: string;
}

/**
 * Horizontal radio-row ("segmented control").
 *   ▸  Mode    [off]  ast  synthetic  llm  full
 *
 * Caller handles keyboard navigation (←→ on focused row). This primitive is
 * purely presentational.
 */
function SegmentedControlImpl<V extends string | number>({
  label,
  labelWidth = 12,
  options,
  value,
  focused,
  suffix,
  bg,
}: SegmentedControlProps<V>): ReactNode {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <box flexDirection="row" backgroundColor={fill}>
      <text bg={fill} fg={focused ? t.brand : t.textFaint} attributes={BOLD}>
        {focused ? "▸ " : "  "}
      </text>
      {label ? (
        <text
          bg={fill}
          fg={focused ? t.textPrimary : t.textMuted}
          attributes={focused ? BOLD : undefined}
        >
          {label.padEnd(labelWidth).slice(0, labelWidth)}
        </text>
      ) : null}
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <text
            key={String(opt.value)}
            bg={fill}
            fg={active ? t.brandSecondary : t.textDim}
            attributes={active ? BOLD : undefined}
          >
            {i > 0 ? "  " : ""}
            {active ? `[${opt.label}]` : ` ${opt.label} `}
          </text>
        );
      })}
      {suffix ? (
        <text bg={fill} fg={t.textMuted}>
          {"  "}
          {suffix}
        </text>
      ) : null}
    </box>
  );
}

export const SegmentedControl = memo(SegmentedControlImpl) as typeof SegmentedControlImpl;
