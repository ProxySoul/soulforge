import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { fetchGroupedModels, fetchProviderModels } from "../../../../core/llm/models.js";
import { getProvider } from "../../../../core/llm/providers/index.js";
import type { ProviderModelInfo } from "../../../../core/llm/providers/types.js";
import {
  getDefaultKeyPriority,
  getSecretSources,
  type SecretKey,
  setSecret,
} from "../../../../core/secrets.js";
import { useTheme } from "../../../../core/theme/index.js";
import { PopupRow, usePopupColors } from "../../../layout/shared.js";
import { Gap, StepHeader } from "../primitives.js";
import { BOLD } from "../theme.js";

// ── Data ──

interface ProviderEntry {
  id: SecretKey;
  providerId: string;
  label: string;
  envVar: string;
  url: string;
  desc: string;
  icon: string;
}

const GATEWAY_REF = "https://llmgateway.io/dashboard?ref=6tjJR2H3X4E9RmVQiQwK";

const PROVIDERS: ProviderEntry[] = [
  {
    id: "llmgateway-api-key",
    providerId: "llmgateway",
    label: "LLM Gateway",
    envVar: "LLM_GATEWAY_API_KEY",
    url: GATEWAY_REF,
    desc: "All models, one key",
    icon: getProvider("llmgateway")?.icon ?? "󰒍",
  },
  {
    id: "anthropic-api-key",
    providerId: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    url: "https://console.anthropic.com",
    desc: "Claude models",
    icon: getProvider("anthropic")?.icon ?? "●",
  },
  {
    id: "openai-api-key",
    providerId: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    url: "https://platform.openai.com",
    desc: "GPT & o-series",
    icon: getProvider("openai")?.icon ?? "●",
  },
  {
    id: "google-api-key",
    providerId: "google",
    label: "Google Gemini",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    url: "https://aistudio.google.com",
    desc: "Gemini models",
    icon: getProvider("google")?.icon ?? "●",
  },
  {
    id: "xai-api-key",
    providerId: "xai",
    label: "xAI Grok",
    envVar: "XAI_API_KEY",
    url: "https://console.x.ai",
    desc: "Grok models",
    icon: getProvider("xai")?.icon ?? "●",
  },
  {
    id: "openrouter-api-key",
    providerId: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai",
    desc: "Multi-provider router",
    icon: getProvider("openrouter")?.icon ?? "●",
  },
];

// ── Helpers ──

function hasKey(id: SecretKey): boolean {
  return getSecretSources(id, getDefaultKeyPriority()).active !== "none";
}

function getStatusTag(id: SecretKey): string {
  const s = getSecretSources(id, getDefaultKeyPriority());
  if (s.active === "none") return "";
  return s.active;
}

interface ModelEntry {
  id: string;
  name: string;
  group?: string;
}

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Phases ──

type Phase = "provider" | "key" | "fetching" | "models" | "error";

// ── Sub-components ──

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ProviderRow({ p, isSelected, iw }: { p: ProviderEntry; isSelected: boolean; iw: number }) {
  const t = useTheme();
  const { bg: popupBg, hl: popupHl } = usePopupColors();
  const bg = isSelected ? popupHl : popupBg;
  const configured = hasKey(p.id);
  const tag = getStatusTag(p.id);

  return (
    <PopupRow w={iw}>
      <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
        {isSelected ? " › " : "   "}
        {p.icon}
        {"  "}
      </text>
      <text bg={bg} fg={isSelected ? t.textPrimary : t.textSecondary} attributes={BOLD}>
        {p.label}
      </text>
      <text bg={bg} fg={t.textFaint}>
        {" — "}
        {p.desc}
      </text>
      {configured && (
        <text bg={bg} fg={t.success}>
          {"  ✓ "}
          {tag}
        </text>
      )}
    </PopupRow>
  );
}

function ModelRow({ m, isSelected, iw }: { m: ModelEntry; isSelected: boolean; iw: number }) {
  const t = useTheme();
  const { bg: popupBg, hl: popupHl } = usePopupColors();
  const bg = isSelected ? popupHl : popupBg;

  return (
    <PopupRow w={iw}>
      <text bg={bg} fg={isSelected ? t.brand : t.textFaint}>
        {isSelected ? " › " : "   "}
      </text>
      {m.group && (
        <text bg={bg} fg={t.textFaint}>
          {m.group}
          {" › "}
        </text>
      )}
      <text bg={bg} fg={isSelected ? t.textPrimary : t.textSecondary}>
        {m.name}
      </text>
    </PopupRow>
  );
}

// ── Main Component ──

