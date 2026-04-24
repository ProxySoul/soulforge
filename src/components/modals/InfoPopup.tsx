/**
 * InfoPopup — generic info display with scrollable mixed-type lines.
 *
 * Used by status / diagnostic commands that want a structured read-only view.
 * Public API (`InfoPopupConfig`) unchanged — callers still pass `{ title, lines }`.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { InfoLine, type InfoLineData, PremiumPopup, Section } from "../ui/index.js";

// Backwards-compat alias — older callers may import this name.
export type InfoPopupLine = InfoLineData;

export interface InfoPopupConfig {
  title: string;
  icon?: string;
  lines: InfoPopupLine[];
  width?: number;
  labelWidth?: number;
  onClose?: () => void;
}

interface Props {
  visible: boolean;
  config: InfoPopupConfig | null;
  onClose: () => void;
}

export function InfoPopup({ visible, config, onClose }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    if (visible) {
      setCursor(0);
      scrollRef.current?.scrollTo(0);
    }
  }, [visible]);

  const popupW = Math.min(config?.width ?? 72, Math.max(56, Math.floor(tw * 0.8)));
  const popupH = Math.min(32, Math.max(14, th - 4));
  const contentW = popupW - 4;
  const labelW = config?.labelWidth ?? 20;
  const viewportRows = Math.max(6, popupH - 9);

  useKeyboard((evt) => {
    if (!visible || !config) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    const maxOffset = Math.max(0, config.lines.length - viewportRows);
    if (evt.name === "up" || evt.name === "k") {
      const next = Math.max(0, cursor - 1);
      setCursor(next);
      scrollRef.current?.scrollTo(next);
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      const next = Math.min(maxOffset, cursor + 1);
      setCursor(next);
      scrollRef.current?.scrollTo(next);
    }
  });

  if (!visible || !config) return null;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title={config.title}
      titleIcon={config.icon}
      footerHints={[
        { key: "↑↓", label: "scroll" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <scrollbox ref={scrollRef} height={viewportRows}>
          {config.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines array
            <InfoLine key={`l-${i}`} line={line} width={contentW} labelWidth={labelW} />
          ))}
        </scrollbox>
        {config.lines.length > viewportRows ? (
          <box flexDirection="row" paddingX={2} height={1} backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={t.textFaint}>
              {cursor + 1}-{Math.min(cursor + viewportRows, config.lines.length)} /{" "}
              {config.lines.length}
            </text>
          </box>
        ) : null}
      </Section>
    </PremiumPopup>
  );
}
