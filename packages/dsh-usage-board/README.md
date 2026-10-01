# dsh-usage-board

[English](#english) | [中文说明](#中文说明)

---

## 中文说明

DeepSeek Harness Web 用量板：一块可拖动悬浮卡片，按当前 **已登录的订阅** 和 **已配置密钥的模型提供方** 自动显示额度。订阅中心只是注册了适配器、但还没登录的供应商 **不会出现在用量板上**。

### 🌟 特性

- **自动检测**：读取 DSH 当前注册的 LLM provider ID、订阅中心 auth 文件中的已登录会话，并通过 DSH `credentialRef` 解析 DeepSeek API key；不依赖不存在的 SettingsForms `get()` API。
- **断流容灾**：用量请求走 Node `https`（带浏览器 UA）；直连失败时再尝试本机代理，避免 Cloudflare / 掐流把卡片打空。
- **快照缓存与单卡超时**：整板快照缓存 20 秒；每个 provider 12 秒超时；HTTP GET 缓存最多 128 条、每条保留 15 秒。
- **有界加载外部适配器**：`~/.dsh/usage-board/providers/` 仅扫描目录返回的前 256 个条目，最多加载 32 个 kebab-case `.js` / `.mjs` 文件；配置文件限制为 256 KiB。
- **中英双语 UI**：根据浏览器语言切换文案；错误可一键复制。

浏览器只请求 `GET /api/usage-board`，并且该接口只接受 loopback 对端和精确同源的本地请求。后端直接向各 provider 的 API 查询用量，浏览器只收到用量快照，不会收到认证令牌。

### 📋 自动显示

| 卡片 | 何时出现 | 数据来源 |
|---|---|---|
| Gemini | 订阅中心登录 Gemini | Antigravity quota |
| GPT | 订阅中心登录 GPT | ChatGPT Codex usage |
| Grok | 订阅中心登录 Grok | Grok CLI billing |
| Claude | 订阅中心登录 Claude | Anthropic OAuth usage |
| OpenRouter / Qwen / Agnes / Spark / ERNIE | 订阅中心对应登录 | 登录态（无公开用量接口时显示已登录） |
| OpenCode | 模型里有 OpenCode 提供方 | `OPENCODE_API_KEY` |
| DeepSeek | 模型 id 含 deepseek，或本机有 `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` |
| SuperGrok | 本机 grok CLI / `GROK_BUILD_ACCESS_TOKEN` | Grok billing |

### 🚀 安装

```sh
dsh plugin --profile desktop add /absolute/path/dsh-usage-board-0.3.1.tgz
```

重启 DSH 后强制刷新。配合订阅中心可显示已登录账号的用量。

### 🧩 扩展更多模型

把适配器放到 `~/.dsh/usage-board/providers/<name>.js`。必须 `export default { id, label, fetch }`，`id` 为 kebab-case。`fetch` 收到 `{ credentials, httpsJson, env, logger }`。

外部适配器是以当前用户权限执行的 JavaScript 插件代码，不是沙箱；只放入自己信任的文件。加载文件数、配置大小、每卡请求时长、HTTP 请求和响应大小都设有上限。停用插件会取消正在进行的用量请求。

示例见 `docs/example-provider.js`。

可选配置 `~/.dsh/usage-board/config.json`：

```json
{
  "externalProviders": ["xuedinerapi"],
  "order": ["gemini", "gpt", "grok-sub", "claude", "opencode", "deepseek"]
}
```

⚠️ `enabled` 是**白名单**：一旦填了非空数组，自动检测会被**完全关闭**，只显示 listed id。只写了外部 provider 而忘了订阅中心的卡片，是很容易踩的坑：

```json
{
  "externalProviders": ["xuedinerapi"],
  "enabled": ["xuedinerapi"]   // ← 订阅中心的 gemini/gpt/grok-sub… 全部不显示
}
```

想「外部 provider + 订阅中心都显示」，就**不要写 `enabled`**（留空或删除即可），自动检测会同时纳入订阅中心登录态、LLM 路由和外部 provider。

`config.json` 请存成**无 BOM 的 UTF-8**。Windows 记事本和 PowerShell 的 `Set-Content -Encoding utf8` 会写入 BOM，插件已做兼容处理，但无 BOM 最稳妥。

### 🧪 测试

```sh
npm run check
npm test
```

### 协议

MIT

---

<a name="english"></a>
## English

DeepSeek Harness usage overlay: a draggable card that auto-detects **signed-in subscriptions** and **key-backed model providers**. Hub adapters that are only registered (not logged in) stay off the board.

### Highlights

- Auto-detects live provider IDs from DSH's LLM registry, signed-in sessions from the hub auth store, and the DeepSeek API key through DSH's `credentialRef` API. It does not call `SettingsForms.get()`.
- Direct HTTPS first, then local proxy fallback. The local usage route is loopback- and same-origin-only. The snapshot cache lasts 20 seconds, each provider has a 12-second timeout, and the HTTP GET cache is capped at 128 entries for 15 seconds.
- External adapters load from `~/.dsh/usage-board/providers/`: at most 32 kebab-case `.js` / `.mjs` files from the first 256 directory entries; configuration is capped at 256 KiB.
- Bilingual UI (zh / en) with one-click error copy.

The browser only calls `GET /api/usage-board` and receives usage snapshots, never provider credentials. The backend sends credentials to the corresponding provider API. External adapters execute as the current user, so only install files you trust; disabling the plugin aborts active requests.

### Install

```sh
dsh plugin --profile desktop add /absolute/path/dsh-usage-board-0.3.1.tgz
```

### Tests

```sh
npm run check
npm test
```

### License

MIT © [xuediner-source](https://github.com/xuediner-source)
