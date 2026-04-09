import { icon } from "../icons.js";
import { invalidateProviderModelCache } from "../llm/models.js";
import { checkProviders } from "../llm/provider.js";
import { getCodexLoginStatus, logoutCodex } from "../llm/providers/codex/index.js";
import { getProvider } from "../llm/providers/index.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";

interface CodexCommandTheme {
  success: string;
  brandSecondary: string;
  warning: string;
  textPrimary: string;
  textSecondary: string;
}

async function refreshCodexState(): Promise<void> {
  invalidateProviderModelCache("codex");
  await checkProviders().catch(() => {});
}

export function getCodexStatusPopupLines(
  status: ReturnType<typeof getCodexLoginStatus>,
  theme: CodexCommandTheme,
) {
  return [
    {
      type: "entry" as const,
      label: "Installed",
      desc: status.installed ? "yes" : "no",
      descColor: status.installed ? theme.success : theme.brandSecondary,
    },
    {
      type: "entry" as const,
      label: "Logged in",
      desc: status.loggedIn ? "yes" : "no",
      descColor: status.loggedIn ? theme.success : theme.warning,
    },
    {
      type: "entry" as const,
      label: "Auth mode",
      desc: status.authMode ?? "none",
    },
    { type: "spacer" as const },
    {
      type: "text" as const,
      label: status.message,
      color: status.loggedIn ? theme.textPrimary : theme.textSecondary,
    },
  ];
}

export function getCodexLogoutPopupLines(
  result: { ok: boolean; message: string },
  usingCodex: boolean,
  theme: CodexCommandTheme,
) {
  return [
    {
      type: "text" as const,
      label: result.message,
      color: result.ok ? theme.success : theme.brandSecondary,
    },
    ...(usingCodex
      ? [
          { type: "spacer" as const },
          {
            type: "text" as const,
            label:
              "The active model is still Codex. Switch models or log back in before your next prompt.",
            color: theme.textSecondary,
          },
        ]
      : []),
  ];
}

function showStatus(ctx: CommandContext): void {
  const theme = getThemeTokens();
  const status = getCodexLoginStatus();
  ctx.openInfoPopup({
    title: "Codex Status",
    icon: icon("openai"),
    lines: getCodexStatusPopupLines(status, theme),
  });
}

async function handleCodexLogin(_input: string, ctx: CommandContext): Promise<void> {
  const provider = getProvider("codex");
  if (!provider?.onRequestAuth) {
    throw new Error("Codex auth flow is not available.");
  }
  await provider.onRequestAuth();
  await refreshCodexState();
  if (ctx.chat.activeModel === "none") {
    ctx.openInfoPopup({
      title: "Codex Login",
      icon: icon("openai"),
      lines: [
        {
          type: "text",
          label: "Login complete. Press Ctrl+L or type /models to select a Codex model.",
          color: getThemeTokens().success,
        },
      ],
    });
  }
}

async function handleCodexStatus(_input: string, ctx: CommandContext): Promise<void> {
  showStatus(ctx);
}

async function handleCodexLogout(_input: string, ctx: CommandContext): Promise<void> {
  const theme = getThemeTokens();
  const result = logoutCodex();
  await refreshCodexState();
  const usingCodex = ctx.chat.activeModel.startsWith("codex/");
  ctx.openInfoPopup({
    title: "Codex Logout",
    icon: icon("openai"),
    lines: getCodexLogoutPopupLines(result, usingCodex, theme),
  });
}

async function handleCodexSwitch(_input: string, ctx: CommandContext): Promise<void> {
  const theme = getThemeTokens();
  const logout = logoutCodex();
  await refreshCodexState();
  ctx.openInfoPopup({
    title: "Codex Switch Account",
    icon: icon("openai"),
    lines: [
      {
        type: "text",
        label: logout.ok
          ? "Logged out of Codex. Starting login for another account..."
          : `Logout note: ${logout.message}`,
        color: logout.ok ? theme.textPrimary : theme.warning,
      },
    ],
  });
  await handleCodexLogin(_input, ctx);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/codex", handleCodexStatus);
  map.set("/codex login", handleCodexLogin);
  map.set("/codex status", handleCodexStatus);
  map.set("/codex logout", handleCodexLogout);
  map.set("/codex switch", handleCodexSwitch);
}
