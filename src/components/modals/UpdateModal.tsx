import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { garble } from "../../core/utils/splash.js";
import {
  type ChangelogCommit,
  type ChangelogRelease,
  dismissVersion,
  getUpgradeCommand,
  performUpgrade,
} from "../../core/version.js";
import { useVersionStore } from "../../stores/version.js";
import { POPUP_BG } from "../layout/shared.js";
import { PremiumPopup, Divider, VSpacer } from "../ui/index.js";

type Phase = "info" | "upgrading" | "success" | "failed";

const UPGRADE_QUIPS = [
  "Heating the forge…",
  "Melting down the old version…",
  "Pouring molten code into the mold…",
  "Hammering out the bugs…",
  "Quenching in liquid nitrogen…",
  "Polishing the new blade…",
  "Enchanting with fresh runes…",
  "Consulting the package spirits…",
  "Negotiating with the registry gods…",
  "Bribing the dependency elves…",
  "Aligning the semantic versions…",
  "Reticulating splines…",
  "Convincing npm to cooperate…",
  "Performing arcane rituals…",
  "Almost there, forgemaster…",
];

const LATEST_QUIPS = [
  "The forge burns bright — you're on the cutting edge.",
  "No updates. The blade is already sharp.",
  "You're running the latest. The gods are pleased.",
  "Peak version achieved. Nothing to see here.",
  "Already forged to perfection.",
  "The scrolls confirm: you're up to date.",
  "No new runes to inscribe today.",
  "Your version is so fresh it's still warm.",
];

