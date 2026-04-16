import { loadConfig } from "../../config/index.js";

export const DEFAULT_TOOL_TIMEOUT_MIN = 2;
const MIN_TIMEOUT_MIN = 0.5;
const MAX_TIMEOUT_MIN = 30;

/** Clamp and convert a minutes value to milliseconds. 0 = no timeout. */
export function toolTimeoutMinToMs(minutes: number | undefined): number {
  const raw = minutes ?? DEFAULT_TOOL_TIMEOUT_MIN;
  if (raw === 0) return 0;
  if (!Number.isFinite(raw)) return DEFAULT_TOOL_TIMEOUT_MIN * 60_000;
  const clamped = Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, raw));
  return clamped * 60_000;
}

/** Returns the configured tool timeout in milliseconds. */
export function getToolTimeoutMs(): number {
  const cfg = loadConfig();
  return toolTimeoutMinToMs(cfg.toolTimeout);
}