interface SetupStepProps {
  iw: number;
  hasModel: boolean;
  activeModel: string;
  onSelectModel: (modelId?: string) => void;
  onForward: () => void;
  active: boolean;
  setActive: (v: boolean) => void;
}

export function SetupStep({
  iw,
  hasModel,
  activeModel,
  onSelectModel,
  onForward,
  setActive,
}: SetupStepProps) {
  const t = useTheme();
  const { bg: popupBg, hl: popupHl } = usePopupColors();

  const [phase, setPhase] = useState<Phase>("provider");
  const [cursor, setCursor] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<ProviderEntry | null>(null);

  // Key input
  const [keyInput, setKeyInput] = useState("");

  // Model state
  const [allModels, setAllModels] = useState<ModelEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [modelCursor, setModelCursor] = useState(0);

  // Feedback
  const [flash, setFlash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const [tick, setTick] = useState(0);
  const spinnerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputWidth = Math.min(Math.floor(iw * 0.8), 60);
  const refresh = () => setTick((n) => n + 1);
  void tick; // dependency: refresh() increments tick after key save, recomputing anyKeySet
  const anyKeySet = PROVIDERS.some((p) => hasKey(p.id));

  // Tell parent when we're handling input
  const isInputPhase = phase !== "provider";
  useEffect(() => {
    setActive(isInputPhase);
  }, [isInputPhase, setActive]);

  // Spinner
  useEffect(() => {
    if (phase === "fetching") {
      spinnerRef.current = setInterval(
        () => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
        80,
      );
      return () => {
        if (spinnerRef.current) clearInterval(spinnerRef.current);
      };
    }
    if (spinnerRef.current) {
      clearInterval(spinnerRef.current);
      spinnerRef.current = null;
    }
    return undefined;
  }, [phase]);

  // Reset on mount
  useEffect(() => {
    setPhase("provider");
    setCursor(0);
  }, []);

  const filteredModels = searchQuery
    ? allModels.filter(
        (m) => fuzzyMatch(searchQuery, m.name) || fuzzyMatch(searchQuery, m.group ?? ""),
      )
    : allModels;

  // Clamp model cursor when filter changes
  useEffect(() => {
    if (modelCursor >= filteredModels.length) {
      setModelCursor(Math.max(0, filteredModels.length - 1));
    }
  }, [filteredModels.length, modelCursor]);

  const fetchModels = async (provider: ProviderEntry) => {
    setPhase("fetching");
    setAllModels([]);
    setSearchQuery("");
    setModelCursor(0);

    try {
      const providerDef = getProvider(provider.providerId);
      let modelList: ModelEntry[] = [];

      if (providerDef?.grouped) {
        const result = await fetchGroupedModels(provider.providerId);
        if (result.error) {
          setErrorMsg(result.error);
          setPhase("error");
          return;
        }
        for (const sub of result.subProviders) {
          const subModels = result.modelsByProvider[sub.id] ?? [];
          for (const m of subModels) {
            modelList.push({ id: `${sub.id}/${m.id}`, name: m.name, group: sub.name });
          }
        }
      } else {
        const result = await fetchProviderModels(provider.providerId);
        if (result.error) {
          setErrorMsg(result.error);
          setPhase("error");
          return;
        }
        modelList = result.models.map((m: ProviderModelInfo) => ({
          id: `${provider.providerId}/${m.id}`,
          name: m.name,
        }));
      }

      if (modelList.length === 0) {
        setErrorMsg("No models returned. Check your API key.");
        setPhase("error");
        return;
      }

      setAllModels(modelList);
      setPhase("models");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to fetch models");
      setPhase("error");
    }
  };

  // ── Keyboard ──

  const handleKeyboard = (evt: import("@opentui/core").KeyEvent) => {
    // ── Models: search + select ──
    if (phase === "models") {
      if (evt.name === "escape") {
        if (searchQuery) {
          setSearchQuery("");
          setModelCursor(0);
        } else {
          setPhase("provider");
        }
        return;
      }
      if (evt.name === "up") {
        setModelCursor((c) => (c > 0 ? c - 1 : filteredModels.length - 1));
        return;
      }
      if (evt.name === "down") {
        setModelCursor((c) => (c < filteredModels.length - 1 ? c + 1 : 0));
        return;
      }
      if (evt.name === "return") {
        const selected = filteredModels[modelCursor];
        if (selected) {
          onSelectModel(selected.id);
          setFlash(`✓ ${selected.name}`);
          setPhase("provider");
          setTimeout(() => {
            setFlash(null);
            onForward();
          }, 600);
        }
        return;
      }
      if (evt.name === "backspace") {
        setSearchQuery((q) => q.slice(0, -1));
        setModelCursor(0);
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        setSearchQuery((q) => q + evt.sequence);
        setModelCursor(0);
      }
      return;
    }

    // ── Error ──
    if (phase === "error") {
      if (evt.name === "return") {
        setPhase("key");
        setKeyInput("");
        return;
      }
      if (evt.name === "escape") {
        setPhase("provider");
        return;
      }
      return;
    }

    // ── Fetching: block ──
    if (phase === "fetching") return;

    // ── Key input ──
    if (phase === "key") {
      if (evt.name === "escape") {
        setPhase("provider");
        setKeyInput("");
        return;
      }
      if (evt.name === "return") {
        if (selectedProvider && keyInput.trim()) {
          const result = setSecret(selectedProvider.id, keyInput.trim());
          if (result.success) {
            refresh();
            fetchModels(selectedProvider);
            return;
          }
        }
        return;
      }
      if (evt.name === "backspace") {
        setKeyInput((v) => v.slice(0, -1));
        return;
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        setKeyInput((v) => v + evt.sequence);
      }
      return;
    }

    // ── Provider selection ──
    if (evt.name === "up") {
      setCursor((c) => (c > 0 ? c - 1 : PROVIDERS.length - 1));
      return;
    }
    if (evt.name === "down") {
      setCursor((c) => (c < PROVIDERS.length - 1 ? c + 1 : 0));
      return;
    }
    if (evt.name === "return") {
      const provider = PROVIDERS[cursor];
      if (!provider) return;
      setSelectedProvider(provider);
      if (hasKey(provider.id)) {
        fetchModels(provider);
      } else {
        setPhase("key");
        setKeyInput("");
      }
    }
  };

  useKeyboard(handleKeyboard);

  // ── Render: Fetching ──
  if (phase === "fetching" && selectedProvider) {
    return (
      <>
        <Gap iw={iw} />
        <StepHeader iw={iw} ic={selectedProvider.icon} title={selectedProvider.label} />
        <Gap iw={iw} />
        <PopupRow w={iw}>
          <text fg={t.info} bg={popupBg}>
            {"   "}
            {SPINNER_FRAMES[spinnerFrame]}
            {" Fetching models..."}
          </text>
        </PopupRow>
      </>
    );
  }

  // ── Render: Model picker with search ──
  if (phase === "models" && selectedProvider) {
    const maxVisible = Math.min(10, filteredModels.length);
    const half = Math.floor(maxVisible / 2);
    const scrollOffset = Math.max(
      0,
      Math.min(modelCursor - half, filteredModels.length - maxVisible),
    );
    const visible = filteredModels.slice(scrollOffset, scrollOffset + maxVisible);

    return (
      <>
        <Gap iw={iw} />
        <StepHeader
          iw={iw}
          ic={selectedProvider.icon}
          title={`${selectedProvider.label} — Pick a Model`}
        />
        <Gap iw={iw} />

        {/* Search bar */}
        <PopupRow w={iw}>
          <text fg={t.textFaint} bg={popupBg}>
            {"   🔍 "}
          </text>
          <text fg={searchQuery ? t.textPrimary : t.textFaint} bg={popupHl}>
            {" "}
            {searchQuery || "type to filter..."}{" "}
          </text>
          {filteredModels.length !== allModels.length && (
            <text fg={t.textFaint} bg={popupBg}>
              {` ${String(filteredModels.length)}/${String(allModels.length)}`}
            </text>
          )}
        </PopupRow>

        <Gap iw={iw} />

        {filteredModels.length === 0 ? (
          <PopupRow w={iw}>
            <text fg={t.textFaint} bg={popupBg}>
              {"   No models match your search."}
            </text>
          </PopupRow>
        ) : (
          <>
            {visible.map((m, i) => {
              const realIdx = scrollOffset + i;
              return <ModelRow key={m.id} m={m} isSelected={realIdx === modelCursor} iw={iw} />;
            })}

            {filteredModels.length > maxVisible && (
              <PopupRow w={iw}>
                <text fg={t.textFaint} bg={popupBg}>
                  {"   "}
                  {`${String(modelCursor + 1)} of ${String(filteredModels.length)}`}
                </text>
              </PopupRow>
            )}
          </>
        )}

        <Gap iw={iw} />
        <PopupRow w={iw}>
          <text fg={t.textFaint} bg={popupBg}>
            {"   ↑↓ navigate · ⏎ select · esc "}
            {searchQuery ? "clear search" : "back"}
          </text>
        </PopupRow>
      </>
    );
  }

  // ── Render: Error ──
  if (phase === "error" && selectedProvider) {
    return (
      <>
        <Gap iw={iw} />
        <StepHeader iw={iw} ic={selectedProvider.icon} title={selectedProvider.label} />
        <Gap iw={iw} />
        <PopupRow w={iw}>
          <text fg={t.error} bg={popupBg}>
            {"   ✗ "}
            {errorMsg.length > iw - 10 ? `${errorMsg.slice(0, iw - 13)}...` : errorMsg}
          </text>
        </PopupRow>
        <Gap iw={iw} />
        <PopupRow w={iw}>
          <text fg={t.textFaint} bg={popupBg}>
            {"   ⏎ re-enter key · esc back"}
          </text>
        </PopupRow>
      </>
    );
  }

  // ── Render: Key input ──
  if (phase === "key" && selectedProvider) {
    const masked =
      keyInput.length > 0
        ? `${"*".repeat(Math.max(0, keyInput.length - 4))}${keyInput.slice(-4)}`
        : "";
    const displayMask = masked.length > inputWidth ? `…${masked.slice(-(inputWidth - 1))}` : masked;

    return (
      <>
        <Gap iw={iw} />
        <StepHeader iw={iw} ic="⚿" title={`Set ${selectedProvider.label} Key`} />
        <Gap iw={iw} />

        <PopupRow w={iw}>
          <text fg={t.textSecondary} bg={popupBg}>
            {"   Get your key at "}
          </text>
          <text bg={popupBg}>
            <a href={selectedProvider.url}>
              <span fg={t.info} attributes={TextAttributes.UNDERLINE}>
                {selectedProvider.url.replace("https://", "").replace(/\?.*$/, "")}
              </span>
            </a>
          </text>
        </PopupRow>

        <Gap iw={iw} />

        <PopupRow w={iw}>
          <text fg={t.textMuted} bg={popupBg}>
            {"   Paste your API key:"}
          </text>
        </PopupRow>

        <PopupRow w={iw}>
          <text bg={popupBg}>{"   "}</text>
          <text bg={popupHl} fg={t.info}>
            {" "}
            {displayMask || " "}
          </text>
          <text bg={popupHl} fg={t.brandSecondary}>
            {"▎"}
          </text>
          <text bg={popupHl}>{" ".repeat(Math.max(0, inputWidth - (displayMask.length + 3)))}</text>
        </PopupRow>

        <Gap iw={iw} />

        <PopupRow w={iw}>
          <text fg={t.textFaint} bg={popupBg}>
            {"   ⏎ save & fetch models · esc cancel"}
          </text>
        </PopupRow>
      </>
    );
  }

  // ── Render: Provider selection ──
  return (
    <>
      <Gap iw={iw} />
      <StepHeader iw={iw} ic="◈" title="Choose a Provider" />
      <Gap iw={iw} />

      <PopupRow w={iw}>
        <text fg={t.textSecondary} bg={popupBg}>
          {"   Select a provider and press ⏎ to set up."}
        </text>
      </PopupRow>

      <Gap iw={iw} />

      {PROVIDERS.map((p, i) => (
        <ProviderRow key={p.id} p={p} isSelected={i === cursor} iw={iw} />
      ))}

      {/* Gateway link — contextual, only when gateway selected and no key */}
      {PROVIDERS[cursor]?.id === "llmgateway-api-key" && !hasKey("llmgateway-api-key") && (
        <>
          <Gap iw={iw} />
          <PopupRow w={iw}>
            <text fg={t.textFaint} bg={popupBg}>
              {"   "}
            </text>
            <text bg={popupBg}>
              <a href={GATEWAY_REF}>
                <span fg={t.info} attributes={TextAttributes.UNDERLINE}>
                  llmgateway.io
                </span>
              </a>
            </text>
            <text fg={t.textFaint} bg={popupBg}>
              {" — one key for all models"}
            </text>
          </PopupRow>
        </>
      )}

      {hasModel && (
        <>
          <Gap iw={iw} />
          <PopupRow w={iw}>
            <text fg={t.success} attributes={BOLD} bg={popupBg}>
              {"   ✓ "}
            </text>
            <text fg={t.textPrimary} attributes={BOLD} bg={popupBg}>
              {activeModel}
            </text>
          </PopupRow>
        </>
      )}

      {flash && (
        <>
          <Gap iw={iw} />
          <PopupRow w={iw}>
            <text fg={t.success} attributes={BOLD} bg={popupBg}>
              {"   "}
              {flash}
            </text>
          </PopupRow>
        </>
      )}

      <Gap iw={iw} />
      <PopupRow w={iw}>
        <text fg={t.textFaint} bg={popupBg}>
          {anyKeySet
            ? "   ↑↓ select · ⏎ set up · → next step"
            : "   ↑↓ select · ⏎ set up · esc close"}
        </text>
      </PopupRow>
    </>
  );
}
