import { existsSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearPathCache,
  downloadRegistry,
  getAllPackageStatus,
  getRecommendedPackages,
  installPackage,
  loadRegistry,
  type MasonPackage,
  type PackageCategory,
  type PackageStatus,
  uninstallPackage,
  updatePackage,
} from "../../core/intelligence/backends/lsp/installer.js";
import { clearProbeCache } from "../../core/intelligence/backends/lsp/server-registry.js";
import { useTheme } from "../../core/theme/index.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { AppConfig } from "../../types/index.js";
import { type ConfigScope, POPUP_BG, POPUP_HL } from "../layout/shared.js";
import { PremiumPopup, Radio } from "../ui/index.js";

const MAX_POPUP_WIDTH = 130;
const CHROME_ROWS = 10;

type Tab = "search" | "installed" | "updates" | "disabled" | "recommended";
const TABS: Tab[] = ["search", "installed", "updates", "disabled", "recommended"];

type CategoryFilter = "All" | PackageCategory;
const CATEGORY_FILTERS: CategoryFilter[] = ["All", "LSP", "Formatter", "Linter", "DAP"];

interface Props {
  visible: boolean;
  cwd: string;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
  saveToScope: (patch: Partial<AppConfig>, toScope: ConfigScope, fromScope?: ConfigScope) => void;
  detectScope: (key: string) => ConfigScope;
  disabledServers: string[];
  initialTab?: Tab;
}

function methodLabel(status: PackageStatus): string {
  if (status.requiresToolchain && !status.toolchainAvailable) {
    return `[requires ${status.requiresToolchain}]`;
  }
  switch (status.installMethod) {
    case "npm":
      return "[npm]";
    case "pypi":
      return "[pip]";
    case "cargo":
      return "[cargo]";
    case "golang":
      return "[go]";
    case "github":
      return "[binary]";
    default:
      return "";
  }
}

function sourceLabel(status: PackageStatus): string {
  if (!status.installed) return "";
  switch (status.source) {
    case "PATH":
      return "✓ PATH";
    case "soulforge":
      return "✓ soulforge";
    case "mason":
      return "✓ mason";
    default:
      return "✓";
  }
}

function langLabel(pkg: MasonPackage): string {
  if (pkg.languages.length === 0) return "";
  if (pkg.languages.length <= 2) return pkg.languages.join(", ");
  return `${pkg.languages.slice(0, 2).join(", ")} +${pkg.languages.length - 2}`;
}

interface PackageRowProps {
  status: PackageStatus;
  isActive: boolean;
  isDisabled: boolean;
  isRecommended: boolean;
  innerW: number;
}

function PackageRow({
  status,
  isActive,
  isDisabled,
  isRecommended,
  innerW: _innerW,
}: PackageRowProps) {
  const t = useTheme();
  const bg = isActive ? POPUP_HL : POPUP_BG;
  const src = sourceLabel(status);
  const method = methodLabel(status);
  const lang = langLabel(status.pkg);
  const missingToolchain = status.requiresToolchain && !status.toolchainAvailable;

  const nameFg = isDisabled ? t.textMuted : isActive ? t.brandSecondary : t.textSecondary;

  const updateBadge = status.hasUpdate ? (
    <text bg={bg} fg={t.warning}>
      {" "}
      {status.installedVersion ?? "?"}
      {" → "}
      {status.registryVersion ?? "?"}
    </text>
  ) : null;

  const statusBadge = status.installed ? (
    <text bg={bg} fg={t.success}>
      {" "}
      {src}
    </text>
  ) : isRecommended ? (
    <text bg={bg} fg={t.info}>
      {" "}
      {"★ recommended"}
    </text>
  ) : method ? (
    <text bg={bg} fg={missingToolchain ? t.error : t.textFaint}>
      {" "}
      {method}
    </text>
  ) : null;

  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text bg={bg} fg={isActive ? t.brandSecondary : t.textMuted}>
        {isActive ? "› " : "  "}
      </text>
      <text bg={bg} fg={nameFg} attributes={isActive ? TextAttributes.BOLD : undefined}>
        {status.pkg.name}
      </text>
      {lang ? (
        <text bg={bg} fg={t.textMuted}>
          {" "}
          {lang}
        </text>
      ) : null}
      {statusBadge}
      {updateBadge}
      {isDisabled && (
        <text bg={bg} fg={t.error}>
          {" "}
          [disabled]
        </text>
      )}
    </box>
  );
}

