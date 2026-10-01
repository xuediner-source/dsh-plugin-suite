<div align="center">

# DSH Plugin Suite

**六个插件，一个维护入口。按需安装，与原生 DeepSeek Harness 协作。**

[![Checks](https://github.com/xuediner-source/dsh-plugin-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/xuediner-source/dsh-plugin-suite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-5865F2)](docs/upstream-audit.md)
[![Packages](https://img.shields.io/badge/independent_plugins-6-2ea44f)](https://github.com/xuediner-source/dsh-plugin-suite/releases)

[下载插件](https://github.com/xuediner-source/dsh-plugin-suite/releases) · [上游对照](docs/upstream-audit.md) · [修复记录](docs/integration-review.md) · [开发说明](CONTRIBUTING.md)

</div>

将 `dsh-subs-hub`、`dsh-antigravity-boost`、`dsh-grok-memory`、`dsh-autocompact`、`dsh-usage-board` 和 `dsh-xuediner-gateway` 整合在同一个 workspace。每个插件都保留自己的入口、配置、许可证和独立安装包，先完成兼容修复与针对性测试，再打包发布。原有六个仓库将在整合发布验证通过后删除；准确的来源提交保存在本仓库的 `source/<package>` 标签中。

**本仓库不包含 Xueness。** 对照的 DSH 版本为 `0.2.0-rc.2`，上游与原插件的准确 commit 见 [来源清单](docs/source-provenance.json)。不替换 DSH 内核，也不自动把六个插件全部启用。

## 插件与原生能力的分工

| 插件 | 保留的能力 | 与原生 DSH 的分工 |
|---|---|---|
| [Subscriptions Hub](packages/dsh-subs-hub) | 订阅账号、额外供应商协议、登录管理 | 原生已有通用模型配置和部分 OAuth；Hub 避让已有 provider 路由 |
| [Antigravity Boost](packages/dsh-antigravity-boost) | 临时工作树、验证与修复迭代、交付检查 | 原生已有并行与工作流；工作树隔离仍是插件增量 |
| [Grok Memory](packages/dsh-grok-memory) | 五轨跨会话记忆、检索注入、建议确认队列 | 原生会话历史不能替代用户/项目长期记忆 |
| [Autocompact](packages/dsh-autocompact) | 可选错误分类、观测与窗口上限纠正 | 自动压缩和 `/compact` 使用原生实现；不再修改旧预设目录 |
| [Usage Board](packages/dsh-usage-board) | 订阅额度、窗口与重置时间面板 | 原生 token meter 负责请求/上下文 token，不等同账号剩余额度 |
| [Xuediner Gateway](packages/dsh-xuediner-gateway) | 统一 provider、多账号协议、号池面板与 Go 网关 | 作为可选 `xuedinerAPI` 路由使用，保留供应商专用增量 |

## 安装

从 [Release](https://github.com/xuediner-source/dsh-plugin-suite/releases) 选择需要的 `.tgz`。使用你正在运行的 profile 名称（下面以 `desktop` 为例）：

```sh
dsh plugin --profile desktop add /absolute/path/dsh-grok-memory-0.3.1.tgz
```

也可以在插件管理器中填入对应 Release 附件的完整 URL。根仓库是 workspace，**不能把仓库根目录当作一个 DSH 插件安装**。六个插件互不要求全部安装；选择实际需要的包，并按该插件 README 完成配置后重启宿主。

- 已由原生 `llm-pi-ai` 管理的 provider，应继续使用该 owner；Hub 会避让已注册的同名路由。
- Memory 的模型建议不会直接改写注入轨道，需用户通过确认命令接受。
- Autocompact 默认 `observe`；只有明确设置 `mode: correct` 才纠正错误分类和模型窗口。
- Boost 只在主动调用时工作；验证未通过会阻止成功交付。
- 网关面板限定本机同源请求。启用 provider 插件不会替你安装、启动或登录外部网关服务。

升级前请查看各包 README。本轮不迁移或删除用户原有的登录、会话和记忆数据；新的 provider 状态与磁盘数据仍位于用户自己的本机目录。

## 开发与验收

需要 Node.js **22.19+ 或 24+**，Go 用于 bundled gateway 回归；CI 使用 Node 24.20.0 和 Go 1.27.1。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm run check
npm test
npm run pack:plugins
```

`artifacts/` 生成六个可独立安装的包、`SHA256SUMS` 和安装包清单。检查包括真实发布 DSH runtime 的协议测试、临时工作树与本机 HTTP 回归、TypeScript、Go 回归及安装包内容检查。缺失工具链不会被记为成功。

**验收范围：** 无真实账号登录、无收费模型请求、无供应商额度实测。测试中的模拟响应仅验证协议、状态和错误处理，不能证明所有供应商当前可用，也不代表模型性能。详细范围和已知限制见 [修复记录](docs/integration-review.md)。

## English

Six independently installable DeepSeek Harness addons in one audited workspace. The suite keeps native compaction and workflow foundations, repairs stale host contracts, and retains useful subscription, memory, quota and account-pool extensions. Install a selected release archive rather than the workspace root. Compatibility is reviewed against DSH `0.2.0-rc.2`; tests do not use live accounts or paid inference.

## License & provenance

MIT. Individual package notices are preserved, including the original bundled Go gateway attribution. See [NOTICE](NOTICE.md) and [pinned source commits](docs/source-provenance.json).
