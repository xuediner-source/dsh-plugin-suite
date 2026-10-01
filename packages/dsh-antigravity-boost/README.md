# dsh-antigravity-boost

DeepSeek Harness 插件：**隔离 Git worktree、验证与交付工具**。显式启动 `/boost` 后，它为任务创建临时分支和 worktree，记录实现/调查报告，在 worktree 中执行配置的验证命令，并在检查仍有效时允许交付。

本插件借鉴 Antigravity `/boost` 的分阶段工作思路，由当前会话调用命令和工具推进。它不自动派发 agent，也不提供独立的推理模型或推理能力。

## 安装

```sh
dsh plugin --profile <profile> add /absolute/path/dsh-antigravity-boost-<version>.tgz
```

从 DSH Plugin Suite 的 Release 下载独立 `.tgz`，或从整合仓库构建后的 `packages/dsh-antigravity-boost` 目录安装。根 workspace 本身不是可安装插件。重启 DSH 后即生效。

插件目录下不要安装 `@deepseek-ai/*`。那些包必须由 DSH 主机提供；本地一份会盖掉主机解析（曾导致 `z.const is not a function`）。

## 能力

| 插件能力 | 实现 |
|---|---|
| **`/boost <task>`** | 命令 + `boost_run` 工具，为任务打开临时 Git worktree |
| **临时隔离 worktree** | `lib/worktree.js`，分支 `boost/<runId>`，路径 `<repo>/.dsh-boost/worktrees/<runId>` |
| **工作流报告** | `boost_report kind=implementation` 记录实现进展；`kind=investigation` 记录只读调查结论 |
| **调查约束** | 调查报告含文件变更，或 worktree 中检测到实际文件变化时，均拒绝报告 |
| **本地验证** | `lib/verify.js`，在 worktree 内执行 `verifyCommands` |
| **失败诊断回灌迭代** | `/boost-verify` 失败时返回 `diagnostics` + `feedback`，状态转 `iterating` |
| **迭代轮次上限** | `maxRounds`（默认 3），耗尽后转 `needs_review` 交人工 |
| **交付检查** | `/boost-deliver` 要求最新验证通过、worktree 内容未变化、目标分支仍处于启动时记录的提交 |
| **Git 更改位置** | 执行期间的任务更改位于 worktree；明确交付时才合并到当前检出的目标分支 |
| **一次性 workspace** | `/boost-discard` 丢弃后移除 worktree 与分支；交付合并后也会尝试清理，清理失败时明确报告 |
| **状态留痕** | `<repo>/.dsh-boost/runs/<runId>/state.json`，崩溃后可查 |

## 适用场景

适合需要隔离代码改动、运行本地检查并按失败诊断继续修复的任务。任务拆分、推理和 agent 调度由 DSH 会话及其已配置的 workflow/provider 决定；Boost 插件自身只管理工作区、报告、验证和交付状态。

## 用法

```
/boost Investigate the race condition in the session cache and implement a thread-safe fix with tests.
```

然后按协议推进：
1. 计划 —— 拆分实现 / 调查工作流
2. 执行 —— `boost_report` 记录工作流结论（调查流不可报文件变更）
3. 验证 —— `/boost-verify`；失败则按诊断迭代
4. 交付 —— 最近一次验证通过且 worktree 未变化后运行 `/boost-deliver`，或用 `/boost-discard` 丢弃

## 已知差异

| 项 | DSH 原生能力 | Boost 插件 |
|---|---|---|
| 子 agent 编排 | DSH 原生 workflow 可按已配置的 provider 编排 agent | 本插件不自动派发 agent；当前会话按协议调用 Boost 工具 |
| Worktree 隔离 | 当前 rc.2 中原生 `agent(isolation: 'worktree')` 工作流能力尚未提供 | 本插件为 Boost run 单独创建和管理 Git worktree |
| 并行执行 | 由所用的 DSH workflow 决定 | Boost 报告与验证工具本身不调度并行任务 |

## 配置

```yaml
- id: dsh-antigravity-boost
  config:
    enabled: true
    maxRounds: 3
    verifyCommands: ["npm test"]
```

## 交付安全

- 每轮验证会记录相对不可变基线的工作区指纹。交付前重新核对内容指纹、当前检出的目标分支和启动运行时记录的目标提交；任一项变化都拒绝合并，须重新验证或检查目标分支变化。
- 迭代允许先失败、修复，再通过验证；交付要求**最新一轮**通过，而不是要求每个历史轮次都通过。
- 不确定 Git 状态、损坏或被篡改的运行状态、清理失败均按失败关闭处理。自动提交失败会保留 worktree；合并成功但清理失败会报告已合并并保留清理提示。
- 工作区只从命令会话 cwd 或显式 `workspace`/repo path 解析；缺少会话工作区时会报错，不会默认写入进程 cwd。
- 验证命令由安装者配置，在临时 worktree 内执行；它们不能证明未纳入命令的行为正确。

## 验证

```sh
npm run check   # 语法
npm test        # 单元与隔离 Git-worktree 回归
```

测试覆盖：临时 worktree 创建与主仓隔离、状态/路径篡改拒绝、linked-worktree exclude 配置、目标分支变化与验证后编辑拒绝交付、验证命令退出码与 spawn 错误、**引号内命令的正确解析**（`node -e "process.exit(1)"` 必须真正失败）、失败诊断回灌、`maxRounds` 耗尽转人工、调查流报文件变更被拒、跨仓 active-run 与无会话 cwd 行为、验证通过后合并和安全清理。

## 许可

MIT © [xuediner-source](https://github.com/xuediner-source)
