import { memo, type ReactNode, useMemo } from "react";
import { icon as iconFn } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import type { ThemeTokens } from "../../core/theme/tokens.js";
import { Overlay } from "../layout/shared.js";
import { KeyCaps } from "./KeyCap.js";
import { Flash, type FlashProps } from "./layout.js";

const BOLD = 1;

// ── Sidebar tabs ───────────────────────────────────────────────────────────

export interface SidebarTab<Id extends string = string> {
  id: Id;
  label: string;
  /** Nerd-font icon name (see core/icons.ts). */
  icon?: string;
  /** One-line blurb shown below active tab. Keep to ≤ 5 words. */
  blurb?: string;
  /** Optional status dot (e.g. running/paused). */
  status?: "online" | "offline" | "warning" | "error" | "idle";
  /** Disable the tab (greyed out, not selectable). */
  disabled?: boolean;
}

const TAB_STATUS_FG: Record<NonNullable<SidebarTab["status"]>, keyof ThemeTokens> = {
  online: "success",
  offline: "textDim",
  warning: "warning",
  error: "error",
  idle: "textFaint",
};

interface SidebarProps<Id extends string> {
  title: string;
  titleIcon?: string;
  tabs: SidebarTab<Id>[];
  active: Id;
  /** Optional status row at the bottom of the sidebar (e.g. "● up 2h 14m"). */
  footer?: ReactNode;
  width: number;
}

function SidebarImpl<Id extends string>({
  title,
  titleIcon,
  tabs,
  active,
  footer,
  width,
}: SidebarProps<Id>) {
  const t = useTheme();
  return (
    <box
      flexDirection="column"
      width={width}
      flexShrink={0}
      backgroundColor={t.bgPopup}
      paddingY={1}
      paddingX={1}
    >
      <box flexDirection="row" backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.brand} attributes={BOLD}>
          {titleIcon ? `${iconFn(titleIcon)}  ` : " "}
          {title}
        </text>
      </box>
      <box height={1} backgroundColor={t.bgPopup} />
      {tabs.map((tab, i) => {
        const isActive = tab.id === active;
        const bg = isActive ? t.bgPopupHighlight : t.bgPopup;
        const fg = tab.disabled ? t.textDim : isActive ? t.brand : t.textPrimary;
        const statusFg = tab.status ? t[TAB_STATUS_FG[tab.status]] : null;
        const glyph = isActive ? "▸" : " ";
        return (
          <box key={tab.id} flexDirection="column" backgroundColor={t.bgPopup}>
            {i > 0 ? <box height={1} backgroundColor={t.bgPopup} /> : null}
            <box flexDirection="row" height={1} backgroundColor={bg} paddingX={1}>
              <text bg={bg} fg={isActive ? t.brand : t.textFaint} attributes={BOLD}>
                {glyph}
              </text>
              <text bg={bg}> </text>
              {tab.icon ? (
                <text bg={bg} fg={fg}>
                  {iconFn(tab.icon)}{" "}
                </text>
              ) : null}
              <text bg={bg} fg={fg} attributes={isActive ? BOLD : undefined}>
                {tab.label}
              </text>
              {statusFg ? (
                <>
                  <box flexGrow={1} backgroundColor={bg} />
                  <text bg={bg} fg={statusFg}>
                    ●
                  </text>
                </>
              ) : null}
            </box>
          </box>
        );
      })}
      <box flexGrow={1} backgroundColor={t.bgPopup} />
      {footer ? (
        <>
          <box height={1} backgroundColor={t.bgPopup} />
          <box flexDirection="row" paddingX={1} backgroundColor={t.bgPopup}>
            {footer}
          </box>
        </>
      ) : null}
    </box>
  );
}

// Generic wrapper preserves Id inference without losing memo.
export const Sidebar = memo(SidebarImpl) as typeof SidebarImpl;

// ── Tab header (content-pane top band) ─────────────────────────────────────
// Shown at the top of the content pane when tabs are enabled. Displays the
// active tab's icon (in a tinted square), label, blurb, and optional status.

