import { type createCliRenderer as CreateCliRenderer, TextAttributes } from "@opentui/core";
import type { createRoot as CreateRoot } from "@opentui/react";
import { startTransition, useCallback, useEffect, useState } from "react";
import type { App as AppComponent } from "./components/App.js";
import type { ContextManager } from "./core/context/manager.js";
import { icon } from "./core/icons.js";
import { disposeIntelligenceRouter } from "./core/intelligence/index.js";
import { deactivateCurrentProvider, type ProviderStatus } from "./core/llm/provider.js";
import type { PrerequisiteStatus } from "./core/setup/prerequisites.js";
import { BRAND_PURPLE, BRAND_RED, garble } from "./core/utils/splash.js";
import { resetStatusBarStore } from "./stores/statusbar.js";
import { resetUIStore } from "./stores/ui.js";
import type { AppConfig } from "./types/index.js";

let exitSessionId: string | null = null;
let renderer: Awaited<ReturnType<typeof CreateCliRenderer>> | null = null;

export function setExitSessionId(id: string | null): void {
  exitSessionId = id;
}

function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch {}
  try {
    process.stdout.write("\x1b[?25h\x1b[0m");
  } catch {}
}

let cleanedUp = false;

function runCleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  restoreTerminal();
  try {
    deactivateCurrentProvider();
  } catch {}
  try {
    disposeIntelligenceRouter();
  } catch {}
}

let bannerPrinted = false;

function printExitBanner(): void {
  if (bannerPrinted) return;
  bannerPrinted = true;
  process.stdout.write("\x1b[2J\x1b[H");
  if (exitSessionId) {
    const shortId = exitSessionId.slice(0, 8);
    process.stdout.write(
      `\x1b[1;35m${icon("ghost")} SoulForge\x1b[0m session saved.\n` +
        `  Resume: \x1b[1;36msoulforge --session ${shortId}\x1b[0m\n` +
        `  by \x1b[1;35mProxy\x1b[38;2;255;0;64mSoul\x1b[0m.com\n\n`,
    );
  }
}

export function cleanupAndExit(code = 0): void {
  runCleanup();
  renderer?.destroy();
  printExitBanner();
  process.exit(code);
}

let triggerRestart: (() => void) | null = null;

export function restart(): void {
  triggerRestart?.();
}

process.on("exit", () => {
  runCleanup();
  printExitBanner();
});

process.on("SIGINT", () => {
  cleanupAndExit(130);
});

process.on("SIGTERM", () => {
  cleanupAndExit(143);
});

const RESTART_STEPS = [
  "Quenching active flames…",
  "Rereading the scrolls…",
  "Consulting the LLM gods…",
  "Reforging the soul…",
];

const RESTART_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function RestartSplash({ onComplete }: { onComplete: () => void }) {
  const ghost = icon("ghost");
  const label = "Restarting";

  const [anim, setAnim] = useState({
    phase: 0,
    ghostFrame: ghost,
    typeIdx: 0,
    wordmark: garble("SOULFORGE"),
    spinIdx: 0,
  });

  useEffect(() => {
    let step = 0;
    const timer = setInterval(() => {
      step++;
      setAnim((prev) => {
        const next = { ...prev, spinIdx: prev.spinIdx + 1 };
        // Ghost fade out: frames 1-4
        if (step === 1) next.ghostFrame = "▓";
        if (step === 2) next.ghostFrame = "▒";
        if (step === 3) next.ghostFrame = "░";
        if (step === 4) next.ghostFrame = " ";
        // Ghost fade in: frames 6-9
        if (step === 6) next.ghostFrame = "░";
        if (step === 7) next.ghostFrame = "▒";
        if (step === 8) next.ghostFrame = "▓";
        if (step === 9) next.ghostFrame = ghost;
        // Typewriter: frames 10+
        if (step >= 10 && step <= 10 + label.length) {
          next.typeIdx = step - 10;
        }
        // Status steps
        if (step === 10 + label.length + 2) next.phase = 1;
        if (step === 10 + label.length + 5) next.phase = 2;
        if (step === 10 + label.length + 8) next.phase = 3;
        // Wordmark glitch
        if (step === 10 + label.length + 11) next.wordmark = garble("SOULFORGE");
        if (step === 10 + label.length + 12) next.wordmark = "SOULFORGE";
        if (step === 10 + label.length + 13) next.wordmark = garble("SOULFORGE");
        return next;
      });
      // Done
      if (step === 10 + label.length + 16) {
        clearInterval(timer);
        onComplete();
      }
    }, 50);
    return () => clearInterval(timer);
  }, [onComplete, ghost]);

  const visibleLabel = label.slice(0, anim.typeIdx);
  const cursor = anim.typeIdx < label.length ? "█" : "";
  const spin = RESTART_SPINNER[anim.spinIdx % RESTART_SPINNER.length];

  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={BRAND_PURPLE} attributes={TextAttributes.BOLD}>
        {anim.ghostFrame}
      </text>
      <box height={1} />
      <text>
        <span fg="#555">{visibleLabel}</span>
        <span fg={BRAND_RED}>{cursor}</span>
      </text>
      <box height={1} />
      <text fg="#333">{"─".repeat(30)}</text>
      <box height={1} />
      {RESTART_STEPS.map((step, i) => {
        if (i > anim.phase) return null;
        const done = i < anim.phase;
        return (
          <box key={step} gap={1} flexDirection="row">
            <text fg={done ? "#4a7" : BRAND_PURPLE}>{done ? "✓" : spin}</text>
            <text fg={done ? "#555" : "#aaa"}>{step}</text>
          </box>
        );
      })}
      <box height={1} />
      <text fg={BRAND_PURPLE} attributes={TextAttributes.BOLD}>
        {anim.wordmark}
      </text>
    </box>
  );
}

