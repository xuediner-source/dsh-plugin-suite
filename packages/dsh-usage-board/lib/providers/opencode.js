import { credentialRef } from "@deepseek-ai/dsh-credentials";

const CRED = credentialRef("OPENCODE_API_KEY");
const URL = "https://opencode.ai/zen/go/v1/usage";

function windowRow(name, win) {
  if (!win || typeof win !== "object") return null;
  const percent = typeof win.percent === "number" ? win.percent : null;
  return {
    label: name,
    value: percent === null ? (win.status || "—") : percent + "%",
    extra: win.resetsAt || null
  };
}

export default {
  id: "opencode",
  label: "OpenCode",
  async fetch({ credentials, httpsJson }) {
    let token;
    try { token = (await credentials.resolve(CRED))?.value; } catch {}
    if (!token) {
      return { id: "opencode", label: "OpenCode", ok: false, skipped: true, error: "未配置 OPENCODE_API_KEY" };
    }
    const res = await httpsJson(URL, { Authorization: "Bearer " + token });
    if (!res.ok) {
      const msg = res.body?.error?.message || ("HTTP " + res.status);
      return { id: "opencode", label: "OpenCode", ok: false, error: msg };
    }
    const usage = res.body?.usage && typeof res.body.usage === "object" ? res.body.usage : {};
    const rolling = windowRow("滚动 5h", usage.rolling);
    const weekly = windowRow("本周", usage.weekly);
    const monthly = windowRow("本月", usage.monthly);
    const percents = [usage.rolling, usage.weekly, usage.monthly]
      .map((w) => (w && typeof w.percent === "number" ? w.percent : null))
      .filter((n) => n !== null);
    const percent = percents.length ? Math.max(...percents) : null;
    const resetAt = usage.monthly?.resetsAt || usage.weekly?.resetsAt || usage.rolling?.resetsAt || null;
    return {
      id: "opencode",
      label: "OpenCode",
      ok: true,
      headline: percent === null ? "Go" : "月 " + (usage.monthly?.percent ?? percent) + "%",
      percent,
      resetAt,
      details: [rolling, weekly, monthly].filter(Boolean)
    };
  }
};
