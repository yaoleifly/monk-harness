# Monk Harness 架构设计

> 一个建立在 DeepSeek Harness 插件框架之上的 agent harness 发行版，默认使用 Monk 融合模型 API。

本文回答三件事：**核心功能模块是什么**、**模块之间的接口契约是什么**、**它如何与现有 dsh 系统集成**。

- 参考产品：`https://monk.party/`（订阅制 OpenAI 兼容融合模型 API）
- 参考框架：`https://github.com/deepseek-ai/deepseek-harness`（`dsh`，MIT，`dsh-v0.1.3-alpha.1`）
- 本实现：`monk-harness/`，四个包，**不 fork 也不修改** dsh 任何一行代码

---

## 1. 设计起点：两个参考各自提供了什么

### 1.1 monk.party 提供的是「能力供给」

| 事实 | 对架构的含义 |
|---|---|
| 三个模型 `monk` / `monk-fast` / `monk-coding`，按**成本与速度**分层而非能力分层 | 选路是**成本优化问题**，不是能力路由问题。harness 应当自动挑最便宜够用的那一档 |
| OpenAI 兼容 Chat Completions | 适配器可以只实现一个 wire 方言；不需要为每个上游 Flash 模型单独适配 |
| 100 万 token 输入 / 6.4 万 token 输出 | 上下文极宽、输出极长。默认值可以激进，但**额度感知**变得必要 |
| 按月订阅（¥30/30 天），而非按 token 计费 | 用户的核心焦虑是"这个月还能用多少"。用量可见性是产品功能，不是运维功能 |
| 密钥是"专属 API Key"，订阅即生成 | 密钥的**获取与轮换**在 harness 之外发生。harness 只负责解析与使用，不做授权流程 |
| 定位是"更便宜更极速的主力模型"，服务开发者工作流 | 目标场景是**长时运行的编码 Agent**，不是一次性问答 |

### 1.2 deepseek-harness 提供的是「组合机制」

dsh 的核心主张是 **everything-is-a-plugin**，建立在 Cordis 之上：插件向共享上下文贡献服务、类型化事件和**可逆的副作用**；不存在需要打补丁的特权内核。

对我们最关键的四条机制：

1. **能力 seam（Service Definition / Provider / Consumer 三角）**。替换一个 Provider 就能改变整个产品行为。LLM 适配器就是一个 seam：`ctx.llm` 是注册表，`LlmAdapter` 是实现，agent loop 是消费者。
2. **组合包 + Profile + 有序 patch**。运行中的 `dsh` 是一棵插件树，由启动时按序叠加的层组成。一条 patch 按 id 定位某个条目并替换其整个 config。
3. **三类事件域**。会话事件（持久事实）、Agent 事件（`agent/*`，进行中的工作）、能力事件（`fs/*`、`tools/*`）。扩展点是**选事件域**，不是改内核。
4. **树外插件是一等公民**。`dsh plugin --profile <name> add <pkg>` 把外部 npm 包挂进 profile 的层栈。**我们因此不需要在 dsh 仓库里写代码。**

### 1.3 由此推出的产品形态

monk.party 卖的是**模型**，不是工具。订阅者拿到一个 API Key 之后，还得自己找 harness、配 provider、写 system prompt。**monk-harness 就是补上这一段**：

> 一个开箱即用的 Agent 发行版 —— 装上就有一个浏览器 Agent，默认走 Monk，自动在三个模型之间按任务选路，并且随时告诉你这个月的额度还剩多少。

---

## 2. 核心功能模块

五个模块，各自对应 dsh 的一个扩展点。命名遵循 dsh 的角色词表（`Adapter` / `Policy` / `Ledger` / `Brand` / `Bundle` 语义），避免"首个实现命名"。

```
monk-harness/
├── packages/
│   ├── monk-llm       M1  适配器    →  ctx.llm 注册 monk-official 路由
│   ├── monk-router    M2  策略      →  agent/request 瀑布事件上选模型
│   ├── monk-usage     M3  账本      →  session/event 上计量 + 工具 + 命令
│   ├── monk-ui-brand  M5  品牌      →  侧边栏品牌槽位 + ctx.theme 令牌覆盖
│   └── monk-bundle    M4  组合包    →  cordis.patch.yml + profile + 启动自检
```

