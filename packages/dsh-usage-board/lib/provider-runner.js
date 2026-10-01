import { httpsJson, errorText } from "./http.js";

export const PROVIDER_TIMEOUT_MS = 12_000;

function snapshotError(provider, error, skipped = false) {
	return {
		id: provider.id,
		label: provider.label || provider.id,
		ok: false,
		skipped: !!skipped,
		error: typeof error === "string" ? error : errorText(error)
	};
}

function withTimeout(promise, ms, label, controller) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(label + " timed out after " + ms + "ms");
			controller.abort(error);
			reject(error);
		}, ms);
		if (typeof timer.unref === "function") timer.unref();
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function linkSignals(...signals) {
	const active = signals.filter(Boolean);
	if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(active), dispose() {} };
	const controller = new AbortController();
	const listeners = [];
	for (const signal of active) {
		if (signal.aborted) controller.abort(signal.reason);
		else {
			const listener = () => controller.abort(signal.reason);
			signal.addEventListener("abort", listener, { once: true });
			listeners.push([signal, listener]);
		}
	}
	return { signal: controller.signal, dispose() { for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener); } };
}

function boundedValue(value, depth = 0, budget = { left: 16 * 1024 }) {
	if (budget.left <= 0) return null;
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		const out = value.slice(0, 512);
		budget.left -= out.length;
		return out;
	}
	if (depth >= 4 || typeof value !== "object") return null;
	if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedValue(entry, depth + 1, budget));
	const out = Object.create(null);
	for (const [key, entry] of Object.entries(value).slice(0, 32)) {
		if (typeof key !== "string" || key.length > 100) continue;
		out[key] = boundedValue(entry, depth + 1, budget);
		if (budget.left <= 0) break;
	}
	return out;
}

/** Run one local or built-in adapter with a real aborting deadline and bounded output. */
export async function runProvider(provider, ctx, lifecycleSignal, timeoutMs = PROVIDER_TIMEOUT_MS) {
	const controller = new AbortController();
	const linked = linkSignals(lifecycleSignal, controller.signal);
	const securedHttpsJson = (url, headers, opts = {}) => {
		const request = linkSignals(linked.signal, opts.signal);
		return httpsJson(url, headers, { ...opts, signal: request.signal }).finally(request.dispose);
	};
	try {
		if (linked.signal.aborted) return snapshotError(provider, "request aborted", true);
		const result = await withTimeout(provider.fetch({
			credentials: ctx.credentials,
			httpsJson: securedHttpsJson,
			env: process.env,
			logger: ctx.logger,
			signal: linked.signal
		}), timeoutMs, provider.id, controller);
		if (!result || typeof result !== "object") return snapshotError(provider, "adapter returned empty result");
		return {
			id: provider.id,
			label: typeof result.label === "string" ? result.label.slice(0, 100) : provider.label || provider.id,
			ok: result.ok !== false && !result.skipped,
			skipped: !!result.skipped,
			headline: typeof result.headline === "string" ? result.headline.slice(0, 512) : null,
			percent: typeof result.percent === "number" && Number.isFinite(result.percent) ? result.percent : null,
			resetAt: typeof result.resetAt === "string" ? result.resetAt.slice(0, 100) : typeof result.resetAt === "number" ? result.resetAt : null,
			details: Array.isArray(result.details) ? boundedValue(result.details.slice(0, 32)) : [],
			extra: result.extra && typeof result.extra === "object" ? boundedValue(result.extra) : null,
			error: typeof result.error === "string" ? errorText(new Error(result.error)) : null
		};
	} catch (error) {
		return snapshotError(provider, error);
	} finally {
		controller.abort(new Error("provider request complete"));
		linked.dispose();
	}
}
