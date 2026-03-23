import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useEffect, useMemo, useState } from "react";
import { icon, providerIcon } from "../../core/icons.js";
import { PROVIDER_CONFIGS } from "../../core/llm/models.js";
import {
  checkProviders,
  getCachedProviderStatuses,
  type ProviderStatus,
} from "../../core/llm/provider.js";
import { hasSecret, type SecretKey } from "../../core/secrets.js";
import { useGroupedModels } from "../../hooks/useGroupedModels.js";
import { usePopupScroll } from "../../hooks/usePopupScroll.js";
import { useProviderModels } from "../../hooks/useProviderModels.js";
import { Overlay, POPUP_BG, POPUP_HL, PopupRow, SPINNER_FRAMES_FILLED } from "../layout/shared.js";

/** Map provider envVar → SecretKey for key-status lookup */
const ENV_TO_SECRET_KEY: Record<string, SecretKey> = {
  ANTHROPIC_API_KEY: "anthropic-api-key",
  OPENAI_API_KEY: "openai-api-key",
  GOOGLE_GENERATIVE_AI_API_KEY: "google-api-key",
  XAI_API_KEY: "xai-api-key",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLM_GATEWAY_API_KEY: "llmgateway-api-key",
  AI_GATEWAY_API_KEY: "vercel-gateway-api-key",
};

function keyStatus(envVar: string): { color: string; label: string } | null {
  if (!envVar) return null; // ollama, proxy — no key needed
  const secretKey = ENV_TO_SECRET_KEY[envVar];
  if (!secretKey) return null;
  const info = hasSecret(secretKey);
  if (!info.set) return { color: "#FF0040", label: "" };
  if (info.source === "env") return { color: "#00FF00", label: "env" };
  return { color: "#00FF00", label: "sec" };
}

const MAX_POPUP_WIDTH = 70;

