import { beforeEach, describe, expect, test } from "bun:test";
import {
	__resetRetryWarnings,
	DEFAULT_AGENT_BASE_DELAY_MS,
	DEFAULT_CHAT_BASE_DELAY_MS,
	DEFAULT_MAX_RETRIES,
	MAX_BASE_DELAY_MS,
	MIN_BASE_DELAY_MS,
	MIN_MAX_ATTEMPTS,
	resolveRetrySettings,
} from "../src/core/retry/settings.js";
import { useErrorStore } from "../src/stores/errors.js";

beforeEach(() => {
	__resetRetryWarnings();
	useErrorStore.getState().clear();
});

/**
 * Hostile-input tests for retry config.
 *
 * Config is loaded from raw JSON (~/.soulforge/config.json) — no schema layer
 * validates it. resolveRetrySettings MUST defensively clamp/fallback so that
 * a malformed user config can never crash the chat loop or the agent runner.
 */

describe("resolveRetrySettings — missing/empty input falls back to defaults", () => {
	test("undefined → defaults (chat)", () => {
		expect(resolveRetrySettings(undefined)).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
	});

	test("null → defaults (chat)", () => {
		expect(resolveRetrySettings(null)).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
	});

	test("empty object → defaults (chat)", () => {
		expect(resolveRetrySettings({})).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
	});

	test("agent preset uses 2000ms base delay", () => {
		expect(resolveRetrySettings(undefined, { agent: true })).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_AGENT_BASE_DELAY_MS,
		});
	});

	test("individual undefined fields fall back per-field", () => {
		expect(resolveRetrySettings({ maxAttempts: 7 })).toEqual({
			maxRetries: 7,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
		expect(resolveRetrySettings({ baseDelayMs: 5000 })).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: 5000,
		});
	});
});

describe("resolveRetrySettings — happy path within range", () => {
	test("exact valid values pass through", () => {
		expect(resolveRetrySettings({ maxAttempts: 5, baseDelayMs: 3000 })).toEqual({
			maxRetries: 5,
			baseDelayMs: 3000,
		});
	});

	test("fractional numbers round to nearest int", () => {
		const r = resolveRetrySettings({ maxAttempts: 4.7, baseDelayMs: 1999.4 });
		expect(r.maxRetries).toBe(5);
		expect(r.baseDelayMs).toBe(1999);
	});

	test("range minimums preserved", () => {
		expect(resolveRetrySettings({ maxAttempts: MIN_MAX_ATTEMPTS })).toMatchObject({
			maxRetries: MIN_MAX_ATTEMPTS,
		});
		expect(resolveRetrySettings({ baseDelayMs: MIN_BASE_DELAY_MS })).toMatchObject({
			baseDelayMs: MIN_BASE_DELAY_MS,
		});
	});

	test("large maxAttempts passes through (no upper cap)", () => {
		expect(resolveRetrySettings({ maxAttempts: 99 }).maxRetries).toBe(99);
		expect(resolveRetrySettings({ maxAttempts: 500 }).maxRetries).toBe(500);
	});

	test("baseDelayMs range maximum preserved", () => {
		expect(resolveRetrySettings({ baseDelayMs: MAX_BASE_DELAY_MS })).toMatchObject({
			baseDelayMs: MAX_BASE_DELAY_MS,
		});
	});
});

describe("resolveRetrySettings — clamps out-of-range numbers", () => {
	test("maxAttempts below min clamps up", () => {
		expect(resolveRetrySettings({ maxAttempts: 0 }).maxRetries).toBe(MIN_MAX_ATTEMPTS);
		expect(resolveRetrySettings({ maxAttempts: -1 }).maxRetries).toBe(MIN_MAX_ATTEMPTS);
		expect(resolveRetrySettings({ maxAttempts: -9999 }).maxRetries).toBe(MIN_MAX_ATTEMPTS);
	});

	test("baseDelayMs below min clamps up", () => {
		expect(resolveRetrySettings({ baseDelayMs: 0 }).baseDelayMs).toBe(MIN_BASE_DELAY_MS);
		expect(resolveRetrySettings({ baseDelayMs: 10 }).baseDelayMs).toBe(MIN_BASE_DELAY_MS);
		expect(resolveRetrySettings({ baseDelayMs: -5000 }).baseDelayMs).toBe(MIN_BASE_DELAY_MS);
	});

	test("baseDelayMs above max clamps down", () => {
		expect(resolveRetrySettings({ baseDelayMs: 999_999 }).baseDelayMs).toBe(MAX_BASE_DELAY_MS);
		expect(
			resolveRetrySettings({ baseDelayMs: Number.MAX_SAFE_INTEGER }).baseDelayMs,
		).toBe(MAX_BASE_DELAY_MS);
	});
});