### M1 `monk-llm` —— 模型适配器

**职责**：把 Monk 的三个模型注册为 dsh 的一个提供方路由，独占 wire 协议的复杂度。

| 文件 | 职责 |
|---|---|
| `catalog.ts` | 模型目录、`tier` 分类（quality / fast / coding）、目录校验 |
| `wire.ts` | OpenAI 兼容协议的最小无损类型投影（只有类型，没有行为） |
| `serialize.ts` | dsh 中立消息词汇 → wire 请求体。**唯一**理解双方词汇的地方 |
| `sse.ts` | SSE 分帧，零依赖，可脱离 dsh 单测 |
| `translate.ts` | wire 增量流 → 中立 `StreamChunk`。有状态 |
| `adapter.ts` | `MonkAdapter`，编排 + 失败分类 + 空闲看门狗 |
| `index.ts` | 插件入口：注册路由、注册 `monk` 服务、挂设置段落 |

**三条必须遵守的适配器契约**（dsh 用两个真实实现验证过的约定）：

1. `usage` 必须在 `finish` **之前**发出，`finish` 之后**不再发出任何内容**。Monk 可能在末尾单独发一个只含 usage 的分片，因此 `translate.ts` 把 finish/usage 缓冲到流结束标记再统一 flush。
2. 工具调用的 `arguments` 全程是**原始 JSON 字符串**，流式片段走 `argumentsDelta`。分片只给增量，翻译器拼接后整体发出。
3. 块 `index` 按**首次出现**的流顺序分配，同一块的每次增量复用该 index。

**失败分两条合法路径**（按故障类别选择，不混用）：

| 类别 | 路径 | 例子 |
|---|---|---|
| 传输与协议故障 | 从 `stream()` **抛出** `LlmError`（带稳定 code） | 网络不可达 → `TRANSPORT_ERROR`；响应体不是 JSON → `PROTOCOL_ERROR`；401/403 → `INVALID_CREDENTIAL`；429 → `RATE_LIMIT`；5xx → `PROVIDER_UNAVAILABLE` |
| 提供方带内故障 | 以 `finish { kind: 'error' }` 结束流 | 流中途收到 `event: error`；空闲超时 → `STREAM_IDLE_TIMEOUT` |

这条区分不是洁癖：抛出的失败**没有产出可提交的内容**，而带内失败**已经产出的内容必须保留**。空闲看门狗因此选择带内路径——它中断的是"等待"，不是"结果"。

### M2 `monk-router` —— 任务分类与选路策略

**职责**：把 monk.party 的"三个模型各管一摊"变成**自动**行为。

- **观察**（`session/event`，只读）：累积每个会话出现过的工具名、assistant 消息数、当前轮次。
- **分类**（纯函数 `classifyTask`）：命中编码工具 → `coding`；对话变长 → `deep`；否则 → `chat`。
- **决策**（`agent/request` 瀑布事件）：把分类映射到目录分层，改写 `model` 与 `reasoningEffort`。

**两个关键设计决定**：

**① 轮次内粘滞。** `agent/request` 每个**步骤**都触发，一个轮次可能有多个步骤（模型请求 → 工具调用 → 再请求）。若每步重新选路，同一轮次内可能从 `monk-fast` 切到 `monk-coding`，后果是：

- 请求前缀变化**击穿 KV 缓存**，本已复用的前缀 token 全部重算——直接违背"更便宜"的产品承诺；
- agent loop 会把配置变化记录成新的 `request/header`，历史被切成两段，回放与遥测都要多背一份头；
- 同一轮次内模型自我认知不稳定，工具调用风格漂移。

因此策略在**轮次边界**决策，轮次内保持粘滞。这不是优化，是正确性要求。

**② 路由隔离。** 只有 `resolved.provider === 'monk-official'` 时才改写。其它提供方的请求原样透传，因此 monk-harness 与原有 `deepseek-official` **并存**，用户随时切换，不必卸载插件。

### M3 `monk-usage` —— 订阅计量

**职责**：回答"这个月还剩多少"。

