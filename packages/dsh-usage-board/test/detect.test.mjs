import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectLlmRoutes, matchWanted, wantedFromSources, withoutSkipped, sortProviders, validProviderId, selectEnabled, parseJsonText, DEFAULT_ORDER } from "../lib/detect.js";
import { collectHubLogins, fromWindows, kindLabel } from "../lib/providers/hub-session.js";

describe("validProviderId", () => {
	it("accepts kebab-case ids", () => {
		assert.equal(validProviderId("gemini"), true);
		assert.equal(validProviderId("grok-sub"), true);
		assert.equal(validProviderId("openrouter"), true);
	});
	it("rejects unsafe ids", () => {
		assert.equal(validProviderId("../evil"), false);
		assert.equal(validProviderId("HasCap"), false);
		assert.equal(validProviderId(""), false);
		assert.equal(validProviderId("a".repeat(50)), false);
	});
});

describe("collectLlmRoutes", () => {
	it("uses live registered route metadata without reading SettingsForms", () => {
		const ids = collectLlmRoutes({ get: (name) => name === "llm" ? { listProviders: () => [{ id: "openai" }, { id: "deepseek" }] } : undefined });
		assert.deepEqual(ids, ["openai", "deepseek"]);
	});
	it("returns empty when the LLM service or route list is absent", () => {
		assert.deepEqual(collectLlmRoutes({ get: () => undefined }), []);
		assert.deepEqual(collectLlmRoutes({ get: () => ({ listProviders: () => { throw new Error("not available"); } }) }), []);
	});
});

describe("matchWanted", () => {
	it("maps hub logins and aliases onto board ids", () => {
		const wanted = matchWanted(["antigravity", "codex", "qwen", "openrouter", "ernie"]);
		assert.equal(wanted.has("gemini"), true);
		assert.equal(wanted.has("gpt"), true);
		assert.equal(wanted.has("qwen"), true);
		assert.equal(wanted.has("openrouter"), true);
		assert.equal(wanted.has("ernie"), true);
		assert.equal(wanted.has("claude"), false);
	});
});

describe("wantedFromSources", () => {
	it("does not show hub cards from LLM routes alone (logged-out adapters)", () => {
		const wanted = wantedFromSources({
			hubLogins: [],
			routes: ["antigravity", "codex", "claude", "openrouter", "qwen", "opencode"]
		});
		assert.equal(wanted.has("gemini"), false);
		assert.equal(wanted.has("gpt"), false);
		assert.equal(wanted.has("claude"), false);
		assert.equal(wanted.has("openrouter"), false);
		assert.equal(wanted.has("qwen"), false);
		assert.equal(wanted.has("opencode"), true);
	});
	it("shows hub cards only after a real login, plus key-backed extras", () => {
		const wanted = wantedFromSources({
			hubLogins: ["antigravity", "qwen"],
			routes: ["codex", "opencode"],
			extraIds: ["deepseek", "xuedinerapi"]
		});
		assert.equal(wanted.has("gemini"), true);
		assert.equal(wanted.has("qwen"), true);
		assert.equal(wanted.has("gpt"), false);
		assert.equal(wanted.has("opencode"), true);
		assert.equal(wanted.has("deepseek"), true);
		assert.equal(wanted.has("xuedinerapi"), true);
	});
});

