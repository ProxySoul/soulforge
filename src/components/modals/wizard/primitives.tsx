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

/**
 * FeatureList — renders a docs-style list of features with icon, title,
 * command, description, and bullets. Used by most content steps.
 */
export function FeatureList({
  heading,
  headerIcon,
  intro,
  items,
}: {
  heading: string;
  headerIcon: string;
  intro?: string;
  items: readonly {
    readonly ic: string;
    readonly title: string;
    readonly cmd: string;
    readonly desc: string;
    readonly bullets: readonly string[];
  }[];
}) {
  const t = useTheme();
  return (
    <box flexDirection="column" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
      <box flexDirection="row" backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup}>
          <span fg={t.brand} attributes={BOLD}>
            {headerIcon} {heading}
          </span>
        </text>
      </box>
      {intro ? (
        <text bg={t.bgPopup} fg={t.textMuted}>
          {intro}
        </text>
      ) : null}
      {items.map((item) => (
        <box key={item.title} flexDirection="column" backgroundColor={t.bgPopup} marginTop={1}>
          <box flexDirection="row" backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup}>
              <span fg={t.brandSecondary}>
                {item.ic}
                {"  "}
              </span>
              <span fg={t.textPrimary} attributes={BOLD}>
                {item.title}
              </span>
              {item.cmd && item.cmd !== "—" ? (
                <span fg={t.info}>
                  {"   "}
                  {item.cmd}
                </span>
              ) : null}
            </text>
          </box>
          <text bg={t.bgPopup} fg={t.textSecondary}>
            {"  "}
            {item.desc}
          </text>
          {item.bullets.map((b) => (
            <text key={b} bg={t.bgPopup} fg={t.textDim}>
              {"    "}
              <span fg={t.textFaint}>·</span> {b}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}
