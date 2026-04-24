import { memo, useEffect, useRef, useState } from "react";
import { icon } from "../../../../core/icons.js";
import { useTheme } from "../../../../core/theme/index.js";
import { VSpacer } from "../../../ui/index.js";
import {
  BLINK_COUNT,
  BLINK_INITIAL_MS,
  BLINK_MS,
  TYPEWRITER_MS,
  WELCOME_BULLETS,
  WELCOME_TITLE,
} from "../data.js";
import { BOLD, ITALIC } from "../theme.js";

function useTypewriter(text: string, ms: number) {
  const [len, setLen] = useState(0);
  const [cursorOn, setCursorOn] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let i = 0;
    const tick = () => {
      if (i < text.length) {
        i++;
        setLen(i);
        timer.current = setTimeout(tick, ms);
      } else {
        let blinks = 0;
        const blink = () => {
          if (blinks >= BLINK_COUNT * 2) {
            setCursorOn(false);
            return;
          }
          blinks++;
          setCursorOn((v) => !v);
          timer.current = setTimeout(blink, BLINK_MS);
        };
        timer.current = setTimeout(blink, BLINK_INITIAL_MS);
      }
    };
    timer.current = setTimeout(tick, BLINK_INITIAL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, ms]);

  return { typed: text.slice(0, len), cursorOn };
}

export const WelcomeStep = memo(function WelcomeStep() {
  const t = useTheme();
  const { typed, cursorOn } = useTypewriter(WELCOME_TITLE, TYPEWRITER_MS);
  const ghostIc = icon("ghost");

  return (
    <box flexDirection="column" paddingX={2} backgroundColor={t.bgPopup}>
      <VSpacer rows={2} />
      <box flexDirection="row" backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup}>
          <span fg={t.brand} attributes={BOLD}>
            {" "}
            {ghostIc}{" "}
          </span>
          <span fg={t.textPrimary} attributes={BOLD}>
            {typed}
          </span>
          <span fg={t.brand}>{cursorOn ? "▌" : " "}</span>
        </text>
      </box>
      <VSpacer />
      <text bg={t.bgPopup} fg={t.textSecondary} attributes={ITALIC}>
        {" Graph-Powered Code Intelligence"}
      </text>
      <VSpacer rows={2} />
      {WELCOME_BULLETS.map((b) => (
        <text key={b} bg={t.bgPopup}>
          <span fg={t.brand}>{" ◆ "}</span>
          <span fg={t.textSecondary}>{b}</span>
        </text>
      ))}
      <VSpacer rows={2} />
      <text bg={t.bgPopup} fg={t.textMuted} attributes={ITALIC}>
        {" Press → or Enter to begin setup"}
      </text>
    </box>
  );
});
