/**
 * Minimal Telegram Bot API helpers used by the setup UI.
 *
 * These are intentionally narrow — we do NOT want the full bot library in core.
 * The UI calls getMe() to validate a freshly-pasted token, derive the bot id,
 * and pre-fill the surface id so the user never has to type `telegram:<botId>`.
 */

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface GetMeOk {
  ok: true;
  info: TelegramBotInfo;
}
export interface GetMeErr {
  ok: false;
  error: string;
}
export type GetMeResult = GetMeOk | GetMeErr;

/**
 * Validate a bot token by calling Telegram's `getMe`. Returns bot info on
 * success, or a redacted human-readable error. The token is NEVER logged.
 */
export async function getMe(
  token: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GetMeResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: "token empty" };
  // Token shape: <numericBotId>:<35+ urlsafe chars>. We do a cheap local check
  // so the user sees an immediate "nope" for obviously-mistyped values.
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return {
      ok: false,
      error: "token does not look like a Telegram bot token (expected <id>:<secret>)",
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const resp = await fetchImpl(`https://api.telegram.org/bot${trimmed}/getMe`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `Telegram API HTTP ${String(resp.status)}` };
    }
    const body = (await resp.json()) as {
      ok: boolean;
      result?: TelegramBotInfo;
      description?: string;
    };
    if (!body.ok || !body.result) {
      return { ok: false, error: body.description ?? "Telegram API rejected the token" };
    }
    return { ok: true, info: body.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the numeric bot id from a token string (no network call). */
export function botIdFromToken(token: string): string | null {
  const m = /^(\d+):/.exec(token.trim());
  return m?.[1] ?? null;
}
