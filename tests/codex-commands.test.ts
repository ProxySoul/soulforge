import { describe, expect, test } from "bun:test";
import {
	getCodexLogoutPopupLines,
	getCodexStatusPopupLines,
	register,
} from "../src/core/commands/codex.js";

const theme = {
	success: "green",
	brandSecondary: "red",
	warning: "yellow",
	textPrimary: "white",
	textSecondary: "gray",
} as const;

describe("codex commands", () => {
	test("registers status, login, logout, and switch commands", () => {
		const map = new Map();
		register(map);

		expect(map.has("/codex")).toBe(true);
		expect(map.has("/codex status")).toBe(true);
		expect(map.has("/codex login")).toBe(true);
		expect(map.has("/codex logout")).toBe(true);
		expect(map.has("/codex switch")).toBe(true);
	});

	test("builds status popup lines from codex login status", () => {
		const lines = getCodexStatusPopupLines(
			{
				installed: true,
				loggedIn: false,
				authMode: null,
				message: "Not logged in",
			},
			theme,
		);

		expect(lines[0]).toMatchObject({ type: "entry", label: "Installed", desc: "yes" });
		expect(lines[1]).toMatchObject({ type: "entry", label: "Logged in", desc: "no" });
		expect(lines[2]).toMatchObject({ type: "entry", label: "Auth mode", desc: "none" });
		expect(lines[4]).toMatchObject({ type: "text", label: "Not logged in" });
	});

	test("builds logout popup lines with active-model warning", () => {
		const lines = getCodexLogoutPopupLines(
			{ ok: true, message: "Logged out of Codex." },
			true,
			theme,
		);

		expect(lines[0]).toMatchObject({ type: "text", label: "Logged out of Codex." });
		expect(lines[2]).toMatchObject({
			type: "text",
			label: "The active model is still Codex. Switch models or log back in before your next prompt.",
		});
	});
});
