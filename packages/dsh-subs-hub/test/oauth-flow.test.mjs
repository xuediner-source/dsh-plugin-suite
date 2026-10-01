import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPkce, OAuthFlowManager } from "../lib/auth/oauth-flow.js";

function spec() {
	return {
		callbackPath: "/callback",
		listen: { host: "localhost", ports: [0] },
		buildAuthorizeUrl({ state, pkce, redirectUri }) {
			const url = new URL("https://provider.invalid/authorize");
			url.searchParams.set("state", state);
			url.searchParams.set("code_challenge", pkce.challenge);
			url.searchParams.set("redirect_uri", redirectUri);
			return url.toString();
		},
	};
}

describe("OAuthFlowManager", () => {
	it("uses a real S256 challenge and completes only a state-matched loopback callback", async (t) => {
		const manager = new OAuthFlowManager();
		const pending = manager.start("test", spec());
		t.after(() => manager.stop());
		const attempt = await pending;
		const calculated = createHash("sha256").update(attempt.pkce.verifier).digest("base64url");
		assert.equal(attempt.pkce.challenge, calculated);
		assert.match(attempt.redirectUri, /^http:\/\/localhost:\d+\/callback$/);
		const wrong = await fetch(`${attempt.redirectUri}?state=bad&code=invalid`);
		assert.equal(wrong.status, 400);
		assert.equal(manager.isBusy("test"), true);
		const accepted = await fetch(`${attempt.redirectUri}?state=${encodeURIComponent(attempt.state)}&code=one-time-code`);
		assert.equal(accepted.status, 200);
		assert.equal(await attempt.waitCode(), "one-time-code");
		attempt.finish();
		assert.equal(manager.isBusy("test"), false);
	});

	it("reserves a provider before the listener bind and rejects duplicate attempts", async (t) => {
		const manager = new OAuthFlowManager();
		const pending = manager.start("test", spec());
		t.after(() => manager.stop());
		await assert.rejects(manager.start("test", spec()), /already in progress/);
		assert.equal(manager.isBusy("test"), true);
		const attempt = await pending;
		attempt.finish();
	});

	it("cancels listener startup and waits for it to settle", async () => {
		const manager = new OAuthFlowManager();
		const pending = manager.start("test", spec());
		await manager.cancel("test");
		await assert.rejects(pending, /login cancelled/);
		assert.equal(manager.isBusy("test"), false);
	});

	it("keeps the provider busy through code exchange until finish and aborts exchange on cancel", async (t) => {
		const manager = new OAuthFlowManager();
		const attempt = await manager.start("test", spec());
		t.after(() => manager.stop());
		attempt.manual("pasted-code");
		let release;
		const completion = new Promise((resolve) => { release = resolve; });
		attempt.completion = completion;
		assert.equal(await attempt.waitCode(), "pasted-code");
		assert.equal(manager.isBusy("test"), true);
		const cancellation = manager.cancel("test");
		assert.equal(attempt.signal.aborted, true);
		release();
		attempt.finish();
		await Promise.all([cancellation, completion]);
		assert.equal(manager.isBusy("test"), false);
	});
});
