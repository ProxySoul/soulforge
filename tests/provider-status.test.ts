import { describe, expect, test } from "bun:test";
import {
	checkProviders,
	getCachedProviderStatuses,
	subscribeProviderStatuses,
} from "../src/core/llm/provider.js";

describe("provider status subscriptions", () => {
	test("notifies subscribers when provider availability is refreshed", async () => {
		const seen: Array<ReturnType<typeof getCachedProviderStatuses>> = [];
		const unsubscribe = subscribeProviderStatuses((statuses) => {
			seen.push(statuses);
		});

		const result = await checkProviders();
		unsubscribe();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual(result);
		expect(getCachedProviderStatuses()).toEqual(result);
	});

	test("stops notifying after unsubscribe", async () => {
		let calls = 0;
		const unsubscribe = subscribeProviderStatuses(() => {
			calls += 1;
		});

		unsubscribe();
		await checkProviders();

		expect(calls).toBe(0);
	});
});
