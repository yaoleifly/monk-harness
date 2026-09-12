# Monk Harness

建立在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件框架之上的 agent harness 发行版，默认使用 [Monk](https://monk.party/) 融合模型 API。

装上就有一个浏览器 Agent：默认走 Monk，按任务自动在 `monk` / `monk-fast` / `monk-coding` 之间选路，随时告诉你这个月的额度还剩多少。

**不 fork、不修改 dsh 任何一行代码** —— 全部通过 dsh 的树外插件机制挂载。

## 模块

| 包 | 角色 | 挂在哪 |
|---|---|---|
| [`@monk/monk-llm`](packages/monk-llm) | 模型适配器 | `ctx.llm` 注册 `monk-official` 路由 |
| [`@monk/monk-router`](packages/monk-router) | 选路策略 | `agent/request` 瀑布事件 |
| [`@monk/monk-usage`](packages/monk-usage) | 订阅计量 | `session/event` + `monk_usage` 工具 + `/monk` 命令 |
| [`@monk/monk-ui-brand`](packages/monk-ui-brand) | 界面品牌 | 侧栏 `sidebar.brand.*` + 首屏 `conversation.hero.brand.mark` 槽位 + `ctx.theme` 令牌覆盖 |
| [`@monk/monk-llm-ui`](packages/monk-llm-ui) | 密钥卡片 | Models 设置页 `settings.models.provider-card` 槽位 |
| [`@monk/monk-bundle`](packages/monk-bundle) | 组合包 | `cordis.patch.yml` + `monk` profile + 启动自检 |

设计说明见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 快速开始

### ⚡ 极简一键安装

在终端直接运行：

```sh
curl -fsSL yaoleifly.github.io/monk-harness | bash
```

一条命令自动完成仓库克隆、依赖构建与 Profile 挂载！

### 🛠️ 手写/源码构建安装

# 2. 建立 monk profile
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME/profiles/monk"
cp packages/monk-bundle/profile/package.json "$DSH_HOME/profiles/monk/"
cp packages/monk-bundle/profile/cordis.patch.yml "$DSH_HOME/profiles/monk/"

# 3. 挂载插件（dsh plugin 是 pnpm 的薄转发器）
dsh plugin --profile monk add \
  ./packages/monk-bundle ./packages/monk-llm ./packages/monk-llm-ui \
  ./packages/monk-router ./packages/monk-usage ./packages/monk-ui-brand \
  dshmarket

# 4. 配密钥
export MONK_API_KEY="sk-..."      # 或经 Web 的 Models 页面写入受管凭据存储

# 5. 启动
dsh --profile monk
```

浏览器打开 `http://127.0.0.1:3080`。

> 想少打字就直接跑 `bash scripts/install-into-dsh.sh`——它做同样的事，外加启动自检（确认 monk 行都在、官方品牌行已禁用、密钥卡片的浏览器半边可被解析）。

> **⚠️ 装在已有 dsh 环境上时，先看这一条。**
>
> `agent-default-model` 在**设置区**（`~/.dsh/settings.yaml`，可从 Models 页面改写）里也有一份，而设置区**优先于**组合包的补丁层。如果你之前已经在 Models 页面选过任何模型，组合包把默认值设成 Monk 这件事会被静默盖掉 —— `--dump-config` 照旧显示 `monk-official`，但实际请求用的是设置区里那个提供方。
>
> 想让 Monk 真正成为默认，请改 `settings.yaml` 或在 Models 页面选中它，而不是只改 profile 的 `cordis.patch.yml`。详见 [docs/ARCHITECTURE.md §4.6](docs/ARCHITECTURE.md)。

## 它替你做了什么

**自动选路。** 你不用记哪个模型该用在哪儿：

| 会话里发生了什么 | 选中的模型 | 推理强度 |
|---|---|---|
| 日常对话、问答、轻量改写 | `monk-fast` | low |
| 出现编辑文件 / 执行命令 / 检索代码 | `monk-coding` | medium |
| 长对话或复杂推理（12 条 assistant 消息 / 8 轮以上） | `monk` | high |

决策在**轮次边界**做，轮次内保持粘滞 —— 中途换模型会击穿 KV 缓存，把本已复用的前缀 token 全部重算，直接违背"更便宜"的承诺。

**用量可见与系统诊断。** 会话里直接问，或使用 `/monk` 命令行套件：

```
$ /monk          # 查看订阅用量与本会话 Token 统计
$ /monk status   # 查看当前会话的模型选路依据与路由状态（如触发了什么工具、推理强度等）
$ /monk doctor   # 运行系统自检（检查路由注册、模型目录、默认设置、API Key 配置）
$ /monk plan     # 查看订阅规格与额度阈值
$ /monk help     # 查看指令帮助
```

模型也能自己查 —— `monk_usage` 工具让它知道剩余额度，从而主动收敛输出长度，而不是等被拒绝。

**默认集成插件市场。** profile 默认搭载 [dshmarket](https://dshmk.com/)，可在 Web 界面左下角/设置区直接浏览、检索与一键安装社区生态插件。

**启动自检。** 配置错位在 dsh 里是静默的（patch 按 id 定位，找不到就忽略）。自检把它提前到进程启动的第一秒，并把修法写进日志。

## 界面品牌

界面按 [monk.party](https://monk.party/) 的视觉身份重新品牌化，不需要 fork 前端：

- **侧边栏标志与字标** —— 占住 `sidebar.brand.mark` / `sidebar.brand.name` 两个槽位（dsh 明确把这对槽位留给"部署方替换外壳兜底"），渲染 monk.party 的僧侣标志（光环 + 头部 + 双袖 + 核心 + 火花，含原站的动画）与 `Monk · Flash Fusion` 字标。
- **首屏标志与标题** —— 占住 `conversation.hero.brand.mark`（官方文档写明这个槽位在**所有构建中都保持无填充**，首屏那条动画鱼是声明包自己的兜底，所以注册即接管），把标题换成 `天下武功，唯快不破`，并移除隐藏原有的 `预览版` 徽标。
- **强调色** —— 通过 `ctx.theme.overrideTokens` 在**活动主题之上**叠一层令牌覆盖，把 `--dsw-alias-brand-primary` / `--dsw-alias-brand-text` 换成 monk.party 的橙（`#EA580C` 亮色 / `#F97316` 暗色）。
- **浏览器标题** —— 把 `DeepSeek Harness` 换成 `Monk`（保留会话标题前缀）。这一条**不是接缝**：外壳把产品名硬编码在 `dsh-client-ui-layout` 里，既没有配置项也没有槽位，本包只能观察 `<title>` 做受控改写；上游一旦让它可配置就应把这段整个删掉。

首屏标题**没有槽位可占**：`hero.headline` / `hero.preview` 是 locale 字典里的键，而字典是**单一所有者**的——`locale.register` 对同一 `(namespace, locale)` 直接抛错，且没有覆盖 API。所以它和浏览器标题一样是受控改写：按 CSS Module 的**局部名**（`headlineText` / `previewBadge`，不是产物里那个会随内容变化的哈希前缀）定位节点，且只在当前文本**正好是外壳原文**时才动手。上游重命名那个类、或者换/加了一种语言的文案，改写会**静默**失效——一条跨包测试钉住了这两件事，改名就会变红。

改动 DOM 文本时用的是 `firstChild.nodeValue` 而不是 `textContent`：React 的 fiber 里存着那个文本节点的引用，换成新节点的话，此后 React 每次更新都在改一个已脱离文档的节点，界面会永远停在旧值。

为什么用 `overrideTokens` 而不是 `register`：注册主题会多出一个要用户手动切换的选项；叠加层则让用户无论选 light、dark 还是 system，强调色都跟着走。

官方品牌行 `ui-brand-official` 在补丁层被显式 `disabled`，而不是与它抢同一个槽位——`sidebar.brand.*` 是 **single** 槽位，两个占用者不是并排而是互相遮蔽，谁赢取决于插件激活顺序。

配色来源是实测的，不是猜的：`monk.party/assets/app.css` 与 `monk.party/monk-logo.svg`。

## 自定义

改 `$DSH_HOME/profiles/monk/cordis.patch.yml`，保存即热重载（profile 的 `patchReload: live`）：

```yaml
# 换个默认模型
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: monk-official
    model: monk-coding

# 关掉自动路由
- id: monk-router
  name: '@monk/monk-router'
  config:
    enabled: false

# 加上月度额度，让 /monk 能报百分比
- id: monk-usage
  name: '@monk/monk-usage'
  config:
    plan:
      name: Monk 月度订阅
      priceCny: 30
      inputTokensLimit: 50000000
```

**patch 是替换不是合并** —— 覆盖某一行时必须把它的完整 `config` 重述一遍。

想看组装后的完整插件树：

```sh
dsh --profile monk --dump-config
```

## 与其它提供方共存

Monk 使用独立路由键 `monk-official`，与 `deepseek-official` 不冲突。`monk-router` 只在 `provider === 'monk-official'` 时改写请求，其它提供方原样透传。

所以你可以把 Monk 当"便宜的那一档"日常用，复杂任务在 Web 的 Models 页面切回旗舰 —— 不用卸载任何东西。

## 本地验证

不需要 Monk 订阅就能验证整条链路。脚本会起一个本地 OpenAI 兼容 mock，用一个干净的 `DSH_HOME` 跑一次真实 agent 回合，然后把 mock 收到的请求逐条打出来：

```sh
bash scripts/e2e-smoke.sh          # 默认端口 7788
```

干净 `DSH_HOME` 是必需的，不是图省事：只有设置区回到"未选择"状态，组合包里的兜底默认值才会显形（原因见上面的 ⚠️）。

跑通后你会看到：请求发往 `monk-official`、闲聊被选到 `monk-fast`、27 个工具（含 `monk_usage`）随请求上行、`authorization` 头带上密钥。

测试与类型检查：

```sh
node --test 'packages/*/tests/*.spec.ts'   # 131 项
pnpm -r typecheck
```

## License

MIT
