# @monk/monk-llm

Monk 融合模型的 dsh LLM 适配器。注册提供方路由 `monk-official`，承载
`monk` / `monk-fast` / `monk-coding` 三个模型。

## 挂载

```yaml
- id: monk-llm
  name: '@monk/monk-llm'
  config:
    apiKeyEnv: MONK_API_KEY
    reasoningEffort: medium
    models:
      - id: monk
        name: Monk
        tier: quality
        contextWindow: 1000000
        maxTokens: 64000
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `MONK_API_KEY` | 凭据引用（环境变量名），每次请求解析 |
| `baseURL` | `https://monk.party/v1` | 端点基址 |
| `reasoningEffort` | 提供方默认 | `low` / `medium` / `high` |
| `maxTokens` | 模型自身上限 | 缺省单次输出上限 |
| `models` | 三个内置模型 | 建议性目录，可用设置覆盖 |
| `streamIdleTimeoutMs` | 300000 | 单次流读取最长空闲时间 |
| `retryPolicy` | 正常模式 5 次 | 注册期捕获，变更时原地替换路由 |
| `defaultTier` | — | 无 router 时的兜底分层 |

## 扩展点

- 通过 `ctx.llm` 的 `registerAdapter` / `registerConfigurableProviders` 贡献路由，
  卸载插件即撤销。
- 设置段落 `monk-llm:` 写入 `$DSH_HOME/settings.yaml` 后热重载，无需重启。

## 已知限制

- 只支持流式调用：`stream` 与 `stream_options.include_usage` 恒为真。非流式
  路径未实现，因为 usage 必须早于 finish 发出。
- 图片输入依赖上层提供 `resolveImages`；未提供时图片投影为 `[image: unresolved]`
  占位文本，而不是让整条消息失败。
