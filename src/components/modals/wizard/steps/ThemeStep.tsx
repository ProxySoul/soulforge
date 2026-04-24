import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadConfig, saveGlobalConfig } from "../../../../config/index.js";
import { applyTheme, listThemes, useTheme, useThemeStore } from "../../../../core/theme/index.js";
import type { BorderStrength } from "../../../../core/theme/loader.js";
import { VirtualList } from "../../../ui/index.js";
import { Gap, Hr, StepHeader } from "../primitives.js";
import { BOLD } from "../theme.js";

interface ThemeStepProps {
  iw: number;
  active: boolean;
  setActive: (v: boolean) => void;
}

const OPACITY_LEVELS = [0, 30, 70, 100] as const;
const OPACITY_LABELS = ["Clear", "Dim", "Subtle", "Solid"];
const BORDER_OPTIONS: BorderStrength[] = ["default", "strong", "op"];
const BORDER_LABELS = ["Default", "Strong", "OP"];

function opacityToIndex(opacity: number): number {
  const idx = OPACITY_LEVELS.indexOf(opacity as (typeof OPACITY_LEVELS)[number]);
  return idx >= 0 ? idx : OPACITY_LEVELS.length - 1;
}

// Chrome rows inside the wizard content pane (PremiumPopup shell already owns
// border + sidebar + footer): TabHeader(3) + gap(1) + header(1) + tip(1) +
// gap(1) + 4 option rows + hr(1) + gap(1) + counter(1) + gap(1) + help(1) = 16
const CHROME_ROWS = 16;

