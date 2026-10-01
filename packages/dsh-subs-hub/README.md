# dsh-subs-hub

[English](#english) | [中文说明](#中文说明)

---

## 中文说明

DeepSeek Harness 订阅中心：将主流 AI 订阅服务统一接入 DSH 模型选择器，**无需手动配置 API Key**。

### 🌟 特性

- **零 API Key 接入**：基于 OAuth PKCE / 设备码 / 本地客户端授权流直接打通订阅。
- **智能代理与直连容灾**：检测到本地代理掐流或异常中断（`ECONNREFUSED`、`UND_ERR_SOCKET`、`other side closed`）时，自动降级为直连重试，保障模型推理链路不中断。
- **Gemini 3 思维签名保持**：自动捕获并回传 `thought_signature`，彻底解决复杂 Tool Call 下缺少签名导致的 HTTP 400 异常。
- **安全原子存储**：凭证持久化至 DSH home（默认 `~/.dsh/plugins/subscriptions/auth.json`，也可由 `DSH_HOME` 指定），采用临时文件 + rename 原子写入；POSIX 系统将目录设为 `0o700`、文件设为 `0o600`。
- **与用量看板联动**：可配合 `dsh-usage-board` 在悬浮窗中监控可查询的订阅配额和重置周期。

---

### 📋 支持的 Provider 与解锁模型

| Provider | 登录方式 | 前置条件 | 解锁模型示例 |
| :--- | :--- | :--- | :--- |
| **Gemini** (Antigravity) | Google OAuth PKCE | Google 账号 (包含 Cloud Code Assist 免费/付费配额) | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` |
| **GPT** (Codex) | ChatGPT Codex OAuth | ChatGPT Plus / Pro 订阅 | `chatgpt-4o-latest`, `o3-mini`, `o1`, `gpt-4o` |
| **Grok** | xAI Grok OAuth | X (Twitter) Premium / Premium+ 订阅 | `grok-2`, `grok-2-mini`, `grok-3` |
| **Claude** | 本机凭据读取 | 本机已安装并登录 Claude Code CLI (`~/.claude/.credentials.json`) | `claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-3-5-haiku` |
| **Qwen** (通义千问) | 设备码快速登录 | 阿里云 / 通义账号 (浏览器访问验证码授权) | `qwen-max`, `qwen-plus`, `qwen-turbo` |
| **OpenRouter** | OAuth PKCE | OpenRouter 账号 | `openrouter/auto`, `openrouter/*` (根据账号模型库) |
| **Agnes AI** | OAuth PKCE | Agnes 账号订阅 | `agnes/*` |
| **讯飞星火** (Spark) | OAuth PKCE | 讯飞开放平台账号 | `spark-max`, `spark-pro` |
| **文心一言** (ERNIE) | OAuth PKCE | 百度千帆/文心账号 | `ernie-4.0`, `ernie-3.5` |

---

### 🚀 安装与使用

```sh
dsh plugin --profile desktop add /absolute/path/dsh-subs-hub-0.1.3.tgz
```

重启 DSH 后，前往 **设置 (Settings) → 订阅中心 (Subscriptions Hub)** 即可管理各 Provider 的登录态。

#### Provider 路由所有权

DSH 的 LLM provider ID 在宿主中共享。订阅中心只会在对应 ID 尚未注册时添加自己的适配器；如果同一 ID 已由其他插件（例如 `llm-pi-ai` 的活动 profile）占用，订阅中心会保留现有路由并在日志中提示跳过。订阅登录态仍可单独管理，但模型请求会继续交给当前路由所有者。需要使用订阅中心适配器时，请在 DSH 中为该 provider 选择唯一的路由所有者，避免两个插件争用同一 ID。禁用订阅中心后，它自己注册的路由会随插件一并释放。

#### 常见场景与故障排查
1. **浏览器无法自动完成重定向回调？**
   - 登录中状态下，设置卡片内提供手动输入框：直接将浏览器地址栏中的完整重定向 URL 或授权码粘贴并点击“提交”，即可完成登录。
2. **代理软件导致断流？**
   - 插件已内置代理健康度嗅探，遇断流自动通过 Undici 直连重试。推荐的分流配置规则可参考 [`docs/ai-proxy-rules.yaml`](docs/ai-proxy-rules.yaml)。

---

### 🛡️ 安全性与隐私说明

- Access Token 与 Refresh Token 保存在 DSH home 的订阅中心 auth 文件中；POSIX 文件权限仅限当前用户。Claude 登录也会读取 Claude Code CLI 自己管理的本地凭据。
- DSH 后端将凭据发送给相应 Provider 的 API 来完成模型或用量请求；凭据不会通过订阅中心浏览器 UI 返回。此插件不提供凭据中继或备份服务。
- OAuth 回调监听器只绑定 loopback 地址，校验 Host、Origin 与 state，限制并发、回调数据大小和等待时长；成功、失败、取消或禁用插件后都会清理监听器和后台请求。
- 订阅中心单独管理各 Provider 的 OAuth 会话，并未把这些异构 Provider 授权流改写为一个通用授权流程；DSH 的 LLM 路由注册仍遵守宿主的 provider ID 唯一性。

---

<a name="english"></a>
## English

DeepSeek Harness Subscriptions Hub: Connect multi-provider AI subscriptions directly into the DSH model selector **without requiring API keys**.

### 🌟 Key Highlights

- **Direct Subscription Integration**: Authenticate via standard OAuth 2.0 PKCE, Device Authorization Flow, or local CLI credentials.
- **Resilient Fallback**: Auto-detects local proxy failures (`ECONNREFUSED`, `UND_ERR_SOCKET`, socket hang-ups) and automatically retries with direct connections.
- **Gemini 3 Thought Signatures**: Captures and re-injects `thought_signature` across multi-turn tool calls to prevent HTTP 400 validation failures.
- **Atomic & Secure Storage**: Credentials are saved atomically to `$DSH_HOME/plugins/subscriptions/auth.json` (default `~/.dsh/plugins/subscriptions/auth.json`). POSIX directories and files use `0700` and `0600` permissions.
- **Ecosystem Integration**: Works with `dsh-usage-board` to show available live quota data.

### 📦 Installation

```sh
dsh plugin --profile desktop add /absolute/path/dsh-subs-hub-0.1.3.tgz
```

After restarting DSH, open **Settings → Subscriptions Hub**.

### Provider route ownership

Provider IDs are shared by the DSH host. The hub registers an adapter only when that ID is free. If another plugin already owns it (including an active `llm-pi-ai` profile), the hub preserves that route and logs that its adapter was skipped. You can still manage the hub login, but model requests continue to use the existing owner. Choose one route owner per provider ID. Disabling the hub releases the routes it registered.

### Credential handling

The hub stores provider sessions in the DSH home auth file; on POSIX systems it uses owner-only directory and file permissions. Claude login also reads the local credentials maintained by Claude Code CLI. The backend sends credentials to the corresponding provider API for model or usage requests, while the browser UI never receives them. OAuth callbacks bind to loopback, validate Host, Origin, and state, and are bounded by concurrency, payload, and timeout limits. Active listeners and requests are cleaned up when the flow ends or the plugin is disabled.

### 🧪 Tests & Quality Assurance

```sh
# Syntax verification
npm run check

# Run automated tests (in-process node:test runner)
npm test
```

### 📄 License

MIT © [xuediner-source](https://github.com/xuediner-source)
