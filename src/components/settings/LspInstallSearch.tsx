import { existsSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../../core/intelligence/backends/lsp/installer.js";
import { clearProbeCache } from "../../core/intelligence/backends/lsp/server-registry.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import type { AppConfig } from "../../types/index.js";

import { type ConfigScope, Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 110;
const CHROME_ROWS = 10;

type Tab = "search" | "installed" | "disabled" | "recommended";
const TABS: Tab[] = ["search", "installed", "disabled", "recommended"];
const TAB_LABELS: Record<Tab, string> = {
  search: "Search",
  installed: "Installed",
  disabled: "Disabled",
  recommended: "Recommended",
};

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

export const LspInstallSearch = memo(function LspInstallSearch({
  visible,
  cwd,
  onClose,
  onSystemMessage,
  saveToScope,
  detectScope,
  disabledServers,
  initialTab = "installed",
}: Props) {
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
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.85));
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS);
  const innerW = popupWidth - 2;
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  // Async refresh — defers the heavy checkPackageStatus calls off the first paint
  const refreshAll = useCallback(async () => {
    setRegistryLoading(true);
    // Yield to let the modal paint first
    await new Promise((r) => setTimeout(r, 16));
    const statuses = getAllPackageStatus();
    setAllStatus(statuses);
    setRegistryLoaded(statuses.length > 0);
    setRecommended(getRecommendedPackages(cwd));
    setRegistryLoading(false);
  }, [cwd]);

  // Load registry on open
  useEffect(() => {
    if (!visible) return;
    setTab(initialTab);
    setQuery("");
    resetScroll();
    setCategoryFilter("All");
    setPendingToggle(null);

    // Try local first
    const localPkgs = loadRegistry();
    if (localPkgs.length > 0) {
      refreshAll();
      return;
    }

    // Download if not available
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
  }, [visible, refreshAll, onSystemMessage, resetScroll, initialTab]);

  // Filter logic
  const filterQuery = query.toLowerCase().trim();

  const filteredList = useMemo(() => {
    let list = allStatus;

    // Category filter
    if (categoryFilter !== "All") {
      list = list.filter((s) => s.pkg.categories.includes(categoryFilter as PackageCategory));
    }

    // Text search
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.description.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }

    return list;
  }, [allStatus, categoryFilter, filterQuery]);

  const installedList = useMemo(() => {
    let list = allStatus.filter((s) => s.installed);
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }
    return list;
  }, [allStatus, filterQuery]);

  const disabledList = useMemo(() => {
    let list = allStatus.filter((s) => disabledServers.includes(s.pkg.name));
    if (filterQuery) {
      list = list.filter(
        (s) =>
          s.pkg.name.toLowerCase().includes(filterQuery) ||
          s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
      );
    }
    return list;
  }, [allStatus, disabledServers, filterQuery]);

  const filteredRecommended = useMemo(() => {
    if (!filterQuery) return recommended;
    return recommended.filter(
      (s) =>
        s.pkg.name.toLowerCase().includes(filterQuery) ||
        s.pkg.languages.some((l) => l.toLowerCase().includes(filterQuery)),
    );
  }, [recommended, filterQuery]);

  const currentItems = (): PackageStatus[] => {
    if (tab === "search") return filteredList;
    if (tab === "installed") return installedList;
    if (tab === "disabled") return disabledList;
    return filteredRecommended;
  };

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
    const isDisabled = disabledServers.includes(pkgName);
    const updated = isDisabled
      ? disabledServers.filter((n) => n !== pkgName)
      : [...disabledServers, pkgName];
    saveToScope({ disabledLspServers: updated }, scope);
    clearProbeCache();
    onSystemMessage(isDisabled ? `${pkgName} enabled` : `${pkgName} disabled (${scope})`);
  };

  useKeyboard((evt) => {
    if (!visible) return;

    // Scope picker sub-modal
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

    // Cycle category filter with Ctrl+F
    if (evt.name === "f" && evt.ctrl) {
      const idx = CATEGORY_FILTERS.indexOf(categoryFilter);
      setCategoryFilter(CATEGORY_FILTERS[(idx + 1) % CATEGORY_FILTERS.length] as CategoryFilter);
      resetScroll();
      return;
    }

    if (evt.name === "up") {
      const len = currentItems().length;
      setCursor((prev) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, len - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      const len = currentItems().length;
      setCursor((prev) => {
        const next = prev < len - 1 ? prev + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }

    // Enter = install (search/recommended) or toggle (installed/disabled)
    if (evt.name === "return") {
      const items = currentItems();
      const item = items[cursor];
      if (!item) return;

      if (tab === "installed" || tab === "disabled") {
        // Toggle enable/disable
        if (isInProject) {
          setPendingToggle(item);
          setScopeCursor(0);
        } else {
          toggleDisabled(item.pkg.name, "global");
        }
      } else {
        // Install
        doInstall(item);
      }
      return;
    }

    // Ctrl+D = toggle disable on any tab
    if (evt.name === "d" && evt.ctrl) {
      const items = currentItems();
      const item = items[cursor];
      if (!item) return;
      if (isInProject) {
        setPendingToggle(item);
        setScopeCursor(0);
      } else {
        toggleDisabled(item.pkg.name, "global");
      }
      return;
    }

    // Ctrl+U = uninstall soulforge-installed package
    if (evt.name === "u" && evt.ctrl) {
      const items = currentItems();
      const item = items[cursor];
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
  });

  if (!visible) return null;

  const tabIdx = TABS.indexOf(tab);
  const items = currentItems();

  const renderRow = (status: PackageStatus, i: number) => {
    const idx = scrollOffset + i;
    const isActive = idx === cursor;
    const bg = isActive ? POPUP_HL : POPUP_BG;
    const isDisabled = disabledServers.includes(status.pkg.name);
    const src = sourceLabel(status);
    const method = methodLabel(status);
    const lang = langLabel(status.pkg);
    const missingToolchain = status.requiresToolchain && !status.toolchainAvailable;

    return (
      <PopupRow key={status.pkg.name} bg={bg} w={innerW}>
        <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
          {isActive ? "› " : "  "}
        </text>
        <text
          bg={bg}
          fg={isDisabled ? "#555" : isActive ? "#FF0040" : "#aaa"}
          attributes={isActive ? TextAttributes.BOLD : undefined}
        >
          {status.pkg.name}
        </text>
        {lang && (
          <text bg={bg} fg="#666">
            {" "}
            {lang}
          </text>
        )}
        {src ? (
          <text bg={bg} fg="#00FF00">
            {" "}
            {src}
          </text>
        ) : method ? (
          <text bg={bg} fg={missingToolchain ? "#FF4444" : "#666"}>
            {" "}
            {method}
          </text>
        ) : null}
        {isDisabled && (
          <text bg={bg} fg="#FF4444">
            {" "}
            [disabled]
          </text>
        )}
      </PopupRow>
    );
  };

  return (
    <Overlay>
      <box
        flexDirection="column"
        borderStyle="rounded"
        border={true}
        borderColor="#8B5CF6"
        width={popupWidth}
      >
        <PopupRow w={innerW}>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            {"\uDB80\uDCA6"} LSP Servers
          </text>
          {tab === "search" && (
            <text fg="#666" bg={POPUP_BG}>
              {" "}
              [{categoryFilter}]
            </text>
          )}
        </PopupRow>

        <PopupRow w={innerW}>
          {TABS.map((t, i) => (
            <text key={t} bg={POPUP_BG}>
              {i > 0 ? (
                <span fg="#333" bg={POPUP_BG}>
                  {" │ "}
                </span>
              ) : (
                ""
              )}
              <span
                fg={i === tabIdx ? "#FF0040" : "#666"}
                attributes={i === tabIdx ? TextAttributes.BOLD : undefined}
                bg={POPUP_BG}
              >
                {TAB_LABELS[t]}
              </span>
            </text>
          ))}
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>

        <PopupRow w={innerW}>
          <text fg="#9B30FF" bg={POPUP_BG}>
            {" "}
          </text>
          {query ? (
            <>
              <text fg="white" bg={POPUP_BG}>
                {query}
              </text>
              <text fg="#FF0040" bg={POPUP_BG}>
                {"█"}
              </text>
            </>
          ) : (
            <>
              <text fg="#FF0040" bg={POPUP_BG}>
                {"█"}
              </text>
              <text fg="#555" bg={POPUP_BG}>
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
        </PopupRow>
        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        {registryLoading ? (
          <PopupRow w={innerW}>
            <text fg="#9B30FF" bg={POPUP_BG}>
              {registryLoaded ? "scanning installed packages..." : "loading Mason registry..."}
            </text>
          </PopupRow>
        ) : !registryLoaded ? (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              no registry available — install Mason or check network
            </text>
          </PopupRow>
        ) : (
          <box
            flexDirection="column"
            height={Math.min(items.length || 1, maxVisible)}
            overflow="hidden"
          >
            {items.length === 0 ? (
              <PopupRow w={innerW}>
                <text fg="#555" bg={POPUP_BG}>
                  {query ? "no matching packages" : "no packages"}
                </text>
              </PopupRow>
            ) : (
              items
                .slice(scrollOffset, scrollOffset + maxVisible)
                .map((status, i) => renderRow(status, i))
            )}
          </box>
        )}

        {items.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {scrollOffset > 0 ? "↑ " : "  "}
              {String(cursor + 1)}/{String(items.length)}
              {scrollOffset + maxVisible < items.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        {pendingToggle && (
          <>
            <PopupRow w={innerW}>
              <text>{""}</text>
            </PopupRow>
            <PopupRow w={innerW}>
              <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
                {disabledServers.includes(pendingToggle.pkg.name) ? "Enable" : "Disable"} "
                {pendingToggle.pkg.name}" scope:
              </text>
            </PopupRow>
            {(["Project", "Global"] as const).map((label, i) => {
              const isActive = i === scopeCursor;
              const bg = isActive ? POPUP_HL : POPUP_BG;
              return (
                <PopupRow key={label} bg={bg} w={innerW}>
                  <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                    {isActive ? "› " : "  "}
                  </text>
                  <text
                    bg={bg}
                    fg={isActive ? "#FF0040" : "#aaa"}
                    attributes={isActive ? TextAttributes.BOLD : undefined}
                  >
                    {label}
                  </text>
                </PopupRow>
              );
            })}
          </>
        )}

        {installing && (
          <PopupRow w={innerW}>
            <text fg="#9B30FF" bg={POPUP_BG}>
              installing...
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {"↑↓"} nav | {"⏎"} {tab === "installed" || tab === "disabled" ? "toggle" : "install"} |
            {"^D"} disable | {"^U"} uninstall | {"^F"} category | {"⇥"} tab | esc close
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
});