interface Props {
  visible: boolean;
  activeModel: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

type Level = "provider" | "subprovider" | "model";

function isGroupedProvider(id: string | null): boolean {
  return !!id && !!PROVIDER_CONFIGS.find((p) => p.id === id)?.grouped;
}

const CHROME_ROWS = 8;

const ProviderRow = memo(function ProviderRow({
  provider,
  isActive,
  available,
  innerW,
}: {
  provider: { id: string; name: string; envVar: string };
  isActive: boolean;
  available: boolean;
  innerW: number;
}) {
  const ks = keyStatus(provider.envVar);
  const bg = isActive ? POPUP_HL : POPUP_BG;
  return (
    <PopupRow bg={bg} w={innerW}>
      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
        {isActive ? "› " : "  "}
      </text>
      {ks && (
        <text bg={bg} fg={ks.color}>
          {icon(ks.label ? "key" : "key_missing")}
          {ks.label ? `[${ks.label}]` : ""}{" "}
        </text>
      )}
      <text
        bg={bg}
        fg={isActive ? "#FF0040" : "#aaa"}
        attributes={isActive ? TextAttributes.BOLD : undefined}
      >
        {providerIcon(provider.id)} {provider.name}
      </text>
      <text bg={bg}> </text>
      <text bg={bg} fg={available ? "#00FF00" : "#FF0040"}>
        {available ? "●" : "○"}
      </text>
    </PopupRow>
  );
});

const ModelRow = memo(function ModelRow({
  modelId,
  displayId,
  isActive,
  isCurrent,
  innerW,
}: {
  modelId: string;
  displayId: string;
  isActive: boolean;
  isCurrent: boolean;
  innerW: number;
}) {
  const bg = isActive ? POPUP_HL : POPUP_BG;
  return (
    <PopupRow key={modelId} bg={bg} w={innerW}>
      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
        {isActive ? "› " : "  "}
      </text>
      <text
        bg={bg}
        fg={isActive ? "#FF0040" : isCurrent ? "#00FF00" : "#aaa"}
        attributes={isActive ? TextAttributes.BOLD : undefined}
        truncate
      >
        {displayId.length > innerW - 8 ? `${displayId.slice(0, innerW - 11)}…` : displayId}
      </text>
      {isCurrent && (
        <text bg={bg} fg="#00FF00">
          {" "}
          ✓
        </text>
      )}
    </PopupRow>
  );
});

const SubProviderRow = memo(function SubProviderRow({
  sub,
  isActive,
  modelCount,
  innerW,
}: {
  sub: { id: string; name: string };
  isActive: boolean;
  modelCount: number;
  innerW: number;
}) {
  const bg = isActive ? POPUP_HL : POPUP_BG;
  return (
    <PopupRow bg={bg} w={innerW}>
      <text bg={bg} fg={isActive ? "#FF0040" : "#555"}>
        {isActive ? "› " : "  "}
      </text>
      <text
        bg={bg}
        fg={isActive ? "#FF0040" : "#aaa"}
        attributes={isActive ? TextAttributes.BOLD : undefined}
      >
        {providerIcon(sub.id)} {sub.name}
      </text>
      <text bg={bg} fg="#555" attributes={TextAttributes.DIM}>
        {" "}
        ({String(modelCount)})
      </text>
    </PopupRow>
  );
});

export const LlmSelector = memo(function LlmSelector({
  visible,
  activeModel,
  onSelect,
  onClose,
}: Props) {
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const containerRows = termRows - 2;
  const popupWidth = Math.min(MAX_POPUP_WIDTH, Math.floor(termCols * 0.8));
  const maxVisible = Math.max(4, Math.floor(containerRows * 0.8) - CHROME_ROWS);
  const [level, setLevel] = useState<Level>("provider");
  const [providerCursor, setProviderCursor] = useState(0);
  const {
    cursor: subproviderCursor,
    setCursor: setSubproviderCursor,
    scrollOffset: subScrollOffset,
    adjustScroll: adjustSubScroll,
    resetScroll: resetSubScroll,
  } = usePopupScroll(maxVisible);
  const {
    cursor: modelCursor,
    setCursor: setModelCursor,
    scrollOffset: modelScrollOffset,
    adjustScroll: adjustModelScroll,
    resetScroll: resetModelScroll,
  } = usePopupScroll(maxVisible);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [expandedSubprovider, setExpandedSubprovider] = useState<string | null>(null);
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  const isGrouped = isGroupedProvider(expandedProvider);

  const directProviderId = expandedProvider && !isGrouped ? expandedProvider : null;
  const {
    models: directModels,
    loading: directLoading,
    error: directError,
  } = useProviderModels(directProviderId);

  const groupedProviderId = isGrouped ? expandedProvider : null;
  const {
    subProviders,
    modelsByProvider: groupedModelsByProvider,
    loading: groupedLoading,
    error: groupedError,
  } = useGroupedModels(groupedProviderId);

  const loading = isGrouped ? groupedLoading : directLoading;

  const [providerStatuses, setProviderStatuses] = useState<ProviderStatus[]>(
    () => getCachedProviderStatuses() ?? [],
  );

  const statusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const s of providerStatuses) map.set(s.id, s.available);
    return map;
  }, [providerStatuses]);

  useEffect(() => {
    if (visible) {
      const cached = getCachedProviderStatuses();
      if (cached) setProviderStatuses(cached);
      checkProviders().then(setProviderStatuses);
      setLevel("provider");
      setExpandedProvider(null);
      setExpandedSubprovider(null);
      resetModelScroll();
      resetSubScroll();
    }
  }, [visible, resetModelScroll, resetSubScroll]);

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER_FRAMES_FILLED.length);
    }, 80);
    return () => clearInterval(interval);
  }, [loading]);

  const currentModels =
    isGrouped && expandedSubprovider
      ? (groupedModelsByProvider[expandedSubprovider] ?? [])
      : directModels;

  const currentError = isGrouped ? groupedError : directError;

  useKeyboard((evt) => {
    if (!visible) return;

    if (level === "provider") {
      if (evt.name === "escape") {
        onClose();
        return;
      }
      if (evt.name === "return") {
        const provider = PROVIDER_CONFIGS[providerCursor];
        if (provider) {
          setExpandedProvider(provider.id);
          if (provider.grouped) {
            setLevel("subprovider");
            resetSubScroll();
          } else {
            setLevel("model");
            resetModelScroll();
          }
        }
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        setProviderCursor((prev) => (prev > 0 ? prev - 1 : PROVIDER_CONFIGS.length - 1));
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setProviderCursor((prev) => (prev < PROVIDER_CONFIGS.length - 1 ? prev + 1 : 0));
        return;
      }
    }

    if (level === "subprovider") {
      if (evt.name === "escape" || evt.name === "left") {
        setLevel("provider");
        setExpandedProvider(null);
        setExpandedSubprovider(null);
        return;
      }
      if (evt.name === "return" && !groupedLoading && subProviders.length > 0) {
        const sub = subProviders[subproviderCursor];
        if (sub) {
          setExpandedSubprovider(sub.id);
          setLevel("model");
          resetModelScroll();
        }
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        setSubproviderCursor((prev) => {
          const next = prev > 0 ? prev - 1 : Math.max(0, subProviders.length - 1);
          adjustSubScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setSubproviderCursor((prev) => {
          const next = prev < subProviders.length - 1 ? prev + 1 : 0;
          adjustSubScroll(next);
          return next;
        });
        return;
      }
    }

    if (level === "model") {
      if (evt.name === "escape" || evt.name === "left") {
        if (isGrouped) {
          setLevel("subprovider");
          setExpandedSubprovider(null);
        } else {
          setLevel("provider");
          setExpandedProvider(null);
        }
        return;
      }
      if (evt.name === "return" && !loading && currentModels.length > 0) {
        const model = currentModels[modelCursor];
        if (model) {
          onSelect(`${expandedProvider}/${model.id}`);
          onClose();
        }
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        setModelCursor((prev) => {
          const next = prev > 0 ? prev - 1 : Math.max(0, currentModels.length - 1);
          adjustModelScroll(next);
          return next;
        });
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        setModelCursor((prev) => {
          const next = prev < currentModels.length - 1 ? prev + 1 : 0;
          adjustModelScroll(next);
          return next;
        });
        return;
      }
    }
  });

  if (!visible) return null;

  const slashIdx = activeModel.indexOf("/");
  const activeProvider = slashIdx >= 0 ? activeModel.slice(0, slashIdx) : "";
  const activeModelId = slashIdx >= 0 ? activeModel.slice(slashIdx + 1) : "";
  const innerW = popupWidth - 2;

  if (level === "provider") {
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
              {"\uDB80\uDE26"} Select Provider
            </text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text fg="#333" bg={POPUP_BG}>
              {"─".repeat(innerW - 4)}
            </text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>

          {PROVIDER_CONFIGS.map((provider, i) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              isActive={i === providerCursor}
              available={statusMap.get(provider.id) ?? false}
              innerW={innerW}
            />
          ))}

          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {"↑↓"} navigate | {"⏎"} select | esc close
            </text>
          </PopupRow>
        </box>
      </Overlay>
    );
  }

  if (level === "subprovider") {
    const totalModels = Object.values(groupedModelsByProvider).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    const providerName =
      PROVIDER_CONFIGS.find((p) => p.id === expandedProvider)?.name ?? expandedProvider ?? "";

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
              {providerIcon(expandedProvider ?? "")} {providerName}
            </text>
            {!groupedLoading && subProviders.length > 0 && (
              <text fg="#555" attributes={TextAttributes.DIM} bg={POPUP_BG}>
                {" "}
                {String(totalModels)} models
              </text>
            )}
          </PopupRow>
          {expandedProvider === "proxy" && !groupedLoading && subProviders.length > 0 && (
            <>
              <PopupRow w={innerW}>
                <text fg="#8B5CF6" bg={POPUP_BG}>
                  {"  "}
                  {icon("check_link")} Claude subscription
                </text>
                <text fg="#555" bg={POPUP_BG}>
                  {" "}
                  · local proxy
                </text>
              </PopupRow>
              <PopupRow w={innerW}>
                <text fg="#a5650a" bg={POPUP_BG}>
                  {"  "} ⚠ Unofficial — uses CLIProxyAPI. Use at your own risk.
                </text>
              </PopupRow>
            </>
          )}
          <PopupRow w={innerW}>
            <text fg="#333" bg={POPUP_BG}>
              {"─".repeat(innerW - 4)}
            </text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text fg="#666" bg={POPUP_BG}>
              {" "}
              esc to go back
            </text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>

          {groupedError && (
            <PopupRow w={innerW}>
              <text fg="#f44" bg={POPUP_BG}>
                ⚠ {groupedError}
              </text>
            </PopupRow>
          )}

          {groupedLoading ? (
            <PopupRow w={innerW}>
              <text fg="#9B30FF" bg={POPUP_BG}>
                {SPINNER_FRAMES_FILLED[spinnerIdx]} fetching providers...
              </text>
            </PopupRow>
          ) : subProviders.length === 0 && !groupedError ? (
            <PopupRow w={innerW}>
              <text fg="#888" bg={POPUP_BG}>
                {"  "}No models found — try restarting SoulForge
              </text>
            </PopupRow>
          ) : (
            <box
              flexDirection="column"
              height={Math.min(subProviders.length || 1, maxVisible)}
              overflow="hidden"
            >
              {subProviders.slice(subScrollOffset, subScrollOffset + maxVisible).map((sub, vi) => (
                <SubProviderRow
                  key={sub.id}
                  sub={sub}
                  isActive={vi + subScrollOffset === subproviderCursor}
                  modelCount={groupedModelsByProvider[sub.id]?.length ?? 0}
                  innerW={innerW}
                />
              ))}
            </box>
          )}
          {!groupedLoading && subProviders.length > maxVisible && (
            <PopupRow w={innerW}>
              <text fg="#555" bg={POPUP_BG}>
                {subScrollOffset > 0 ? "↑ " : "  "}
                {String(subproviderCursor + 1)}/{String(subProviders.length)}
                {subScrollOffset + maxVisible < subProviders.length ? " ↓" : ""}
              </text>
            </PopupRow>
          )}

          <PopupRow w={innerW}>
            <text>{""}</text>
          </PopupRow>
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {"↑↓"} navigate | {"⏎"} select | esc back
            </text>
          </PopupRow>
        </box>
      </Overlay>
    );
  }

  const headerIcon = isGrouped
    ? providerIcon(expandedSubprovider ?? "")
    : providerIcon(expandedProvider ?? "");
  const headerName = isGrouped
    ? (subProviders.find((s) => s.id === expandedSubprovider)?.name ?? expandedSubprovider ?? "")
    : (PROVIDER_CONFIGS.find((p) => p.id === expandedProvider)?.name ?? expandedProvider ?? "");

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
            {headerIcon} {headerName}
          </text>
          {isGrouped && (
            <text fg="#555" attributes={TextAttributes.DIM} bg={POPUP_BG}>
              {" "}
              via {expandedProvider}
            </text>
          )}
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#333" bg={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#666" bg={POPUP_BG}>
            {" "}
            esc to go back
          </text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>

        {currentError && (
          <PopupRow w={innerW}>
            <text fg="#f44" bg={POPUP_BG}>
              ⚠ {currentError}
            </text>
          </PopupRow>
        )}

        {loading ? (
          <PopupRow w={innerW}>
            <text fg="#9B30FF" bg={POPUP_BG}>
              {SPINNER_FRAMES_FILLED[spinnerIdx]} fetching models...
            </text>
          </PopupRow>
        ) : currentModels.length === 0 && !currentError ? (
          <PopupRow w={innerW}>
            <text fg="#888" bg={POPUP_BG}>
              {"  "}No models found — try restarting SoulForge
            </text>
          </PopupRow>
        ) : (
          <box
            flexDirection="column"
            height={Math.min(currentModels.length || 1, maxVisible)}
            overflow="hidden"
          >
            {currentModels
              .slice(modelScrollOffset, modelScrollOffset + maxVisible)
              .map((model, vi) => {
                const displayId = model.id.includes("/")
                  ? model.id.slice(model.id.indexOf("/") + 1)
                  : model.id;
                return (
                  <ModelRow
                    key={model.id}
                    modelId={model.id}
                    displayId={displayId}
                    isActive={vi + modelScrollOffset === modelCursor}
                    isCurrent={expandedProvider === activeProvider && model.id === activeModelId}
                    innerW={innerW}
                  />
                );
              })}
          </box>
        )}
        {!loading && currentModels.length > maxVisible && (
          <PopupRow w={innerW}>
            <text fg="#555" bg={POPUP_BG}>
              {modelScrollOffset > 0 ? "↑ " : "  "}
              {String(modelCursor + 1)}/{String(currentModels.length)}
              {modelScrollOffset + maxVisible < currentModels.length ? " ↓" : ""}
            </text>
          </PopupRow>
        )}

        <PopupRow w={innerW}>
          <text>{""}</text>
        </PopupRow>
        <PopupRow w={innerW}>
          <text fg="#555" bg={POPUP_BG}>
            ↑↓ navigate ⏎ select esc back
          </text>
        </PopupRow>
      </box>
    </Overlay>
  );
});
