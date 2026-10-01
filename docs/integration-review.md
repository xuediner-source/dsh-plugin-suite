# 整合与完善记录

审查基线：DeepSeek Harness 0.2.0-rc.2，2026-10-02 复查公开上游与六个来源仓库的默认分支。准确来源提交及新仓库内的 source 标签见 [source-provenance.json](source-provenance.json)。[上游能力对照](upstream-audit.md) 说明哪些能力已由 DSH 原生提供；本页说明实际应用到整合包的改动。

## 六个插件均先完善，再保留为独立包

| 包 | 新版本 | 实际修复与优化 |
|---|---|---|
| dsh-antigravity-boost | 0.1.2 | 状态/路径/目标分支校验，linked worktree 排除路径，验证后内容指纹，最新一轮成功语义，提交失败保留现场，清理失败明确报告，禁止任意 force-rm 兜底 |
| dsh-grok-memory | 0.3.1 | 当前已提交 Session/Agent 事件，真实人类输入过滤，压缩后 recall 缓存失效，首轮 FTS 查询修复，注入轨道用户确认与项目 cwd 绑定 |
| dsh-subs-hub | 0.1.3 | 保留既有 provider owner，OAuth 尝试预留/取消/卸载生命周期，私有原子存储，非过期 Key/会话兼容，安全错误输出，RFC 8628 轮询回归 |
| dsh-usage-board | 0.3.1 | 当前 native credentialRef 与已注册 LLM provider 检测，完整账号身份缓存，受限缓存/响应/重定向，跨站凭证转发防护，超时取消和 HTTP 回归 |
| dsh-autocompact | 0.2.0 | 默认观察，显式纠正，使用当前 LLM waterfall 和 prepareCall，明确 token 超限分类，本地有界窗口表，卸载恢复；停止修改旧预设目录与重复挂载原生压缩 |
| dsh-xuediner-gateway | 0.2.1 | RequestMessage 兼容、真实 native SettingsForms/Loader 接线、每请求动态连接配置、输出后取消、截断失败、SSE 内嵌错误/上限、安全日志和全部号池 HTTP 路由边界 |

更多细节见 [Memory/Boost](audit-memory-boost.md)、[Subscriptions/Usage](audit-subscriptions-usage.md) 与各包 README。

## 分工与限制

原生 DSH 负责基础 compaction、通用模型适配、工作流与 host 生命周期。插件保留订阅专用协议、五轨长期记忆、订阅额度、独立 Git worktree 验证以及 xuedinerAPI 号池。Boost 管理显式报告/验证/交付，不自动派生并行 agent；需要编排时使用原生 workflow。Autocompact 只可选地纠正错误或窗口，不是第二个压缩引擎。

验收不加载真实个人 profile，不访问真实供应商账号，不调用收费模型，不把模拟 Token/额度数字当成实测。没有执行 DSH 完整上游测试或完整桌面 UI 端到端测试。原生主机兼容通过固定源码审查、真实发布 runtime 的 LLM 协议和 SettingsForms/Loader 集成测试进行验证；其余插件使用隔离状态、本机 HTTP 与临时 Git 仓库回归。

## 统一发布门禁

`npm run build`、`npm run typecheck`、`npm run check`、`npm test`、`npm run pack:plugins`。Go 网关另包含全包 `go test ./...` 和 `go vet ./...`。安装包检查实际导出、入口、patch、许可证、文件列表和凭据模式，并生成 SHA-256 清单。测试和打包失败时不发布。

旧六个仓库在整合发布验证后删除。来源历史提交保存在整合仓库 `source/<package>` 标签中，审查链接使用整合仓库内的同一 source SHA；来源清单仍记录原 URL 作为历史来源事实。当前独立包只从整合仓库 Release 或构建后的 package 目录安装。

## 本轮最终结果

Node 24.20.0 本机统一回归通过：Boost 50、Autocompact 3、Memory 76、Subscriptions Hub 65、Usage Board 40、Gateway stream 6、真实 native SettingsForms 1，合计 **241 项 node:test 用例**。此外号池真实本机 HTTP、结构/导出/凭据检查、TypeScript、Go 全包回归和 Go vet 均通过。GitHub CI 同时覆盖 Node 22.19.0 与 24.20.0；线上运行结果以仓库 Checks 为准。测试数不包含供应商实测或模型性能测量。