interface StartOptions {
  App: typeof AppComponent;
  createCliRenderer: typeof CreateCliRenderer;
  createRoot: typeof CreateRoot;
  config: AppConfig;
  projectConfig: Partial<AppConfig> | null;
  resumeSessionId?: string;
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  contextManager?: ContextManager;
}

function AppRoot({ opts }: { opts: StartOptions }) {
  const [appKey, setAppKey] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const [freshConfig, setFreshConfig] = useState(opts.config);
  const [freshProjectConfig, setFreshProjectConfig] = useState(opts.projectConfig);
  const [freshProviders, setFreshProviders] = useState(opts.bootProviders);
  const [freshPrereqs, setFreshPrereqs] = useState(opts.bootPrereqs);
  const [contextManager, setContextManager] = useState(opts.contextManager);

  useEffect(() => {
    triggerRestart = () => setRestarting(true);
    return () => {
      triggerRestart = null;
    };
  }, []);

  const handleRestartComplete = useCallback(async () => {
    resetStatusBarStore();
    resetUIStore();

    try {
      const { loadConfig, loadProjectConfig } = await import("./config/index.js");
      const { checkProviders } = await import("./core/llm/provider.js");
      const { checkPrerequisites } = await import("./core/setup/prerequisites.js");

      const newConfig = loadConfig();
      const newProjectConfig = loadProjectConfig(process.cwd());
      const [newProviders, newPrereqs] = await Promise.all([
        checkProviders(),
        Promise.resolve(checkPrerequisites()),
      ]);

      const kp = newProjectConfig?.keyPriority ?? newConfig.keyPriority;
      if (kp) {
        const { setDefaultKeyPriority } = await import("./core/secrets.js");
        setDefaultKeyPriority(kp);
      }

      setFreshConfig(newConfig);
      setFreshProjectConfig(newProjectConfig);
      setFreshProviders(newProviders);
      setFreshPrereqs(newPrereqs);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: intentional error surfacing on restart failure
      console.error("Restart config reload failed:", err);
    }
    // Batch all state updates to avoid 7 separate re-renders after await
    startTransition(() => {
      setContextManager(undefined);
      setExitSessionId(null);
      setAppKey((k) => k + 1);
      setRestarting(false);
    });
  }, []);

  if (restarting) {
    return <RestartSplash onComplete={handleRestartComplete} />;
  }

  return (
    <opts.App
      key={appKey}
      config={freshConfig}
      projectConfig={freshProjectConfig}
      resumeSessionId={appKey === 0 ? opts.resumeSessionId : undefined}
      bootProviders={freshProviders}
      bootPrereqs={freshPrereqs}
      preloadedContextManager={contextManager}
    />
  );
}

export async function start(opts: StartOptions): Promise<void> {
  const r = await opts.createCliRenderer({
    exitOnCtrlC: false,
    useKittyKeyboard: { disambiguate: true },
  });
  renderer = r;

  // 20+ components use useKeyboard/useOnResize concurrently — raise the
  // default EventEmitter limit (10) to suppress spurious leak warnings.
  r.setMaxListeners(30);
  r.keyInput.setMaxListeners(30);

  opts.createRoot(r).render(<AppRoot opts={opts} />);
}