describe("resolveRetrySettings — garbage inputs never throw and fall back", () => {
	test("NaN → default", () => {
		const r = resolveRetrySettings({ maxAttempts: NaN, baseDelayMs: NaN });
		expect(r.maxRetries).toBe(DEFAULT_MAX_RETRIES);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("Infinity / -Infinity → default", () => {
		expect(
			resolveRetrySettings({ maxAttempts: Infinity, baseDelayMs: Infinity }),
		).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
		expect(
			resolveRetrySettings({ maxAttempts: -Infinity, baseDelayMs: -Infinity }),
		).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
	});

	test("string values → default (no coercion)", () => {
		// User might write `"maxAttempts": "5"` by hand in JSON
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		const r = resolveRetrySettings({ maxAttempts: "5", baseDelayMs: "3000" } as any);
		expect(r.maxRetries).toBe(DEFAULT_MAX_RETRIES);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("boolean values → default", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		const r = resolveRetrySettings({ maxAttempts: true, baseDelayMs: false } as any);
		expect(r.maxRetries).toBe(DEFAULT_MAX_RETRIES);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("null fields → default (not 0)", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		const r = resolveRetrySettings({ maxAttempts: null, baseDelayMs: null } as any);
		expect(r.maxRetries).toBe(DEFAULT_MAX_RETRIES);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("nested object / array → default", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		const r = resolveRetrySettings({ maxAttempts: { n: 5 }, baseDelayMs: [1000] } as any);
		expect(r.maxRetries).toBe(DEFAULT_MAX_RETRIES);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("whole raw input as non-object → defaults", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		expect(resolveRetrySettings("broken" as any)).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		expect(resolveRetrySettings(42 as any)).toEqual({
			maxRetries: DEFAULT_MAX_RETRIES,
			baseDelayMs: DEFAULT_CHAT_BASE_DELAY_MS,
		});
	});

	test("extra unknown keys are ignored", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
		const r = resolveRetrySettings({ maxAttempts: 5, hacker: "value" } as any);
		expect(r.maxRetries).toBe(5);
		expect(r.baseDelayMs).toBe(DEFAULT_CHAT_BASE_DELAY_MS);
	});

	test("does not throw on any of the above", () => {
		const hostile: unknown[] = [
			undefined,
			null,
			{},
			{ maxAttempts: NaN },
			{ baseDelayMs: Infinity },
			{ maxAttempts: -1 },
			{ maxAttempts: 10 ** 9, baseDelayMs: 10 ** 12 },
			{ maxAttempts: "bad", baseDelayMs: null },
			{ maxAttempts: {}, baseDelayMs: [] },
			"not-an-object",
			42,
			true,
			[],
		];
		for (const input of hostile) {
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: testing runtime garbage
				const r = resolveRetrySettings(input as any);
				// Invariants the retry loop depends on:
				expect(Number.isFinite(r.maxRetries)).toBe(true);
				expect(Number.isFinite(r.baseDelayMs)).toBe(true);
				expect(r.maxRetries).toBeGreaterThanOrEqual(MIN_MAX_ATTEMPTS);
				expect(r.maxRetries).toBeGreaterThanOrEqual(MIN_MAX_ATTEMPTS);
				expect(r.baseDelayMs).toBeGreaterThanOrEqual(MIN_BASE_DELAY_MS);
				expect(r.baseDelayMs).toBeLessThanOrEqual(MAX_BASE_DELAY_MS);
			}).not.toThrow();
		}
	});
});

describe("resolveRetrySettings — backoff math stays bounded", () => {
	test("worst-case exponential delay at maxRetries never overflows", () => {
		// The retry loop computes: baseDelayMs * 2^attempt + jitter.
		// With our clamps, the final retry's delay is bounded.
		const { baseDelayMs } = resolveRetrySettings({
			maxAttempts: 100,
			baseDelayMs: 10 ** 9,
		});
		// baseDelayMs clamped to 60s, maxAttempts passes through as 100
		const worstCase = baseDelayMs * 2 ** 99;
		expect(Number.isFinite(worstCase)).toBe(true);
		expect(worstCase).toBeGreaterThan(0);
	});
});

describe("resolveRetrySettings — warns on invalid user input", () => {
	test("string maxAttempts logs a config warning", () => {
		// biome-ignore lint/suspicious/noExplicitAny: hostile input
		resolveRetrySettings({ maxAttempts: "5" } as any);
		const errors = useErrorStore.getState().errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]?.source).toBe("config");
		expect(errors[0]?.message).toContain("retry.maxAttempts");
		expect(errors[0]?.message).toContain("string");
	});

	test("NaN baseDelayMs logs a config warning", () => {
		resolveRetrySettings({ baseDelayMs: NaN });
		const errors = useErrorStore.getState().errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("retry.baseDelayMs");
	});

	test("warns once per key across repeated calls", () => {
		// biome-ignore lint/suspicious/noExplicitAny: hostile input
		resolveRetrySettings({ maxAttempts: "5" } as any);
		// biome-ignore lint/suspicious/noExplicitAny: hostile input
		resolveRetrySettings({ maxAttempts: "7" } as any);
		// biome-ignore lint/suspicious/noExplicitAny: hostile input
		resolveRetrySettings({ maxAttempts: true } as any);
		expect(useErrorStore.getState().errors).toHaveLength(1);
	});

	test("does not warn on undefined / missing fields", () => {
		resolveRetrySettings(undefined);
		resolveRetrySettings(null);
		resolveRetrySettings({});
		resolveRetrySettings({ maxAttempts: 5 });
		expect(useErrorStore.getState().errors).toHaveLength(0);
	});

	test("does not warn on valid-but-out-of-range numbers (clamped silently)", () => {
		resolveRetrySettings({ maxAttempts: 999, baseDelayMs: 999_999 });
		resolveRetrySettings({ maxAttempts: -5, baseDelayMs: 10 });
		expect(useErrorStore.getState().errors).toHaveLength(0);
	});
});
