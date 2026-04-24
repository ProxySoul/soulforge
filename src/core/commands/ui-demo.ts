import { useUIStore } from "../../stores/ui.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

function isEnabled(): boolean {
  return process.env.SOULFORGE_DEV_UI === "1";
}

function handleUiDemo(_input: string, ctx: CommandContext): void {
  if (!isEnabled()) {
    sysMsg(ctx, "/ui-demo is gated behind SOULFORGE_DEV_UI=1");
    return;
  }
  useUIStore.getState().openModal("uiDemo");
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/ui-demo", handleUiDemo);
}
