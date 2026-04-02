import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { Overlay, usePopupColors } from "../../layout/shared.js";
import { MAX_W, STEPS } from "./data.js";
import { FooterNav } from "./FooterNav.js";
import { ProgressBar } from "./ProgressBar.js";
import { Hr } from "./primitives.js";
import { IntelligenceStep } from "./steps/IntelligenceStep.js";
import { ReadyStep } from "./steps/ReadyStep.js";
import { SetupStep } from "./steps/SetupStep.js";
import { ShortcutsStep } from "./steps/ShortcutsStep.js";
import { ThemeStep } from "./steps/ThemeStep.js";
import { WelcomeStep } from "./steps/WelcomeStep.js";
import { WorkflowStep } from "./steps/WorkflowStep.js";

interface Props {
  visible: boolean;
  hasModel: boolean;
  activeModel: string;
  onSelectModel: (modelId?: string) => void;
  onClose: () => void;
}

export function FirstRunWizard({ visible, hasModel, activeModel, onSelectModel, onClose }: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const pw = Math.min(MAX_W, Math.floor(termCols * 0.92));
  const iw = pw - 2;

  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx] ?? "welcome";
  const [setupActive, setSetupActive] = useState(false);

  const hasOpened = useRef(false);

  // Reset only on first open, not on reopen from model picker
  useEffect(() => {
    if (!visible) return;
    if (!hasOpened.current) {
      hasOpened.current = true;
      setStepIdx(0);
    }
    setSetupActive(false);
  }, [visible]);

  // Navigation
  const goForward = () => {
    if (stepIdx < STEPS.length - 1) setStepIdx((i) => i + 1);
    else onClose();
  };

  const goBack = () => {
    if (stepIdx > 0) setStepIdx((i) => i - 1);
  };

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!visible) return;
    if (setupActive) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (step === "setup" || step === "theme") {
      if (evt.name === "right" || evt.name === "l") {
        goForward();
        return;
      }
      if (evt.name === "left" || evt.name === "h") {
        goBack();
        return;
      }
      return;
    }
    if (evt.name === "return" || evt.name === "right" || evt.name === "l") {
      goForward();
      return;
    }
    if (evt.name === "left" || evt.name === "h") {
      goBack();
      return;
    }
  };

  useKeyboard(handleKeyboard);

  const t = useTheme();
  const { bg } = usePopupColors();

  if (!visible) return null;

  const maxH = Math.max(24, Math.floor(termRows * 0.7));

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={t.brandAlt}
        backgroundColor={bg}
        width={pw}
        height={maxH}
      >
        <ProgressBar iw={iw} stepIdx={stepIdx} />
        <Hr iw={iw} />

        <box flexDirection="column" flexGrow={1} overflow="hidden">
          {step === "welcome" && <WelcomeStep iw={iw} />}
          {step === "setup" && (
            <SetupStep
              iw={iw}
              hasModel={hasModel}
              activeModel={activeModel}
              onSelectModel={onSelectModel}
              onForward={goForward}
              active={setupActive}
              setActive={setSetupActive}
            />
          )}
          {step === "intelligence" && <IntelligenceStep iw={iw} />}
          {step === "workflow" && <WorkflowStep iw={iw} />}
          {step === "shortcuts" && <ShortcutsStep iw={iw} />}
          {step === "theme" && (
            <ThemeStep iw={iw} active={setupActive} setActive={setSetupActive} />
          )}
          {step === "ready" && <ReadyStep iw={iw} />}
        </box>

        <Hr iw={iw} />
        <FooterNav iw={iw} stepIdx={stepIdx} step={step} />
      </box>
    </Overlay>
  );
}
