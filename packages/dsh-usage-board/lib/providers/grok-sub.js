import { readHubSession, skipped, fromWindows } from "./hub-session.js";

const URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export default {
  id: "grok-sub",
  label: "Grok",
  async fetch({ httpsJson }) {
    const session = readHubSession("grok");
    if (!session) return skipped("grok-sub", "Grok");
    try {
      const res = await httpsJson(URL, {
        authorization: "Bearer " + session.accessToken,
        "X-XAI-Token-Auth": "xai-grok-cli",
        accept: "application/json"
      });
      if (!res.ok) return { id: "grok-sub", label: "Grok", ok: false, error: "HTTP " + res.status };
      const cfg = res.body?.config && typeof res.body.config === "object" ? res.body.config : {};
      const windows = [];
      if (typeof cfg.creditUsagePercent === "number") {
        windows.push({
          kind: cfg.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "other",
          usedPercent: cfg.creditUsagePercent,
          resetsAt: cfg.currentPeriod?.end || cfg.billingPeriodEnd
        });
      }
      return fromWindows("grok-sub", "Grok", { supported: windows.length > 0, windows });
    } catch (error) {
      return { id: "grok-sub", label: "Grok", ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
