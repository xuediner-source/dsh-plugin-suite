import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirroring the production isDeadProxyError logic in lib/index.js
function causeText(error) {
	if (error instanceof Error) {
		const parts = [error.message];
		if ("code" in error && typeof error.code === "string") parts.push(error.code);
		if (error.cause !== void 0) parts.push(causeText(error.cause));
		return parts.join("\n");
	}
	return String(error);
}

function isDeadProxyError(error) {
	const text = causeText(error);
	return /ECONNREFUSED[^\n]*7890|connect ECONNREFUSED 127\.0\.0\.1:7890|ECONNREFUSED 127\.0\.0\.1:1080|other side closed|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|socket hang up|ECONNRESET|EPIPE|ETIMEDOUT/i.test(text);
}

describe("isDeadProxyError", () => {
	it("should detect local proxy connection refused (7890 / 1080)", () => {
		const err7890 = new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7890") });
		assert.equal(isDeadProxyError(err7890), true);

		const err1080 = new Error("connect ECONNREFUSED 127.0.0.1:1080");
		assert.equal(isDeadProxyError(err1080), true);
	});

	it("should detect proxy socket closures and timeouts", () => {
		const socketHangUp = new Error("socket hang up");
		assert.equal(isDeadProxyError(socketHangUp), true);

		const otherSideClosed = new Error("other side closed");
		assert.equal(isDeadProxyError(otherSideClosed), true);

		const undiciSocket = new Error("fetch failed", { cause: Object.assign(new Error("socket terminated"), { code: "UND_ERR_SOCKET" }) });
		assert.equal(isDeadProxyError(undiciSocket), true);

		const timedOut = new Error("connect ETIMEDOUT");
		assert.equal(isDeadProxyError(timedOut), true);

		const reset = new Error("read ECONNRESET");
		assert.equal(isDeadProxyError(reset), true);
	});

	it("should not falsely match normal HTTP 4xx or 5xx application errors", () => {
		const normal401 = new Error("antigravity API: HTTP 401 Unauthorized");
		assert.equal(isDeadProxyError(normal401), false);

		const normal429 = new Error("rate limit exceeded: 429 Too Many Requests");
		assert.equal(isDeadProxyError(normal429), false);

		const normal500 = new Error("Internal Server Error: 500");
		assert.equal(isDeadProxyError(normal500), false);
	});
});
