/**
 * UiDemo — playground for the `src/components/ui/` primitives.
 *
 * Gated behind SOULFORGE_DEV_UI=1. Not shipped to end-users.
 * Open with `/ui-demo` to verify visual grammar across focus states,
 * Nerd Font vs ASCII, and every primitive at once.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  buildGroupedRows,
  Checkbox,
  Divider,
  Field,
  GroupedList,
  type GroupedListGroup,
  Hint,
  KeyCap,
  PremiumPopup,
  Radio,
  Search,
  Section,
  type SidebarTab,
  StatusPill,
  Table,
  type TableColumn,
  Toggle,
  VSpacer,
} from "../ui/index.js";

type Tab = "controls" | "fields" | "data" | "picker" | "flash" | "keys";

interface ModelRow {
  id: string;
  label: string;
  meta?: string;
  status?: "online" | "warning" | "offline";
}

const PROVIDERS: GroupedListGroup<ModelRow>[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    icon: "ai",
    items: [
      { id: "opus-4-7", label: "claude-opus-4-7", meta: "200K · flagship", status: "online" },
      { id: "sonnet-4-6", label: "claude-sonnet-4-6", meta: "200K · balanced", status: "online" },
      { id: "haiku-4-5", label: "claude-haiku-4-5", meta: "200K · fast", status: "online" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    icon: "ai",
    items: [
      { id: "gpt-5", label: "gpt-5", meta: "256K", status: "online" },
      { id: "gpt-5-mini", label: "gpt-5-mini", meta: "256K · fast" },
      { id: "o4", label: "o4", meta: "128K · reasoning", status: "warning" },
      { id: "gpt-4.1", label: "gpt-4.1", meta: "1M" },
    ],
  },
  {
    id: "google",
    label: "Google",
    icon: "ai",
    items: [
      { id: "gemini-3-pro", label: "gemini-3-pro", meta: "2M · multimodal", status: "online" },
      { id: "gemini-3-flash", label: "gemini-3-flash", meta: "1M · fast" },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    icon: "ai",
    items: [
      { id: "grok-4", label: "grok-4", meta: "1M", status: "online" },
      { id: "grok-4-fast", label: "grok-4-fast", meta: "128K · fast" },
    ],
  },
  {
    id: "gateway",
    label: "Vercel Gateway",
    icon: "vercel_gateway",
    items: [
      { id: "g-opus", label: "anthropic/claude-opus-4-7" },
      { id: "g-sonnet", label: "anthropic/claude-sonnet-4-6" },
      { id: "g-gpt5", label: "openai/gpt-5" },
      { id: "g-gemini", label: "google/gemini-3-pro" },
      { id: "g-mistral", label: "mistral/mistral-large-3" },
      { id: "g-deepseek", label: "deepseek/deepseek-v4", status: "warning" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    icon: "server",
    items: [
      { id: "llama-4-70b", label: "llama-4:70b", meta: "local · 40GB" },
      { id: "qwen3", label: "qwen3:32b", meta: "local · 19GB", status: "offline" },
    ],
  },
];

interface User {
  first: string;
  last: string;
  email: string;
  role: string;
}

const USERS: User[] = [
  { first: "Ada", last: "Lovelace", email: "ada@analytical.engine", role: "admin" },
  { first: "Alan", last: "Turing", email: "alan@bletchley.uk", role: "admin" },
  { first: "Grace", last: "Hopper", email: "grace@cobol.navy", role: "admin" },
  { first: "Linus", last: "Torvalds", email: "linus@kernel.org", role: "member" },
  { first: "Margaret", last: "Hamilton", email: "margaret@apollo.nasa", role: "admin" },
  { first: "Donald", last: "Knuth", email: "don@tex.stanford", role: "member" },
  { first: "Barbara", last: "Liskov", email: "barbara@mit.edu", role: "member" },
  { first: "Edsger", last: "Dijkstra", email: "edsger@eindhoven.nl", role: "member" },
  { first: "Katherine", last: "Johnson", email: "katherine@nasa.gov", role: "guest" },
  { first: "Dennis", last: "Ritchie", email: "dmr@bell-labs.com", role: "guest" },
  { first: "Radia", last: "Perlman", email: "radia@spanning.tree", role: "admin" },
  { first: "Tim", last: "Berners-Lee", email: "tim@w3c.org", role: "admin" },
  { first: "Vint", last: "Cerf", email: "vint@internet.org", role: "admin" },
  { first: "Brian", last: "Kernighan", email: "brian@bell-labs.com", role: "member" },
  { first: "Ken", last: "Thompson", email: "ken@bell-labs.com", role: "admin" },
  { first: "Bjarne", last: "Stroustrup", email: "bjarne@cpp.dev", role: "member" },
  { first: "Anita", last: "Borg", email: "anita@grace.hopper.celebration", role: "admin" },
  { first: "John", last: "McCarthy", email: "john@lisp.stanford", role: "guest" },
  { first: "Guido", last: "van Rossum", email: "guido@python.org", role: "member" },
  { first: "Yukihiro", last: "Matsumoto", email: "matz@ruby-lang.org", role: "member" },
];

const USER_COLUMNS: TableColumn<User>[] = [
  { key: "first", width: 12 },
  { key: "last", width: 14 },
  { key: "email" },
  { key: "role", width: 10 },
];

/** Subsequence match: every char of q appears in target in order. */
function subsequence(target: string, q: string): boolean {
  if (!q) return true;
  const t = target.toLowerCase();
  const qq = q.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < qq.length; i++) {
    if (t[i] === qq[qi]) qi++;
  }
  return qi === qq.length;
}

