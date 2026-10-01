import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackBoardRequest } from "../lib/security.js";

function request(remoteAddress, host, extra = {}) {
	return { socket: { remoteAddress }, headers: { host, ...extra } };
}

describe("usage route loopback fence", () => {
	it("allows local clients with an exact same-origin HTTP authority", () => {
		assert.equal(isLoopbackBoardRequest(request("127.0.0.1", "127.0.0.1:7863")), true);
		assert.equal(isLoopbackBoardRequest(request("::1", "[::1]:7863", { origin: "http://[::1]:7863" })), true);
		assert.equal(isLoopbackBoardRequest(request("::ffff:127.8.9.10", "localhost:7863")), true);
	});

	it("rejects remote peers, forged Host values, and cross-site Origins", () => {
		assert.equal(isLoopbackBoardRequest(request("192.168.1.7", "127.0.0.1:7863")), false);
		assert.equal(isLoopbackBoardRequest(request("127.0.0.1", "127.evil.example:7863")), false);
		assert.equal(isLoopbackBoardRequest(request("127.0.0.1", "127.0.0.1:7863", { origin: "https://127.0.0.1:7863" })), false);
		assert.equal(isLoopbackBoardRequest(request("127.0.0.1", "127.0.0.1:7863", { origin: "http://127.0.0.1:7863/other" })), false);
		assert.equal(isLoopbackBoardRequest(request("127.0.0.1", "127.0.0.1:7863", { "sec-fetch-site": "cross-site" })), false);
	});
});
