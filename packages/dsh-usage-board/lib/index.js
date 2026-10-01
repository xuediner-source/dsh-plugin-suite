/**
 * dsh-usage-board — host half.
 * GET /api/usage-board
 * Built-in providers: gemini, gpt, grok-sub, claude, openrouter, qwen, agnes, spark, ernie, grok, opencode, deepseek.
 * Extra adapters: ~/.dsh/usage-board/providers/*.js
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { opendirSync, readFileSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { errorText } from "./http.js";
import { runProvider } from "./provider-runner.js";
import { isLoopbackBoardRequest } from "./security.js";
import { collectLlmRoutes, wantedFromSources, sortProviders, validProviderId, withoutSkipped, selectEnabled, parseJsonText, DEFAULT_ORDER } from "./detect.js";
import { collectHubLogins, readAuthStore } from "./providers/hub-session.js";
import grok from "./providers/grok.js";
import opencode from "./providers/opencode.js";
import deepseek from "./providers/deepseek.js";
import gemini from "./providers/gemini.js";
import gpt from "./providers/gpt.js";
import grokSub from "./providers/grok-sub.js";
import claude from "./providers/claude.js";
import openrouter from "./providers/openrouter.js";
import qwen from "./providers/qwen.js";
import agnes from "./providers/agnes.js";
import spark from "./providers/spark.js";
import ernie from "./providers/ernie.js";

const name = "dsh-usage-board";
const inject = ["credentials", "webServer"];
const ROUTE_PATH = "/api/usage-board";
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store"
};
const SNAPSHOT_TTL_MS = 20 * 1000;
const EXTERNAL_TTL_MS = 30 * 1000;
const MAX_EXTERNAL_PROVIDER_FILES = 32;
const MAX_PROVIDER_DIRECTORY_ENTRIES = 256;
const MAX_CONFIG_BYTES = 256 * 1024;
const DEEPSEEK_API_KEY = credentialRef("DEEPSEEK_API_KEY");

const builtins = [gemini, gpt, grokSub, claude, openrouter, qwen, agnes, spark, ernie, grok, opencode, deepseek];

let extraCache = { expires: 0, key: "", providers: [] };

function sendJson(res, status, body) {
	res.writeHead(status, JSON_HEADERS);
	res.end(JSON.stringify(body));
}

function boardHome() {
	const root = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(root, "usage-board");
}

/**
 * Parse JSON that a user may have written with a BOM.
 * Windows editors and `Set-Content -Encoding utf8` prepend U+FEFF, which makes
 * JSON.parse throw — silently turning config.json into `{}` and dropping the
 * externalProviders list. See parseJsonText in detect.js.
 */
