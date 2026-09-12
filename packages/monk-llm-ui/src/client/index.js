/**
 * Monk 密钥卡片的客户端半边（浏览器）。
 *
 * ## 为什么需要这个包
 *
 * Models 设置页的手写编辑器只认两个设置命名空间：`llm-deepseek` 与
 * `llm-pi-ai`（`layoutOf()` 里写死）。任何其它命名空间都落到
 * `layout: "unknown"`——编辑器只渲染一句"其余字段在 settings.yaml 中"，
 * 并把「保存」置灰。也就是说，第三方适配器家族**在 Models 页里根本拿不到
 * 密钥输入框**。
 *
 * dsh 为此留了正式接缝：`settings.models.provider-card` 是一个按
 * `settingsNs` 分键的槽位，文档原话是"以某适配器家族的 namespace 注册一次
 * 即可收到该家族的全部卡片，含手工声明的路由"。本模块就是它的一个占用者，
 * 键为 `monk-llm`（即 `@monk/monk-llm` 的设置命名空间）。
 *
 * ## 为什么是 JS 而不是 TS
 *
 * 要注册的槽位类型住在 `@deepseek-ai/dsh-client-ui-slots`，而那是 dsh 内部的
 * **虚拟模块**——只以类型再导出的形式出现在 `dsh-client-ui-renderer` 里，
 * 不作为独立包发布，因此无法从本包解析。硬写一份本地 shim 会让类型在两侧
 * 各说一套，比不做更糟。宿主半边仍是完整 TS；这一半由
 * `scripts/build-client.mjs` 打包，并由 `tests/card.spec.ts` 校验产物结构。
 *
 * ## 运行时契约（逐项来自官方实现，不是猜的）
 *
 * - 槽位分发：`renderSlot('settings.models.provider-card', ownerProps, { entryKey })`，
 *   `entryKey` 取 `ProviderDirectoryEntry.settingsNs`；owner props 是
 *   `{ provider, configured, keyConfigured }`。
 * - 注入面：root 作用域的条目以 `inject()`（**无参**）求值一次并缓存，
 *   返回值与 owner props 一起摊平进组件 props，**owner 胜**。
 * - 声明 `locale` 的条目会额外拿到 `t`（由 locale 面按命名空间绑定）。
 * - 密钥校验与宿主侧 `normalizeApiKey`（`@deepseek-ai/dsh-llm`）互为镜像：
 *   去空白后非空，且每个字符都在 `[\x21-\x7E]` 内。客户端包只引用客户端包，
 *   所以这条字符集规则在这里复刻而不是导入。
 *
 * 本文件是 ESM 源；构建脚本把下面两条 `import` 改写为工厂的 `require`。
 */

import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'

/** 浏览器模块 id，必须等于包名（模块图按包名寻址）。 */
const PACKAGE_ID = '@monk/monk-llm-ui'

/**
 * 本包认领的槽位。
 * @see https://github.com/deepseek-ai/deepseek-harness —— `dsh-client-ui-settings-models` 的 slot-contract
 */
const SLOT = 'settings.models.provider-card'

/** 本包认领的槽位键，必须等于 `@monk/monk-llm` 的 `SETTINGS_NS`。 */
const SETTINGS_NS = 'monk-llm'

/** 本包提供方路由键，必须等于 `@monk/monk-llm` 的 `MONK_PROVIDER`。 */
const PROVIDER = 'monk-official'

/**
 * 缺省凭据引用，必须等于 `@monk/monk-llm` 的 `DEFAULT_API_KEY_ENV`。
 *
 * 只在读不到设置区时兜底：正常路径下引用从设置区解析，因此部署方把
 * `apiKeyEnv` 改成别的名字时，这里跟着走而不是各说一套。
 */
const DEFAULT_API_KEY_ENV = 'MONK_API_KEY'

/** locale 命名空间。 */
const LOCALE_NS = 'monk-llm-ui'

/** 注入样式的元素 id；重复挂载时按它去重。 */
const STYLE_ELEMENT_ID = 'monk-llm-ui-styles'

/**
 * 合法的 API 密钥字符集：可打印 ASCII，不含空格。
 *
 * 与 `@deepseek-ai/dsh-llm` 的 `LEGAL_API_KEY` 逐字一致。越界的值根本进不了
 * HTTP 头（`fetch` 会拒绝构头），所以这是**传输层不变式**，不是某家提供方的
 * 策略——在这里拦住能给出解释，放过去只会换回一个不透明的 401。
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** 文案字典。键名同时被测试钉住，漏一个键会让卡片显示空白。 */
const zh = {
  keyLabel: 'API 密钥',
  keyPlaceholder: '粘贴 monk.party 提供的密钥',
  save: '保存',
  saving: '保存中…',
  saved: '已保存，下一次请求即生效。',
  keyRequired: '请填写密钥。',
  keyIllegalCharacters: '密钥格式不合法：不能含空格，且只能是可打印 ASCII 字符。',
  failed: '保存失败：{message}',
  hint: '只需填写 monk.party 提供的密钥（端点 https://monk.party/v1 与模型目录已内置）。含有 .edu 邮箱享 9 折优惠，已购买可前往 https://monk.party/account/ 查询 Key 与天数用量。',
  store: '以只写方式存为凭据引用 {ref}，不会写进 settings.yaml，也不会回显。',
  readOnly: '当前部署的凭据存储是只读的，无法在这里保存。',
  configured: '已配置',
  unconfigured: '尚未配置',
  fromEnvironment: '由启动环境提供',
}

