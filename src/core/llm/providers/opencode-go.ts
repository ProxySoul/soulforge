import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition } from "./types.js";

const BASE_URL = "https://opencode.ai/zen/go/v1";

export const opencodeGo: ProviderDefinition = {
  id: "opencode-go",
  name: "OpenCode Go",
  envVar: "OPENCODE_GO_API_KEY",
  icon: "\uE795", // nf-dev-go U+E795
  secretKey: "opencode-go-api-key",
  keyUrl: "opencode.ai",
  asciiIcon: "GO",
  description: "GLM, Kimi, MiMo, MiniMax models",

  createModel(modelId: string): LanguageModel {
    const apiKey = getProviderApiKey("OPENCODE_GO_API_KEY");
    if (!apiKey) {
      throw new Error("OPENCODE_GO_API_KEY is not set");
    }
    // Use @ai-sdk/openai-compatible to properly handle reasoning_content
    // Fixes 400 error: "thinking is enabled but reasoning_content is missing"
    const provider = createOpenAICompatible({
      name: "opencode-go",
      baseURL: BASE_URL,
      apiKey,
    });
    return provider.chatModel(modelId);
  },

  async fetchModels(): Promise<null> {
    // No model listing API available
    return null;
  },

  fallbackModels: [
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "mimo-v2-pro", name: "MiMo V2 Pro" },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
  ],

  contextWindows: [
    // GLM models: ~200k context window (docs.z.ai)
    ["glm-5.1", 204_800],
    ["glm-5", 204_800],
    // Kimi K2.5: standard 128k
    ["kimi-k2.5", 131_072],
    // MiMo models: assumed standard
    ["mimo-v2-pro", 131_072],
    ["mimo-v2-omni", 131_072],
    // MiniMax
    ["minimax-m2.7", 131_072],
    ["minimax-m2.5", 131_072],
  ],
};
