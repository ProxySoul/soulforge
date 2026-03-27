import { existsSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import {
  type InstalledSkill,
  installSkill,
  listInstalledSkills,
  listPopularSkills,
  loadSkill,
  removeInstalledSkill,
  type SkillSearchResult,
  searchSkills,
} from "../../core/skills/manager.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";

import { Overlay, POPUP_BG, POPUP_HL, PopupRow } from "../layout/shared.js";

const MAX_POPUP_WIDTH = 100;
const CHROME_ROWS = 9;

type Tab = "search" | "installed" | "active";
const TABS: Tab[] = ["search", "installed", "active"];
const TAB_LABELS: Record<Tab, string> = {
  search: "Search",
  installed: "Installed",
  active: "Active",
};

interface Props {
  visible: boolean;
  contextManager: ContextManager;
  agentSkillsEnabled: boolean;
  onToggleAgentSkills: () => void;
  onClose: () => void;
  onSystemMessage: (msg: string) => void;
}

export const SkillSearch = memo(function SkillSearch({
  visible,
  contextManager,
  agentSkillsEnabled,
  onToggleAgentSkills,
  onClose,
  onSystemMessage,
}: Props) {
  const [tab, setTab] = useState<Tab>("search");
  const [query, setQuery] = useState("");
  const [popular, setPopular] = useState<SkillSearchResult[]>([]);
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [pendingInstall, setPendingInstall] = useState<SkillSearchResult | null>(null);
  const [scopeCursor, setScopeCursor] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isInProject = existsSync(join(process.cwd(), ".git"));
  const { width: termCols, height: termRows } = useTerminalDimensions();

  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.8));
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS);
  const innerW = popupWidth - 2;
  const { cursor, setCursor, scrollOffset, adjustScroll, resetScroll } = usePopupScroll(maxVisible);

  const filterQuery = query.toLowerCase().trim();
  const installedNames = new Set(installed.map((s) => s.name));
  const filteredInstalled = filterQuery
    ? installed.filter((s) => s.name.toLowerCase().includes(filterQuery))
    : installed;
  const filteredActive = filterQuery
    ? activeSkills.filter((s) => s.toLowerCase().includes(filterQuery))
    : activeSkills;

  // Show popular skills when query is empty, search results when typing
  const displayResults = query.trim() ? results : popular;

  const refreshInstalled = useCallback(() => {
    setInstalled(listInstalledSkills());
  }, []);

  const refreshActive = useCallback(() => {
    setActiveSkills(contextManager.getActiveSkills());
  }, [contextManager]);

  useEffect(() => {
    if (visible) {
      setTab("search");
      setQuery("");
      setResults([]);
      setCursor(0);
      refreshInstalled();
      refreshActive();
      // Fetch popular skills for the default view
      listPopularSkills()
        .then((r) => setPopular(r))
        .catch(() => {});
    }
  }, [visible, refreshInstalled, refreshActive, setCursor]);

  useEffect(() => {
    if (!visible || tab !== "search") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }

    // Clear popular once user starts typing — search results take over
    if (popular.length > 0) setPopular([]);

    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchSkills(query.trim())
        .then((r) => {
          setResults(r);
          setCursor(0);
        })
        .catch(() => {
          setResults([]);
        })
        .finally(() => setSearching(false));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, visible, tab, popular.length, setCursor]);

  useEffect(() => {
    setQuery("");
    setResults([]);
    resetScroll();
    if (tab === "installed") refreshInstalled();
    if (tab === "active") refreshActive();
  }, [tab, refreshInstalled, refreshActive, resetScroll]);

  const currentList = (): number => {
    if (tab === "search") return displayResults.length;
    if (tab === "installed") return filteredInstalled.length;
    return filteredActive.length;
  };

  useKeyboard((evt) => {
    if (!visible) return;

    if (pendingInstall) {
      if (evt.name === "escape") {
        setPendingInstall(null);
        return;
      }
      if (evt.name === "up" || evt.name === "down") {
        setScopeCursor((prev) => (prev === 0 ? 1 : 0));
        return;
      }
      if (evt.name === "return") {
        const isGlobal = isInProject ? scopeCursor === 1 : true;
        doInstall(pendingInstall, isGlobal);
        setPendingInstall(null);
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
      return;
    }

    if (evt.name === "up") {
      const len = currentList();
      setCursor((prev) => {
        const next = prev > 0 ? prev - 1 : Math.max(0, len - 1);
        adjustScroll(next);
        return next;
      });
      return;
    }
    if (evt.name === "down") {
      const len = currentList();
      setCursor((prev) => {
        const next = prev < len - 1 ? prev + 1 : 0;
        adjustScroll(next);
        return next;
      });
      return;
    }

    if (evt.name === "return") {
      handleAction();
      return;
    }

    // Ctrl+D: delete skill from disk (installed tab) or unload (active tab)
    if (evt.ctrl && evt.name === "d") {
      if (tab === "installed") {
        const skill = filteredInstalled[cursor];
        if (skill) {
          // Unload from context if active
          if (activeSkills.includes(skill.name)) {
            contextManager.removeSkill(skill.name);
          }
          if (removeInstalledSkill(skill)) {
            onSystemMessage(`Skill "${skill.name}" removed.`);
          } else {
            onSystemMessage(`Failed to remove "${skill.name}".`);
          }
          refreshInstalled();
          refreshActive();
          resetScroll();
        }
      } else if (tab === "active") {
        const name = filteredActive[cursor];
        if (name) {
          contextManager.removeSkill(name);
          onSystemMessage(`Skill "${name}" unloaded.`);
          refreshActive();
          resetScroll();
        }
      }
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((prev) => prev.slice(0, -1));
      resetScroll();
      return;
    }

    if (evt.name === "a" && !evt.ctrl && !evt.meta && !query) {
      onToggleAgentSkills();
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

  const doInstall = (skill: SkillSearchResult, global: boolean) => {
    setInstalling(true);
    installSkill(skill.source, skill.skillId, global)
      .then((result) => {
        if (result.installed) {
          onSystemMessage(
            `Skill "${result.name ?? skill.name}" installed ${global ? "globally" : "to project"}.`,
          );
        } else {
          onSystemMessage(`Failed to install "${skill.name}": ${result.error ?? "unknown error"}`);
        }
        refreshInstalled();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        onSystemMessage(`Failed to install "${skill.name}": ${msg}`);
      })
      .finally(() => setInstalling(false));
  };

  const handleAction = () => {
    if (tab === "search") {
      const skill = results[cursor];
      if (!skill || installing) return;
      if (isInProject) {
        setPendingInstall(skill);
        setScopeCursor(0);
      } else {
        doInstall(skill, true);
      }
    } else if (tab === "installed") {
      const skill = filteredInstalled[cursor];
      if (!skill) return;
      const content = loadSkill(skill.path);
      contextManager.addSkill(skill.name, content);
      onSystemMessage(`Skill "${skill.name}" loaded into AI context.`);
      refreshActive();
    } else {
      const name = filteredActive[cursor];
      if (!name) return;
      contextManager.removeSkill(name);
      onSystemMessage(`Skill "${name}" unloaded from AI context.`);
      refreshActive();
    }
  };

  if (!visible) return null;

  const tabIdx = TABS.indexOf(tab);

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
            {"\uDB82\uDD2A"} Skills
          </text>
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
                  ? "type to filter / search skills.sh..."
                  : tab === "installed"
                    ? "type to filter installed..."
                    : "type to filter active..."}
              </text>
            </>
          )}
        </PopupRow>
        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        {tab === "search" && (
          <>
            <box
              flexDirection="column"
              height={Math.min(displayResults.length || 1, maxVisible)}
              overflow="hidden"
            >
              {searching ? (
                <PopupRow w={innerW}>
                  <text fg="#9B30FF" bg={POPUP_BG}>
                    searching...
                  </text>
                </PopupRow>
              ) : displayResults.length === 0 ? (
                <PopupRow w={innerW}>
                  <text fg="#555" bg={POPUP_BG}>
                    {query ? "no results" : "loading popular skills..."}
                  </text>
                </PopupRow>
              ) : (
                displayResults.slice(scrollOffset, scrollOffset + maxVisible).map((skill, i) => {
                  const idx = scrollOffset + i;
                  const isActive = idx === cursor;
                  const bg = isActive ? POPUP_HL : POPUP_BG;
                  const isInstalled =
                    installedNames.has(skill.skillId) || installedNames.has(skill.name);
                  const isLoaded =
                    activeSkills.includes(skill.skillId) || activeSkills.includes(skill.name);
                  return (
                    <PopupRow key={skill.id} bg={bg} w={innerW}>
                      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                        {isActive ? "› " : "  "}
                      </text>
                      {isLoaded ? (
                        <text bg={bg} fg="#00FF00">
                          ●{" "}
                        </text>
                      ) : isInstalled ? (
                        <text bg={bg} fg="#4a7">
                          ✓{" "}
                        </text>
                      ) : null}
                      <text
                        bg={bg}
                        fg={isActive ? "#FF0040" : "#aaa"}
                        attributes={isActive ? TextAttributes.BOLD : undefined}
                      >
                        {skill.skillId}
                      </text>
                      <text bg={bg} fg="#555">
                        {" "}
                        {skill.source}
                      </text>
                      <text bg={bg} fg="#444">
                        {" "}
                        {skill.installs.toLocaleString()}↓
                      </text>
                    </PopupRow>
                  );
                })
              )}
            </box>
            {displayResults.length > maxVisible && (
              <PopupRow w={innerW}>
                <text fg="#555" bg={POPUP_BG}>
                  {scrollOffset > 0 ? "↑ " : "  "}
                  {String(cursor + 1)}/{String(displayResults.length)}
                  {scrollOffset + maxVisible < displayResults.length ? " ↓" : ""}
                </text>
              </PopupRow>
            )}

            {pendingInstall && (
              <>
                <PopupRow w={innerW}>
                  <text>{""}</text>
                </PopupRow>
                <PopupRow w={innerW}>
                  <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
                    Install "{pendingInstall.skillId}" to:
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
                      <text bg={bg} fg="#555">
                        {" "}
                        {i === 0
                          ? ".agents/skills/ (this repo)"
                          : "~/.agents/skills/ (all projects)"}
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
          </>
        )}

        {tab === "installed" && (
          <>
            <box
              flexDirection="column"
              height={Math.min(filteredInstalled.length || 1, maxVisible)}
              overflow="hidden"
            >
              {filteredInstalled.length === 0 ? (
                <PopupRow w={innerW}>
                  <text fg="#555" bg={POPUP_BG}>
                    {query ? "no matching skills" : "no installed skills found"}
                  </text>
                </PopupRow>
              ) : (
                filteredInstalled.slice(scrollOffset, scrollOffset + maxVisible).map((skill, i) => {
                  const idx = scrollOffset + i;
                  const isActive = idx === cursor;
                  const isLoaded = activeSkills.includes(skill.name);
                  const bg = isActive ? POPUP_HL : POPUP_BG;
                  return (
                    <PopupRow key={skill.path} bg={bg} w={innerW}>
                      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                        {isActive ? "› " : "  "}
                      </text>
                      <text
                        bg={bg}
                        fg={isActive ? "#FF0040" : "#aaa"}
                        attributes={isActive ? TextAttributes.BOLD : undefined}
                      >
                        {skill.name}
                      </text>
                      <text bg={bg} fg="#555">
                        {" "}
                        {skill.scope === "project" ? "(project)" : "(global)"}
                      </text>
                      {isLoaded && (
                        <text bg={bg} fg="#00FF00">
                          {" "}
                          ●
                        </text>
                      )}
                    </PopupRow>
                  );
                })
              )}
            </box>
            {filteredInstalled.length > maxVisible && (
              <PopupRow w={innerW}>
                <text fg="#555" bg={POPUP_BG}>
                  {scrollOffset > 0 ? "↑ " : "  "}
                  {String(cursor + 1)}/{String(filteredInstalled.length)}
                  {scrollOffset + maxVisible < filteredInstalled.length ? " ↓" : ""}
                </text>
              </PopupRow>
            )}
          </>
        )}

        {tab === "active" && (
          <>
            <box
              flexDirection="column"
              height={Math.min(filteredActive.length || 1, maxVisible)}
              overflow="hidden"
            >
              {filteredActive.length === 0 ? (
                <PopupRow w={innerW}>
                  <text fg="#555" bg={POPUP_BG}>
                    {query ? "no matching skills" : "no active skills — load from Installed tab"}
                  </text>
                </PopupRow>
              ) : (
                filteredActive.slice(scrollOffset, scrollOffset + maxVisible).map((name, i) => {
                  const idx = scrollOffset + i;
                  const isActive = idx === cursor;
                  const bg = isActive ? POPUP_HL : POPUP_BG;
                  return (
                    <PopupRow key={name} bg={bg} w={innerW}>
                      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
                        {isActive ? "› " : "  "}
                      </text>
                      <text
                        bg={bg}
                        fg={isActive ? "#FF0040" : "#00FF00"}
                        attributes={isActive ? TextAttributes.BOLD : undefined}
                      >
                        {name}
                      </text>
                    </PopupRow>
                  );
                })
              )}
            </box>
            {filteredActive.length > maxVisible && (
              <PopupRow w={innerW}>
                <text fg="#555" bg={POPUP_BG}>
                  {scrollOffset > 0 ? "↑ " : "  "}
                  {String(cursor + 1)}/{String(filteredActive.length)}
                  {scrollOffset + maxVisible < filteredActive.length ? " ↓" : ""}
                </text>
              </PopupRow>
            )}
          </>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            Agent access:{" "}
          </text>
          <text fg={agentSkillsEnabled ? "#00FF00" : "#c55"} bg={POPUP_BG}>
            {agentSkillsEnabled ? "on" : "off"}
          </text>
          <text fg="#444" bg={POPUP_BG}>
            {" "}
            (a to toggle)
          </text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            {"↑↓"} nav | {"⏎"}{" "}
            {tab === "search" ? "install" : tab === "installed" ? "load" : "unload"}
            {tab === "installed" ? " | ^D remove" : tab === "active" ? " | ^D unload" : ""}
            {" | ⇥ tab | esc close"}
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
});