const TabHeader = memo(function TabHeader({ tab }: { tab: SidebarTab }) {
  const t = useTheme();
  const statusFg = tab.status ? t[TAB_STATUS_FG[tab.status]] : null;
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={t.bgPopup}>
      <box flexDirection="row" height={3} paddingX={2} paddingY={1} backgroundColor={t.bgElevated}>
        {tab.icon ? (
          <box
            flexDirection="column"
            width={5}
            height={1}
            justifyContent="center"
            alignItems="center"
            backgroundColor={t.bgPopupHighlight}
            flexShrink={0}
          >
            <text bg={t.bgPopupHighlight} fg={t.brand} attributes={BOLD}>
              {iconFn(tab.icon)}
            </text>
          </box>
        ) : null}
        <box width={2} backgroundColor={t.bgElevated} />
        <box flexDirection="column" flexGrow={1} backgroundColor={t.bgElevated}>
          <text bg={t.bgElevated} fg={t.textPrimary} attributes={BOLD}>
            {tab.label}
          </text>
          {tab.blurb ? (
            <text bg={t.bgElevated} fg={t.textFaint}>
              {tab.blurb}
            </text>
          ) : null}
        </box>
        {statusFg ? (
          <box flexDirection="row" alignItems="center" backgroundColor={t.bgElevated}>
            <text bg={t.bgElevated} fg={statusFg}>
              ●
            </text>
            <text bg={t.bgElevated} fg={t.textMuted}>
              {" "}
              {tab.status?.toUpperCase()}
            </text>
          </box>
        ) : null}
      </box>
    </box>
  );
});

// ── PremiumPopup ───────────────────────────────────────────────────────────

export interface PremiumPopupProps<Id extends string> {
  visible: boolean;
  /** Total outer width (border included). */
  width: number;
  /** Total outer height (border included). Must fit the terminal. */
  height: number;

  /** Popup title (bold, primary). Shown top-left of the sidebar. */
  title: string;
  titleIcon?: string;
  /** Subtitle rendered below the title (used only when no tabs are set). */
  blurb?: string;
  /** Status indicator in the header right side (used only when no tabs are set). */
  status?: SidebarTab["status"];

  /** Sidebar tab definitions. Omit to render content-only (no sidebar). */
  tabs?: SidebarTab<Id>[];
  activeTab?: Id;
  /** Content rendered in the sidebar footer (below the tabs). Ideal for global status. */
  sidebarFooter?: ReactNode;
  /** Sidebar column width. Default: 22. */
  sidebarWidth?: number;

  /** Body — rendered to the right of the sidebar (or full-width if no tabs). */
  children: ReactNode;

  /** Key hints in the footer. Rendered as `[key] label · [key] label · …`. */
  footerHints?: { key: string; label: string }[];

  /** Auto-dismissing toast line above the footer. */
  flash?: { kind: FlashProps["kind"]; message: string } | null;

  /** Border color override (default: brandAlt). */
  borderColor?: string;
}

function PremiumPopupImpl<Id extends string>({
  visible,
  width,
  height,
  title,
  titleIcon,
  blurb,
  status,
  tabs,
  activeTab,
  sidebarFooter,
  sidebarWidth = 22,
  children,
  footerHints,
  flash,
  borderColor,
}: PremiumPopupProps<Id>) {
  const t = useTheme();

  const hints = useMemo(() => footerHints ?? [], [footerHints]);
  const activeTabDef = useMemo<SidebarTab | null>(
    () =>
      tabs && activeTab
        ? (tabs.find((x) => x.id === activeTab) ?? null)
        : titleIcon || blurb || status
          ? { id: "__synthetic", label: title, icon: titleIcon, blurb, status }
          : null,
    [tabs, activeTab, title, titleIcon, blurb, status],
  );

  if (!visible) return null;

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor={borderColor ?? t.brandAlt}
        width={width}
        height={height}
        backgroundColor={t.bgPopup}
      >
        <box flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
          {tabs && activeTab ? (
            <>
              <Sidebar
                title={title}
                titleIcon={titleIcon}
                tabs={tabs}
                active={activeTab}
                footer={sidebarFooter}
                width={sidebarWidth}
              />
              <box flexDirection="column" width={1} flexShrink={0} backgroundColor={t.bgPopup}>
                {Array.from({ length: Math.max(0, height - 4) }, (_, i) => `vsep-${i}`).map((k) => (
                  <text key={k} bg={t.bgPopup} fg={t.textFaint}>
                    {"│"}
                  </text>
                ))}
              </box>
            </>
          ) : null}
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
            {activeTabDef ? (
              <TabHeader tab={activeTabDef} />
            ) : (
              <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
                <text bg={t.bgPopup} fg={t.textPrimary} attributes={BOLD}>
                  {title}
                </text>
              </box>
            )}
            {children}
          </box>
        </box>

        {hints.length > 0 ? (
          <box flexDirection="column" height={2} flexShrink={0} backgroundColor={t.bgPopup}>
            <box flexDirection="row" height={1} paddingX={1} backgroundColor={t.bgPopup}>
              <text bg={t.bgPopup} fg={t.textFaint}>
                {"─".repeat(Math.max(0, width - 4))}
              </text>
            </box>
            <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup}>
              <KeyCaps hints={hints} />
            </box>
          </box>
        ) : null}

        {flash ? <Flash kind={flash.kind} message={flash.message} /> : null}
      </box>
    </Overlay>
  );
}

export const PremiumPopup = memo(PremiumPopupImpl) as typeof PremiumPopupImpl;
