import { readHubSession, skipped, fromWindows } from "./hub-session.js";

const URL = "https://api.anthropic.com/api/oauth/usage";

export default {
  id: "claude",
  label: "Claude",
  async fetch({ httpsJson }) {
    const session = readHubSession("claude");
    if (!session) return skipped("claude", "Claude");
    try {
      const res = await httpsJson(URL, {
        authorization: "Bearer " + session.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json"
      });
      if (!res.ok) return { id: "claude", label: "Claude", ok: false, error: "HTTP " + res.status };
      const windows = [];
      if (Array.isArray(res.body?.limits)) {
        for (const entry of res.body.limits) {
          if (typeof entry?.percent !== "number") continue;
          const kind = entry.kind === "session" ? "session" : (String(entry.kind || "").startsWith("weekly") ? "weekly" : "other");
          windows.push({ kind, usedPercent: entry.percent, resetsAt: entry.resets_at });
        }
      }
      return fromWindows("claude", "Claude", { supported: windows.length > 0, windows });
    } catch (error) {
      return { id: "claude", label: "Claude", ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
