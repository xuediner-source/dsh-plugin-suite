import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJsonText } from "../detect.js";

export function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function authStorePath() {
	return join(dshHome(), "plugins", "subscriptions", "auth.json");
}

export function collectHubLogins(store) {
	if (!store || typeof store !== "object" || Array.isArray(store)) return [];
	return Object.keys(store).filter((key) => {
		const session = store[key];
		return session && typeof session === "object" && typeof session.accessToken === "string" && session.accessToken.length > 0;
	});
}

export function readAuthStore() {
	const path = authStorePath();
	if (!existsSync(path)) return null;
	try {
		// auth.json is written by another plugin, but a BOM would make
		// JSON.parse throw and every hub card silently vanish.
		const store = parseJsonText(readFileSync(path, "utf8"));
		return store && typeof store === "object" && !Array.isArray(store) ? store : null;
	} catch {
		return null;
	}
}

export function readHubSession(provider) {
	const store = readAuthStore();
	if (!store) return null;
	const session = store[provider];
	if (!session || typeof session !== "object") return null;
	if (typeof session.accessToken !== "string" || !session.accessToken) return null;
	return session;
}

export function skipped(id, label) {
	return { id, label, ok: false, skipped: true, error: "未在订阅中心登录" };
}

export function loggedIn(id, label, session) {
	const account = typeof session?.account === "string" && session.account.trim() ? session.account.trim() : "";
	return {
		id,
		label,
		ok: true,
		headline: account || "已登录",
		percent: null,
		resetAt: null,
		details: account
			? [{ label: "账号", value: account }]
			: [{ label: "状态", value: "已登录" }]
	};
}

export function kindLabel(kind) {
	if (kind === "session") return "5 小时";
	if (kind === "weekly") return "本周";
	if (kind === "monthly") return "本月";
	if (kind === "daily") return "今日";
	if (kind === "other") return "本周期";
	if (kind === "lifetime") return "累计";
	return kind || "用量";
}

function toIso(value) {
	if (value == null || value === "") return null;
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value < 1e12 ? value * 1000 : value;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function fromWindows(id, label, usage) {
	if (!usage || usage.supported === false) {
		return {
			id,
			label,
			ok: true,
			skipped: false,
			headline: "已登录",
			percent: null,
			details: [{ label: "用量", value: "暂无数据" }]
		};
	}
	const windows = Array.isArray(usage.windows) ? usage.windows : [];
	const percents = windows
		.map((w) => (typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) ? w.usedPercent : null))
		.filter((n) => n !== null);
	const percent = percents.length ? Math.max(...percents) : null;
	const resetAt = toIso(windows.find((w) => w.resetsAt)?.resetsAt);
	const details = windows.map((w) => ({
		label: kindLabel(w.kind),
		value: typeof w.usedPercent === "number"
			? (Math.round(w.usedPercent * 10) / 10) + "%"
			: (w.usedUsd != null ? "$" + w.usedUsd : "—"),
		extra: toIso(w.resetsAt)
	}));
	if (usage.plan) details.unshift({ label: "套餐", value: usage.plan });
	const headline = percent === null ? (usage.plan || "已登录") : (Math.round(percent * 10) / 10) + "%";
	return { id, label, ok: true, headline, percent, resetAt, details };
}
