/**
 * dsh-usage-board external provider: xuedinerAPI.
 *
 * Aggregates:
 *  1. the local pool gateway's per-account credits (workbuddy2api-panel
 *     /status, the "xuedinerAPI 号池" card), and
 *  2. the Codex GPT account pool (ChatGPT wham/usage per account), since the
 *     DSH GPT entry is served by this pool.
 *
 * Opt-in via ~/.dsh/usage-board/config.json:
 *   { "externalProviders": ["xuedinerapi"], "enabled": [...] }
 *
 * Percent semantics: pool = remaining/total credits per account, headline is
 * the LOWEST remaining account (a spent account is the binding constraint);
 * Codex = highest used_percent across accounts/windows (matches the board's
 * "worst window" convention).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const POOL_BASE = 'http://127.0.0.1:7863';
const POOL_KEY = 'wb2api-dsh-key';
const CODEX_HOMES = [
  ['A', join(homedir(), '.codex')],
  ['B', join(homedir(), '.codex-pool-b')],
];

function readCodexAccount(home) {
  try {
    const file = join(home, 'auth.json');
    if (!existsSync(file)) return undefined;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const t = j.tokens ?? {};
    if (typeof t.access_token !== 'string' || typeof t.account_id !== 'string') return undefined;
    return { accessToken: t.access_token, accountId: t.account_id };
  } catch { return undefined; }
}

export default {
  id: 'xuedinerapi',
  label: 'xuedinerAPI',
  async fetch({ httpsJson }) {
    const [pool, codexA, codexB] = await Promise.all([
      fetchPool(httpsJson).catch((e) => ({ error: String(e?.message ?? e) })),
      fetchCodex('A', CODEX_HOMES[0][1], httpsJson).catch((e) => ({ error: String(e?.message ?? e) })),
      fetchCodex('B', CODEX_HOMES[1][1], httpsJson).catch((e) => ({ error: String(e?.message ?? e) })),
    ]);

    const details = [];
    let percent = null;
    let poolFailed = null;

    // --- pool card: per-account remaining credits ---
    if (pool.accounts) {
      for (const a of pool.accounts) {
        details.push({
          label: a.nickname || a.uid?.slice(0, 8) || '账号',
          value: `${a.credits}/${a.credits_total}`,
          extra: a.cooling ? null : undefined,
        });
      }
      const ratios = pool.accounts
        .filter((a) => typeof a.credits_total === 'number' && a.credits_total > 0)
        .map((a) => 1 - a.credits / a.credits_total);
      if (ratios.length > 0) percent = Math.round(Math.max(...ratios) * 1000) / 10;
      details.push({ label: '账号健康', value: `${pool.healthy ?? '?'}/${pool.total ?? pool.accounts.length} 可用` });
      if (pool.sticky_sessions !== undefined) details.push({ label: '粘性会话', value: String(pool.sticky_sessions) });
    } else {
      // A pool outage must NOT return early: that discarded the GPT rows
      // fetched below and silently removed the GPT usage section from the
      // card. Report the pool as one failed row and carry on.
      poolFailed = pool.error ? `号池不可达：${pool.error}` : '号池无数据';
      details.push({ label: '号池', value: '查询失败' });
    }

    // --- codex rows (one per account with its own windows) ---
    for (const c of [codexA, codexB]) {
      if (c.error) {
        details.push({ label: `GPT 账号 ${c.key}`, value: '查询失败' });
        continue;
      }
      if (!c) continue;
      const wins = c.windows ?? [];
      const used = wins.map((w) => w.usedPercent).filter((n) => typeof n === 'number');
      const worst = used.length ? Math.max(...used) : null;
      const reset = wins.map((w) => w.resetsAt).filter(Boolean).sort((a, b) => a - b)[0];
      details.push({
        label: `GPT 账号 ${c.key}（${c.plan ?? 'chatgpt'}）`,
        value: worst === null ? '无数据' : Math.round(worst * 10) / 10 + '%',
        extra: reset ? new Date(reset).toISOString() : undefined,
      });
      if (worst !== null) percent = percent === null ? worst : Math.max(percent, worst);
    }

    const worstPool = pool.accounts
      ?.filter((a) => typeof a.credits_total === 'number' && a.credits_total > 0)
      .sort((a, b) => a.credits / a.credits_total - b.credits / b.credits_total)[0];

    const gptRows = details.filter((d) => String(d.label).startsWith('GPT 账号')).length;

    return {
      id: 'xuedinerapi',
      label: 'xuedinerAPI',
      // Only fail the whole card when nothing at all could be read.
      ok: poolFailed === null || gptRows > 0,
      ...poolFailed !== null && gptRows === 0 ? { error: poolFailed } : {},
      headline: worstPool
        ? `${worstPool.nickname || '最紧账号'} 余 ${worstPool.credits}`
        : (gptRows > 0 ? `GPT ${gptRows} 账号` : '暂无数据'),
      percent,
      details,
    };
  },
};

async function fetchPool(httpsJson) {
  const r = await httpsJson(`${POOL_BASE}/status`, {
    authorization: `Bearer ${POOL_KEY}`,
    accept: 'application/json',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.body;
}

async function fetchCodex(key, home, httpsJson) {
  const acct = readCodexAccount(home);
  if (!acct) return undefined;
  const r = await httpsJson('https://chatgpt.com/backend-api/wham/usage', {
    authorization: `Bearer ${acct.accessToken}`,
    'chatgpt-account-id': acct.accountId,
    originator: 'codex_cli_rs',
    accept: 'application/json',
  });
  if (!r.ok) return { key, error: 'HTTP ' + r.status };
  const b = r.body ?? {};
  const windowOf = (w, kind) => {
    if (!w || typeof w.used_percent !== 'number') return null;
    let resetsAt;
    if (typeof w.reset_at === 'number' && w.reset_at > 0) resetsAt = w.reset_at * 1000;
    else if (typeof w.reset_after_seconds === 'number') resetsAt = Date.now() + w.reset_after_seconds * 1000;
    let k = kind;
    const s = w.limit_window_seconds;
    if (typeof s === 'number') {
      if (s >= 300 * 60 * 0.95 && s <= 300 * 60 * 1.05) k = 'session';
      else if (s >= 10080 * 60 * 0.95 && s <= 10080 * 60 * 1.05) k = 'weekly';
    }
    return { kind: k, usedPercent: w.used_percent, resetsAt };
  };
  const windows = [];
  const a = windowOf(b.rate_limit?.primary_window, 'session');
  const weekly = windowOf(b.rate_limit?.secondary_window, 'weekly');
  if (a) windows.push(a);
  if (weekly) windows.push(weekly);
  return { key, plan: typeof b.plan_type === 'string' ? b.plan_type : undefined, windows };
}
