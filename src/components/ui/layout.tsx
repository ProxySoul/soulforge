import { memo, type ReactNode } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";

const BOLD = 1;
const ITALIC = 2;

// ── Section ────────────────────────────────────────────────────────────────
// Title (brand, bold) + optional one-line description (muted) + body.
// Use to group related controls inside a popup body.

export interface SectionProps {
  title?: string;
  /** One-line description, kept under ~8 words. */
  description?: string;
  /** Optional icon (brand color) rendered before the title. */
  icon?: string;
  /** Right-aligned header content (e.g. status pill, counter). */
  headerRight?: ReactNode;
  children?: ReactNode;
  bg?: string;
  paddingX?: number;
  paddingY?: number;
}

export const Section = memo(function Section({
  title,
  description,
  icon,
  headerRight,
  children,
  bg,
  paddingX = 2,
  paddingY = 1,
}: SectionProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return (
    <box flexDirection="column" backgroundColor={fill} paddingX={paddingX} paddingY={paddingY}>
      {title ? (
        <box flexDirection="row" backgroundColor={fill}>
          {icon ? (
            <text bg={fill} fg={t.brand} attributes={BOLD}>
              {icon}
              {"  "}
            </text>
          ) : null}
          <text bg={fill} fg={t.textPrimary} attributes={BOLD}>
            {title}
          </text>
          {headerRight ? <box flexGrow={1} backgroundColor={fill} /> : null}
          {headerRight}
        </box>
      ) : null}
      {description ? (
        <text bg={fill} fg={t.textFaint}>
          {description}
        </text>
      ) : null}
      {(title || description) && children ? <box height={1} backgroundColor={fill} /> : null}
      {children}
    </box>
  );
});

// ── Field ──────────────────────────────────────────────────────────────────
// Label + value row. Use for read-only metadata or inline editable fields.

export interface FieldProps {
  label: string;
  value?: ReactNode;
  /** Key hint rendered after the value (e.g. "Enter" to edit). */
  keyHint?: string;
  focused?: boolean;
  /** Mono-width label column so rows align. Default: auto. */
  labelWidth?: number;
  bg?: string;
}

export const Field = memo(function Field({
  label,
  value,
  keyHint,
  focused,
  labelWidth,
  bg,
}: FieldProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const labelPadded = labelWidth ? label.padEnd(labelWidth).slice(0, labelWidth) : label;
  return (
    <box flexDirection="row" backgroundColor={fill}>
      <text bg={fill} fg={focused ? t.brand : t.textFaint}>
        {focused ? "▸ " : "  "}
      </text>
      <text bg={fill} fg={t.textMuted}>
        {labelPadded}
      </text>
      <text bg={fill}>{"  "}</text>
      {typeof value === "string" ? (
        <text bg={fill} fg={focused ? t.brand : t.textPrimary}>
          {value}
        </text>
      ) : (
        value
      )}
      {keyHint && focused ? (
        <>
          <box flexGrow={1} backgroundColor={fill} />
          <text bg={fill} fg={t.textFaint}>
            [{keyHint}]
          </text>
        </>
      ) : null}
    </box>
  );
});

// ── StatusPill ─────────────────────────────────────────────────────────────
// Compact state indicator. ● color-coded + uppercase label.

export interface StatusPillProps {
  status: "online" | "offline" | "warning" | "error" | "info" | "idle";
  label?: string;
  bg?: string;
}

const STATUS_DOT: Record<StatusPillProps["status"], string> = {
  online: "●",
  offline: "○",
  warning: "◐",
  error: "●",
  info: "●",
  idle: "○",
};

export const StatusPill = memo(function StatusPill({ status, label, bg }: StatusPillProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const color =
    status === "online"
      ? t.success
      : status === "offline"
        ? t.textDim
        : status === "warning"
          ? t.warning
          : status === "error"
            ? t.error
            : status === "info"
              ? t.info
              : t.textFaint;
  const text = label ?? status.toUpperCase();
  return (
    <text bg={fill}>
      <span fg={color}>{STATUS_DOT[status]}</span>
      <span fg={t.textMuted}> {text}</span>
    </text>
  );
});

