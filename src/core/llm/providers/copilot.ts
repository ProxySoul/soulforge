import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getProviderApiKey } from "../../secrets.js";
import { CURRENT_VERSION } from "../../version.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

const ENV_VAR = "COPILOT_API_KEY";
const COPILOT_API = "https://api.githubcopilot.com";
const TOKEN_EXCHANGE = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": `SoulForge/${CURRENT_VERSION}`,
  "Editor-Plugin-Version": `SoulForge/${CURRENT_VERSION}`,
  "Copilot-Integration-Id": "vscode-chat",
};

interface TokenResponse {
  token: string;
  expires_at: number;
}

let cachedBearer: { token: string; expiresAt: number } | null = null;

async function exchangeToken(githubToken: string): Promise<string> {
  if (cachedBearer && Date.now() / 1000 < cachedBearer.expiresAt - 60) {
    return cachedBearer.token;
  }
  const res = await fetch(TOKEN_EXCHANGE, {
    headers: {
      Authorization: `Token ${githubToken}`,
      "User-Agent": `SoulForge/${CURRENT_VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    cachedBearer = null;
    const body = await res.text().catch(() => "");
    throw new Error(
      `Copilot token exchange failed (${String(res.status)})${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.token) throw new Error("Copilot token exchange returned empty token");
  cachedBearer = { token: data.token, expiresAt: data.expires_at };
  return data.token;
}

/** Invalidate cached bearer so next request triggers a fresh exchange. */
function invalidateBearer(): void {
  cachedBearer = null;
}

function getGitHubToken(): string {
  const stored = getProviderApiKey(ENV_VAR);
  if (stored) return stored;
  throw new Error(
    "GitHub Copilot requires an OAuth token. Sign in via VS Code or JetBrains, then copy oauth_token from ~/.config/github-copilot/apps.json and save it with /keys or --set-key copilot.",
  );
}

function createCopilotModel(modelId: string): LanguageModel {
  const githubToken = getGitHubToken();
  const client = createOpenAI({
    baseURL: COPILOT_API,
    apiKey: "copilot",
    headers: { ...COPILOT_HEADERS },
    // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type mismatch with preconnect
    fetch: (async (url: any, init: any) => {
      let bearer: string;
      try {
        bearer = await exchangeToken(githubToken);
      } catch {
        invalidateBearer();
        bearer = await exchangeToken(githubToken);
      }
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${bearer}`);
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401) {
        invalidateBearer();
        const retryBearer = await exchangeToken(githubToken);
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set("Authorization", `Bearer ${retryBearer}`);
        return fetch(url, { ...init, headers: retryHeaders });
      }
      return res;
    }) as typeof fetch,
  });
  return client.chat(modelId);
}

export const copilot: ProviderDefinition = {
  id: "copilot",
  name: "GitHub Copilot",
  envVar: ENV_VAR,
  icon: "\uEC1E", // nf-cod-copilot U+EC1E
  secretKey: "copilot-api-key",
  keyUrl: "github.com/features/copilot",
  asciiIcon: "CP",
  description: "Free with Copilot sub",
  badge: "unofficial",

  createModel: createCopilotModel,

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    try {
      const githubToken = getGitHubToken();
      const bearer = await exchangeToken(githubToken);
      const res = await fetch(`${COPILOT_API}/models`, {
        headers: { Authorization: `Bearer ${bearer}`, ...COPILOT_HEADERS },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data: { id: string }[] };
      if (!Array.isArray(data?.data)) return null;
      const skip = /embed|text-embedding|oswe|goldeneye|inference/i;
      const result: ProviderModelInfo[] = [];
      for (const m of data.data) {
        if (skip.test(m.id)) continue;
        if (result.some((r) => r.id === m.id)) continue;
        result.push({ id: m.id, name: m.id });
      }
      return result;
    } catch {
      return null;
    }
  },

  fallbackModels: [
    { id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 200_000 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 128_000 },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000 },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000 },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000 },
    { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 128_000 },
    { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 200_000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 200_000 },
    { id: "o4-mini", name: "o4 Mini", contextWindow: 128_000 },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 128_000 },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", contextWindow: 1_000_000 },
  ],

  contextWindows: [
    ["claude-opus-4.6", 200_000],
    ["claude-sonnet-4.6", 200_000],
    ["claude-opus-4.5", 200_000],
    ["claude-sonnet-4.5", 200_000],
    ["claude-sonnet-4", 128_000],
    ["claude-haiku-4.5", 200_000],
    ["claude-3.7-sonnet", 200_000],
    ["claude-3.5-sonnet", 90_000],
    ["gpt-5.4", 200_000],
    ["gpt-5.3", 200_000],
    ["gpt-5.2", 200_000],
    ["gpt-5.1", 200_000],
    ["gpt-5-mini", 128_000],
    ["gpt-4.1", 128_000],
    ["gpt-4o-mini", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4", 32_768],
    ["o4-mini", 128_000],
    ["o3-mini", 200_000],
    ["gemini-3", 1_000_000],
    ["gemini-2.5-pro", 128_000],
    ["gemini-2.0-flash", 1_000_000],
    ["grok", 131_072],
  ],

  async checkAvailability() {
    return !!getProviderApiKey(ENV_VAR);
  },

  grouped: true,
};