export function LspInstallSearch({
  visible,
  cwd,
  onClose,
  onSystemMessage,
  saveToScope,
  detectScope,
  disabledServers,
  initialTab = "installed",
}: Props) {
  const t = useTheme();
  const pc = { bg: t.bgPopup, hl: t.bgPopupHighlight };
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("All");
  const [allStatus, setAllStatus] = useState<PackageStatus[]>([]);
  const [recommended, setRecommended] = useState<PackageStatus[]>([]);
  const [installing, setInstalling] = useState(false);
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<PackageStatus | null>(null);
  const defaultScopeCursor = detectScope("disabledLspServers") === "project" ? 0 : 1;
  const [scopeCursor, setScopeCursor] = useState(defaultScopeCursor);
  const downloadAttemptedRef = useRef(false);

  const isInProject = existsSync(join(cwd, ".git"));
  const { width: termCols, height: termRows } = useTerminalDimensions();

  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.9));
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.85) - CHROME_ROWS);
  const contentW = popupWidth - 22 - 3;
  const innerW = contentW;
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const refreshAll = useCallback(async () => {
    setRegistryLoading(true);
    await new Promise((r) => setTimeout(r, 16));
    const statuses = getAllPackageStatus();
    setAllStatus(statuses);
    setRegistryLoaded(statuses.length > 0);
    setRecommended(getRecommendedPackages(cwd));
    setRegistryLoading(false);
  }, [cwd]);

  useEffect(() => {
    if (!visible) return;
    setTab(initialTab);
    setQuery("");
    resetScroll();
    setCategoryFilter("All");
    setPendingToggle(null);

    const localPkgs = loadRegistry();
    if (localPkgs.length > 0) {
      refreshAll();
      return;
    }

    if (!downloadAttemptedRef.current) {
      downloadAttemptedRef.current = true;
      setRegistryLoading(true);
      downloadRegistry()
        .then(() => refreshAll())
        .catch(() => {
          onSystemMessage("Failed to download Mason registry");
          setRegistryLoading(false);
        });
    }
  }, [visible, onSystemMessage, resetScroll, initialTab, refreshAll]);

  const filterQuery = query.toLowerCase().trim();

  const filteredList = (() => {
    let list = allStatus;

    if (categoryFilter !== "All") {
      list = list.filter((s) => s.pkg.categories.includes(categoryFilter as PackageCategory));
    }

    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.description.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }

    return list;
  })();

  const installedList = (() => {
    let list = allStatus.filter((s) => s.installed);
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }
    return list;
  })();

  const disabledList = (() => {
    let list = allStatus.filter((s) => disabledServers.includes(s.pkg.name));
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }
    return list;
  })();

  const updatesList = (() => {
    let list = allStatus.filter((s) => s.hasUpdate);
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }
    return list;
  })();

  const filteredRecommended = (() => {
    if (!filterQuery) return recommended;
    return recommended.filter(
      (s) =>
        s.pkg.name.toLowerCase().includes(filterQuery) ||
        s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
    );
  })();

  const currentItems = ((): PackageStatus[] => {
    if (tab === "search") return filteredList;
    if (tab === "installed") return installedList;
    if (tab === "updates") return updatesList;
    if (tab === "disabled") return disabledList;
    return filteredRecommended;
  })();

  const recommendedNames = new Set(recommended.map((s) => s.pkg.name));

  const doInstall = async (status: PackageStatus) => {
    if (installing) return;
    if (status.installed) {
      onSystemMessage(`${status.pkg.name} is already installed`);
      return;
    }
    if (status.requiresToolchain && !status.toolchainAvailable) {
      onSystemMessage(
        `Cannot install ${status.pkg.name}: requires ${status.requiresToolchain} which is not available`,
      );
      return;
    }

    setInstalling(true);
    onSystemMessage(`Installing ${status.pkg.name}...`);

    try {
      const result = await installPackage(status.pkg, (msg) => onSystemMessage(msg));
      if (result.success) {
        onSystemMessage(`✓ ${status.pkg.name} installed successfully`);
        clearProbeCache();
        clearPathCache();
        refreshAll();
      } else {
        onSystemMessage(`✗ Failed to install ${status.pkg.name}: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSystemMessage(`✗ Failed to install ${status.pkg.name}: ${msg}`);
    } finally {
      setInstalling(false);
    }
  };

  const doUpdate = async (status: PackageStatus) => {
    if (installing) return;
    if (!status.hasUpdate) {
      onSystemMessage(`${status.pkg.name} is already up to date`);
      return;
    }

    setInstalling(true);
    try {
      const result = await updatePackage(status.pkg, (msg) => onSystemMessage(msg));
      if (result.success) {
        onSystemMessage(`✓ ${status.pkg.name} updated to ${status.registryVersion ?? "latest"}`);
        clearProbeCache();
        clearPathCache();
        refreshAll();
      } else {
        onSystemMessage(`✗ Failed to update ${status.pkg.name}: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSystemMessage(`✗ Failed to update ${status.pkg.name}: ${msg}`);
    } finally {
      setInstalling(false);
    }
  };

  const doUninstall = async (status: PackageStatus) => {
    if (installing) return;
    if (!status.installed || status.source !== "soulforge") {
      onSystemMessage(
        status.source === "PATH"
          ? `${status.pkg.name} is in system PATH — uninstall it with your package manager`
          : status.source === "mason"
            ? `${status.pkg.name} is installed via Mason — uninstall it from Neovim`
            : `${status.pkg.name} is not installed by SoulForge`,
      );
      return;
    }

    setInstalling(true);
    onSystemMessage(`Uninstalling ${status.pkg.name}...`);

    try {
      const result = await uninstallPackage(status.pkg, (msg) => onSystemMessage(msg));
      if (result.success) {
        onSystemMessage(`✓ ${status.pkg.name} uninstalled`);
        clearProbeCache();
        clearPathCache();
        refreshAll();
      } else {
        onSystemMessage(`✗ Failed to uninstall ${status.pkg.name}: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSystemMessage(`✗ Failed to uninstall ${status.pkg.name}: ${msg}`);
    } finally {
      setInstalling(false);
    }
  };

  const toggleDisabled = (pkgName: string, scope: ConfigScope) => {
    const isDisabledPkg = disabledServers.includes(pkgName);
    const updated = isDisabledPkg
      ? disabledServers.filter((n) => n !== pkgName)
      : [...disabledServers, pkgName];
    saveToScope({ disabledLspServers: updated }, scope);
    clearProbeCache();
    onSystemMessage(isDisabledPkg ? `${pkgName} enabled` : `${pkgName} disabled (${scope})`);
  };

  const handleKeyboard = (evt: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (!visible) return;

    if (pendingToggle) {
      if (evt.name === "escape") {
        setPendingToggle(null);
        return;
      }
      if (evt.name === "up" || evt.name === "down") {
        setScopeCursor((prev) => (prev === 0 ? 1 : 0));
        return;
      }
      if (evt.name === "return") {
        const scope: ConfigScope = isInProject
          ? scopeCursor === 0
            ? "project"
            : "global"
          : "global";
        toggleDisabled(pendingToggle.pkg.name, scope);
        setPendingToggle(null);
        return;
      }
      return;
    }

    if (evt.name === "escape") {
      onClose();
      return;
    }

    if (evt.name === "tab") {
      const idx = TABS.indexOf(tab);
      const next = TABS[(idx + 1) % TABS.length] as Tab;
      setTab(next);
      setQuery("");
      resetScroll();
      return;
    }

    if (evt.name === "f" && evt.ctrl) {
      const idx = CATEGORY_FILTERS.indexOf(categoryFilter);
      setCategoryFilter(CATEGORY_FILTERS[(idx + 1) % CATEGORY_FILTERS.length] as CategoryFilter);
      resetScroll();
      return;
    }

    if (evt.name === "up") {
      const len = currentItems.length;
      setCursor((prev) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, len - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      const len = currentItems.length;
      setCursor((prev) => {
        const next = prev < len - 1 ? prev + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "return") {
      const item = currentItems[cursor];
      if (!item) return;

      if (tab === "updates") {
        doUpdate(item);
      } else if (tab === "installed" || tab === "disabled") {
        if (isInProject) {
          setPendingToggle(item);
          setScopeCursor(0);
        } else {
          toggleDisabled(item.pkg.name, "global");
        }
      } else {
        doInstall(item);
      }
      return;
    }

    if (evt.name === "d" && evt.ctrl) {
      const item = currentItems[cursor];
      if (!item) return;
      if (isInProject) {
        setPendingToggle(item);
        setScopeCursor(0);
      } else {
        toggleDisabled(item.pkg.name, "global");
      }
      return;
    }

    if (evt.name === "u" && evt.ctrl) {
      const item = currentItems[cursor];
      if (!item) return;
      doUninstall(item);
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name === "space") {
      setQuery((prev) => `${prev} `);
      resetScroll();
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((prev) => prev + evt.name);
      resetScroll();
    }
  };

  useKeyboard(handleKeyboard);

  if (!visible) return null;
  const visibleItems = currentItems.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <PremiumPopup
      visible={visible}
      width={popupWidth}
      height={Math.min(Math.max(20, Math.floor(termRows * 0.85)), termRows - 2)}
      title="LSP Servers"
      titleIcon="code"
      tabs={[
        { id: "search", label: "Search", icon: "search", blurb: "find packages" },
        { id: "installed", label: "Installed", icon: "folder", blurb: "manage installed" },
        { id: "updates", label: "Updates", icon: "refresh", blurb: "available upgrades" },
        { id: "disabled", label: "Disabled", icon: "ban", blurb: "paused servers" },
        { id: "recommended", label: "Recommended", icon: "sparkle", blurb: "curated picks" },
      ]}
      activeTab={tab}
      footerHints={[
        { key: "↑↓", label: "nav" },
        {
          key: "Enter",
          label:
            tab === "updates"
              ? "update"
              : tab === "installed" || tab === "disabled"
                ? "toggle"
                : "install",
        },
        { key: "^D", label: "disable" },
        { key: "^U", label: "uninstall" },
        { key: "^F", label: "category" },
        { key: "Tab", label: "tab" },
        { key: "Esc", label: "close" },
      ]}
    >
      <box flexDirection="row" backgroundColor={POPUP_BG}>
        <text fg={t.textFaint} bg={POPUP_BG}>
          {"─".repeat(innerW - 4)}
        </text>
      </box>

      <box flexDirection="row" backgroundColor={pc.hl}>
        <text fg={t.brand} bg={pc.hl}>
          {"🔍 "}
        </text>
        {query ? (
          <>
            <text fg={t.textPrimary} bg={pc.hl}>
              {query}
            </text>
            <text fg={t.brandSecondary} bg={pc.hl}>
              {"█"}
            </text>
          </>
        ) : (
          <>
            <text fg={t.brandSecondary} bg={pc.hl}>
              {"█"}
            </text>
            <text fg={t.textMuted} bg={pc.hl}>
              {tab === "search"
                ? "type to search 576+ packages..."
                : tab === "installed"
                  ? "type to filter installed..."
                  : tab === "disabled"
                    ? "type to filter disabled..."
                    : "type to filter recommended..."}
            </text>
          </>
        )}
        <text fg={t.textFaint} bg={pc.hl}>
          {`  ${String(currentItems.length)} results`}
        </text>
        {tab === "search" && categoryFilter !== "All" && (
          <text fg={t.info} bg={pc.hl}>
            {`  [${categoryFilter}]`}
          </text>
        )}
      </box>
      <box height={1} backgroundColor={POPUP_BG} />

      {registryLoading ? (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.brand} bg={POPUP_BG}>
            {registryLoaded ? "scanning installed packages..." : "loading Mason registry..."}
          </text>
        </box>
      ) : !registryLoaded ? (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            no registry available — install Mason or check network
          </text>
        </box>
      ) : (
        <box
          flexDirection="column"
          height={Math.min(currentItems.length || 1, maxVisible)}
          overflow="hidden"
        >
          {currentItems.length === 0 ? (
            <box flexDirection="row" backgroundColor={POPUP_BG}>
              <text fg={t.textMuted} bg={POPUP_BG}>
                {query ? "no matching packages" : "no packages"}
              </text>
            </box>
          ) : (
            visibleItems.map((status, i) => {
              const idx = scrollOffset + i;
              return (
                <PackageRow
                  key={status.pkg.name}
                  status={status}
                  isActive={idx === cursor}
                  isDisabled={disabledServers.includes(status.pkg.name)}
                  isRecommended={recommendedNames.has(status.pkg.name)}
                  innerW={innerW}
                />
              );
            })
          )}
        </box>
      )}

      {currentItems.length > maxVisible && (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.textMuted} bg={POPUP_BG}>
            {scrollOffset > 0 ? "↑ " : "  "}
            {String(cursor + 1)}/{String(currentItems.length)}
            {scrollOffset + maxVisible < currentItems.length ? " ↓" : ""}
          </text>
        </box>
      )}

      {pendingToggle && (
        <>
          <box height={1} backgroundColor={POPUP_BG} />
          <box flexDirection="row" backgroundColor={POPUP_BG}>
            <text fg={t.textPrimary} attributes={TextAttributes.BOLD} bg={POPUP_BG}>
              {disabledServers.includes(pendingToggle.pkg.name) ? "Enable" : "Disable"} "
              {pendingToggle.pkg.name}" scope:
            </text>
          </box>
          {(["Project", "Global"] as const).map((label, i) => (
            <Radio
              key={label}
              label={label}
              selected={i === scopeCursor}
              focused={i === scopeCursor}
            />
          ))}
        </>
      )}

      {installing && (
        <box flexDirection="row" backgroundColor={POPUP_BG}>
          <text fg={t.brand} bg={POPUP_BG}>
            installing...
          </text>
        </box>
      )}
    </PremiumPopup>
  );
}
