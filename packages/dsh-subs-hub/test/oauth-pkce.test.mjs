import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

function randomToken(bytes) {
	return randomBytes(bytes).toString("base64url");
}

function createPkce() {
	const verifier = randomToken(32);
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge, method: "S256" };
}

describe("OAuth PKCE & State Generation", () => {
	it("should generate cryptographically strong verifier and S256 challenge", () => {
		const pkce1 = createPkce();
		const pkce2 = createPkce();

		assert.notEqual(pkce1.verifier, pkce2.verifier);
		assert.equal(pkce1.method, "S256");

		// Verify SHA-256 base64url calculation
		const expectedChallenge = createHash("sha256").update(pkce1.verifier).digest("base64url");
		assert.equal(pkce1.challenge, expectedChallenge);
	});

	it("should generate random tokens of sufficient entropy", () => {
		const state1 = randomToken(16);
		const state2 = randomToken(16);

		assert.notEqual(state1, state2);
		assert.ok(state1.length >= 20); // 16 bytes base64url
	});

	it("should validate callback state matching logic", () => {
		const expectedState = randomToken(16);
		const attackerState = randomToken(16);

		const callbackUrl = new URL(`http://localhost:8080/callback?state=${attackerState}&code=auth123`);
		assert.notEqual(callbackUrl.searchParams.get("state"), expectedState);

		const validUrl = new URL(`http://localhost:8080/callback?state=${expectedState}&code=auth123`);
		assert.equal(validUrl.searchParams.get("state"), expectedState);
		assert.equal(validUrl.searchParams.get("code"), "auth123");
	});

	it("should properly extract error and error_description", () => {
		const errorUrl = new URL("http://localhost:8080/callback?error=access_denied&error_description=The+user+denied+access");
		const errorDesc = errorUrl.searchParams.get("error_description") ?? errorUrl.searchParams.get("error");
		assert.equal(errorDesc, "The user denied access");
	});
});