const CHANGELOG_ERROR_QUIPS = [
  "The scroll courier didn't make it — changelog unavailable",
  "The raven carrying the changelog was lost to the void",
  "The archive gates are sealed — try again later",
  "The changelog runes could not be summoned",
  "The forge's scrying pool is clouded — no changelog today",
  "The record keeper is away from the anvil",
  "The changelog embers have gone cold — GitHub unreachable",
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GHOST_FADE = ["░", "▒", "▓"];
const WISP = ["~∿~", "∿~∿", "·∿·", "∿·∿"];
const MAX_LOG = 50;
const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;
const DIM = TextAttributes.DIM;

// ── Helpers ────────────────────────────────────────────────────────

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function Hr({ w, bg }: { w: number; bg: string; fg?: string }) {
  return <Divider width={w - 4} bg={bg} />;
}

function Gap({ bg, n = 1 }: { w?: number; bg: string; n?: number }) {
  return <VSpacer rows={n} bg={bg} />;
}

const TYPE_BADGE: Record<
  ChangelogCommit["type"],
  {
    label: string;
    color: keyof ThemeTokens;
  }
> = {
  feat: { label: "feat", color: "success" },
  fix: { label: "fix", color: "brandSecondary" },
  perf: { label: "perf", color: "brandAlt" },
  refactor: { label: "refac", color: "textSecondary" },
  docs: { label: "docs", color: "textMuted" },
  other: { label: "misc", color: "textMuted" },
};

function ChangelogSection({
  releases,
  maxLines,
  iw,
  bg,
  t,
}: {
  releases: ChangelogRelease[];
  maxLines: number;
  iw: number;
  bg: string;
  t: ThemeTokens;
}) {
  // Flatten all commits across releases into renderable rows
  const rows: Array<
    { type: "header"; version: string; date?: string } | { type: "commit"; commit: ChangelogCommit }
  > = [];
  for (const rel of releases) {
    rows.push({ type: "header", version: rel.version, date: rel.date });
    for (const c of rel.commits) {
      rows.push({ type: "commit", commit: c });
    }
  }

  const visible = rows.slice(0, maxLines);
  const remaining = rows.length - visible.length;

  return (
    <>
      <box flexDirection="column" height={Math.min(rows.length, maxLines)} overflow="hidden">
        {visible.map((row, i) => {
          if (row.type === "header") {
            return (
              <box key={String(i)} flexDirection="row" backgroundColor={bg}>
                <text bg={bg}>
                  <span fg={t.brand} attributes={BOLD}>
                    {"  "}v{row.version}
                  </span>
                  {row.date && (
                    <span fg={t.textFaint} attributes={DIM}>
                      {" "}
                      {row.date}
                    </span>
                  )}
                </text>
              </box>
            );
          }
          const badge = TYPE_BADGE[row.commit.type] ?? TYPE_BADGE.other;
          const scope = row.commit.scope ? `(${row.commit.scope}) ` : "";
          const breakingMark = row.commit.breaking ? " !!" : "";
          return (
            <box key={String(i)} flexDirection="row" backgroundColor={bg}>
              <text bg={bg}>
                <span fg={t[badge.color] ?? t.textMuted}>
                  {"    "}
                  {badge.label.padEnd(5)}
                </span>
                <span fg={t.textFaint}>{" │ "}</span>
                {row.commit.breaking ? (
                  <span fg={t.brandSecondary} attributes={BOLD}>
                    {trunc(`${scope}${row.commit.message}${breakingMark}`, iw - 16)}
                  </span>
                ) : (
                  <span fg={t.textSecondary}>
                    {trunc(`${scope}${row.commit.message}`, iw - 16)}
                  </span>
                )}
              </text>
            </box>
          );
        })}
      </box>
      {remaining > 0 && (
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} fg={t.textFaint} attributes={DIM}>
            {"      "}… and {remaining} more
          </text>
        </box>
      )}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function UpdateModal({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const {
    current,
    latest,
    changelog,
    currentRelease,
    changelogError,
    installMethod,
    updateAvailable,
  } = useVersionStore();
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<Phase>("info");
  const [quipIdx, setQuipIdx] = useState(0);
  const [spinIdx, setSpinIdx] = useState(0);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const upgrading = useRef(false);

  // Entrance animation
  const [tick, setTick] = useState(0);
  const prevVisible = useRef(false);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      setTick(0);
      setPhase("info");
    }
    prevVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!visible || tick >= 12) return;
    const timer = setInterval(() => setTick((prev) => prev + 1), 60);
    return () => clearInterval(timer);
  }, [visible, tick]);

  const pw = Math.min(76, Math.floor(termCols * 0.9));
  const iw = pw - 2;
  const maxChangelog = Math.max(6, Math.floor(termRows * 0.5) - 10);
  const logH = Math.max(3, Math.min(6, Math.floor(termRows * 0.2)));
  const bg = POPUP_BG;

  // Animate spinner + cycle quips during upgrade
  useEffect(() => {
    if (phase !== "upgrading") return;
    const s = setInterval(() => setSpinIdx((i) => i + 1), 80);
    const q = setInterval(() => setQuipIdx((i) => (i + 1) % UPGRADE_QUIPS.length), 2500);
    return () => {
      clearInterval(s);
      clearInterval(q);
    };
  }, [phase]);

  const doUpgrade = useCallback(async () => {
    if (upgrading.current) return;
    upgrading.current = true;
    setPhase("upgrading");
    setLogLines([]);
    setErrorMsg("");
    setQuipIdx(0);

    const result = await performUpgrade(installMethod, (msg) => {
      setLogLines((prev) => {
        const next = [...prev, msg];
        return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
      });
    });

    if (result.ok) {
      setPhase("success");
    } else {
      setPhase("failed");
      setErrorMsg(result.error ?? "Unknown error");
    }
    upgrading.current = false;
  }, [installMethod]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (phase === "upgrading") return;

    if (phase === "success") {
      if (evt.name === "escape" || evt.name === "return") {
        setPhase("info");
        onClose();
        return;
      }
      return;
    }

    if (phase === "failed") {
      if (evt.name === "escape" || evt.name === "return") {
        setPhase("info");
        return;
      }
      return;
    }

    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }
    if (evt.name === "u" && updateAvailable && installMethod !== "binary") {
      doUpgrade();
      return;
    }
    if (evt.name === "d") {
      if (latest) dismissVersion(latest);
      onClose();
      return;
    }
    if (evt.name === "c") {
      try {
        const b64 = Buffer.from(getUpgradeCommand(installMethod)).toString("base64");
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
    if (evt.name === "g") {
      const tag = updateAvailable ? latest : current;
      const url = tag
        ? `https://github.com/ProxySoul/soulforge/releases/tag/v${tag}`
        : "https://github.com/ProxySoul/soulforge/releases";
      try {
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {}
    }
  });

  if (!visible) return null;

  const upgradeCmd = getUpgradeCommand(installMethod);
  const canAuto = installMethod !== "binary" && installMethod !== "unknown" && updateAvailable;
  const isBinary = installMethod === "binary" || installMethod === "unknown";
  const releaseUrl = latest
    ? `https://github.com/ProxySoul/soulforge/releases/tag/v${latest}`
    : "https://github.com/ProxySoul/soulforge/releases";
  const ghostIc = icon("ghost");
  const sparkle = icon("sparkle");
  const checkIc = icon("check");
  const errorIc = icon("error");
  const arrowIc = icon("arrow_right");

  // Entrance animation values
  const ghostChar = tick < GHOST_FADE.length ? (GHOST_FADE[tick] ?? "░") : ghostIc;
  const wispFrame = WISP[tick % WISP.length] ?? "";
  const titleReady = tick >= 4;
  const vCurrent = tick < 6 ? garble(`v${current}`) : `v${current}`;
  const vLatest = tick < 7 ? garble(`v${latest ?? current}`) : `v${latest ?? current}`;

  // ── Success: ask user to restart manually ─────────────────────────
  if (phase === "success") {
    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(22, termRows - 2)}
        borderColor={t.success}
        title="Upgrade Complete"
        titleIcon="check"
      >
        <box flexDirection="column">
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.success} attributes={BOLD}>
                {checkIc} Upgrade Complete!
              </span>
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandDim} attributes={DIM}>
              {"  "}∿~∿
            </text>
          </box>
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textPrimary}>{"  "}Successfully upgraded to </span>
              <span fg={t.success} attributes={BOLD}>
                v{latest}
              </span>
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.textSecondary} attributes={ITALIC}>
              {"  "}The forge has been retempered.
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandAlt}>
              {"  "}Please close and restart SoulForge to use the new version.
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} truncate>
              <span fg={t.textFaint}> {"<Esc>"} close</span>
            </text>
          </box>
        </box>
      </PremiumPopup>
    );
  }

  // ── Upgrading: spinner + quips + live log ────────────────────────
  if (phase === "upgrading") {
    const spin = SPINNER[spinIdx % SPINNER.length];
    const quip = UPGRADE_QUIPS[quipIdx % UPGRADE_QUIPS.length] ?? "";
    const visibleLog = logLines.slice(-logH);

    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(24, termRows - 2)}
        borderColor={t.brand}
        title="Upgrading"
        titleIcon="sparkle"
      >
        <box flexDirection="column">
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brand} attributes={BOLD}>
              {ghostIc} Upgrading SoulForge…
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandDim} attributes={DIM}>
              {"  "}∿~∿
            </text>
          </box>
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.brand}> {spin}</span>
              <span fg={t.brandAlt} attributes={ITALIC}>
                {" "}
                {trunc(quip, iw - 8)}
              </span>
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <box flexDirection="column" height={logH} overflow="hidden">
            {visibleLog.length === 0 ? (
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={t.textFaint}>
                  {"  "}Waiting for output…
                </text>
              </box>
            ) : (
              visibleLog.map((line, i) => (
                <box key={String(i)} flexDirection="row" backgroundColor={bg}>
                  <text bg={bg} fg={i === visibleLog.length - 1 ? t.textSecondary : t.textFaint}>
                    {"  "}
                    {trunc(line, iw - 6)}
                  </text>
                </box>
              ))
            )}
          </box>
          <Hr w={iw} bg={bg} fg={t.textFaint} />
        </box>
      </PremiumPopup>
    );
  }

  // ── Failed: error + manual command ───────────────────────────────
  if (phase === "failed") {
    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(22, termRows - 2)}
        borderColor={t.brandSecondary}
        title="Upgrade Failed"
        titleIcon="error"
      >
        <box
          flexDirection="column"
          borderStyle={undefined}
          border={undefined}
          borderColor={t.brandSecondary}
          width={pw}
        >
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandSecondary} attributes={BOLD}>
              {errorIc} The Forge Sputtered
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandDim} attributes={DIM}>
              {"  "}∿~∿
            </text>
          </box>
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandSecondary}>
              {"  "}
              {trunc(errorMsg, iw - 6)}
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.textMuted} attributes={ITALIC}>
              {"  "}The spirits suggest a manual approach:
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textFaint}>
                {"    "}
                {arrowIc}{" "}
              </span>
              <span fg={t.brand} attributes={BOLD}>
                {trunc(upgradeCmd, iw - 10)}
              </span>
            </text>
          </box>
          <Gap w={iw} bg={bg} />
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.textMuted}>
              {" "}
              {"<Esc>"} back
            </text>
          </box>
        </box>
      </PremiumPopup>
    );
  }

  // ── Info: no update available (already on latest) ────────────────
  if (!updateAvailable) {
    const quip = LATEST_QUIPS[Math.floor(Date.now() / 60000) % LATEST_QUIPS.length] ?? "";
    const clErrorQuip =
      CHANGELOG_ERROR_QUIPS[Math.floor(Date.now() / 60000) % CHANGELOG_ERROR_QUIPS.length] ?? "";

    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(26, termRows - 2)}
        borderColor={t.brand}
        title="Update Available"
        titleIcon="sparkle"
      >
        <box flexDirection="column">
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.brand} attributes={BOLD}>
                {" "}
                {ghostChar}{" "}
              </span>
              <span fg={t.textPrimary} attributes={BOLD}>
                {titleReady ? "SoulForge" : garble("SoulForge")}
              </span>
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} fg={t.brandDim} attributes={DIM}>
              {"   "}
              {wispFrame}
            </text>
          </box>
          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <Gap w={iw} bg={bg} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textMuted}>
                {"  "}
                {icon("check")} Version{" "}
              </span>
              <span fg={t.success} attributes={BOLD}>
                {vCurrent}
              </span>
              <span fg={t.textFaint}> — latest</span>
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textMuted}>
                {"  "}
                {icon("wrench")} Via{" "}
              </span>
              <span fg={t.textSecondary}>{installMethod}</span>
            </text>
          </box>
          <Gap w={iw} bg={bg} />

          {/* Current version changelog */}
          {currentRelease && currentRelease.commits.length > 0 ? (
            <>
              <Hr w={iw} bg={bg} fg={t.textFaint} />
              <Gap w={iw} bg={bg} />
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={t.brandAlt} attributes={BOLD}>
                  {"  "}What's in this version
                </text>
              </box>
              <Gap w={iw} bg={bg} />
              <ChangelogSection
                releases={[currentRelease]}
                maxLines={maxChangelog}
                iw={iw}
                bg={bg}
                t={t}
              />
              <Gap w={iw} bg={bg} />
            </>
          ) : changelogError ? (
            <>
              <Hr w={iw} bg={bg} fg={t.textFaint} />
              <Gap w={iw} bg={bg} />
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={t.error} attributes={ITALIC}>
                  {"  "}
                  {icon("warning")} {clErrorQuip}
                </text>
              </box>
              <Gap w={iw} bg={bg} />
            </>
          ) : (
            <>
              <Hr w={iw} bg={bg} fg={t.textFaint} />
              <Gap w={iw} bg={bg} />
              <box flexDirection="row" backgroundColor={bg}>
                <text bg={bg} fg={t.brandAlt} attributes={ITALIC}>
                  {"  "}
                  {quip}
                </text>
              </box>
              <Gap w={iw} bg={bg} />
            </>
          )}

          <Hr w={iw} bg={bg} fg={t.textFaint} />
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg} truncate>
              <span fg={t.brandDim}>
                {" "}
                {icon("globe")} {"<G>"}
              </span>
              <span fg={t.textFaint}> view full changelog on GitHub</span>
              <span fg={t.textFaint}>{"  "}</span>
              <span fg={t.textFaint}>{"<Esc>"}</span>
            </text>
          </box>
        </box>
      </PremiumPopup>
    );
  }

  // ── Info: update available ───────────────────────────────────────
  return (
    <PremiumPopup
      visible={visible}
      width={pw}
      height={Math.min(22, termRows - 2)}
      borderColor={t.success}
      title="Check for Updates"
      titleIcon="sparkle"
    >
      <box flexDirection="column">
        <Gap w={iw} bg={bg} />
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.success} attributes={BOLD}>
              {" "}
              {ghostChar}{" "}
            </span>
            <span fg={t.success} attributes={BOLD}>
              {titleReady ? `${sparkle} Update Available` : garble("Update Available")}
            </span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} fg={t.brandDim} attributes={DIM}>
            {"   "}
            {wispFrame}
          </text>
        </box>
        <Hr w={iw} bg={bg} fg={t.textFaint} />
        <Gap w={iw} bg={bg} />

        {/* Version info with icons */}
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>
              {"  "}
              {icon("clock")} Current{" "}
            </span>
            <span fg={t.textPrimary}>{vCurrent}</span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>
              {"  "}
              {sparkle} Latest{" "}
            </span>
            <span fg={t.success} attributes={BOLD}>
              {vLatest}
            </span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>
              {"  "}
              {icon("wrench")} Via{" "}
            </span>
            <span fg={t.textSecondary}>{installMethod}</span>
          </text>
        </box>
        <Gap w={iw} bg={bg} />

        {/* Changelog */}
        {changelog.length > 0 ? (
          <>
            <Hr w={iw} bg={bg} fg={t.textFaint} />
            <Gap w={iw} bg={bg} />
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={t.brandAlt} attributes={BOLD}>
                {"  "}What's new
              </text>
            </box>
            <Gap w={iw} bg={bg} />
            <ChangelogSection releases={changelog} maxLines={maxChangelog} iw={iw} bg={bg} t={t} />
            <Gap w={iw} bg={bg} />
          </>
        ) : changelogError ? (
          <>
            <Hr w={iw} bg={bg} fg={t.textFaint} />
            <Gap w={iw} bg={bg} />
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={t.error} attributes={ITALIC}>
                {"  "}
                {icon("warning")}{" "}
                {
                  CHANGELOG_ERROR_QUIPS[
                    Math.floor(Date.now() / 60000) % CHANGELOG_ERROR_QUIPS.length
                  ]
                }
              </text>
            </box>
            <Gap w={iw} bg={bg} />
          </>
        ) : null}

        {/* Upgrade command */}
        <Hr w={iw} bg={bg} fg={t.textFaint} />
        <Gap w={iw} bg={bg} />
        {isBinary ? (
          <>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={t.textMuted}>
                {"  "}
                {icon("globe")} Download from GitHub
              </text>
            </box>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg}>
                <span fg={t.textFaint}>
                  {"    "}
                  {arrowIc}{" "}
                </span>
                <span fg={t.brand} attributes={BOLD}>
                  {trunc(releaseUrl, iw - 10)}
                </span>
              </text>
            </box>
          </>
        ) : (
          <>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg} fg={t.textMuted}>
                {"  "}
                {icon("terminal")} Upgrade command
              </text>
            </box>
            <box flexDirection="row" backgroundColor={bg}>
              <text bg={bg}>
                <span fg={t.textFaint}>
                  {"    "}
                  {arrowIc}{" "}
                </span>
                <span fg={t.brand} attributes={BOLD}>
                  {trunc(upgradeCmd, iw - 10)}
                </span>
              </text>
            </box>
          </>
        )}
        <Gap w={iw} bg={bg} />

        {/* Footer */}
        <Hr w={iw} bg={bg} fg={t.textFaint} />
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} truncate>
            {canAuto && (
              <>
                <span fg={t.success} attributes={BOLD}>
                  {" "}
                  {arrowIc} {"<U>"}
                </span>
                <span fg={t.textMuted}> upgrade</span>
                <span fg={t.textFaint}>{"  "}</span>
              </>
            )}
            {!isBinary && (
              <span fg={copied ? t.success : t.textFaint}>
                {copied ? " ✓ copied" : " <C> copy"}
              </span>
            )}
            <span fg={t.textFaint}>{"  "}</span>
            <span fg={t.textFaint}>{"<D>"} dismiss</span>
            <span fg={t.textFaint}>{"  "}</span>
            <span fg={t.textFaint}>{"<Esc>"}</span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} truncate>
            <span fg={t.brandDim}>
              {" "}
              {icon("globe")} {"<G>"}
            </span>
            <span fg={t.textFaint}>
              {isBinary ? " open release on GitHub" : " view full changelog on GitHub"}
            </span>
          </text>
        </box>
      </box>
    </PremiumPopup>
  );
}
