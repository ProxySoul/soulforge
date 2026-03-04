import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { providerIcon } from "../core/icons.js";
import { PROVIDER_CONFIGS } from "../core/llm/models.js";
import { checkProviders } from "../core/llm/provider.js";
import { useGroupedModels } from "../hooks/useGroupedModels.js";
import { useProviderModels } from "../hooks/useProviderModels.js";
import { POPUP_BG, POPUP_HL, PopupRow, SPINNER_FRAMES_FILLED } from "./shared.js";

const POPUP_WIDTH = 44;

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

export function LlmSelector({ visible, activeModel, onSelect, onClose }: Props) {
  const [level, setLevel] = useState<Level>("provider");
  const [providerCursor, setProviderCursor] = useState(0);
  const [subproviderCursor, setSubproviderCursor] = useState(0);
  const [modelCursor, setModelCursor] = useState(0);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [expandedSubprovider, setExpandedSubprovider] = useState<string | null>(null);
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  const isGrouped = isGroupedProvider(expandedProvider);

  // Direct provider models (non-grouped)
  const directProviderId = expandedProvider && !isGrouped ? expandedProvider : null;
  const {
    models: directModels,
    loading: directLoading,
    error: directError,
  } = useProviderModels(directProviderId);

  // Grouped provider models (gateway, proxy, etc.)
  const groupedProviderId = isGrouped ? expandedProvider : null;
  const {
    subProviders,
    modelsByProvider: groupedModelsByProvider,
    loading: groupedLoading,
    error: groupedError,
  } = useGroupedModels(groupedProviderId);

  const loading = isGrouped ? groupedLoading : directLoading;

  const providerStatuses = checkProviders();

  useEffect(() => {
    if (visible) {
      setLevel("provider");
      setExpandedProvider(null);
      setExpandedSubprovider(null);
      setModelCursor(0);
      setSubproviderCursor(0);
    }
  }, [visible]);

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER_FRAMES_FILLED.length);
    }, 80);
    return () => clearInterval(interval);
  }, [loading]);

  // Determine current models for the model level
  const currentModels =
    isGrouped && expandedSubprovider
      ? (groupedModelsByProvider[expandedSubprovider] ?? [])
      : directModels;

  const currentError = isGrouped ? groupedError : directError;

  useInput(
    (input, key) => {
      if (level === "provider") {
        if (key.escape) {
          onClose();
          return;
        }
        if (key.return) {
          const provider = PROVIDER_CONFIGS[providerCursor];
          if (provider) {
            setExpandedProvider(provider.id);
            if (provider.grouped) {
              setLevel("subprovider");
              setSubproviderCursor(0);
            } else {
              setLevel("model");
              setModelCursor(0);
            }
          }
          return;
        }
        if (key.upArrow || input === "k") {
          setProviderCursor((prev) => (prev > 0 ? prev - 1 : PROVIDER_CONFIGS.length - 1));
          return;
        }
        if (key.downArrow || input === "j") {
          setProviderCursor((prev) => (prev < PROVIDER_CONFIGS.length - 1 ? prev + 1 : 0));
          return;
        }
      }

      if (level === "subprovider") {
        if (key.escape || key.leftArrow) {
          setLevel("provider");
          setExpandedProvider(null);
          setExpandedSubprovider(null);
          return;
        }
        if (key.return && !groupedLoading && subProviders.length > 0) {
          const sub = subProviders[subproviderCursor];
          if (sub) {
            setExpandedSubprovider(sub.id);
            setLevel("model");
            setModelCursor(0);
          }
          return;
        }
        if (key.upArrow || input === "k") {
          setSubproviderCursor((prev) =>
            prev > 0 ? prev - 1 : Math.max(0, subProviders.length - 1),
          );
          return;
        }
        if (key.downArrow || input === "j") {
          setSubproviderCursor((prev) => (prev < subProviders.length - 1 ? prev + 1 : 0));
          return;
        }
      }

      if (level === "model") {
        if (key.escape || key.leftArrow) {
          if (isGrouped) {
            setLevel("subprovider");
            setExpandedSubprovider(null);
          } else {
            setLevel("provider");
            setExpandedProvider(null);
          }
          return;
        }
        if (key.return && !loading && currentModels.length > 0) {
          const model = currentModels[modelCursor];
          if (model) {
            onSelect(`${expandedProvider}/${model.id}`);
            onClose();
          }
          return;
        }
        if (key.upArrow || input === "k") {
          setModelCursor((prev) => (prev > 0 ? prev - 1 : Math.max(0, currentModels.length - 1)));
          return;
        }
        if (key.downArrow || input === "j") {
          setModelCursor((prev) => (prev < currentModels.length - 1 ? prev + 1 : 0));
          return;
        }
      }
    },
    { isActive: visible },
  );

  if (!visible) return null;

  // Parse activeModel: "gateway/anthropic/claude-opus-4.6" or "anthropic/claude-opus-4.6"
  const slashIdx = activeModel.indexOf("/");
  const activeProvider = slashIdx >= 0 ? activeModel.slice(0, slashIdx) : "";
  const activeModelId = slashIdx >= 0 ? activeModel.slice(slashIdx + 1) : "";
  const innerW = POPUP_WIDTH - 2; // inside border

  if (level === "provider") {
    return (
      <Box
        position="absolute"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width="100%"
        height="100%"
      >
        <Box flexDirection="column" borderStyle="round" borderColor="#8B5CF6" width={POPUP_WIDTH}>
          {/* Title */}
          <PopupRow w={innerW}>
            <Text color="white" bold backgroundColor={POPUP_BG}>
              {"\uDB80\uDE26"} Select Provider
            </Text>
          </PopupRow>
          {/* Separator */}
          <PopupRow w={innerW}>
            <Text color="#333" backgroundColor={POPUP_BG}>
              {"─".repeat(innerW - 4)}
            </Text>
          </PopupRow>
          {/* Empty row for spacing */}
          <PopupRow w={innerW}>
            <Text>{""}</Text>
          </PopupRow>

          {PROVIDER_CONFIGS.map((provider, i) => {
            const isActive = i === providerCursor;
            const status = providerStatuses.find((s) => s.id === provider.id);
            const available = status?.available ?? false;
            const bg = isActive ? POPUP_HL : POPUP_BG;
            return (
              <PopupRow key={provider.id} bg={bg} w={innerW}>
                <Text backgroundColor={bg} color={isActive ? "#FF0040" : "#555"}>
                  {isActive ? "› " : "  "}
                </Text>
                <Text backgroundColor={bg} color={isActive ? "#FF0040" : "#aaa"} bold={isActive}>
                  {providerIcon(provider.id)} {provider.name}
                </Text>
                <Text backgroundColor={bg}> </Text>
                <Text backgroundColor={bg} color={available ? "#00FF00" : "#FF0040"}>
                  {available ? "●" : "○"}
                </Text>
              </PopupRow>
            );
          })}

          {/* Empty row for spacing */}
          <PopupRow w={innerW}>
            <Text>{""}</Text>
          </PopupRow>
          {/* Hints */}
          <PopupRow w={innerW}>
            <Text color="#555" backgroundColor={POPUP_BG}>
              ↑↓ navigate ⏎ select esc close
            </Text>
          </PopupRow>
        </Box>
      </Box>
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
      <Box
        position="absolute"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        width="100%"
        height="100%"
      >
        <Box flexDirection="column" borderStyle="round" borderColor="#8B5CF6" width={POPUP_WIDTH}>
          {/* Title */}
          <PopupRow w={innerW}>
            <Text color="white" bold backgroundColor={POPUP_BG}>
              {providerIcon(expandedProvider ?? "")} {providerName}
            </Text>
            {!groupedLoading && subProviders.length > 0 && (
              <Text color="#555" dimColor backgroundColor={POPUP_BG}>
                {" "}
                {String(totalModels)} models
              </Text>
            )}
          </PopupRow>
          {/* Subscription badge for proxy */}
          {expandedProvider === "proxy" && !groupedLoading && subProviders.length > 0 && (
            <PopupRow w={innerW}>
              <Text color="#8B5CF6" backgroundColor={POPUP_BG}>
                {"  "}󰄬 Claude subscription
              </Text>
              <Text color="#555" backgroundColor={POPUP_BG}>
                {" "}
                · local proxy
              </Text>
            </PopupRow>
          )}
          {/* Separator */}
          <PopupRow w={innerW}>
            <Text color="#333" backgroundColor={POPUP_BG}>
              {"─".repeat(innerW - 4)}
            </Text>
          </PopupRow>
          {/* Back */}
          <PopupRow w={innerW}>
            <Text color="#666" backgroundColor={POPUP_BG}>
              {" "}
              esc to go back
            </Text>
          </PopupRow>
          {/* Empty row */}
          <PopupRow w={innerW}>
            <Text>{""}</Text>
          </PopupRow>

          {/* Error warning */}
          {groupedError && (
            <PopupRow w={innerW}>
              <Text color="#f44" backgroundColor={POPUP_BG}>
                ⚠ {groupedError}
              </Text>
            </PopupRow>
          )}

          {groupedLoading ? (
            <PopupRow w={innerW}>
              <Text color="#9B30FF" backgroundColor={POPUP_BG}>
                {SPINNER_FRAMES_FILLED[spinnerIdx]} fetching providers...
              </Text>
            </PopupRow>
          ) : (
            subProviders.map((sub, i) => {
              const isActive = i === subproviderCursor;
              const modelCount = groupedModelsByProvider[sub.id]?.length ?? 0;
              const bg = isActive ? POPUP_HL : POPUP_BG;
              return (
                <PopupRow key={sub.id} bg={bg} w={innerW}>
                  <Text backgroundColor={bg} color={isActive ? "#FF0040" : "#555"}>
                    {isActive ? "› " : "  "}
                  </Text>
                  <Text backgroundColor={bg} color={isActive ? "#FF0040" : "#aaa"} bold={isActive}>
                    {providerIcon(sub.id)} {sub.name}
                  </Text>
                  <Text backgroundColor={bg} color="#555" dimColor>
                    {" "}
                    ({String(modelCount)})
                  </Text>
                </PopupRow>
              );
            })
          )}

          {/* Empty row */}
          <PopupRow w={innerW}>
            <Text>{""}</Text>
          </PopupRow>
          {/* Hints */}
          <PopupRow w={innerW}>
            <Text color="#555" backgroundColor={POPUP_BG}>
              ↑↓ navigate ⏎ select esc back
            </Text>
          </PopupRow>
        </Box>
      </Box>
    );
  }

  // Level: model
  const headerIcon = isGrouped
    ? providerIcon(expandedSubprovider ?? "")
    : providerIcon(expandedProvider ?? "");
  const headerName = isGrouped
    ? (subProviders.find((s) => s.id === expandedSubprovider)?.name ?? expandedSubprovider ?? "")
    : (PROVIDER_CONFIGS.find((p) => p.id === expandedProvider)?.name ?? expandedProvider ?? "");

  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      height="100%"
    >
      <Box flexDirection="column" borderStyle="round" borderColor="#8B5CF6" width={POPUP_WIDTH}>
        {/* Title */}
        <PopupRow w={innerW}>
          <Text color="white" bold backgroundColor={POPUP_BG}>
            {headerIcon} {headerName}
          </Text>
          {isGrouped && (
            <Text color="#555" dimColor backgroundColor={POPUP_BG}>
              {" "}
              via {expandedProvider}
            </Text>
          )}
        </PopupRow>
        {/* Separator */}
        <PopupRow w={innerW}>
          <Text color="#333" backgroundColor={POPUP_BG}>
            {"─".repeat(innerW - 4)}
          </Text>
        </PopupRow>
        {/* Back */}
        <PopupRow w={innerW}>
          <Text color="#666" backgroundColor={POPUP_BG}>
            {" "}
            esc to go back
          </Text>
        </PopupRow>
        {/* Empty row */}
        <PopupRow w={innerW}>
          <Text>{""}</Text>
        </PopupRow>

        {/* Error warning */}
        {currentError && (
          <PopupRow w={innerW}>
            <Text color="#f44" backgroundColor={POPUP_BG}>
              ⚠ {currentError}
            </Text>
          </PopupRow>
        )}

        {loading ? (
          <PopupRow w={innerW}>
            <Text color="#9B30FF" backgroundColor={POPUP_BG}>
              {SPINNER_FRAMES_FILLED[spinnerIdx]} fetching models...
            </Text>
          </PopupRow>
        ) : (
          currentModels.map((model, i) => {
            const isActive = i === modelCursor;
            const isCurrent = isGrouped
              ? activeProvider === expandedProvider && model.id === activeModelId
              : expandedProvider === activeProvider && model.id === activeModelId;
            const bg = isActive ? POPUP_HL : POPUP_BG;
            // Strip provider prefix for display (gateway models have "anthropic/..." IDs)
            const displayId = model.id.includes("/")
              ? model.id.slice(model.id.indexOf("/") + 1)
              : model.id;
            return (
              <PopupRow key={model.id} bg={bg} w={innerW}>
                <Text backgroundColor={bg} color={isActive ? "#FF0040" : "#555"}>
                  {isActive ? "› " : "  "}
                </Text>
                <Text
                  backgroundColor={bg}
                  color={isActive ? "#FF0040" : isCurrent ? "#00FF00" : "#aaa"}
                  bold={isActive}
                >
                  {displayId}
                </Text>
                {isCurrent && (
                  <Text backgroundColor={bg} color="#00FF00">
                    {" "}
                    ✓
                  </Text>
                )}
              </PopupRow>
            );
          })
        )}

        {/* Empty row */}
        <PopupRow w={innerW}>
          <Text>{""}</Text>
        </PopupRow>
        {/* Hints */}
        <PopupRow w={innerW}>
          <Text color="#555" backgroundColor={POPUP_BG}>
            ↑↓ navigate ⏎ select esc back
          </Text>
        </PopupRow>
      </Box>
    </Box>
  );
}
