import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { parseJsonText } from "../detect.js";

const CRED = credentialRef(process.env.DSH_GROK_CREDENTIAL_REF || "GROK_BUILD_ACCESS_TOKEN");
const BASE = "https://cli-chat-proxy.grok.com/v1";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

function grokAuthPath() {
  if (process.env.DSH_GROK_AUTH_PATH) return process.env.DSH_GROK_AUTH_PATH;
  const home = process.env.GROK_HOME || join(homedir(), ".grok");
  return join(home, "auth.json");
}

function pickAuthKey(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return undefined;
  const requested = process.env.DSH_GROK_AUTH_SCOPE;
  const usable = (entry) => entry && typeof entry === "object" && typeof entry.key === "string" && entry.key && entry.auth_mode !== "api_key";
  if (requested) {
    const entry = store[requested];
    return usable(entry) ? entry.key : undefined;
  }
  const candidates = Object.values(store).filter(usable);
  const firstParty = candidates.filter((e) => e.oidc_issuer === XAI_OAUTH_ISSUER && e.oidc_client_id === XAI_OAUTH_CLIENT_ID);
  const pool = firstParty.length ? firstParty : candidates;
  return pool[0]?.key;
}

function readGrokAuthToken() {
  try { return pickAuthKey(parseJsonText(readFileSync(grokAuthPath(), "utf8"))); } catch { return undefined; }
}

function numVal(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && typeof value.val === "number" && Number.isFinite(value.val)) return value.val;
  return null;
}

function periodKind(type) {
  const raw = typeof type === "string" ? type : "";
  if (raw.includes("WEEK")) return "本周";
  if (raw.includes("MONTH")) return "本月";
  if (raw.includes("DAY")) return "今日";
  return "额度";
}

export default {
  id: "grok",
  label: "SuperGrok",
  async fetch({ credentials, httpsJson }) {
    let token;
    try { token = (await credentials.resolve(CRED))?.value; } catch {}
    if (!token) token = readGrokAuthToken();
    if (!token) {
      return { id: "grok", label: "SuperGrok", ok: false, skipped: true, error: "未配置 GROK_BUILD_ACCESS_TOKEN / grok login" };
    }
    const headers = {
      Authorization: "Bearer " + token,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-mode": "headless",
      "x-grok-client-identifier": "dsh-usage-board"
    };
    const [credits, settings] = await Promise.all([
      httpsJson(BASE + "/billing?format=credits", headers),
      httpsJson(BASE + "/settings", headers)
    ]);
    if (!credits.ok) {
      const msg = credits.status === 401 || credits.status === 403 ? "登录已过期，请 grok login" : "HTTP " + credits.status;
      return { id: "grok", label: "SuperGrok", ok: false, error: msg };
    }
    const cfg = credits.body?.config && typeof credits.body.config === "object" ? credits.body.config : {};
    const st = settings.body && typeof settings.body === "object" ? settings.body : {};
    const period = cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : {};
    const percent = numVal(cfg.creditUsagePercent) ?? numVal(cfg.usagePercent);
    const plan = typeof st.subscription_tier_display === "string" ? st.subscription_tier_display : "SuperGrok";
    const model = typeof st.default_model === "string" ? st.default_model : "";
    const remaining = percent === null ? null : Math.max(0, Math.round((100 - percent) * 10) / 10);
    const details = [
      { label: periodKind(period.type), value: percent === null ? "—" : percent + "% 已用" },
      remaining === null ? null : { label: "剩余", value: remaining + "%" },
      period.end ? { label: "重置", value: period.end } : null,
      model ? { label: "模型", value: model } : null
    ].filter(Boolean);
    return {
      id: "grok",
      label: plan,
      ok: true,
      headline: percent === null ? plan : percent + "%",
      percent,
      resetAt: period.end || cfg.billingPeriodEnd || null,
      details
    };
  }
};