/** Token match: substring first, then subsequence fallback. */
function tokenMatches(target: string, q: string): boolean {
  if (!q) return true;
  const t = target.toLowerCase();
  const qq = q.toLowerCase();
  return t.includes(qq) || subsequence(target, q);
}

/**
 * Fuzzy-filter providers + models.
 *
 * Rules:
 *  - empty query → return all providers unchanged
 *  - `foo/bar`   → provider matches `foo`, model matches `bar` (either via
 *                   substring or subsequence). `/` with empty side = wildcard.
 *  - `foo`       → match against provider label, model label, or `provider/model`
 */
function fuzzyFilterProviders(
  providers: GroupedListGroup<ModelRow>[],
  query: string,
): GroupedListGroup<ModelRow>[] {
  const q = query.trim();
  if (!q) return providers;
  const hasSlash = q.includes("/");
  const [pq, mq] = hasSlash ? q.split("/", 2).map((s) => s.trim()) : [null, null];

  return providers
    .map((g) => {
      if (pq != null) {
        const providerHit = !pq || tokenMatches(g.label, pq);
        if (!providerHit) return { ...g, items: [] };
        const items = g.items.filter((i) => !mq || tokenMatches(i.label, mq));
        return { ...g, items };
      }
      const items = g.items.filter(
        (i) =>
          tokenMatches(i.label, q) ||
          tokenMatches(g.label, q) ||
          tokenMatches(`${g.label}/${i.label}`, q),
      );
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}

const TABS: SidebarTab<Tab>[] = [
  {
    id: "controls",
    label: "Controls",
    icon: "gear",
    blurb: "Button · Toggle · Checkbox · Radio",
  },
  {
    id: "fields",
    label: "Fields",
    icon: "editor",
    blurb: "Field rows · status pills",
    status: "online",
  },
  {
    id: "data",
    label: "Data",
    icon: "storage",
    blurb: "Search · filter · table rows",
  },
  {
    id: "picker",
    label: "Picker",
    icon: "model",
    blurb: "Grouped list · provider → models",
  },
  {
    id: "flash",
    label: "Flash",
    icon: "info",
    blurb: "Toasts · hints · warnings",
    status: "warning",
  },
  {
    id: "keys",
    label: "Keys",
    icon: "terminal",
    blurb: "Key cap styles",
  },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function UiDemo({ visible, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const [tab, setTab] = useState<Tab>("controls");
  const [row, setRow] = useState(0);
  const [btnCol, setBtnCol] = useState(0);
  const [toggles, setToggles] = useState({ a: true, b: false });
  const [checks, setChecks] = useState({ x: true, y: false, z: false });
  const [radio, setRadio] = useState<"x" | "y" | "z">("y");
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["anthropic"]));
  const [pickerIdx, setPickerIdx] = useState(0);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerSearchMode, setPickerSearchMode] = useState(false);

  const width = Math.min(120, Math.max(90, Math.floor(tw * 0.85)));
  const height = Math.min(30, Math.max(22, Math.floor(th * 0.82)));

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return USERS;
    return USERS.filter((u) =>
      [u.first, u.last, u.email, u.role].some((v) => v.toLowerCase().includes(q)),
    );
  }, [query]);

  const filteredProviders = useMemo(() => {
    return fuzzyFilterProviders(PROVIDERS, pickerQuery);
  }, [pickerQuery]);

  // When a filter is active, auto-expand every surviving group so matches are visible.
  const effectiveExpanded = useMemo(
    () => (pickerQuery.trim().length > 0 ? new Set(filteredProviders.map((g) => g.id)) : expanded),
    [pickerQuery, filteredProviders, expanded],
  );

  const pickerRows = useMemo(
    () => buildGroupedRows(filteredProviders, effectiveExpanded),
    [filteredProviders, effectiveExpanded],
  );

  // Keep pickerIdx valid when rows shrink (e.g. filter narrows list).
  useEffect(() => {
    if (pickerIdx >= pickerRows.length) setPickerIdx(Math.max(0, pickerRows.length - 1));
  }, [pickerRows.length, pickerIdx]);

  const rowCount = useMemo(() => {
    if (tab === "controls") return 5;
    if (tab === "fields") return 4;
    if (tab === "data") return Math.max(1, filteredUsers.length);
    if (tab === "picker") return Math.max(1, pickerRows.length);
    if (tab === "flash") return 3;
    return 1;
  }, [tab, filteredUsers.length, pickerRows.length]);

  useKeyboard((evt) => {
    if (!visible) return;

    // Search mode absorbs printable chars / backspace / escape → exits search
    if (tab === "data" && searchMode) {
      if (evt.name === "escape") {
        setSearchMode(false);
        return;
      }
      if (evt.name === "return") {
        setSearchMode(false);
        setRow(0);
        return;
      }
      if (evt.name === "backspace") {
        setQuery((q) => q.slice(0, -1));
        setRow(0);
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && ch !== "\x7f") {
        setQuery((q) => q + ch);
        setRow(0);
        return;
      }
      return;
    }

    if (tab === "picker" && pickerSearchMode) {
      if (evt.name === "escape") {
        setPickerSearchMode(false);
        return;
      }
      if (evt.name === "return") {
        setPickerSearchMode(false);
        setPickerIdx(0);
        return;
      }
      if (evt.name === "backspace") {
        setPickerQuery((q) => q.slice(0, -1));
        setPickerIdx(0);
        return;
      }
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && ch !== "\x7f") {
        setPickerQuery((q) => q + ch);
        setPickerIdx(0);
        return;
      }
      return;
    }

    if (evt.name === "escape") return onClose();
    if (evt.name === "tab") {
      const idx = TABS.findIndex((t) => t.id === tab);
      const next = TABS[(idx + (evt.shift ? TABS.length - 1 : 1)) % TABS.length];
      if (next) {
        setTab(next.id);
        setRow(0);
      }
      return;
    }
    if (tab === "data" && evt.name === "/") {
      setSearchMode(true);
      return;
    }
    if (tab === "picker" && evt.name === "/") {
      setPickerSearchMode(true);
      return;
    }

    // Picker tab — left/right collapse/expand, Enter toggles on group header
    if (tab === "picker") {
      const cur = pickerRows[pickerIdx];
      if (evt.name === "left" || evt.name === "h") {
        if (cur?.kind === "group" && cur.expanded) {
          setExpanded((s) => {
            const n = new Set(s);
            n.delete(cur.groupId);
            return n;
          });
        } else if (cur?.kind === "item") {
          // jump up to parent group header
          const parentIdx = pickerRows.findIndex(
            (r) => r.kind === "group" && r.groupId === cur.groupId,
          );
          if (parentIdx >= 0) setPickerIdx(parentIdx);
        }
        return;
      }
      if (evt.name === "right" || evt.name === "l") {
        if (cur?.kind === "group" && !cur.expanded) {
          setExpanded((s) => new Set([...s, cur.groupId]));
        } else if (cur?.kind === "group" && cur.expanded) {
          // jump to first item in group
          const firstItem = pickerRows.findIndex(
            (r, i) => i > pickerIdx && r.kind === "item" && r.groupId === cur.groupId,
          );
          if (firstItem >= 0) setPickerIdx(firstItem);
        }
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setPickerIdx((i) => (i + 1) % Math.max(1, pickerRows.length));
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        setPickerIdx(
          (i) => (i - 1 + Math.max(1, pickerRows.length)) % Math.max(1, pickerRows.length),
        );
        return;
      }
      if (evt.name === "space" || evt.name === "return") {
        if (cur?.kind === "group") {
          setExpanded((s) => {
            const n = new Set(s);
            if (n.has(cur.groupId)) n.delete(cur.groupId);
            else n.add(cur.groupId);
            return n;
          });
        } else if (cur?.kind === "item" && cur.item) {
          setFlash({
            kind: "ok",
            message: `Selected ${cur.groupId} · ${cur.item.label}`,
          });
          setTimeout(() => setFlash(null), 2500);
        }
        return;
      }
      return;
    }

    if (evt.name === "down" || evt.name === "j") {
      setRow((r) => (r + 1) % rowCount);
      setBtnCol(0);
      return;
    }
    if (evt.name === "up" || evt.name === "k") {
      setRow((r) => (r - 1 + rowCount) % rowCount);
      setBtnCol(0);
      return;
    }
    if (tab === "controls" && row === 4 && (evt.name === "left" || evt.name === "h")) {
      setBtnCol((c) => (c - 1 + 3) % 3);
      return;
    }
    if (tab === "controls" && row === 4 && (evt.name === "right" || evt.name === "l")) {
      setBtnCol((c) => (c + 1) % 3);
      return;
    }
    if (evt.name === "space" || evt.name === "return") {
      if (tab === "controls") {
        if (row === 0) setToggles((t) => ({ ...t, a: !t.a }));
        else if (row === 1) setToggles((t) => ({ ...t, b: !t.b }));
        else if (row === 2) setChecks((c) => ({ ...c, [Object.keys(c)[0] as "x"]: !c.x }));
        else if (row === 3) {
          const choices: Array<"x" | "y" | "z"> = ["x", "y", "z"];
          setRadio((r) => choices[(choices.indexOf(r) + 1) % 3] ?? "x");
        } else if (row === 4) {
          const labels = ["Save", "Cancel", "Delete"];
          const label = labels[btnCol] ?? "Save";
          setFlash({ kind: "ok", message: `${label} pressed` });
          setTimeout(() => setFlash(null), 2000);
        }
      } else if (tab === "data") {
        const u = filteredUsers[row];
        if (u) {
          setFlash({ kind: "ok", message: `Selected ${u.first} ${u.last} · ${u.email}` });
          setTimeout(() => setFlash(null), 2500);
        }
      } else if (tab === "flash") {
        const messages: Array<{ kind: "ok" | "err" | "info"; message: string }> = [
          { kind: "ok", message: "Saved — config persisted to global scope" },
          { kind: "err", message: "Cannot connect — check token and retry" },
          { kind: "info", message: "Hearth daemon is running on socket /tmp/…" },
        ];
        setFlash(messages[row] ?? null);
        setTimeout(() => setFlash(null), 2500);
      }
    }
  });

  if (!visible) return null;

  const body = renderBody(
    tab,
    row,
    btnCol,
    toggles,
    checks,
    radio,
    width - 26,
    query,
    searchMode,
    filteredUsers,
    effectiveExpanded,
    pickerIdx,
    filteredProviders,
    pickerQuery,
    pickerSearchMode,
  );

  return (
    <PremiumPopup
      visible={visible}
      width={width}
      height={height}
      title="UI Demo"
      titleIcon="⌂"
      tabs={TABS}
      activeTab={tab}
      sidebarFooter={<StatusPill status="online" label="dev" />}
      footerHints={
        tab === "data" && searchMode
          ? [
              { key: "type", label: "filter" },
              { key: "Backspace", label: "delete" },
              { key: "Enter", label: "done" },
              { key: "Esc", label: "exit search" },
            ]
          : tab === "data"
            ? [
                { key: "↑↓", label: "row" },
                { key: "/", label: "search" },
                { key: "Enter", label: "select" },
                { key: "Tab", label: "switch" },
                { key: "Esc", label: "close" },
              ]
            : tab === "picker" && pickerSearchMode
              ? [
                  { key: "type", label: "filter (try anthr/sonn)" },
                  { key: "Backspace", label: "delete" },
                  { key: "Enter", label: "done" },
                  { key: "Esc", label: "exit search" },
                ]
              : tab === "picker"
                ? [
                    { key: "↑↓", label: "row" },
                    { key: "←→", label: "collapse / drill in" },
                    { key: "/", label: "search" },
                    { key: "Enter", label: "toggle / select" },
                    { key: "Tab", label: "switch" },
                    { key: "Esc", label: "close" },
                  ]
                : tab === "controls" && row === 4
                  ? [
                      { key: "←→", label: "button" },
                      { key: "↑↓", label: "row" },
                      { key: "Enter", label: "activate" },
                      { key: "Tab", label: "switch" },
                      { key: "Esc", label: "close" },
                    ]
                  : [
                      { key: "↑↓", label: "nav" },
                      { key: "Tab", label: "switch" },
                      { key: "Space", label: "toggle" },
                      { key: "Esc", label: "close" },
                    ]
      }
      flash={flash}
    >
      {body}
    </PremiumPopup>
  );
}