- **计量**：观察 `session/event` 的 `assistant/message`，把每步的 `usage` 折进 `UsageLedger`。事实来自**会话日志**而非本地计数器，因此进程重启后重放日志即可复算到相同数值。
- **面向模型的工具** `monk_usage`：让模型自己知道剩余额度，从而在接近上限时主动收敛输出长度，而不是等到被拒绝。
- **面向人的命令** `/monk`：无需模型轮次即可查看用量与订阅规格。

**一个容易搞错的细节**：dsh 的 `TokenUsage` 计数是**互斥**的 —— `inputTokens` 只计未命中缓存的输入，缓存命中单独记在 `cacheReadTokens`。账单关心总吞吐，因此账本统一用 `billedInput = inputTokens + cacheReadTokens + cacheWriteTokens`，同时把**缓存命中率**单独暴露 —— 那才是"省了多少钱"的证据。

### M4 `monk-bundle` —— 组合包与发行

**职责**：把 M1–M3 组装成一个可启动的 profile。

- `cordis.patch.yml` —— 一层 patch，叠加在 `dsh-base` 之上：插入三行 Monk 模块，覆盖 `agent-default-model`（指向 `monk`）与 `system-prompt`（写入 Monk 产品人格）。
- `profile/package.json` —— `monk` profile 模板，声明有序组合包列表。
- `src/index.ts` —— 运行时胶水：**启动自检**。

**为什么需要自检**：配置错位在 dsh 里是**静默**的。patch 按 id 定位，找不到目标 id 的行会被忽略；把 `agent-default-model` 写成别的 provider 也不会报错，只会在用户发第一条消息时以 `NO_ADAPTER` 失败。自检把这个失败提前到进程启动的第一秒，并把"该怎么修"直接写进日志。

### M5 `monk-ui-brand` —— 界面品牌

**职责**：让 Web 界面呈现 Monk 的身份，而不 fork 前端。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 宿主侧：空 `apply()`，只为让 Loader 有一行可扫描、把客户端半边投递到浏览器 |
| `src/client/index.js` | 浏览器半边：品牌槽位注册 + 样式注入 + 主题令牌覆盖 |
| `scripts/build-client.mjs` | 把客户端半边打成 `window.__ModuleLoader__.load({ id, factory })` 惰性工厂 |

**两条接缝，各自解决一半问题**：

| 想要的效果 | 用的接缝 | 为什么不是另一种 |
|---|---|---|
| 侧边栏出现 Monk 标志与字标 | `sidebar.brand.mark` / `sidebar.brand.name` 槽位 | 这对槽位是 dsh 明确留给"部署方替换外壳兜底"的，改它是**被设计支持**的用法，不是侵入 |
| 全站强调色变成 monk.party 的橙 | `ctx.theme.overrideTokens(source, tokens)` | `ctx.theme.register()` 会多出一个要用户手动切换的主题；叠加层让 light / dark / system 三种偏好下强调色都跟着走 |

**single 槽位的遮蔽语义**：`sidebar.brand.*` 是 `single` 槽位——两个占用者不是并排而是**互相遮蔽**，谁赢取决于插件激活顺序。那不是一个可以依赖的顺序，所以补丁层显式 `disabled: true` 官方品牌行，而不是与它抢。

**浏览器标题是绕过硬编码常量的权宜做法**：外壳把 `productTitle: "DeepSeek Harness"` 硬编码在 `dsh-client-ui-layout` 里，既没有配置项也没有槽位。标签页是界面身份的一部分，所以本包用 `MutationObserver` 观察 `<title>` 并只替换**以产品名结尾**的那一段（会话标题是用户内容，用户完全可能把它命名成含产品名的字样，用 `includes` 会改到用户自己写的那段）。改写自身会再触发一次回调，但那时标题已不再以产品名结尾，不会自激。**这不是接缝**——上游若把 `productTitle` 变成可配置项，这段应当整个删掉。

**为什么客户端半边是 JS 而不是 TS**：槽位类型住在 `@deepseek-ai/dsh-client-ui-slots`，那是 dsh 内部的**虚拟模块**——只以类型再导出的形式出现在 `dsh-client-ui-renderer` 里，不作为独立包发布，从本包无法解析。硬写一份本地 shim 会让类型在两侧各说一套，比不做更糟。宿主半边仍是完整 TS；客户端半边由构建脚本打包、由测试校验产物结构（模块 id、无残留 ESM 语句、令牌两态齐全、SVG 几何）。