const en = {
  keyLabel: 'API key',
  keyPlaceholder: 'Paste the key issued by monk.party',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved; the next request picks it up.',
  keyRequired: 'Enter a key.',
  keyIllegalCharacters: 'Not a valid key: no spaces, printable ASCII only.',
  failed: 'Could not save: {message}',
  hint: 'This is the only field you need (endpoint https://monk.party/v1 & catalog are built-in). .edu emails get 10% off; visit https://monk.party/account/ to look up keys.',
  store: 'Stored write-only as the credential reference {ref}; never written to settings.yaml and never echoed back.',
  readOnly: 'This deployment stores credentials read-only, so it cannot be saved here.',
  configured: 'Configured',
  unconfigured: 'Not configured',
  fromEnvironment: 'Supplied by the launching environment',
}

/**
 * 卡片样式。
 *
 * 所有选择器都带 `monk-key-` 前缀，不会碰到外壳自己的类名；配色沿用 dsh 的
 * `--dsw-alias-*` 语义令牌并带兜底值，因此在本包单独存在时也能渲染。
 */
const STYLES = `
.monk-key{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l4,#ebebeb);border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fafafa);font-family:Geist,Inter,system-ui,-apple-system,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.monk-key-head{align-items:center;gap:8px;display:flex}
.monk-key-label{color:var(--dsw-alias-label-primary,#171717);font-size:13px;font-weight:500;line-height:18px;letter-spacing:-0.28px}
.monk-key-dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.monk-key-dot-on{background:var(--dsw-alias-state-success-primary,#0070f3)}
.monk-key-dot-off{background:var(--dsw-alias-state-error-primary,#ee0000)}
.monk-key-state{color:var(--dsw-alias-label-tertiary,#888888);margin-left:auto;font-family:Geist Mono,ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:12px;line-height:16px}
.monk-key-row{align-items:center;gap:8px;display:flex}
.monk-key-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l4,#ebebeb);flex:1 1 0;min-width:0;height:32px;color:var(--dsw-alias-label-primary,#171717);font-family:Geist Mono,ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;background:var(--dsw-alias-bg-layer-1,#ffffff);border-radius:6px;padding:0 10px;font-size:13px;line-height:20px;transition:border-color .15s ease,box-shadow .15s ease}
.monk-key-input:focus{border-color:var(--dsw-alias-brand-primary,#ea580c);box-shadow:0 0 0 2px rgba(234,88,12,.15);outline:none}
.monk-key-input::placeholder{color:var(--dsw-alias-label-dimmed,#888888);font-family:Geist,Inter,system-ui,-apple-system,sans-serif}
.monk-key-input:disabled{opacity:.6;cursor:default}
.monk-key-save{box-sizing:border-box;height:32px;color:#ffffff;font-family:Geist,Inter,system-ui,-apple-system,sans-serif;font-weight:500;cursor:pointer;background:#171717;border:none;border-radius:100px;justify-content:center;align-items:center;padding:0 16px;font-size:13px;line-height:20px;display:inline-flex;transition:background-color .15s ease}
.monk-key-save:hover:not(:disabled){background:#333333}
.monk-key-save:disabled{opacity:.4;cursor:default}
.monk-key-save:focus-visible{box-shadow:0 0 0 2px #171717;outline:none}
.monk-key-hint,.monk-key-note,.monk-key-ok,.monk-key-error{margin:0;font-size:12px;line-height:18px}
.monk-key-hint{color:var(--dsw-alias-label-secondary,#4d4d4d)}
.monk-key-note{color:var(--dsw-alias-label-tertiary,#888888)}
.monk-key-ok{color:var(--dsw-alias-state-success-primary,#0070f3);font-weight:500}
.monk-key-error{color:var(--dsw-alias-state-error-primary,#ee0000);font-weight:500}
.monk-key-code{font-family:Geist Mono,ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:12px;padding:2px 5px;background:var(--dsw-alias-canvas-soft-2,#f5f5f5);border-radius:4px;overflow-wrap:anywhere}
`