function renderBody(
  tab: Tab,
  row: number,
  btnCol: number,
  toggles: { a: boolean; b: boolean },
  checks: { x: boolean; y: boolean; z: boolean },
  radio: "x" | "y" | "z",
  contentW: number,
  query: string,
  searchMode: boolean,
  filteredUsers: User[],
  expanded: Set<string>,
  pickerIdx: number,
  pickerGroups: GroupedListGroup<ModelRow>[],
  pickerQuery: string,
  pickerSearchMode: boolean,
) {
  if (tab === "controls") {
    return (
      <Section>
        <Toggle
          label="Auto-compact"
          description="Summarize old messages when context fills up"
          on={toggles.a}
          focused={row === 0}
        />
        <VSpacer />
        <Toggle
          label="Verbose logs"
          description="Include tool-call payloads in the event stream"
          on={toggles.b}
          focused={row === 1}
        />
        <VSpacer />
        <Checkbox
          label="Index node_modules"
          description="Slower scans, but covers vendored code"
          checked={checks.x}
          focused={row === 2}
        />
        <VSpacer />
        <box flexDirection="column">
          <Radio label="Plan first" selected={radio === "x"} focused={row === 3 && false} />
          <Radio label="Execute immediately" selected={radio === "y"} focused={row === 3} />
          <Radio label="Ask every time" selected={radio === "z"} focused={row === 3 && false} />
        </box>
        <VSpacer />
        <box flexDirection="row">
          <Button
            label=" Save "
            focused={row === 4 && btnCol === 0}
            keyHint={row === 4 && btnCol === 0 ? "Enter" : undefined}
          />
          <box width={2} />
          <Button
            label=" Cancel "
            variant="ghost"
            focused={row === 4 && btnCol === 1}
            keyHint={row === 4 && btnCol === 1 ? "Enter" : undefined}
          />
          <box width={2} />
          <Button
            label=" Delete "
            variant="danger"
            focused={row === 4 && btnCol === 2}
            keyHint={row === 4 && btnCol === 2 ? "Enter" : undefined}
          />
        </box>
      </Section>
    );
  }

  if (tab === "fields") {
    return (
      <Section>
        <Field
          label="Provider"
          value="anthropic"
          labelWidth={14}
          focused={row === 0}
          keyHint="Enter"
        />
        <Field
          label="Model"
          value="claude-sonnet-4-7"
          labelWidth={14}
          focused={row === 1}
          keyHint="Enter"
        />
        <Field label="Workspace" value="~/dev/proxy" labelWidth={14} focused={row === 2} />
        <Field
          label="Connection"
          value={<StatusPill status="online" label="READY" />}
          labelWidth={14}
          focused={row === 3}
        />
        <VSpacer />
        <Divider width={contentW} />
        <VSpacer />
        <box flexDirection="row">
          <StatusPill status="online" label="ONLINE" />
          <box width={3} />
          <StatusPill status="warning" label="DEGRADED" />
          <box width={3} />
          <StatusPill status="error" label="ERROR" />
          <box width={3} />
          <StatusPill status="offline" label="OFFLINE" />
          <box width={3} />
          <StatusPill status="idle" label="IDLE" />
        </box>
      </Section>
    );
  }

  if (tab === "data") {
    return (
      <Section>
        <Search
          value={query}
          focused={searchMode}
          placeholder="Search by name, email, role — press / to focus"
          count={`${filteredUsers.length} / ${USERS.length}`}
        />
        <VSpacer />
        <Table
          columns={USER_COLUMNS}
          rows={filteredUsers}
          width={contentW - 4}
          selectedIndex={searchMode ? -1 : row}
          focused={!searchMode}
          emptyMessage="No matches — refine your query"
          maxRows={6}
        />
        <VSpacer />
        <Hint>
          Press [/] to filter · typing updates live · [Enter] in search returns to the list
        </Hint>
      </Section>
    );
  }

  if (tab === "picker") {
    const totalModels = PROVIDERS.reduce((a, g) => a + g.items.length, 0);
    const visibleModels = pickerGroups.reduce((a, g) => a + g.items.length, 0);
    return (
      <Section>
        <Search
          value={pickerQuery}
          focused={pickerSearchMode}
          placeholder="Try anthr/sonn · gpt · gateway/opus · claude"
          count={
            pickerQuery
              ? `${visibleModels} / ${totalModels} models`
              : `${totalModels} models · ${PROVIDERS.length} providers`
          }
        />
        <VSpacer />
        <GroupedList
          groups={pickerGroups}
          expanded={expanded}
          selectedIndex={pickerSearchMode ? -1 : pickerIdx}
          width={contentW - 4}
          maxRows={10}
          focused={!pickerSearchMode}
          emptyMessage="No matches — try a shorter query or a different split (foo/bar)"
        />
        <VSpacer />
        <Hint>[/] search · supports `provider/model` splits · substring + subsequence match</Hint>
      </Section>
    );
  }

  if (tab === "flash") {
    return (
      <Section>
        <Field
          label="Success flash"
          value="✓ Saved — config persisted"
          focused={row === 0}
          keyHint="Space"
        />
        <Field
          label="Error flash"
          value="✗ Cannot connect — check token"
          focused={row === 1}
          keyHint="Space"
        />
        <Field label="Info flash" value="ⓘ Daemon is running" focused={row === 2} keyHint="Space" />
        <VSpacer />
        <Divider width={contentW} />
        <VSpacer />
        <Hint>Tip: hints use italic muted text with a · prefix</Hint>
        <Hint kind="warn">Warnings escalate to the warning color and icon</Hint>
      </Section>
    );
  }

  return (
    <Section>
      <box flexDirection="row">
        <KeyCap keyName="Enter" label="select" />
        <box width={3} />
        <KeyCap keyName="Esc" label="close" />
        <box width={3} />
        <KeyCap keyName="Tab" label="switch panel" />
      </box>
      <VSpacer />
      <box flexDirection="row">
        <KeyCap keyName="↑↓" label="navigate" />
        <box width={3} />
        <KeyCap keyName="Ctrl+K" label="command palette" />
        <box width={3} />
        <KeyCap keyName="Ctrl+D" label="cycle mode" />
      </box>
      <VSpacer />
      <Divider width={contentW} />
      <VSpacer />
      <Hint>Each `[key]` uses dim brackets + bold accent letter + muted label.</Hint>
    </Section>
  );
}