**构建脚本为什么做受校验的定点改写**：官方 bundle 由 tsdown 产出，本包没有那条工具链。与其手写产物（会与源码漂移），不如每次构建重新生成——两处改写（`react/jsx-runtime` 导入转 `require`、具名导出转 `exports.*`）任一处不匹配即失败退出。工厂体**原样嵌入、不逐行缩进**：缩进会连带改写模板字符串的内容，把"代码排版"变成"改数据"。

---

## 3. 接口设计

### 3.1 对内：Cordis 插件契约

每个包都是标准 Cordis 插件，四个导出：

```ts
export const name = 'monk-llm'      // 插件名
export const inject = ['llm']        // 依赖的 ctx 键；未满足时不激活
export const Config: z<Config> = ... // schemastery schema，同时是设置段落形状
export function apply(ctx: Context, config: Config): void
```

**所有注册都是副作用**：卸载插件即撤销。这是"无特权内核"的具体体现，也是热重载安全的前提。

### 3.2 M1 → dsh 核心：LLM seam

| 接口 | 方向 | 说明 |
|---|---|---|
| `ctx.llm.registerAdapter(['monk-official'], adapter)` | M1 → core | 注册路由。返回 `AdapterRegistrationHandle`：可 dispose，也可 `replace()` 原子换路由 |
| `ctx.llm.registerConfigurableProviders([...])` | M1 → core | 让 Web 的 Models 页面自动出现 Monk 条目 |
| `LlmAdapter.stream(options)` | core → M1 | **唯一必需**方法。返回 `AsyncIterable<StreamChunk>` |
| `LlmAdapter.resolveModel(provider, model, signal)` | core → M1 | 精确模型元数据：上下文容量、默认输出上限、推理强度列表 |
| `LlmAdapter.listModels(provider)` | core → M1 | 建议性目录。**缺失不等于请求会被拒绝** |
| `LlmAdapter.prepareCall(...)` | core → M1 | 动态适配器覆写点：绑定**一代**配置的元数据与分派入口 |

**`prepareCall` 为什么必须覆写**：模型元数据解析与最终分派若来自两次独立的配置读取，一次设置变更就可能把 A 代的上下文容量与 B 代的端点拼在一起。`MonkAdapter` 用同一次 `resolve()` 结果构造两者。

### 3.3 M1 → M2：目录接缝

M2 不该复制一份模型表。M1 通过 `ctx.provide('monk', service)` 暴露：

```ts
interface MonkService {
  readonly provider: string
  catalog(): readonly MonkCatalogModel[]
  resolveTier(tier: MonkTier): string | undefined
}
```

用户在设置里换了模型 id，路由立刻跟着变，无需两处同步。**这是 seam 三角的完整落地**：M1 是 Provider，M2 是 Consumer，`MonkService` 是 Definition。

### 3.4 凭据与设置

| 接口 | 说明 |
|---|---|
| `ctx.credentials.resolve(ref)` | 按**请求**解析密钥。轮换后的密钥在紧接着的下一次请求生效，而正在飞行的流保留启动时的事实 |
| `ctx.settings.installSection(ctx, NS, Config, config, { setSource, onChange })` | 把 `monk-llm:` 段落挂到用户设置文档上，热重载 |
| 环境变量 `MONK_API_KEY` / `MONK_BASE_URL` | 无 credentials seam 时的回退平面；`baseURL` 只在受信环境层生效 |

**密钥与端点属于同一份快照**，一起解析、一起拒绝。被拒的设置世代无法把它的密钥泄漏到上一代的端点上。

**重试策略是唯一例外**：它在注册时被注册表快照，无法按请求刷新。变更时用 `registration.replace()` **原地**替换路由 —— 不做 dispose + 重新注册，因为那会在两步之间发布一个空路由集，让观察者看到提供方"消失又回来"。

### 3.5 M2 → agent loop：请求瀑布

