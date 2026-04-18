import { logBackgroundError } from "../../stores/errors.js";
import type { RetryConfig } from "../../types/index.js";

export const DEFAULT_AGENT_BASE_DELAY_MS = 2000;
export const DEFAULT_CHAT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRIES = 3;

export const MIN_MAX_ATTEMPTS = 1;
export const MIN_BASE_DELAY_MS = 250;
export const MAX_BASE_DELAY_MS = 60_000;

export interface ResolvedRetrySettings {
  maxRetries: number;
  baseDelayMs: number;
}

/**
 * Pure, defensive resolver for user-supplied retry config.
 * - Accepts `undefined`, `null`, or garbage inputs (strings, NaN, Infinity, negatives) without throwing.
 * - Clamps valid numbers into safe ranges; falls back to defaults for anything else.
 */
export function resolveRetrySettings(
  raw: RetryConfig | undefined | null,
  opts: { agent?: boolean } = {},
): ResolvedRetrySettings {
  const defaultBase = opts.agent ? DEFAULT_AGENT_BASE_DELAY_MS : DEFAULT_CHAT_BASE_DELAY_MS;
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

  const maxRetries = clampIntMin(
    obj?.maxAttempts,
    MIN_MAX_ATTEMPTS,
    DEFAULT_MAX_RETRIES,
    "retry.maxAttempts",
  );

  const baseDelayMs = clampInt(
    obj?.baseDelayMs,
    MIN_BASE_DELAY_MS,
    MAX_BASE_DELAY_MS,
    defaultBase,
    "retry.baseDelayMs",
  );

  return { maxRetries, baseDelayMs };
}

const warnedKeys = new Set<string>();

function clampIntMin(value: unknown, min: number, fallback: number, key?: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (key && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      logBackgroundError(
        "config",
        `${key}: expected a finite number, got ${typeof value === "object" ? JSON.stringify(value) : String(value)} (${typeof value}). Using default ${String(fallback)}.`,
      );
    }
    return fallback;
  }
  return Math.max(min, Math.round(value));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  key?: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (key && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      logBackgroundError(
        "config",
        `${key}: expected a finite number, got ${typeof value === "object" ? JSON.stringify(value) : String(value)} (${typeof value}). Using default ${String(fallback)}.`,
      );
    }
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Test-only: reset the once-per-process warning state. */
export function __resetRetryWarnings(): void {
  warnedKeys.clear();
}
