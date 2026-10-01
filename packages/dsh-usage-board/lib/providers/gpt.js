import { readHubSession, skipped, fromWindows } from "./hub-session.js";

const URL = "https://chatgpt.com/backend-api/wham/usage";

function windowOf(value, fallback) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.used_percent !== "number") return null;
  let resetsAt;
  if (typeof value.reset_at === "number" && value.reset_at > 0) resetsAt = value.reset_at * 1000;
  else if (typeof value.reset_after_seconds === "number" && value.reset_after_seconds > 0) resetsAt = Date.now() + value.reset_after_seconds * 1000;
  const seconds = value.limit_window_seconds;
  let kind = fallback;
  if (typeof seconds === "number") {
    if (seconds >= 300 * 60 * 0.95 && seconds <= 300 * 60 * 1.05) kind = "session";
    else if (seconds >= 10080 * 60 * 0.95 && seconds <= 10080 * 60 * 1.05) kind = "weekly";
  }
  return { kind, usedPercent: value.used_percent, resetsAt };
}

export default {
  id: "gpt",
  label: "GPT",
  async fetch({ httpsJson }) {
    const session = readHubSession("codex");
    if (!session) return skipped("gpt", "GPT");
    try {
      const res = await httpsJson(URL, {
        authorization: "Bearer " + session.accessToken,
        "chatgpt-account-id": session.accountId || "",
        originator: "codex_cli_rs",
        accept: "application/json"
      });
      if (!res.ok) return { id: "gpt", label: "GPT", ok: false, error: "HTTP " + res.status };
      const windows = [];
      const a = windowOf(res.body?.rate_limit?.primary_window, "session");
      const b = windowOf(res.body?.rate_limit?.secondary_window, "weekly");
      if (a) windows.push(a);
      if (b) windows.push(b);
      const plan = typeof res.body?.plan_type === "string" ? res.body.plan_type : undefined;
      return fromWindows("gpt", "GPT", { supported: true, windows, plan });
    } catch (error) {
      return { id: "gpt", label: "GPT", ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