export function ThemeStep({ iw, setActive }: ThemeStepProps) {
  const t = useTheme();
  const popupBg = t.bgPopup;
  const popupHl = t.bgPopupHighlight;
  const themes = useMemo(() => listThemes(), []);
  const currentName = useThemeStore((s) => s.name);
  const isTransparent = useThemeStore((s) => s.tokens.bgApp === "transparent");

  // Load saved options from config
  const cfg = useMemo(() => loadConfig(), []);
  const [msgOpacity, setMsgOpacity] = useState(() =>
    typeof cfg.theme?.userMessageOpacity === "number" ? cfg.theme.userMessageOpacity : 100,
  );
  const [diffOpacity, setDiffOpacity] = useState(() =>
    typeof cfg.theme?.diffOpacity === "number" ? cfg.theme.diffOpacity : 100,
  );
  const [borderStr, setBorderStr] = useState<BorderStrength>(
    () => cfg.theme?.borderStrength ?? "default",
  );

  const { height: termRows } = useTerminalDimensions();
  const maxH = Math.max(24, Math.floor(termRows * 0.7));
  const maxVisible = Math.max(4, maxH - CHROME_ROWS);

  const [cursor, setCursor] = useState(0);

  const applyAll = useCallback(
    (name: string, tp: boolean, mOp: number, dOp: number, bdr: BorderStrength) => {
      applyTheme(name, tp, { userMessageOpacity: mOp, diffOpacity: dOp, borderStrength: bdr });
    },
    [],
  );

  const saveAll = useCallback(
    (name: string, tp: boolean, mOp: number, dOp: number, bdr: BorderStrength) => {
      saveGlobalConfig({
        theme: {
          name,
          transparent: tp,
          userMessageOpacity: mOp,
          diffOpacity: dOp,
          borderStrength: bdr,
        },
      } as Record<string, unknown>);
    },
    [],
  );

  // Initialize cursor to current theme
  useEffect(() => {
    const idx = themes.findIndex((th) => th.id === currentName);
    if (idx >= 0) setCursor(idx);
  }, [currentName, themes]);

  useEffect(() => {
    setActive(false);
  }, [setActive]);

  useKeyboard((evt) => {
    const name = themes[cursor]?.id ?? currentName;
    if (evt.name === "up") {
      const next = cursor > 0 ? cursor - 1 : themes.length - 1;
      setCursor(next);
      const th = themes[next];
      if (th) applyAll(th.id, isTransparent, msgOpacity, diffOpacity, borderStr);
      return;
    }
    if (evt.name === "down") {
      const next = cursor < themes.length - 1 ? cursor + 1 : 0;
      setCursor(next);
      const th = themes[next];
      if (th) applyAll(th.id, isTransparent, msgOpacity, diffOpacity, borderStr);
      return;
    }
    if (evt.name === "return") {
      const th = themes[cursor];
      if (th) {
        applyAll(th.id, isTransparent, msgOpacity, diffOpacity, borderStr);
        saveAll(th.id, isTransparent, msgOpacity, diffOpacity, borderStr);
      }
      return;
    }
    if (evt.name === "tab") {
      const next = !isTransparent;
      applyAll(name, next, msgOpacity, diffOpacity, borderStr);
      saveAll(name, next, msgOpacity, diffOpacity, borderStr);
      return;
    }
    if (evt.name === "m") {
      const nextIdx = (opacityToIndex(msgOpacity) + 1) % OPACITY_LEVELS.length;
      const nextOp = OPACITY_LEVELS[nextIdx] ?? 100;
      setMsgOpacity(nextOp);
      applyAll(name, isTransparent, nextOp, diffOpacity, borderStr);
      saveAll(name, isTransparent, nextOp, diffOpacity, borderStr);
      return;
    }
    if (evt.name === "d") {
      const nextIdx = (opacityToIndex(diffOpacity) + 1) % OPACITY_LEVELS.length;
      const nextOp = OPACITY_LEVELS[nextIdx] ?? 100;
      setDiffOpacity(nextOp);
      applyAll(name, isTransparent, msgOpacity, nextOp, borderStr);
      saveAll(name, isTransparent, msgOpacity, nextOp, borderStr);
      return;
    }
    if (evt.name === "b") {
      const nextIdx = (BORDER_OPTIONS.indexOf(borderStr) + 1) % BORDER_OPTIONS.length;
      const nextBdr = BORDER_OPTIONS[nextIdx] ?? "default";
      setBorderStr(nextBdr);
      applyAll(name, isTransparent, msgOpacity, diffOpacity, nextBdr);
      saveAll(name, isTransparent, msgOpacity, diffOpacity, nextBdr);
      return;
    }
  });

  const msgLabel = OPACITY_LABELS[opacityToIndex(msgOpacity)] ?? "Solid";
  const diffLabel = OPACITY_LABELS[opacityToIndex(diffOpacity)] ?? "Solid";
  const bdrLabel = BORDER_LABELS[BORDER_OPTIONS.indexOf(borderStr)] ?? "Default";

  return (
    <>
      <Gap iw={iw} />
      <StepHeader iw={iw} ic="◎" title="Pick Your Theme" />
      <box flexDirection="row" backgroundColor={popupBg}>
        <text fg={t.textDim} bg={popupBg}>
          {"  Tip: add your own tailwind-style theme in "}
        </text>
        <text fg={t.info} bg={popupBg} attributes={BOLD}>
          {"~/.soulforge/themes.json"}
        </text>
      </box>
      <Gap iw={iw} />

      <OptionRow
        iw={iw}
        label="Transparent"
        value={isTransparent ? "on" : "off"}
        key_="tab"
        active={isTransparent}
      />
      <OptionRow iw={iw} label="Message BG" value={msgLabel} key_="m" active={msgOpacity < 100} />
      <OptionRow iw={iw} label="Diff BG" value={diffLabel} key_="d" active={diffOpacity < 100} />
      <OptionRow
        iw={iw}
        label="Borders"
        value={bdrLabel}
        key_="b"
        active={borderStr !== "default"}
      />

      <Hr iw={iw} />
      <Gap iw={iw} />

      <VirtualList
        items={themes}
        selectedIndex={cursor}
        width={iw}
        maxRows={maxVisible}
        keyExtractor={(th) => th.id}
        renderItem={(th, { selected }) => {
          const bg = selected ? popupHl : popupBg;
          const isCurrent = th.id === currentName;
          const variantIcon = th.variant === "light" ? "☀" : "☾";
          return (
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={selected ? t.textPrimary : t.textMuted}>
                {selected ? "› " : "  "}
              </text>
              <text bg={bg} fg={th.brand} attributes={BOLD}>
                {"■■ "}
              </text>
              <text bg={bg} fg={selected ? t.textPrimary : t.textSecondary}>
                {variantIcon} {th.label}
              </text>
              {isCurrent && (
                <text bg={bg} fg={t.success} attributes={TextAttributes.BOLD}>
                  {" ✓"}
                </text>
              )}
            </box>
          );
        }}
      />

      <Gap iw={iw} />
      <box flexDirection="row" backgroundColor={popupBg}>
        <text fg={t.textDim} bg={popupBg}>
          {"  ↑↓ preview · ⏎ apply · tab/m/d/b toggle options · → next"}
        </text>
      </box>
    </>
  );
}

function OptionRow({
  iw: _iw,
  label,
  value,
  key_,
  active,
}: {
  iw: number;
  label: string;
  value: string;
  key_: string;
  active: boolean;
}) {
  const t = useTheme();
  const bg = t.bgPopup;
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text fg={t.textSecondary} bg={bg}>
        {"  "}
        {label.padEnd(14)}
      </text>
      <text fg={active ? t.success : t.textDim} attributes={BOLD} bg={bg}>
        {"["}
        {value}
        {"]"}
      </text>
      <text fg={t.textFaint} bg={bg}>
        {"  "}
        {key_}
      </text>
    </box>
  );
}
