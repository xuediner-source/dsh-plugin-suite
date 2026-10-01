import https from "node:https";
import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import { createHash } from "node:crypto";

export const TIMEOUT_MS = 20000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const cache = new Map();
export const CACHE_TTL_MS = 15 * 1000;
export const MAX_CACHE_ENTRIES = 128;

export function envProxy() {
	return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port, timeout: 250 });
		socket.on("connect", () => { socket.destroy(); resolve(true); });
		socket.on("error", () => resolve(false));
		socket.on("timeout", () => { socket.destroy(); resolve(false); });
	});
}

export async function resolveProxyUrl() {
	const fromEnv = envProxy();
	if (fromEnv) return fromEnv;
	for (const port of [7890, 7897, 10809, 20171, 1080]) {
		if (await portOpen(port)) return "http://127.0.0.1:" + port;
	}
	return "";
}

export function errorText(error) {
	const parts = [];
	let cur = error;
	for (let i = 0; i < 4 && cur; i++) {
		parts.push(cur.message || String(cur));
		cur = cur.cause;
	}
	return parts.join(" → ").replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]").replace(/([?&](?:access_token|refresh_token|token|key|api_key|client_secret|code_verifier|code|state)=)[^&#\s]*/giu, "$1[redacted]").slice(0, 1000);
}

function cacheKey(urlStr, method, headers, body) {
	const payload = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
	const normalizedHeaders = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]).sort(([a], [b]) => a.localeCompare(b));
	return createHash("sha256").update(JSON.stringify([method || "GET", urlStr, normalizedHeaders, payload])).digest("hex");
}

export function clearHttpCache() {
	cache.clear();
}

export function httpCacheSize() {
	return cache.size;
}

function getCached(key) {
	const hit = cache.get(key);
	if (!hit) return undefined;
	if (hit.expires <= Date.now()) {
		cache.delete(key);
		return undefined;
	}
	cache.delete(key);
	cache.set(key, hit);
	return hit.value;
}

function cacheResult(key, value) {
	for (const [entryKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(entryKey);
	while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
	cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

/** Loopback-only plaintext HTTP is allowed (local gateways); the open internet is not. */
export function isLoopbackUrl(target) {
	const name = String(target.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
	if (name === "localhost" || name === "::1") return true;
	// Require an IPv4 LITERAL in 127/8. A bare `startsWith("127.")` would also
	// accept the DNS name "127.evil.com", which can resolve anywhere — that
	// would leak a bearer token in cleartext to an arbitrary host.
	const parts = name.split(".");
	if (parts.length !== 4) return false;
	if (parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
	return Number(parts[0]) === 127;
}

function httpsJsonOnce(urlStr, headers, proxyUrl, timeoutMs, method = "GET", body, signal, redirectsLeft = MAX_REDIRECTS) {
	return new Promise((resolve, reject) => {
		let target;
		try { target = new URL(urlStr); } catch (error) { reject(error); return; }
		if (signal?.aborted) { reject(signal.reason ?? new Error("request aborted")); return; }
		if (target.username || target.password) { reject(new Error("URL credentials are not allowed")); return; }
		// Plaintext HTTP is permitted only for a loopback gateway. Sending a
		// bearer token over cleartext to a remote host must stay impossible,
		// so anything non-loopback is still https-only.
		const plaintext = target.protocol === "http:" && isLoopbackUrl(target);
		if (target.protocol !== "https:" && !plaintext) {
			reject(new Error("only https is allowed"));
			return;
		}
		// A loopback gateway must be reached directly: routing it through an
		// HTTP proxy would send it to the proxy instead of to localhost.
		if (plaintext) proxyUrl = "";
		const chunks = [];
		let size = 0;
		const collect = (res) => {
			const location = res.headers?.location;
			if (res.statusCode >= 300 && res.statusCode < 400 && location && redirectsLeft > 0) {
				res.resume();
				let next;
				try { next = new URL(location, target); } catch (error) { reject(error); return; }
				if (next.username || next.password) { reject(new Error("redirect URL credentials are not allowed")); return; }
				if (next.origin !== target.origin) { reject(new Error("cross-origin redirects are not allowed")); return; }
				httpsJsonOnce(next.toString(), headers, proxyUrl, timeoutMs, method, body, signal, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			res.on("data", (c) => {
				size += c.length;
				if (size > MAX_BODY_BYTES) {
					res.destroy();
					reject(new Error("response too large"));
					return;
				}
				chunks.push(c);
			});
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let parsed = null;
				try { parsed = JSON.parse(text); } catch {}
				resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed, text });
			});
		};
		const payload = body == null ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		if (payload && payload.length > 256 * 1024) { reject(new Error("request body too large")); return; }
		const hdrs = { ...headers };
		if (payload && !hdrs["Content-Length"] && !hdrs["content-length"]) hdrs["Content-Length"] = String(payload.length);
		const reqOpts = {
			method: method || "GET",
			hostname: target.hostname,
			port: target.port || (plaintext ? 80 : 443),
			path: target.pathname + target.search,
			headers: hdrs,
			timeout: timeoutMs || TIMEOUT_MS,
			signal,
			...plaintext ? {} : { servername: target.hostname }
		};
		if (!proxyUrl) {
			const transport = plaintext ? http : https;
			const req = transport.request(reqOpts, collect);
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error((plaintext ? "http" : "https") + " timeout")));
			req.end(payload);
			return;
		}
		let proxy;
		try { proxy = new URL(proxyUrl); } catch (e) { reject(e); return; }
		const connect = http.request({
			method: "CONNECT",
			hostname: proxy.hostname,
			port: proxy.port || 80,
			path: target.hostname + ":" + (target.port || 443),
			timeout: timeoutMs || TIMEOUT_MS,
			signal,
			headers: { Host: target.hostname + ":" + (target.port || 443) }
		});
		connect.on("connect", (res, socket) => {
			if (res.statusCode !== 200) {
				socket.destroy();
				reject(new Error("proxy CONNECT HTTP " + res.statusCode));
				return;
			}
			const req = https.request({ ...reqOpts, socket, agent: false }, collect);
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("https timeout via proxy")));
			req.end(payload);
		});
		connect.on("error", reject);
		connect.on("timeout", () => connect.destroy(new Error("proxy CONNECT timeout")));
		connect.end();
	});
}

export async function httpsJson(urlStr, headers = {}, opts = {}) {
	const hdrs = { Accept: "application/json", "User-Agent": BROWSER_UA, ...headers };
	const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
	const method = opts.method || "GET";
	const body = opts.body;
	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("request aborted");
	const key = cacheKey(urlStr, method, hdrs, body);
	const hit = method.toUpperCase() === "GET" ? getCached(key) : undefined;
	if (hit !== undefined) return hit;
	let value;
	try {
		value = await httpsJsonOnce(urlStr, hdrs, "", timeoutMs, method, body, opts.signal);
	} catch (directErr) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? directErr;
		// A loopback gateway has no proxy route; retrying through one only
		// obscures the real error with "proxy: only https is allowed".
		let loopback = false;
		try { loopback = isLoopbackUrl(new URL(urlStr)); } catch {}
		if (loopback) throw directErr;
		const proxyUrl = opts.proxyUrl || (await resolveProxyUrl());
		if (!proxyUrl) throw directErr;
		try {
			value = await httpsJsonOnce(urlStr, hdrs, proxyUrl, timeoutMs, method, body, opts.signal);
		} catch (proxyErr) {
			throw new Error(errorText(directErr) + " | proxy: " + errorText(proxyErr));
		}
	}
	if (method.toUpperCase() === "GET" && value && value.ok) cacheResult(key, value);
	return value;
}