describe("selectEnabled", () => {
	const all = [
		{ id: "gemini" },
		{ id: "gpt" },
		{ id: "grok-sub" },
		{ id: "xuedinerapi" }
	];

	it("a non-empty enabled list is a whitelist that replaces auto-detection", () => {
		const auto = new Set(["gemini", "gpt", "grok-sub"]);
		const picked = selectEnabled(all, auto, { enabled: ["xuedinerapi"] });
		assert.deepEqual(picked.map((p) => p.id), ["xuedinerapi"]);
	});

	it("this is exactly how the hub cards disappeared", () => {
		// The real regression: config.enabled held only the external provider,
		// so three signed-in hub cards were filtered out even though the hub
		// logins were present.
		const auto = new Set(["gemini", "gpt", "grok-sub"]);
		const withWhitelist = selectEnabled(all, auto, { enabled: ["xuedinerapi"] });
		assert.equal(withWhitelist.some((p) => p.id === "gemini"), false);
		// dropping `enabled` restores them
		const withoutWhitelist = selectEnabled(all, auto, {});
		assert.deepEqual(withoutWhitelist.map((p) => p.id), ["gemini", "gpt", "grok-sub"]);
	});

	it("an absent or empty enabled list falls back to auto-detection", () => {
		const auto = new Set(["gemini"]);
		assert.deepEqual(selectEnabled(all, auto, undefined).map((p) => p.id), ["gemini"]);
		assert.deepEqual(selectEnabled(all, auto, {}).map((p) => p.id), ["gemini"]);
		assert.deepEqual(selectEnabled(all, auto, { enabled: [] }).map((p) => p.id), ["gemini"]);
	});

	it("an empty auto set shows nothing rather than everything", () => {
		assert.deepEqual(selectEnabled(all, new Set(), {}), []);
	});

	it("ignores non-string whitelist entries", () => {
		const picked = selectEnabled(all, new Set(), { enabled: [null, 7, "gpt"] });
		assert.deepEqual(picked.map((p) => p.id), ["gpt"]);
	});
});

describe("parseJsonText", () => {
	it("parses plain JSON", () => {
		assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
	});

	it("parses JSON written with a UTF-8 BOM", () => {
		// PowerShell's `Set-Content -Encoding utf8` and Windows editors add this.
		// Without stripping it, loadConfig() silently returned {} and
		// externalProviders was dropped.
		const withBom = "\uFEFF" + '{"externalProviders":["xuedinerapi"]}';
		assert.deepEqual(parseJsonText(withBom), { externalProviders: ["xuedinerapi"] });
	});

	it("a BOM'd auth store still yields hub logins", () => {
		const store = parseJsonText("\uFEFF" + '{"antigravity":{"accessToken":"a"}}');
		assert.deepEqual(collectHubLogins(store), ["antigravity"]);
	});

	it("still throws on genuinely malformed text", () => {
		assert.throws(() => parseJsonText("\uFEFF{not json"));
	});
});

describe("withoutSkipped", () => {
	it("drops unconfigured rows so names do not appear on the board", () => {
		const rows = withoutSkipped([
			{ id: "gemini", skipped: false, headline: "12%" },
			{ id: "qwen", skipped: true, error: "未在订阅中心登录" },
			{ id: "gpt", skipped: true }
		]);
		assert.deepEqual(rows.map((p) => p.id), ["gemini"]);
	});
});

describe("collectHubLogins", () => {
	it("keeps only sessions with an access token", () => {
		const ids = collectHubLogins({
			antigravity: { accessToken: "a" },
			codex: { refreshToken: "r" },
			qwen: { accessToken: "q" },
			empty: null
		});
		assert.deepEqual(ids, ["antigravity", "qwen"]);
	});
});

describe("sortProviders", () => {
	it("uses DEFAULT_ORDER and leaves unknown ids last", () => {
		const ranked = sortProviders([{ id: "deepseek" }, { id: "gemini" }, { id: "custom" }]);
		assert.deepEqual(ranked.map((p) => p.id), ["gemini", "deepseek", "custom"]);
		assert.ok(DEFAULT_ORDER.includes("qwen"));
	});
});

describe("fromWindows", () => {
	it("picks the highest used percent and ISO reset time", () => {
		const snap = fromWindows("gpt", "GPT", {
			supported: true,
			plan: "plus",
			windows: [
				{ kind: "session", usedPercent: 12.34, resetsAt: "2026-09-04T10:00:00.000Z" },
				{ kind: "weekly", usedPercent: 80.01, resetsAt: 1_725_000_000_000 }
			]
		});
		assert.equal(snap.ok, true);
		assert.equal(snap.percent, 80.01);
		assert.equal(snap.headline, "80%");
		assert.equal(snap.details[0].label, "套餐");
		assert.equal(kindLabel("session"), "5 小时");
	});
});