/**
 * 挂载卡片样式表。
 *
 * 返回清理函数，交给 `ctx.effect` 持有，使插件卸载与 HMR 一并移除样式——
 * 与 ui-theme 对自己的样式表采用同一条约定。
 * @returns 移除本次注入样式的清理函数。
 */
function injectStyles() {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return () => {}
  const element = document.createElement('style')
  element.id = STYLE_ELEMENT_ID
  element.textContent = STYLES
  document.head.appendChild(element)
  return () => element.remove()
}

/**
 * 判断一枚键入的密钥是否可用。
 *
 * 与 `normalizeApiKey` 同规则：先去空白，再判字符集。返回**失败键名**而不是
 * 句子，让调用方去查文案——校验是纯逻辑，不该依赖 locale。
 * @param raw - 用户键入的原始文本。
 * @returns 文案键名；通过校验时返回 `undefined`。
 */
function apiKeyFailure(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length === 0) return 'keyRequired'
  return LEGAL_API_KEY.test(value) ? undefined : 'keyIllegalCharacters'
}

/**
 * 把 `{token}` 占位符替换成实参。
 *
 * 文案字典里只放字符串（locale 面的既有约定，官方页面同此），所以带变量的
 * 句子靠这一步拼接，而不是把函数塞进字典。
 * @param template - 含 `{token}` 的模板。
 * @param replacements - token 名到替换值的映射。
 * @returns 填充后的句子。
 */
function fill(template, replacements) {
  let out = template
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(`{${token}}`).join(value)
  }
  return out
}

/**
 * 从设置命名空间视图里读出该提供方实际使用的凭据引用。
 *
 * 读的是**已解析值**（schema 默认 → 组合基础 → 用户层），与设置页自己的
 * `refFor` 同规则：两处必须给出同一个引用，否则卡片写的和适配器读的会错位。
 * @param view - 该命名空间的视图，可能不存在。
 * @returns 引用名；视图缺失或没写引用时返回 `undefined`。
 */
function profileApiKeyRef(view) {
  if (view === null || typeof view !== 'object') return undefined
  const value = view.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const named = value.apiKeyEnv
  return typeof named === 'string' && named.trim().length > 0 ? named.trim() : undefined
}

/**
 * 绑定本卡片要用的两个 Remote 面。
 *
 * 密钥值只单向穿过 `credentials.set`，读取侧拿到的永远是"是否已配置 /
 * 是否可写"这类视图，没有回显密钥的通道。
 * @param ctx - 客户端根上下文，其 `inject` 已声明 `remote` 及其两个子面。
 * @returns 卡片调用的三个回调。
 */