```ts
ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
  const resolved = await next()          // 先委托，才能拿到 loop 已解析的配置
  if (resolved.provider !== monk.provider) return resolved   // 路由隔离
  return { ...resolved, model: decision.model, reasoningEffort: decision.reasoningEffort }
})
```

`agent/request` 是 **waterfall** 事件，监听器必须调用 `next()` 才能委托下去。改写 `model` 会被 loop 记录为一次 `request/header` 变化 —— 这正是我们想要的：历史里能看到"这一轮换了模型"，回放与遥测因此保持可解释。

### 3.6 M3 → 模型与用户：工具与命令

```ts
ctx.tools.register(defineTool({
  name: 'monk_usage',
  description: '...',                    // 模型看到的说明
  parameters: { scope: { type: 'string', enum: ['month', 'session'] } },
  output: {
    schema: { /* 规范 JSON 值 */ },       // 程序化 API：PTC mode 下可直接调用
    render: (_args, value) => [{ type: 'text', text: ... }],  // 模型可见文本
  },
  execute(args, exec) { /* ... */ },
}))
```

两条 dsh 工具约定被显式遵守：

- **`output.schema` 是实用的程序化 API**：返回结构化字段（`calls` / `billedInputTokens` / `cacheHitPercent` / `quota`），而不是让调用方从自然语言里解析数字。在 PTC mode 下模型可以直接 `await tools.monk_usage({scope:'month'})` 拿到这个值。
- **UI 格式不进入模型结果**：人类可读的摘要由 `render` 负责，工具主体只返回规范值。

```ts
ctx.commands.register({
  name: 'monk',
  description: '查看 Monk 订阅用量与当前模型路由',
  handler: invocation => ({ kind: 'success', text: '...' }),
})
```

命令**不经过模型轮次**即可分派，因此查看用量不会消耗额度 —— 对一个月度订阅制产品，这是必要的。

### 3.7 M4 → 启动器：组合包与 Profile

两个 manifest 声明，都在 `package.json` 里：

```jsonc
// 组合包：我导出一层 patch
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }

// profile：我按这个顺序叠加组合包
"dsh": { "profile": { "bundles": [...], "patchReload": "live" } }
```

**层的应用顺序**（在空条目列表之上）：

```
dsh-base 的 patch  →  dsh-web-app 的 patch  →  @monk/monk-bundle 的 patch
                   →  profile 的 cordis.patch.yml（用户层）
                   →  --patch overlay（命令行）
```

后写者胜，逐行替换。因此 **monk-bundle 不设"不可变默认"** —— 用户的 profile 层永远能覆盖它。

---

## 4. 与现有系统的集成方式

### 4.1 集成路径：树外插件（推荐，也是本实现采用的方式）

monk-harness **不进 dsh 仓库**，作为独立 npm 包集发布，通过 dsh 的 profile 插件机制挂载：

```sh
# 一次性：把 monk profile 建起来
mkdir -p "$DSH_HOME/profiles/monk"
cp packages/monk-bundle/profile/package.json "$DSH_HOME/profiles/monk/"
cp packages/monk-bundle/profile/cordis.patch.yml "$DSH_HOME/profiles/monk/"

# 装插件（dsh plugin 是 pnpm 的薄转发器，之后按已安装状态回填 bundles 列表）
dsh plugin --profile monk add @monk/monk-bundle @monk/monk-llm @monk/monk-router @monk/monk-usage

# 起服务
dsh --profile monk
```

`dsh plugin` 的**回填语义**值得注意：它按**已安装状态**而不是依赖差异来调和 `dsh.profile.bundles`。因此 `update` 会激活一个在新版本里才获得 `dsh.bundle` 声明的包 —— 我们后续把某个模块拆成独立 bundle 时，用户升级即可生效，不必改配置。

### 4.2 集成点清单

