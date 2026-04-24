import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PremiumPopup, type SidebarTab } from "../../ui/index.js";
import { MAX_W, SIDEBAR_W, STEP_BLURBS, STEP_ICONS, STEP_LABELS, STEPS } from "./data.js";
import { AutomationStep } from "./steps/AutomationStep.js";
import { EditingStep } from "./steps/EditingStep.js";
import { IntelligenceStep } from "./steps/IntelligenceStep.js";
import { ModesStep } from "./steps/ModesStep.js";
import { ReadyStep } from "./steps/ReadyStep.js";
import { RemoteStep } from "./steps/RemoteStep.js";
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
  const contentW = pw - SIDEBAR_W - 3;

  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx] ?? "welcome";
  const [inputLocked, setInputLocked] = useState(false);
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0]));

  const hasOpened = useRef(false);

  useEffect(() => {
    if (!visible) return;
    if (!hasOpened.current) {
      hasOpened.current = true;
      setStepIdx(0);
      setVisited(new Set([0]));
    }
    setInputLocked(false);
  }, [visible]);

  useEffect(() => {
    setVisited((v) => {
      if (v.has(stepIdx)) return v;
      const next = new Set(v);
      next.add(stepIdx);
      return next;
    });
  }, [stepIdx]);

  const goForward = () => {
    if (stepIdx < STEPS.length - 1) setStepIdx((i) => i + 1);
    else onClose();
  };

  const goBack = () => {
    if (stepIdx > 0) setStepIdx((i) => i - 1);
  };

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    if (!visible) return;
    if (inputLocked) return;
    if (evt.name === "escape") {
      onClose();
      return;
    }
    if (evt.name === "right" || evt.name === "l" || evt.name === "tab") {
      goForward();
      return;
    }
    if (evt.name === "left" || evt.name === "h") {
      goBack();
      return;
    }
    if (evt.name === "return" && step !== "setup" && step !== "theme") {
      goForward();
      return;
    }
  };

  useKeyboard(handleKeyboard);

  const tabs = useMemo<SidebarTab<(typeof STEPS)[number]>[]>(
    () =>
      STEPS.map((s, i) => ({
        id: s,
        label: STEP_LABELS[s],
        icon: STEP_ICONS[s],
        blurb: i === stepIdx ? STEP_BLURBS[s] : undefined,
        status:
          i === stepIdx ? "warning" : visited.has(i) ? "online" : i < stepIdx ? "online" : "idle",
      })),
    [stepIdx, visited],
  );

  if (!visible) return null;

  const maxH = Math.max(26, Math.floor(termRows * 0.78));
  const isLast = stepIdx === STEPS.length - 1;

  return (
    <PremiumPopup
      visible={visible}
      width={pw}
      height={maxH}
      title="SoulForge"
      titleIcon="smithy"
      tabs={tabs}
      activeTab={step}
      sidebarWidth={SIDEBAR_W}
      footerHints={[
        ...(stepIdx > 0 ? [{ key: "←", label: "back" }] : []),
        { key: isLast ? "⏎" : "→", label: isLast ? "start forging" : "next" },
        { key: "Esc", label: isLast ? "close" : "skip" },
      ]}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        {step === "welcome" && <WelcomeStep />}
        {step === "setup" && (
          <SetupStep
            iw={contentW}
            hasModel={hasModel}
            activeModel={activeModel}
            onSelectModel={onSelectModel}
            onForward={goForward}
            active={inputLocked}
            setActive={setInputLocked}
          />
        )}
        {step === "intelligence" && <IntelligenceStep />}
        {step === "editing" && <EditingStep />}
        {step === "modes" && <ModesStep />}
        {step === "workflow" && <WorkflowStep />}
        {step === "automation" && <AutomationStep />}
        {step === "remote" && <RemoteStep />}
        {step === "shortcuts" && <ShortcutsStep />}
        {step === "theme" && (
          <ThemeStep iw={contentW} active={inputLocked} setActive={setInputLocked} />
        )}
        {step === "ready" && <ReadyStep />}
      </box>
    </PremiumPopup>
  );
}
