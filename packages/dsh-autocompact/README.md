# dsh-autocompact

DeepSeek Harness 的可选上下文错误与窗口纠正插件，适配 **0.2.0-rc.2**。原生 DSH 已提供自动压缩、`/compact` 和工具结果裁剪；本插件不再维护另一套压缩流程。

## 本次完善

- 使用当前 `llm/stream` 协议，识别实际 `finish.reason.failure`，同时覆盖普通调用和 `prepareCall().stream()`。
- 默认 `observe`：仅记录明确的上下文超限与上游明确给出的 token 上限，不改变请求、模型元数据或错误码。
- 显式 `correct`：将明确的 token 超限归类为 `CONTEXT_WINDOW_EXCEEDED`，交给原生压缩恢复；以已记录的更小上限修正普通和预备调用的上下文窗口。
- 不把 HTTP 413、`request_body_too_large` 或普通文档中的“context window”字样当作 token 超限。
- 卸载会清理中间件和本实例拥有的元数据包装。持久状态只包含限值、计数和来源类别，不保存报错正文。

**不扫描、不修改 `.agent-presets`，不自动挂载压缩组。** 旧版本的预设注入已移除，因为当前 DSH 不再读取该目录。过去生成的用户备份不会被本插件改动。

## 安装与选择模式

下载整合仓库 Release 中的独立 `.tgz`，使用实际 profile 名称安装：

```sh
dsh plugin --profile desktop add /absolute/path/dsh-autocompact-0.2.0.tgz
```

也可以从整合仓库构建后的包目录安装。安装后重启宿主，默认观察模式。需要纠正时，在该 profile 的 `cordis.patch.yml` 中覆写本插件条目：

```yaml
- id: dsh-autocompact
  config:
    mode: correct
```

`observe` 与 `correct` 均可运行 `/autocompact` 查看模式、计数和记录的窗口。纠正仅在出现明确错误或用户配置了限值后生效，不预置未经验证的 provider/model 限值。原生压缩插件仍需由 profile/agent composition 正常提供。

```sh
dsh plugin --profile desktop remove dsh-autocompact
```

## 本地状态

默认目录 `~/.dsh/dsh-autocompact`，设置 `DSH_HOME` 后使用 `$DSH_HOME/dsh-autocompact`。`state.json` 保存运行期观察；可选 `seeds.json` 是手工配置的窗口字典：

```json
{
  "my-provider/my-model": {
    "contextWindow": 32000,
    "source": "local configuration",
    "updatedAt": 0
  }
}
```

限值须为 1024–10000000 的整数，最多 1024 条；只降低已声明窗口。记录按 provider/model 区分，不能代表其他路由或实际模型性能。

## 验证

在整合仓库根目录运行 `npm ci --ignore-scripts`、`npm run build`，然后 `npm test --workspace dsh-autocompact`。测试加载真实发布的 DSH LLM runtime，检查两种模式、普通/预备调用、卸载恢复及误分类边界；不调用收费模型。