| 集成点 | 机制 | 我方需要做什么 |
|---|---|---|
| 模型提供方 | `ctx.llm` seam | 注册适配器 + 可配置提供方条目 |
| 请求路由 | `agent/request` waterfall | 监听并改写 `LlmCallConfig` |
| 会话事实 | `session/event` emit | 只读观察，累积事实 |
| 面向模型的能力 | `ctx.tools` | `defineTool` 注册，schema 自动进入提示词组装 |
| 面向人的入口 | `ctx.commands` | 注册 `/monk`，不经模型轮次 |
| 密钥 | `ctx.credentials` | 按请求解析引用 |
| 用户设置 | `ctx.settings` | 安装 `monk-llm:` 段落，热重载 |
| Web UI | `registerConfigurableProviders` | Models 页面自动出现 Monk 条目 |
| 启动 | `dsh.profile.bundles` | 声明有序层列表 |
| 分发 | `dsh.bundle.patch` | 导出一层 patch |

### 4.3 与已有提供方共存

关键约束：**路由键必须唯一**。dsh 的注册表规定"每个提供方路由仅对应一个适配器，重复注册会抛出异常"。

- Monk 使用 `monk-official`，与 `deepseek-official` 天然不冲突；
- `monk-router` 显式做路由隔离，不碰别的提供方；
- 用户在 Web 的 Models 页面可以在两者之间切换，也可以让某个 agent preset 固定用其中一个。

因此 **monk-harness 是叠加而不是替换**。用户可以只把 Monk 当"便宜的那一档"日常用，复杂任务切回旗舰 —— 这正是 monk.party 的定位。

### 4.4 传输无关性

因为所有能力都挂在 `ctx.*` 服务上，而不是挂在某个 UI 上，**同一套插件在四个 profile 里都成立**：

| profile | 表面 | Monk 模块的可用性 |
|---|---|---|
| `monk`（= base + web-app + monk-bundle） | 浏览器 UI | 全部 |
| `headless` | 一次性运行器 | 全部（无 Web 卡片） |
| `sdk` | JSON-RPC 服务器 | 全部（`monk_usage` 通过 SDK 可调用） |
| `acp` | 编辑器集成 | 全部 |

这不是额外工作，而是"扩展点选对了"的副产品。

### 4.5 部署方需要提供的三样东西

1. **`MONK_API_KEY`** —— 或通过 Web 的 Models 页面写入受管凭据存储（不会物化进进程环境）。
2. **`MONK_BASE_URL`（可选）** —— 只在受信环境层生效。用于自建网关或区域端点。优先级：显式 `baseURL` 配置 > `$MONK_BASE_URL` > 公开端点；空白值视为未设置。
3. **额度规格（可选）** —— `monk-usage` 的 `plan.inputTokensLimit`。**不配也能跑**，只是 `/monk` 报"不限量"而不是报百分比。默认不猜额度数字，因为猜错比不报更糟。

### 4.6 一个必须知道的优先级陷阱：设置区盖过补丁层

这是把 monk-harness 装进**已有** dsh 环境时最容易踩的坑，且它不报错——只是静默失效。

`agent-default-model` 同时存在于两个地方，优先级相反于直觉：

```
可运行时改写的设置区（~/.dsh/settings.yaml）   ← 更高
> 组合包的补丁层（cordis.patch.yml）           ← 更低
```

也就是说：**如果用户的 `settings.yaml` 里已经选过任何模型**（哪怕只是从 Models 页面点过一次），组合包把 `agent-default-model` 覆写成 `monk-official` / `monk` 这件事就会被完全盖掉。`--dump-config` 仍然会显示 `provider: monk-official`——因为 dump 的是补丁层组合结果，不含运行时设置——但真正发出去的请求用的是设置区里那个提供方。

这个陷阱的代价是双向的：既可能"以为在测 Monk、其实没测"，也可能"以为装上了、其实没生效"。

判断与规避：

```sh
# 看补丁层组合结果（不含设置区）
dsh --profile monk --dump-config | grep -A3 'id: agent-default-model'

# 看真正生效的选择
cat ~/.dsh/settings.yaml | grep -A3 'agent-default-model'
```

- 想让 Monk 成为**默认**：在 Models 页面选中它，或改 `settings.yaml` 的 `agent-default-model`。**不要**只改补丁层。
- 想验证组合包自身的行为：用一个干净的 `DSH_HOME`，让设置区回到"未选择"状态，兜底默认值才会显形。`scripts/e2e-smoke.sh` 就是这么做的。
- 不想动默认值：`monk-official` 仍然可以作为**可选**提供方存在，用户随时切换。这正是 §4.3 说的"叠加而非替换"。