// ── Hint ───────────────────────────────────────────────────────────────────
// Tip line below a section. Always muted, italic, prefixed with `·`.

export interface HintProps {
  children: ReactNode;
  bg?: string;
  kind?: "tip" | "warn";
}

export const Hint = memo(function Hint({ children, bg, kind = "tip" }: HintProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const fg = kind === "warn" ? t.warning : t.textFaint;
  const glyph = kind === "warn" ? icon("warning") : "·";
  return (
    <text bg={fill} fg={fg} attributes={ITALIC}>
      {glyph} {children}
    </text>
  );
});

// ── Flash ──────────────────────────────────────────────────────────────────
// Bottom-of-popup toast. Auto-dismiss is caller's responsibility.

export interface FlashProps {
  kind: "ok" | "err" | "info";
  message: string;
  bg?: string;
}

export const Flash = memo(function Flash({ kind, message, bg }: FlashProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const fg = kind === "ok" ? t.success : kind === "err" ? t.error : t.info;
  const glyph = kind === "ok" ? icon("success") : kind === "err" ? icon("fail") : icon("info");
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingX={2} backgroundColor={fill}>
      <text bg={fill} fg={fg} attributes={BOLD}>
        {glyph} {message}
      </text>
    </box>
  );
});

// ── Divider ────────────────────────────────────────────────────────────────
// Horizontal rule. Uses text-faint ─.

export interface DividerProps {
  width: number;
  bg?: string;
  /** Inset from left/right (default: 0). */
  inset?: number;
}

export const Divider = memo(function Divider({ width, bg, inset = 0 }: DividerProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const len = Math.max(0, width - inset * 2);
  return (
    <box flexDirection="row" height={1} backgroundColor={fill}>
      {inset > 0 ? <text bg={fill}>{" ".repeat(inset)}</text> : null}
      <text bg={fill} fg={t.textFaint}>
        {"─".repeat(len)}
      </text>
    </box>
  );
});

// ── VSpacer ────────────────────────────────────────────────────────────────

export const VSpacer = memo(function VSpacer({ rows = 1, bg }: { rows?: number; bg?: string }) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  return <box height={rows} backgroundColor={fill} />;
});

// ── ProgressBar ────────────────────────────────────────────────────────────
// Single-row horizontal bar. Label left, filled track center, value right.
// Color shifts green → yellow → red as pct crosses thresholds, or caller
// override via `color`.

export interface ProgressBarProps {
  label?: string;
  /** 0 to 100 */
  pct: number;
  /** Total width in cells. Bar auto-sizes from this minus label/value. */
  width: number;
  /** Label column width (default 20, only used when label is set). */
  labelWidth?: number;
  /** Trailing value text (e.g. "4.2GB / 16GB"). */
  value?: string;
  color?: string;
  bg?: string;
}

export const ProgressBar = memo(function ProgressBar({
  label,
  pct,
  width,
  labelWidth = 20,
  value,
  color,
  bg,
}: ProgressBarProps) {
  const t = useTheme();
  const fill = bg ?? t.bgPopup;
  const clamped = Math.min(100, Math.max(0, pct));
  const valueStr = value ?? `${Math.round(clamped)}%`;
  const prefixW = label ? labelWidth : 0;
  const barW = Math.max(4, width - prefixW - valueStr.length - 2);
  const filled = Math.max(clamped > 0 ? 1 : 0, Math.round((clamped / 100) * barW));
  const empty = barW - filled;
  const barFg =
    color ??
    (clamped >= 90 ? t.error : clamped >= 75 ? t.warning : clamped >= 50 ? t.info : t.success);
  return (
    <box flexDirection="row" backgroundColor={fill}>
      {label ? (
        <text bg={fill} fg={t.textMuted}>
          {label.padEnd(labelWidth).slice(0, labelWidth)}
        </text>
      ) : null}
      <text bg={fill} fg={barFg}>
        {"━".repeat(filled)}
      </text>
      <text bg={fill} fg={t.textFaint}>
        {"─".repeat(empty)}
      </text>
      <text bg={fill} fg={t.textMuted}>
        {" "}
        {valueStr}
      </text>
    </box>
  );
});
