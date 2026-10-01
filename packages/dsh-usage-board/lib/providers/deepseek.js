import { credentialRef } from "@deepseek-ai/dsh-credentials";

const CRED = credentialRef("DEEPSEEK_API_KEY");
const URL = "https://api.deepseek.com/user/balance";

export default {
  id: "deepseek",
  label: "DeepSeek",
  async fetch({ credentials, httpsJson }) {
    let token;
    try { token = (await credentials.resolve(CRED))?.value; } catch {}
    if (!token) {
      return { id: "deepseek", label: "DeepSeek", ok: false, skipped: true, error: "未配置 DEEPSEEK_API_KEY" };
    }
    const res = await httpsJson(URL, { Authorization: "Bearer " + token });
    if (!res.ok) {
      return { id: "deepseek", label: "DeepSeek", ok: false, error: "HTTP " + res.status };
    }
    const info = Array.isArray(res.body?.balance_infos) ? res.body.balance_infos[0] : null;
    const currency = info?.currency === "USD" ? "$" : "¥";
    const total = info?.total_balance ?? "—";
    const available = res.body?.is_available !== false;
    const balanceText = currency + total;
    return {
      id: "deepseek",
      label: "DeepSeek",
      ok: true,
      headline: balanceText,
      percent: null,
      details: [
        { label: "余额", value: balanceText },
        { label: "赠送", value: currency + (info?.granted_balance ?? "—") },
        { label: "充值", value: currency + (info?.topped_up_balance ?? "—") }
      ],
      extra: {
        available,
        balance: balanceText
      }
    };
  }
};