---

## 5. 已知限制与后续工作

诚实地列出当前实现的边界：

| 项 | 现状 | 影响 | 后续 |
|---|---|---|---|
| **非流式调用** | 未实现，`stream` 恒为真 | 只影响嵌入方；dsh 的 agent loop 本来就只用流式 | 需要时补一个 `stream:false` 分支，但 usage 契约要重新推导 |
| **图片输入** | `MonkAdapter` 接受 `resolveImages` 回调；未注入时图片投影为 `[image: unresolved]` 占位 | 多模态能力受限于调用方 | 接 `ctx.attachments` seam，复用 `resolveImageAttachmentAccess` |
| **`thinking` 开关** | 只暴露 `reasoningEffort`，未暴露"关闭思考" | 无法强制关闭推理 | 视 monk.party 是否暴露该参数而定 |
| **额度上限** | 需要部署方手工配置 | 默认只报绝对值不报百分比 | 若 monk.party 提供 `/usage` 端点，可改为自动拉取 |
| **`replayState`** | 只带 `id` 与 `finishReason` | 跨模型回放未验证 | Monk 若要求签名或响应 ID 才能续写，需要扩展该投影 |
| **自检的 `agentDefaultModel`** | 通过 `ctx.get('agentDefaultModel')?.current?.()` 读取 | 该服务的读取接口若变更，自检会静默跳过默认模型检查（不报错） | 收紧为显式类型依赖 |

### 5.1 已在本机端到端验证的事实

以上是设计边界；以下是**实测**跑通的链路，不是纸面推导。`scripts/e2e-smoke.sh` 可复现：它在本地起一个 OpenAI 兼容 mock，用干净的 `DSH_HOME` 跑一次真实 agent 回合。

| 事实 | 证据 |
|---|---|
| 请求确实走 `monk-official` 路由 | 会话日志 `request/header.config.provider = "monk-official"` |
| 路由器按任务类型选路 | 闲聊被判为 `chat` → `model: "monk-fast"`、`reasoningEffort: "low"` |
| 目录上限被适配器填充 | `request/header.config.maxTokens = 64000`，且 `adapterDefaults.maxTokens = true` |
| 凭据从受信环境层解析 | mock 收到 `authorization: Bearer sk-mock-key` |
| 工具注册完整 | 27 个工具，含本包提供的 `monk_usage` |
| 流式契约成立 | `stream: true` + `stream_options.include_usage: true`，SSE 回包被翻译并打印 |
| 未缓存输入与缓存读取是**不相交**计数 | mock 发 `prompt_tokens: 1000` / `cached_tokens: 768`，会话日志落 `inputTokens: 232` + `cacheReadTokens: 768` |
| Monk 人格注入 | `request/header.system` 含 Monk 段，mock 日志可查 |
| 非 agent 请求也走同一路由 | 会话标题生成请求同样落到 `monk-fast` |
| 品牌模块被投递到浏览器 | 服务端 index 的组合脚本 URL 含 `@monk/monk-ui-brand/client.js`；抓取该 URL 返回的 3.7MB 组合体里能找到 `id: "@monk/monk-ui-brand"` |
| 官方品牌行被替换而非争抢 | `--dump-config` 显示 `ui-brand-official` 为 `disabled: true`，`monk-ui-brand` 为新增行；index 里已无 `ui-brand-official` |
| 品牌补丁对 headless 无害 | `monk-headless` 组合与启动均正常——覆盖不存在的 id 是空操作 |

自动化测试：**85 项全通过**（SSE 分帧 15、适配器端到端 6、路由策略 16、用量账本 17、配置解析 12、界面品牌 19），五个包 `tsc --noEmit` **零错误**。

---

## 6. 参考

- dsh 架构：`docs/architecture.zh.md`（profile 与组合包、轮次流程、会话日志、能力 seam）
- dsh 适配器实操手册：`docs/cookbook/adding-an-llm-adapter.zh.md`
- dsh 工具编写参考：`docs/cookbook/adding-a-tool.zh.md`
- dsh 能力 seam 全图：`docs/capability-seams.zh.md`
- Cordis 设计论文：*A Programming Paradigm for Spatiotemporal Composability*