function monkCredentials(ctx) {
  return {
    /**
     * 解析引用并读取它的凭据状态。
     *
     * 任何一步读不到都不当成失败：引用退到内置缺省值，可写性退到"允许"。
     * 设置区读不到是**部署形态**（比如只挂了凭据提供方），不是用户的错误。
     *
     * `configured` 是**三态**：`undefined` 表示"读不到，不知道"。调用方不得把
     * 它当成 `false`——把未知当未配置，会让一次失败的读取把一个本来配好的
     * 密钥显示成缺失。
     * @returns 引用名、是否已配置（未知时为 `undefined`）、是否可写。
     */
    async resolve() {
      let ref = DEFAULT_API_KEY_ENV
      let writable = true
      try {
        const described = await ctx.remote.settings.describe()
        if (described.ok) {
          const view = described.value.namespaces.find(candidate => candidate.ns === SETTINGS_NS)
          ref = profileApiKeyRef(view) ?? DEFAULT_API_KEY_ENV
          writable = described.value.writable
        }
      } catch {
        // 读不到就用缺省引用；写不写得成由随后的凭据描述说了算。
      }
      let configured
      try {
        const described = await ctx.remote.credentials.describe([ref])
        if (described.ok) {
          const info = described.value[ref]
          if (info !== undefined) {
            configured = info.configured
            writable = writable && info.writable
          }
        }
      } catch {
        // 描述失败不改判定：按钮保持可用，真正的拒绝由写入阶段给出。
      }
      return { ref, configured, writable }
    },
    /**
     * 写入一枚密钥。
     * @param ref - 凭据引用名。
     * @param value - 已去空白的密钥。
     * @returns 失败文案；成功返回 `undefined`。
     */
    async store(ref, value) {
      try {
        const response = await ctx.remote.credentials.set(ref, value)
        return response.ok ? undefined : response.error.message
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  }
}

/**
 * 渲染 Monk 密钥卡片。
 *
 * 组件的职责只有一个：让用户**只填一项**就能把 Monk 跑起来。它不碰
 * `baseURL`、模型目录、推理强度——那些都有出厂默认值，放进界面只会把
 * "粘贴一枚密钥"变成一次配置作业。
 * @param props - 槽位摊平后的 props（注入面 + owner props）。
 * @returns 卡片元素。
 */
function MonkKeyCard(props) {
  const t = props.t
  const credentials = props.monkCredentials
  const provider = props.provider
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState(undefined)
  const [saved, setSaved] = React.useState(false)
  const [ref, setRef] = React.useState(DEFAULT_API_KEY_ENV)
  const [configured, setConfigured] = React.useState(props.keyConfigured === true)
  const [writable, setWritable] = React.useState(true)

  React.useEffect(() => {
    let stale = false
    credentials.resolve().then((resolved) => {
      if (stale) return
      setRef(resolved.ref)
      // 三态：只有真读到结果才覆盖初始判定。读不到时保留 owner props 里
      // 那个已知事实，而不是把"不知道"显示成"没配置"。
      if (resolved.configured !== undefined) setConfigured(resolved.configured)
      setWritable(resolved.writable)
    }).catch(() => {
      // 解析失败保留初始判定，界面照常可用。
    })
    return () => {
      stale = true
    }
  }, [credentials])

  if (provider === undefined || provider.settingsNs !== SETTINGS_NS) return null

  const submit = async () => {
    const invalid = apiKeyFailure(draft)
    if (invalid !== undefined) {
      setSaved(false)
      setFailure(t(invalid))
      return
    }
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const message = await credentials.store(ref, draft.trim())
      if (message !== undefined) {
        setFailure(fill(t('failed'), { message }))
        return
      }
      // 绝不回显：成功后立刻清空输入框，密钥只存在于受管存储里。
      setDraft('')
      setConfigured(true)
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'monk-key',
    children: [
      jsxs('div', {
        className: 'monk-key-head',
        children: [
          jsx('span', { className: 'monk-key-label', children: t('keyLabel') }),
          jsx('span', {
            className: `monk-key-dot ${configured ? 'monk-key-dot-on' : 'monk-key-dot-off'}`,
            role: 'img',
            'aria-label': configured ? t('configured') : t('unconfigured'),
          }),
          jsx('span', {
            className: 'monk-key-state',
            children: configured ? t('configured') : t('unconfigured'),
          }),
        ],
      }),
      jsxs('div', {
        className: 'monk-key-row',
        children: [
          jsx('input', {
            className: 'monk-key-input',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            value: draft,
            placeholder: t('keyPlaceholder'),
            'aria-label': t('keyLabel'),
            'aria-invalid': failure !== undefined,
            disabled: busy || !writable,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            },
          }),
          jsx('button', {
            className: 'monk-key-save',
            type: 'button',
            disabled: busy || !writable,
            onClick: () => {
              void submit()
            },
            children: busy ? t('saving') : t('save'),
          }),
        ],
      }),
      jsx('p', { className: 'monk-key-hint', children: t('hint') }),
      jsx('p', {
        className: 'monk-key-note',
        // 引用名以 <code> 呈现：它是用户在 settings.yaml 里唯一会看到的名字，
        // 直接印出来比让用户去猜"密钥存哪了"更有用。
        children: t('store').split('{ref}').flatMap((part, index) => index === 0
          ? [part]
          : [jsx('code', { className: 'monk-key-code', children: ref }, `ref${index}`), part]),
      }),
      writable ? null : jsx('p', { className: 'monk-key-note', children: t('readOnly') }),
      failure === undefined
        ? null
        : jsx('p', { className: 'monk-key-error', role: 'alert', children: failure }),
      saved ? jsx('p', { className: 'monk-key-ok', role: 'status', children: t('saved') }) : null,
    ],
  })
}

/** 需要的服务：槽位注册表、locale 面，以及 Remote 的凭据与设置两个子面。 */
const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings']

/**
 * 客户端插件体。
 *
 * 两件事，都是可撤销副作用：注册 locale 字典（声明 `locale` 的条目靠它拿到
 * `t`），以及在 `settings.models.provider-card` 的 `monk-llm` 键上占一个位。
 *
 * 槽位用 `ctx.slots.inject` 而不是直接 `register`：该槽位由
 * `dsh-client-ui-settings-models` 声明，而它与本包的激活顺序**没有约束**。
 * `inject` 会在声明已存在时同步回调、否则等声明提交后再回调，两种顺序都成立。
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
  ctx.effect(() => injectStyles())
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }))
  ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT,
    key: SETTINGS_NS,
    locale: LOCALE_NS,
    inject: () => ({ monkCredentials: monkCredentials(ctx) }),
  }, MonkKeyCard))
}

export {
  PACKAGE_ID,
  SLOT,
  SETTINGS_NS,
  PROVIDER,
  DEFAULT_API_KEY_ENV,
  LOCALE_NS,
  STYLES,
  zh,
  en,
  apiKeyFailure,
  fill,
  profileApiKeyRef,
  inject,
  apply,
}
