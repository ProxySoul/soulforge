import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../../core/history/fuzzy.js";
import { icon, providerIcon } from "../../core/icons.js";
import { PROVIDER_CONFIGS } from "../../core/llm/models.js";
import { useAllProviderModels } from "../../hooks/useAllProviderModels.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow, SPINNER_FRAMES } from "../layout/shared.js";

const MAX_W = 72;

type Entry =
  | {
      kind: "header";
      id: string;
      name: string;
      avail: boolean;
      loading: boolean;
      count: number;
    }
  | {
      kind: "model";
      providerId: string;
      id: string;
      fullId: string;
      name: string;
      ctx?: number;
      hasDesc: boolean;
    };

function fmtCtx(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${String(Math.round(n / 1_000_000))}M`;
  return `${String(Math.round(n / 1_000))}k`;
}

interface Props {
  visible: boolean;
  activeModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export const LlmSelector = memo(function LlmSelector({
  visible,
  activeModel,
  onSelect,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const pw = Math.min(MAX_W, Math.floor(termCols * 0.85));
  const iw = pw - 2;
  // Chrome: title(1) + sep(1) + search(1) + hint(1) + sep(1) + spacer(1) + sep(1) + footer(1) = 8
  const maxVis = Math.max(6, termRows - 4 - 8);

  const { providerData: provData, availability, anyLoading } = useAllProviderModels(visible);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [scrollOff, setScrollOff] = useState(0);
  const [spinFrame, setSpinFrame] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setCursor(0);
    setScrollOff(0);
    const activeProvider = activeModel.split("/")[0] ?? "";
    const init: Record<string, boolean> = {};
    for (const cfg of PROVIDER_CONFIGS) {
      init[cfg.id] = cfg.id !== activeProvider;
    }
    setCollapsed(init);
  }, [visible, activeModel]);

  useEffect(() => {
    if (!anyLoading || !visible) return;
    const timer = setInterval(() => {
      setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => clearInterval(timer);
  }, [anyLoading, visible]);

  const { providerFilter, modelFilter } = useMemo(() => {
    const raw = query.toLowerCase().trim();
    const slashIdx = raw.indexOf("/");
    if (slashIdx >= 0) {
      return { providerFilter: raw.slice(0, slashIdx), modelFilter: raw.slice(slashIdx + 1) };
    }
    return { providerFilter: "", modelFilter: raw };
  }, [query]);

  // Full entry list (before collapse filtering)
  const entries = useMemo(() => {
    const out: Entry[] = [];

    for (const cfg of PROVIDER_CONFIGS) {
      const pd = provData[cfg.id];
      const items = pd?.items ?? [];
      const loading = pd?.loading ?? true;
      const avail = availability.get(cfg.id) ?? false;

      if (providerFilter) {
        const provTarget = `${cfg.id} ${cfg.name}`.toLowerCase();
        const provMatch =
          provTarget.includes(providerFilter) || fuzzyMatch(providerFilter, provTarget) !== null;
        if (!provMatch) continue;
      }

      const provTarget = `${cfg.id} ${cfg.name}`.toLowerCase();
      const queryMatchesProvider =
        !providerFilter &&
        modelFilter &&
        (provTarget.includes(modelFilter) || fuzzyMatch(modelFilter, provTarget) !== null);

      let filtered = items;
      if (modelFilter && !queryMatchesProvider) {
        filtered = items.filter((m) => {
          const t = `${m.id} ${m.name ?? ""} ${cfg.id} ${cfg.name}`.toLowerCase();
          return t.includes(modelFilter) || fuzzyMatch(modelFilter, t) !== null;
        });
        if (filtered.length === 0 && !loading) continue;
      }

      if (!avail && items.length === 0 && !loading) continue;

      out.push({
        kind: "header",
        id: cfg.id,
        name: cfg.name,
        avail,
        loading,
        count: filtered.length,
      });

      for (const m of filtered) {
        const name = m.name || m.id;
        const hasDesc = name !== m.id;
        out.push({
          kind: "model",
          providerId: cfg.id,
          id: m.id,
          fullId: `${cfg.id}/${m.id}`,
          name,
          ctx: m.contextWindow,
          hasDesc,
        });
      }
    }
    return out;
  }, [provData, providerFilter, modelFilter, availability]);

  // Visible entries: hide models under collapsed providers (unless searching)
  const displayEntries = useMemo(() => {
    if (query) return entries;
    return entries.filter((e) => {
      if (e.kind === "header") return true;
      return !collapsed[e.providerId];
    });
  }, [entries, collapsed, query]);

  const eH = useCallback((e: Entry): number => (e.kind === "model" && e.hasDesc ? 2 : 1), []);

  const visualRowCount = useMemo(() => {
    let count = 0;
    for (const e of displayEntries) count += eH(e);
    return count;
  }, [displayEntries, eH]);

  // Track cursor across displayEntries changes
  const prevDisplayRef = useRef(displayEntries);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const scrollRef = useRef(scrollOff);
  scrollRef.current = scrollOff;
  const displayRef = useRef(displayEntries);
  displayRef.current = displayEntries;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const ensureVisible = useCallback(
    (idx: number) => {
      const ents = displayRef.current;
      const so = scrollRef.current;
      if (idx < so) {
        setScrollOff(idx);
        scrollRef.current = idx;
      } else {
        let rowsNeeded = 0;
        for (let i = so; i <= idx && i < ents.length; i++) {
          const e = ents[i];
          if (e) rowsNeeded += eH(e);
        }
        if (rowsNeeded > maxVis) {
          let newOff = so;
          while (newOff < idx) {
            const e = ents[newOff];
            if (e) rowsNeeded -= eH(e);
            newOff++;
            if (rowsNeeded <= maxVis) break;
          }
          setScrollOff(newOff);
          scrollRef.current = newOff;
        }
      }
    },
    [eH, maxVis],
  );

  useEffect(() => {
    if (displayEntries !== prevDisplayRef.current) {
      const prev = prevDisplayRef.current;
      prevDisplayRef.current = displayEntries;
      const prevEntry = prev[cursorRef.current];
      if (prevEntry) {
        const newIdx = displayEntries.findIndex((e) => {
          if (e.kind === "header" && prevEntry.kind === "header") return e.id === prevEntry.id;
          if (e.kind === "model" && prevEntry.kind === "model")
            return e.fullId === prevEntry.fullId;
          return false;
        });
        if (newIdx >= 0) {
          setCursor(newIdx);
          cursorRef.current = newIdx;
          ensureVisible(newIdx);
          return;
        }
      }
      if (query) {
        const first = displayEntries.findIndex((e) => e.kind === "model");
        if (first >= 0) {
          setCursor(first);
          cursorRef.current = first;
          ensureVisible(first);
          return;
        }
      }
      setCursor(0);
      cursorRef.current = 0;
      setScrollOff(0);
      scrollRef.current = 0;
    }
  }, [displayEntries, query, ensureVisible]);

  const toggleCollapse = useCallback((providerId: string) => {
    setCollapsed((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  }, []);

  useKeyboard((evt) => {
    if (!visible) return;
    const ents = displayRef.current;

    if (evt.name === "escape") {
      if (query) {
        setQuery("");
        return;
      }
      onClose();
      return;
    }

    if (evt.name === "return") {
      const e = ents[cursorRef.current];
      if (e?.kind === "header") {
        toggleCollapse(e.id);
      } else if (e?.kind === "model") {
        onSelect(e.fullId);
        onClose();
      }
      return;
    }

    if (evt.name === "left") {
      const e = ents[cursorRef.current];
      if (e?.kind === "model") {
        let i = cursorRef.current - 1;
        while (i >= 0 && ents[i]?.kind !== "header") i--;
        if (i >= 0) {
          setCursor(i);
          cursorRef.current = i;
          ensureVisible(i);
        }
      } else if (e?.kind === "header" && !collapsedRef.current[e.id]) {
        toggleCollapse(e.id);
      }
      return;
    }

    if (evt.name === "right") {
      const e = ents[cursorRef.current];
      if (e?.kind === "header" && collapsedRef.current[e.id]) {
        toggleCollapse(e.id);
      }
      return;
    }

    const move = (dir: 1 | -1) => {
      if (ents.length === 0) return;
      let next = cursorRef.current + dir;
      if (next < 0) next = ents.length - 1;
      if (next >= ents.length) next = 0;
      setCursor(next);
      cursorRef.current = next;
      ensureVisible(next);
    };

    if (evt.name === "up") {
      move(-1);
      return;
    }
    if (evt.name === "down") {
      move(1);
      return;
    }

    if (evt.name === "tab") {
      let i = cursorRef.current + 1;
      while (i < ents.length && ents[i]?.kind !== "header") i++;
      if (i >= ents.length) {
        i = ents.findIndex((e) => e.kind === "header");
        if (i < 0) return;
      }
      setCursor(i);
      cursorRef.current = i;
      ensureVisible(i);
      return;
    }

    if (evt.name === "backspace" || evt.name === "delete") {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    if (evt.name === "space") {
      setQuery((q) => `${q} `);
      return;
    }

    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setQuery((q) => q + evt.name);
    }
  });

  if (!visible) return null;

  const visEntries: Entry[] = [];
  let visRows = 0;
  for (let i = scrollOff; i < displayEntries.length && visRows < maxVis; i++) {
    const e = displayEntries[i];
    if (!e) break;
    const h = eH(e);
    if (visRows + h > maxVis && visRows > 0) break;
    visEntries.push(e);
    visRows += h;
  }

  const totalModels = entries.filter((e) => e.kind === "model").length;
  const canScrollUp = scrollOff > 0;
  const canScrollDown = scrollOff + visEntries.length < displayEntries.length;

  return (
    <Overlay>
      <box flexDirection="column" borderStyle="rounded" border borderColor="#8B5CF6" width={pw}>
        <PopupRow w={iw}>
          <text fg="#9B30FF" bg={POPUP_BG}>
            {icon("model")}{" "}
          </text>
          <text fg="white" attributes={TextAttributes.BOLD} bg={POPUP_BG}>
            Select Model
          </text>
        </PopupRow>

        <PopupRow w={iw}>
          <text fg="#333" bg={POPUP_BG}>
            {"─".repeat(iw - 4)}
          </text>
        </PopupRow>

        <PopupRow w={iw}>
          <text fg="#555" bg={POPUP_BG}>
            {icon("search")}{" "}
          </text>
          <text fg="white" bg={POPUP_BG}>
            {query}
          </text>
          <text fg="#8B5CF6" bg={POPUP_BG}>
            ▎
          </text>
          {!query && (
            <text fg="#333" bg={POPUP_BG}>
              {" search…"}
            </text>
          )}
        </PopupRow>

        <PopupRow w={iw}>
          <text fg="#333" bg={POPUP_BG}>
            {"<provider>/<model>"}
          </text>
        </PopupRow>

        <PopupRow w={iw}>
          <text fg="#222" bg={POPUP_BG}>
            {"─".repeat(iw - 4)}
          </text>
        </PopupRow>

        <PopupRow w={iw}>
          <text>{""}</text>
        </PopupRow>

        {displayEntries.length === 0 ? (
          <PopupRow w={iw}>
            <text fg="#555" bg={POPUP_BG}>
              {query ? "no matching models" : "no providers available"}
            </text>
          </PopupRow>
        ) : (
          <box flexDirection="column" height={Math.min(visualRowCount, maxVis)} overflow="hidden">
            {visEntries.map((entry) => {
              const entryIdx = displayEntries.indexOf(entry);
              const active = entryIdx === cursor;

              if (entry.kind === "header") {
                const isCol = !query && (collapsed[entry.id] ?? false);
                const isActiveProvider = activeModel.startsWith(`${entry.id}/`);
                const bg = active ? POPUP_HL : POPUP_BG;
                const fg = !entry.avail
                  ? "#444"
                  : isActiveProvider
                    ? "#00FF00"
                    : active
                      ? "white"
                      : "#8B5CF6";
                return (
                  <PopupRow key={`h-${entry.id}`} bg={bg} w={iw}>
                    <text fg={fg} bg={bg}>
                      {isCol ? "▸ " : "▾ "}
                    </text>
                    <text fg={fg} attributes={TextAttributes.BOLD} bg={bg}>
                      {providerIcon(entry.id)} {entry.name.toUpperCase()}
                    </text>
                    {entry.loading && (
                      <text fg="#555" bg={bg}>
                        {" "}
                        {SPINNER_FRAMES[spinFrame]}
                      </text>
                    )}
                    {!entry.loading && entry.count > 0 && (
                      <text fg="#555" bg={bg}>
                        {" "}
                        {String(entry.count)}
                      </text>
                    )}
                    {!entry.avail && !entry.loading && (
                      <text fg="#444" bg={bg}>
                        {" · no key"}
                      </text>
                    )}
                  </PopupRow>
                );
              }

              const nextEntry = displayEntries[entryIdx + 1];
              const isLast = !nextEntry || nextEntry.kind === "header";
              const connector = isLast ? " └ " : " ├ ";
              const cont = isLast ? "   " : " │ ";
              const isCur = entry.fullId === activeModel;
              const bg = active ? POPUP_HL : POPUP_BG;
              const ctxStr = fmtCtx(entry.ctx);
              const checkW = isCur ? 2 : 0;
              const avail = iw - 5 - ctxStr.length - checkW;
              const nm =
                entry.name.length > avail
                  ? `${entry.name.slice(0, Math.max(0, avail - 1))}…`
                  : entry.name;
              const pad = Math.max(1, iw - 5 - nm.length - ctxStr.length - checkW);

              return (
                <box key={`m-${entry.fullId}`} flexDirection="column">
                  <PopupRow bg={bg} w={iw}>
                    <text fg={active ? "#8B5CF6" : "#555"} bg={bg}>
                      {connector}
                    </text>
                    <text
                      fg={active ? "#FF0040" : isCur ? "#00FF00" : "#aaa"}
                      bg={bg}
                      attributes={active ? TextAttributes.BOLD : undefined}
                    >
                      {nm}
                    </text>
                    {ctxStr ? (
                      <text fg={active ? "#994060" : "#444"} bg={bg}>
                        {" ".repeat(pad)}
                        {ctxStr}
                      </text>
                    ) : null}
                    {isCur && (
                      <text fg="#00FF00" bg={bg}>
                        {" ✓"}
                      </text>
                    )}
                  </PopupRow>
                  {entry.hasDesc && (
                    <PopupRow bg={bg} w={iw}>
                      <text fg={active ? "#888" : "#555"} bg={bg} truncate>
                        {cont}
                        {entry.id.length > iw - 9 ? `${entry.id.slice(0, iw - 12)}…` : entry.id}
                      </text>
                    </PopupRow>
                  )}
                </box>
              );
            })}
          </box>
        )}

        <PopupRow w={iw}>
          <text>{""}</text>
        </PopupRow>

        <PopupRow w={iw}>
          <text fg="#555" bg={POPUP_BG}>
            {"↑↓"} navigate {"←→"} fold {"⏎"} select {"⇥"} next {"⎋"} {query ? "clear" : "close"}
          </text>
          {totalModels > 0 && (
            <text fg="#444" bg={POPUP_BG}>
              {" "}
              {canScrollUp ? "↑" : " "}
              {String(totalModels)}
              {canScrollDown ? "↓" : " "}
            </text>
          )}
        </PopupRow>
      </box>
    </Overlay>
  );
});