function loadConfig() {
	const path = join(boardHome(), "config.json");
	try {
		if (!existsSync(path) || statSync(path).size > MAX_CONFIG_BYTES) return {};
		const parsed = parseJsonText(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function hasDeepseekKey(ctx) {
	try {
		const hit = await ctx.credentials.resolve(DEEPSEEK_API_KEY);
		return !!(hit && hit.value);
	} catch {
		return false;
	}
}

async function wantedBoardIds(ctx, configuredExtraIds = []) {
	const extraIds = configuredExtraIds.slice(0, MAX_EXTERNAL_PROVIDER_FILES);
	if (await hasDeepseekKey(ctx)) extraIds.push("deepseek");
	return wantedFromSources({
		hubLogins: collectHubLogins(readAuthStore()),
		routes: collectLlmRoutes(ctx),
		extraIds
	});
}

function providerFiles(dir) {
	const files = [];
	try {
		const handle = opendirSync(dir);
		try {
			for (let count = 0; count < MAX_PROVIDER_DIRECTORY_ENTRIES; count++) {
				const entry = handle.readSync();
				if (entry === null) break;
				if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name)) continue;
				if (validProviderId(entry.name.replace(/\.(?:js|mjs)$/, ""))) files.push(entry.name);
			}
		} finally { handle.closeSync(); }
	} catch {
		return [];
	}
	return files.sort().slice(0, MAX_EXTERNAL_PROVIDER_FILES);
}

function extraFingerprint(dir, files = providerFiles(dir)) {
	return files.map((file) => {
		try {
			const st = statSync(join(dir, file));
			return file + ":" + st.mtimeMs + ":" + st.size;
		} catch {
			return file;
		}
	}).join("|");
}

async function loadExternalProviders(logger, signal) {
	const dir = join(boardHome(), "providers");
	if (!existsSync(dir)) return [];
	const files = providerFiles(dir);
	const key = dir + "|" + extraFingerprint(dir, files);
	if (extraCache.key === key && extraCache.expires > Date.now()) return extraCache.providers;
	const out = [];
	for (const file of files) {
		if (signal?.aborted) break;
		try {
			const href = pathToFileURL(join(dir, file)).href + "?t=" + encodeURIComponent(key);
			const mod = await import(href);
			const provider = mod.default || mod.provider || mod;
			if (!provider || !validProviderId(provider.id) || typeof provider.fetch !== "function") {
				logger?.warn("dsh-usage-board: skip " + file + " (need export default { id, fetch } with kebab-case id)");
				continue;
			}
			out.push(provider);
		} catch (error) {
			logger?.warn("dsh-usage-board: failed to load " + file);
			logger?.warn(errorText(error));
		}
	}
	if (signal?.aborted) return out;
	extraCache = { expires: Date.now() + EXTERNAL_TTL_MS, key, providers: out };
	return out;
}

async function buildSnapshot(ctx, signal) {
	const config = loadConfig();
	if (signal?.aborted) throw signal.reason;
	const extra = await loadExternalProviders(ctx.logger, signal);
	if (signal?.aborted) throw signal.reason;
	const seen = new Set();
	const all = [];
	for (const p of [...extra, ...builtins]) {
		if (!p?.id || seen.has(p.id) || !validProviderId(p.id)) continue;
		seen.add(p.id);
		all.push(p);
	}
	const extraIds = new Set(extra.map((provider) => provider.id));
	const configuredExtraIds = Array.isArray(config.externalProviders)
		? config.externalProviders.filter((id) => validProviderId(id) && extraIds.has(id))
		: [];
	const auto = await wantedBoardIds(ctx, configuredExtraIds);
	const enabled = selectEnabled(all, auto, config);
	const order = Array.isArray(config.order) ? config.order : DEFAULT_ORDER;
	const ranked = sortProviders(enabled, order);
	const providers = withoutSkipped(await Promise.all(ranked.map((p) => runProvider(p, ctx, signal))));
	return { ok: true, providers, fetchedAt: new Date().toISOString() };
}

function apply(ctx) {
	const lifecycle = new AbortController();
	let snapshotCache = { expires: 0, body: null };
	let snapshotInFlight;
	ctx.effect(() => () => {
		lifecycle.abort(new Error("usage board disabled"));
		snapshotCache = { expires: 0, body: null };
		snapshotInFlight = void 0;
	}, "dsh-usage-board: abort provider lookups on disposal");
	ctx.effect(
		() => ctx.webServer.register({
			kind: "exact",
			path: ROUTE_PATH,
			handler: async (req, res) => {
				if (!isLoopbackBoardRequest(req)) {
					res.writeHead(403);
					res.end("forbidden");
					return;
				}
				if (req.method !== "GET") {
					res.writeHead(405);
					res.end();
					return;
				}
				try {
					if (snapshotCache.body && snapshotCache.expires > Date.now()) {
						sendJson(res, 200, snapshotCache.body);
						return;
					}
					snapshotInFlight ??= buildSnapshot(ctx, lifecycle.signal).then((body) => {
						snapshotCache = { expires: Date.now() + SNAPSHOT_TTL_MS, body };
						return body;
					}).finally(() => { snapshotInFlight = void 0; });
					const body = await snapshotInFlight;
					if (!lifecycle.signal.aborted && !res.destroyed && !res.writableEnded) sendJson(res, 200, body);
				} catch (error) {
					if (lifecycle.signal.aborted || res.destroyed || res.writableEnded) return;
					ctx.logger.warn("dsh-usage-board: failed");
					ctx.logger.warn(errorText(error));
					sendJson(res, 502, { ok: false, error: "fetch-failed", message: errorText(error) });
				}
			}
		}),
		"dsh-usage-board: usage route"
	);
}

export { name, inject, apply };
