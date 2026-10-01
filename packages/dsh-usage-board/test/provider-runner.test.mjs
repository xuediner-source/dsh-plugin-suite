import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runProvider } from "../lib/provider-runner.js";

const context = { credentials: {}, logger: { warn() {} } };

describe("provider runner lifecycle and response bounds", () => {
	it("aborts a provider lookup at its deadline", async () => {
		let aborted = false;
		const provider = {
			id: "example",
			async fetch({ signal }) {
				return new Promise((resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(signal.reason);
					}, { once: true });
				});
			},
		};
		const result = await runProvider(provider, context, undefined, 20);
		assert.equal(aborted, true);
		assert.equal(result.ok, false);
		assert.match(result.error, /timed out/);
	});

	it("links the plugin lifetime signal to active provider work", async () => {
		const lifetime = new AbortController();
		let aborted = false;
		const provider = {
			id: "example",
			async fetch({ signal }) {
				return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
					aborted = true;
					reject(signal.reason);
				}, { once: true }));
			},
		};
		const running = runProvider(provider, context, lifetime.signal, 5000);
		await new Promise((resolve) => setTimeout(resolve, 10));
		lifetime.abort(new Error("plugin disabled"));
		const result = await running;
		assert.equal(aborted, true);
		assert.match(result.error, /plugin disabled/);
	});

	it("caps provider-controlled output and ignores a claimed route id", async () => {
		const provider = {
			id: "example",
			label: "x".repeat(200),
			async fetch() {
				return { id: "spoofed", label: "y".repeat(200), headline: "h".repeat(1000), details: Array.from({ length: 50 }, (_, index) => ({ label: String(index), value: "v".repeat(900) })), extra: { data: "e".repeat(20_000) } };
			},
		};
		const result = await runProvider(provider, context);
		assert.equal(result.id, "example");
		assert.equal(result.label.length, 100);
		assert.equal(result.headline.length, 512);
		assert.equal(result.details.length, 32);
		assert.ok(result.details[0].value.length <= 512);
		assert.ok(result.extra.data.length <= 16 * 1024);
	});
});
