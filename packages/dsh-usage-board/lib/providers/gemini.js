import { readHubSession, skipped, fromWindows } from "./hub-session.js";

const URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary";
const VERSION = "1.18.3";

function headers() {
  const platform = process.platform === "win32" ? "WINDOWS" : "MACOS";
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/" + VERSION + " Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform, pluginType: "GEMINI" })
  };
}

export default {
  id: "gemini",
  label: "Gemini",
  async fetch({ httpsJson }) {
    const session = readHubSession("antigravity");
    if (!session) return skipped("gemini", "Gemini");
    try {
      const res = await httpsJson(URL, {
        ...headers(),
        authorization: "Bearer " + session.accessToken,
        "content-type": "application/json"
      }, { method: "POST", body: {} });
      if (!res.ok) return { id: "gemini", label: "Gemini", ok: false, error: "HTTP " + res.status };
      const windows = [];
      const groups = Array.isArray(res.body?.groups) ? res.body.groups : [];
      for (const group of groups) {
        for (const bucket of group.buckets || []) {
          if (typeof bucket.remainingFraction !== "number") continue;
          const kind = String(bucket.window || "").toLowerCase().includes("5h") ? "session" : "weekly";
          windows.push({ kind, usedPercent: (1 - bucket.remainingFraction) * 100, resetsAt: bucket.resetTime });
        }
      }
      return fromWindows("gemini", "Gemini", { supported: windows.length > 0, windows });
    } catch (error) {
      return { id: "gemini", label: "Gemini", ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
