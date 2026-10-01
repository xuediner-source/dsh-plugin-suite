# Memory 与 Boost 插件审查

本记录针对整合仓库中独立保留的 `dsh-grok-memory` 和 `dsh-antigravity-boost`，对照 DeepSeek Harness `0.2.0-rc.2`（commit `639ed015397290b3745d163aafe02ffee4aa3f84`）。插件来源提交见 [`source-provenance.json`](source-provenance.json)。此处只保留插件增量，不复制 DSH 内核实现。

## DSH 原生能力边界

DSH 提供持久 Session 事件流、会话上下文装配、原生压缩，以及可并行编排子 agent 的 workflow。Session 历史和压缩摘要用于当前会话的可恢复上下文；在此版本的内核包中没有覆盖本插件五轨数据模型的跨会话用户/项目长期记忆及其确认队列。Memory 插件因此保留长期记忆、项目检索与注入范围分层。

Boost 插件管理自身一次性 Git worktree、验证与交付状态。DSH 原生 workflow 已提供工作流编排，但 `workflow-ptc` 在该提交中明确将 `agent(..., { isolation: 'worktree' })` 标为 deferred 并拒绝执行。因此插件 worktree 是独立的主动调用增量，不能视为原生 workflow 隔离，也不提供自动并行子 agent 调度。

审查所用的主要内核契约位于 `packages/core/agent/src/runtime-types.ts`、`packages/core/session/src/index.ts`、`packages/core/session/src/known-event-types.ts`、`packages/workflow/workflow-ptc/tests/workflow-ptc.spec.ts`。以下修复根据这些已固定的源代码契约审查；测试没有启动完整 DSH 主机。

## `dsh-grok-memory`

### 发现和修复

- 生命周期曾依赖不存在的 `agent/settled` Cordis 事件及不存在的 Cordis compaction 事件，因此真实 rc.2 主机不会按预期保存、更新压缩后的检索缓存。现在由 `agent/inbox/claimed({ agent, message, turn })` 缓冲人类输入，并从 `session/event(session, event)` 消费已提交的 Session 日志；在 `turn/end` 自动保存，在 `compaction/end` 清除旧 recall 缓存，`agent/disposed({ agent })` 作为最后保存和清理回退。`turn/end` 与 `compaction/*` 是 Session 日志事件，不是 Cordis 事件。
- DSH 可在 user-role 内容中装配合成的目标、计划和上下文文本。记忆保存与 recall 现仅采用 `source.kind === 'user'` 的消息（兼容旧的无 source 记录），避免把插件注入或系统合成内容重新保存成用户事实。
- 注入轨 `memory`、`user`、`key` 不再允许模型通过记忆工具直接增删、替换、归档或提升。需要写入这些轨的建议必须先入队，用户再通过 `/suggest accept <n>` 确认；接受时继续经过注入风险扫描。被拒绝的建议留在队列供检查。
- 项目操作不再猜测或回退到 `process.cwd()`。无会话工作区时，项目/key 写入和 `/dream` 安全失败；无有效会话上下文的 prompt 装配返回空结果。
- 修复 FTS 检索条件：不把完整 cwd 附加到检索词，避免 FTS5 的 AND 查询语义因路径 token 导致有效命中被抑制。
- README 说明了新确认流程；包的可选 peer 声明包含其 host API 使用到的 agent、commands、session、system-prompt、tools 和 schema 包。

### 验证

在 `suite/packages/dsh-grok-memory` 中运行：

```sh
npm run check
npm test
node --test test/plugin.test.mjs
```

结果：`npm run check` 通过；`npm test` **76/76** 通过；插件行为回归 **34/34** 通过。回归覆盖工具权限、建议确认、无 cwd、注入合成内容过滤、提交后的压缩缓存失效、真实 payload 形状的生命周期事件、`turn/end` 保存及 disposal fallback。

## `dsh-antigravity-boost`

### 发现和修复

- 运行 ID、状态文件及 worktree 路径现做校验；拒绝路径穿越、被篡改的 workspace/branch 状态和关键状态目录的符号链接。运行记录固定目标分支、基线提交和目标提交。
- 对 Git 状态无法检查时按“有变化/不安全”处理。调查流会检查实际 worktree 变化，不能通过报告 `files: []` 掩盖磁盘修改。
- 交付须处于 verified 状态，最近一次验证成功，且相对固定基线的 tracked/untracked 内容指纹仍匹配。交付同时核验当前检出的目标分支及其启动时提交；运行后目标分支前进、切换分支或验证后改动都会阻止合并。
- 迭代可以先失败、修复后通过；只有最新验证需要通过。旧逻辑要求每一轮都通过，令设计中的失败反馈循环无法交付。
- 删除任意递归删除 worktree 的兜底行为。Git 拒绝移除 worktree 时保留现场并返回错误；自动提交失败时不合并、不清理；合并成功但清理失败则明确报告已合并和清理状态。
- 用 `git rev-parse --git-path info/exclude` 定位 ignore 文件，修复在 linked worktree 中误写到错误 `.git` 路径的问题。
- 工作区只从会话 cwd 或显式 repo/workspace 路径解析，避免缺失会话 cwd 时对插件进程目录操作；跨仓 active-run 记录按会话所有者解析，并且旧 run 的清理不能删除新 run 的指针。
- README 补上交付校验限制、原生 workflow 隔离差异、会话 cwd 要求和整合仓库包安装说明。可选 peer 声明列出使用的 agent、commands、session、system-prompt、tools 和 schema host 包。

### 验证

在 `suite/packages/dsh-antigravity-boost` 中运行：

```sh
npm run check
npm test
```

结果：`npm run check` 通过；`npm test` **50/50** 通过。测试使用临时 Git 仓库和隔离状态目录，覆盖符号链接/路径篡改、Git worktree 隔离、linked worktree ignore 路径、目标分支前进或切换、验证后编辑、失败后修复、自动提交钩子失败、跨仓会话 owner 和无 cwd 行为。

## 验证范围与限制

内核 API 契约通过固定源码审查；memory 的 Cordis 主机使用隔离测试 host，Boost 使用隔离 host 加真实本地临时 Git worktree。没有运行 DeepSeek Harness 完整上游测试套件，也没有在完整桌面运行时做端到端加载测试。验证命令仅执行包内 `check` 和回归测试；未调用收费模型、真实账号、供应商服务或网关，发布与提交由整合仓库统一门禁完成。这些测试证明实现处理了列出的 API、状态和本地 Git 情况，不证明未配置验证命令所覆盖的产品行为。
