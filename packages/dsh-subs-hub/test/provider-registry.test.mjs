import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSubscriptionAdapter } from "../lib/auth/provider-registry.js";

function fixture(initial = [], register = undefined, effect = undefined) {
	let providers = [...initial];
	const cleanups = [];
	const warnings = [];
	const handles = new Map();
	const ctx = {
		llm: {
			listProviders: () => providers,
			registerAdapter: register ?? ((ids) => {
				providers = [...providers, ...ids.map((id) => ({ id }))];
				const dispose = () => { providers = providers.filter((row) => !ids.includes(row.id)); };
				dispose.replace = (next) => { providers = providers.filter((row) => !ids.includes(row.id)).concat(next.map((id) => ({ id }))); };
				return dispose;
			}),
		},
		effect: effect ?? ((callback) => cleanups.push(callback())),
	};
	return { ctx, handles, cleanups, warnings, providers: () => providers };
}

test("preserves a route already owned by another provider, including llm-pi-ai", () => {
	const state = fixture([{ id: "openrouter", name: "llm-pi-ai profile" }]);
	registerSubscriptionAdapter(state.ctx, state.handles, "openrouter", {}, (message) => state.warnings.push(message));
	assert.deepEqual(state.providers().map((item) => item.name), ["llm-pi-ai profile"]);
	assert.equal(state.handles.has("openrouter"), false);
	assert.match(state.warnings[0], /active llm-pi-ai profile/);
});

test("ties a successful registration and its replace handle to plugin disposal", () => {
	const state = fixture();
	registerSubscriptionAdapter(state.ctx, state.handles, "openrouter", {}, (message) => state.warnings.push(message));
	const registration = state.handles.get("openrouter");
	assert.equal(typeof registration, "function");
	assert.equal(typeof registration.replace, "function");
	assert.deepEqual(state.providers().map((item) => item.id), ["openrouter"]);
	assert.equal(state.cleanups.length, 1);
	state.cleanups[0]();
	assert.deepEqual(state.providers(), []);
	assert.equal(state.handles.has("openrouter"), false);
});

test("handles a route claimed between discovery and registration", () => {
	const conflict = Object.assign(new Error("duplicate route"), { code: "DUPLICATE_ADAPTER" });
	const state = fixture([], () => { throw conflict; });
	registerSubscriptionAdapter(state.ctx, state.handles, "openrouter", {}, (message) => state.warnings.push(message));
	assert.equal(state.handles.has("openrouter"), false);
	assert.match(state.warnings[0], /claimed during registration/);
});

test("releases the adapter if binding its disposer to the plugin effect fails", () => {
	let disposed = 0;
	const state = fixture([], () => {
		const handle = () => { disposed += 1; };
		handle.replace = () => {};
		return handle;
	}, () => { throw new Error("effect unavailable"); });
	assert.throws(() => registerSubscriptionAdapter(state.ctx, state.handles, "openrouter", {}, () => {}), /effect unavailable/);
	assert.equal(disposed, 1);
	assert.equal(state.handles.has("openrouter"), false);
});
