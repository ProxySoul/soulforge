/**
 * Factory that turns a HearthConfig's `surfaces` map into live Surface instances.
 * Shared by the CLI (`soulforge hearth start`) and the daemon's live-reload path
 * so both paths produce identically-configured adapters.
 */

import { DiscordSurface } from "./adapters/discord.js";
import { FakechatSurface } from "./adapters/fakechat.js";
import { IMessageSurface } from "./adapters/imessage.js";
import { TelegramSurface } from "./adapters/telegram.js";
import type { HearthConfig, Surface, SurfaceId } from "./types.js";

export interface BuildSurfacesResult {
  surfaces: Surface[];
  errors: { id: SurfaceId; error: string }[];
}

export function buildSurfacesFromConfig(
  config: HearthConfig,
  onLog?: (line: string) => void,
): BuildSurfacesResult {
  const out: Surface[] = [];
  const errors: { id: SurfaceId; error: string }[] = [];
  for (const [surfaceId, cfg] of Object.entries(config.surfaces)) {
    if (!cfg.enabled) continue;
    const [kind, id] = surfaceId.split(":") as [string, string];
    if (!kind || !id) continue;
    try {
      if (kind === "telegram") {
        const allowed: Record<string, number[]> = {};
        for (const [chatId, userIds] of Object.entries(cfg.allowed ?? {})) {
          allowed[chatId] = userIds
            .map((n) => Number.parseInt(n, 10))
            .filter((n) => !Number.isNaN(n));
        }
        out.push(new TelegramSurface({ botId: id, allowedUserIdsByChat: allowed, log: onLog }));
      } else if (kind === "discord") {
        const allowed: Record<string, string[]> = {};
        for (const [chId, userIds] of Object.entries(cfg.allowed ?? {})) {
          allowed[chId] = userIds;
        }
        out.push(new DiscordSurface({ appId: id, allowedUserIdsByChannel: allowed, log: onLog }));
      } else if (kind === "imessage") {
        const handles = Object.values(cfg.allowed ?? {}).flat();
        out.push(new IMessageSurface({ id, allowedHandles: handles, log: onLog }));
      } else if (kind === "fakechat") {
        out.push(new FakechatSurface(`fakechat:${id}` as SurfaceId));
      }
    } catch (err) {
      errors.push({
        id: surfaceId as SurfaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { surfaces: out, errors };
}
