import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { errorText, envProxy, httpsJson, isLoopbackUrl, clearHttpCache, httpCacheSize, MAX_CACHE_ENTRIES } from "../lib/http.js";

describe("errorText", () => {
	it("flattens nested causes", () => {
		const err = new Error("outer", { cause: new Error("inner") });
		assert.match(errorText(err), /outer/);
		assert.match(errorText(err), /inner/);
	});
	it("redacts bearer tokens and secret query parameters", () => {
		const text = errorText(new Error("Bearer my-secret https://local.invalid/?access_token=query-secret"));
		assert.doesNotMatch(text, /my-secret|query-secret/);
	});
});

describe("envProxy", () => {
	it("returns a string even when unset", () => {
		assert.equal(typeof envProxy(), "string");
	});
});

describe("isLoopbackUrl", () => {
	it("recognises loopback authorities", () => {
		for (const u of ["http://127.0.0.1:7863/status", "http://localhost/x", "http://[::1]:9/y", "http://127.9.9.9/z", "http://LOCALHOST/x"]) {
			assert.equal(isLoopbackUrl(new URL(u)), true, u);
		}
	});
	it("rejects everything else", () => {
		for (const u of ["http://evil.example.com/x", "https://api.openai.com/v1", "http://192.168.1.5/x"]) {
			assert.equal(isLoopbackUrl(new URL(u)), false, u);
		}
	});
	it("rejects a DNS name that merely starts with 127.", () => {
		// "127.evil.com" is a registrable domain that can resolve anywhere, so a
		// naive startsWith("127.") check would leak a bearer token in cleartext.
		assert.equal(isLoopbackUrl(new URL("http://127.evil.com/x")), false);
	});
	it("rejects non-literal and out-of-range 127 shapes", () => {
		assert.equal(isLoopbackUrl({ hostname: "127.0.0.1.evil.com" }), false);
		assert.equal(isLoopbackUrl({ hostname: "127.0.0.999" }), false);
		assert.equal(isLoopbackUrl({ hostname: "127.0.0" }), false);
		assert.equal(isLoopbackUrl({ hostname: "127.0.0.1" }), true);
	});
});

describe("httpsJson transport", () => {
	it("allows plaintext HTTP only to a loopback gateway", async (t) => {
		// The xuedinerAPI pool gateway is http://127.0.0.1:7863. The old
		// https-only guard rejected it, so the pool row always failed.
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ healthy: 5, total: 5 }));
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		t.after(() => server.close());
		const url = `http://127.0.0.1:${server.address().port}/status`;

		const result = await httpsJson(url, {}, { timeoutMs: 4000 });
		assert.equal(result.ok, true);
		assert.equal(result.body.healthy, 5);
	});

	it("still refuses plaintext HTTP to a non-loopback host", async () => {
		await assert.rejects(
			() => httpsJson("http://example.com/status", {}, { timeoutMs: 1000 }),
			/only https is allowed/,
		);
	});

	it("does not retry a loopback failure through an HTTP proxy", async (t) => {
		// A proxy cannot reach 127.0.0.1 on behalf of the caller; retrying there
		// replaced the real error with "proxy: only https is allowed".
		const dead = createServer(() => {});
		await new Promise((r) => dead.listen(0, "127.0.0.1", r));
		const port = dead.address().port;
		await new Promise((r) => dead.close(r));

		let message = "";
		try {
			await httpsJson(`http://127.0.0.1:${port}/status`, {}, { timeoutMs: 800 });
		} catch (error) {
			message = String(error.message);
		}
		// Either a connection error or a timeout, but never the proxy wording.
		assert.ok(!/proxy:/.test(message), `must not mention a proxy retry, got: ${message}`);
	});

	it("does not collide cache entries for bearer tokens sharing a prefix", async (t) => {
		clearHttpCache();
		const server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ authorization: req.headers.authorization }));
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		t.after(() => server.close());
		const url = `http://127.0.0.1:${server.address().port}/usage`;
		const prefix = "Bearer same-prefix-1234567890";
		const first = await httpsJson(url, { Authorization: `${prefix}-A` });
		const second = await httpsJson(url, { Authorization: `${prefix}-B` });
		assert.equal(first.body.authorization, `${prefix}-A`);
		assert.equal(second.body.authorization, `${prefix}-B`);
	});

	it("rejects a redirect to another origin without forwarding authorization", async (t) => {
		let targetCalls = 0;
		const target = createServer((_req, res) => { targetCalls++; res.end("{}"); });
		await new Promise((r) => target.listen(0, "127.0.0.1", r));
		t.after(() => target.close());
		const source = createServer((_req, res) => {
			res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/sink` });
			res.end();
		});
		await new Promise((r) => source.listen(0, "127.0.0.1", r));
		t.after(() => source.close());
		await assert.rejects(httpsJson(`http://127.0.0.1:${source.address().port}/redirect`, { Authorization: "Bearer never-forward" }), /cross-origin redirects/);
		assert.equal(targetCalls, 0);
	});

	it("aborts an in-flight local request", async (t) => {
		const server = createServer((_req, res) => setTimeout(() => res.end("{}"), 500));
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		t.after(() => new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		}));
		const controller = new AbortController();
		const pending = httpsJson(`http://127.0.0.1:${server.address().port}/slow`, {}, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(pending);
	});

	it("bounds successful response cache entries", async (t) => {
		clearHttpCache();
		const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		t.after(() => server.close());
		for (let i = 0; i < MAX_CACHE_ENTRIES + 3; i++) await httpsJson(`http://127.0.0.1:${server.address().port}/usage/${i}`);
		assert.equal(httpCacheSize(), MAX_CACHE_ENTRIES);
	});

	it("rejects request bodies above the memory bound", async () => {
		await assert.rejects(httpsJson("http://127.0.0.1:9/never", {}, { method: "POST", body: "x".repeat(256 * 1024 + 1) }), /request body too large/);
	});
});
