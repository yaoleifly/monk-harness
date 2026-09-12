/**
 * Monk 密钥卡片测试。
 *
 * 重点不是"文件存在"，而是几件**只在浏览器里才会显形**的事实，必须在构建期
 * 或测试期拦住：
 *
 * 1. bundle 的模块 id 必须等于包名——模块图按包名寻址，写错的话表现为
 *    "Models 页里没有密钥框"且不报错。
 * 2. 工厂体里不能残留行首 `import`/`export`——那是语法错误，只在浏览器里炸。
 * 3. 槽位键必须等于 `@monk/monk-llm` 的设置命名空间——错一个字符，槽位就
 *    永远收不到卡片，同样不报错。这条靠**跨包读常量**钉死，而不是各写一遍。
 * 4. `exports` 里广告的每个路径都必须真实存在——广告一个不存在的类型文件，
 *    会让第一个 TS 消费者拿到"找不到声明"，而这里根本不会有人发现。
 *
 * 组件用一个**极简 hooks 运行时**驱动（受控输入 + 一次性 effect），因此不需要
 * React 也能断言渲染结果与保存路径。
 *
 * bundle 用**同域**动态导入执行（而非 `node:vm`）：vm 里造出来的数组/对象带
 * 另一个 realm 的原型，`deepStrictEqual` 会因原型不同而失败，把真实断言淹没在
 * 假失败里。同域执行只需要在 `globalThis` 上摆一个 `window`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_API_KEY_ENV,
  MONK_PROVIDER,
  SETTINGS_NS as HOST_SETTINGS_NS,
  name as HOST_PLUGIN_NAME,
} from '../../monk-llm/src/index.ts'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(PACKAGE_ROOT, 'lib/client.js')

/** package.json 里本测试用到的字段。 */
interface Manifest {
  name: string
  exports: Record<string, string | Record<string, string>>
  dsh: { client: { platform: string; inject: string[] } }
}

const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Manifest

/** 极简元素树：够断言结构，不引入 React。 */
interface ElementTree {
  type: string
  props: Record<string, unknown>
  key?: string
}

/** 一个可渲染组件。 */
type Component = (props: Record<string, unknown>) => ElementTree

/** 一条模块注册记录。 */
interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** 一次槽位注册的观测。 */
interface SlotEntry {
  spec: Record<string, unknown>
  component: Component
}

/** Remote 面的替身。 */
interface RemoteStub {
  settings: { describe: () => Promise<unknown> }
  credentials: {
    describe: (refs: string[]) => Promise<unknown>
    set: (ref: string, value: string) => Promise<unknown>
  }
}

/** 一次 apply 的观测结果。 */
interface Observation {
  effects: number
  injectedSlots: string[]
  registered: SlotEntry[]
  locales: Array<{ ns: string; dictionaries: Record<string, Record<string, string>> }>
}

/** 假的 jsx 运行时。 */
const jsxRuntime = {
  jsx: (type: string, props: Record<string, unknown> | null, key?: string): ElementTree =>
    ({ type, props: props ?? {}, ...(key === undefined ? {} : { key }) }),
  jsxs: (type: string, props: Record<string, unknown> | null, key?: string): ElementTree =>
    ({ type, props: props ?? {}, ...(key === undefined ? {} : { key }) }),
  Fragment: 'Fragment',
}

/** 极简 hooks 运行时：够驱动受控输入与一次性 effect。 */
interface HookRuntime {
  React: { useState: unknown; useEffect: unknown }
  reset: () => void
  drain: () => void
  /**
   * 装上"状态变更后立刻重渲染"的回调。
   *
   * 真实 React 在 setState 后会同步重渲染，因此事件处理函数拿到的是**新**闭包。
   * 少了这一步，测试会从旧元素上取到旧闭包（`draft` 还是空串），把"点了保存但
   * 没读到刚键入的密钥"当成产品缺陷——那是测试替身的失真，不是代码的问题。
   * @param commit - 状态落定后调用的重渲染函数。
   */
  setCommit: (commit: () => void) => void
}

/**
 * 造一套 hook 单元。
 *
 * `useEffect` 实现了 deps 比对——否则每次重渲染都会重跑解析请求，测试会在
 * 反复请求里打转，看不出真实行为。
 * @returns hook 运行时。
 */
function createHooks(): HookRuntime {
  const cells: unknown[] = []
  const effects: Array<{ deps: readonly unknown[] | undefined }> = []
  let queued: Array<() => void> = []
  let commit: (() => void) | undefined
  let index = 0

  const React = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const cell = index
      index += 1
      if (!(cell in cells)) {
        cells[cell] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const set = (next: unknown): void => {
        cells[cell] = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(cells[cell])
          : next
        commit?.()
      }
      return [cells[cell], set]
    },
    useEffect(run: () => unknown, deps?: readonly unknown[]): void {
      const cell = index
      index += 1
      const previous = effects[cell]
      const unchanged = previous !== undefined && deps !== undefined && previous.deps !== undefined
        && deps.length === previous.deps.length
        && deps.every((value, at) => Object.is(value, previous.deps?.[at]))
      if (unchanged) return
      effects[cell] = { deps }
      queued.push(() => {
        run()
      })
    },
  }

  return {
    React,
    reset: () => {
      index = 0
    },
    drain: () => {
      const batch = queued
      queued = []
      for (const run of batch) run()
    },
    setCommit: (next: () => void) => {
      commit = next
    },
  }
}

let probe = 0

/** 在假的 `window` 下执行 bundle，返回它注册的记录。 */
async function registrationsOf(): Promise<Registration[]> {
  const records: Registration[] = []
  ;(globalThis as { window?: unknown }).window = {
    __ModuleLoader__: { load: (record: Registration) => records.push(record) },
  }
  // 查询串让每个用例拿到一份全新的模块实例：否则 import 缓存会让后续用例
  // 拿到空记录，表现为"bundle 没有注册任何模块"这种假失败。
  probe += 1
  await import(`${pathToFileURL(BUNDLE).href}?probe=${probe}`)
  return records
}

/** 加载 bundle 并物化它的工厂体。 */
async function loadModule(react: unknown = {}): Promise<Record<string, unknown>> {
  const records = await registrationsOf()
  assert.equal(records.length, 1, 'bundle 应当只注册一个模块')
  return records[0]!.factory((specifier: string) => {
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })
}

/** 用假上下文执行一次 apply。 */
function runApply(module: Record<string, unknown>, remote: RemoteStub): Observation {
  const observation: Observation = { effects: 0, injectedSlots: [], registered: [], locales: [] }
  const ctx = {
    effect: (callback: () => unknown) => {
      observation.effects += 1
      callback()
    },
    slots: {
      inject: (name: string, callback: () => unknown) => {
        observation.injectedSlots.push(name)
        callback()
        return () => {}
      },
      register: (spec: Record<string, unknown>, component: Component) => {
        observation.registered.push({ spec, component })
        return () => {}
      },
    },
    locale: {
      register: (ns: string, dictionaries: Record<string, Record<string, string>>) => {
        observation.locales.push({ ns, dictionaries })
        return () => {}
      },
    },
    remote,
  }
  ;(module.apply as (context: unknown) => void)(ctx)
  return observation
}

/** 一个恒不响应的 Remote 替身。 */
function silentRemote(): RemoteStub {
  return {
    settings: { describe: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) },
    credentials: {
      describe: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
      set: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
    },
  }
}

/** 默认的提供方目录行。 */
function monkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: MONK_PROVIDER,
    displayName: 'Monk',
    settingsNs: HOST_SETTINGS_NS,
    settingsPath: [],
    active: true,
    ...overrides,
  }
}

/** 深度优先找一个带指定类名的元素。 */
function find(node: ElementTree, className: string): ElementTree | undefined {
  const own = node.props.className
  if (typeof own === 'string' && own.split(' ').includes(className)) return node
  for (const child of childrenOf(node)) {
    const hit = find(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 取出元素的子元素列表。 */
function childrenOf(node: ElementTree): ElementTree[] {
  const children = node.props.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  return list.filter((child): child is ElementTree =>
    child !== null && typeof child === 'object' && 'type' in (child as ElementTree))
}

/** 收集元素树里的全部可见文本。 */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const element = node as ElementTree
  // 这里必须遍历**原始** children，不能走 `childrenOf`——后者只留元素，会把
  // 文本节点整个丢掉，于是所有"界面显示了什么"的断言都会看到空字符串。
  const children = element.props.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  for (const child of list) collectText(child, out)
  return out
}

/** 已挂载的卡片。 */
interface CardHandle {
  /** 当前元素树；组件判定"不该渲染"时是 `null`。 */
  readonly tree: ElementTree | null
  settle: () => Promise<ElementTree | null>
  find: (className: string) => ElementTree | undefined
  texts: () => string[]
}

/** 挂载卡片并跑完首轮解析。 */
async function mount(options: {
  remote?: RemoteStub
  provider?: Record<string, unknown>
  keyConfigured?: boolean
} = {}): Promise<CardHandle> {
  const hooks = createHooks()
  const module = await loadModule(hooks.React)
  const observation = runApply(module, options.remote ?? silentRemote())
  const entry = observation.registered[0]
  assert.ok(entry !== undefined, '应当注册一个槽位占用者')
  const dictionaries = module.zh as Record<string, string>
  const props: Record<string, unknown> = {
    // 注入面在 root 作用域下是**无参**调用一次并缓存（渲染器行为）。
    ...(entry.spec.inject as () => Record<string, unknown>)(),
    t: (key: string) => dictionaries[key] ?? key,
    provider: options.provider ?? monkRow(),
    configured: true,
    keyConfigured: options.keyConfigured ?? false,
  }
  let tree: ElementTree | null = null
  const render = (): ElementTree | null => {
    hooks.reset()
    tree = entry.component(props)
    return tree
  }
  hooks.setCommit(render)
  const settle = async (): Promise<ElementTree | null> => {
    for (let round = 0; round < 3; round += 1) {
      hooks.drain()
      // 跨一个宏任务边界，把所有挂起的微任务（含链式 await）一次性排空。
      await new Promise(resolve => setTimeout(resolve, 0))
      render()
    }
    return tree
  }
  await settle()
  return {
    get tree() {
      return tree
    },
    settle,
    find: className => (tree === null ? undefined : find(tree, className)),
    texts: () => (tree === null ? [] : collectText(tree)),
  }
}

// ── 产物结构 ──────────────────────────────────────────────────────────────────

test('bundle 的模块 id 等于包名', async () => {
  const records = await registrationsOf()
  assert.equal(records[0]!.id, MANIFEST.name)
})

test('工厂体不残留行首 import/export', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  const body = source.split('\n').slice(6).join('\n')
  assert.equal(/^\s*(?:import|export)\s/m.test(body), false)
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
})

test('package.json 声明了 web 客户端半边', () => {
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.deepEqual(MANIFEST.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
  ])
  const client = MANIFEST.exports['./client']
  assert.equal(typeof client === 'string' ? client : client?.default, './lib/client.js')
})

test('exports 广告的每个路径都真实存在', () => {
  for (const [key, conditions] of Object.entries(MANIFEST.exports)) {
    const targets = typeof conditions === 'string' ? [conditions] : Object.values(conditions)
    for (const target of targets) {
      assert.ok(
        existsSync(join(PACKAGE_ROOT, target)),
        `exports["${key}"] 指向不存在的 ${target}`,
      )
    }
  }
})

// ── 槽位契约 ──────────────────────────────────────────────────────────────────

test('工厂体导出 apply 与 inject', async () => {
  const module = await loadModule()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings'])
})

test('apply 在 Models 页的提供方卡片槽位上占一个位', async () => {
  const module = await loadModule()
  const observation = runApply(module, silentRemote())
  assert.deepEqual(observation.injectedSlots, ['settings.models.provider-card'])
  assert.equal(observation.registered.length, 1)
  assert.equal(observation.registered[0]!.spec.name, 'settings.models.provider-card')
})

test('槽位按 monk-llm 这个设置命名空间分键', async () => {
  const module = await loadModule()
  const spec = runApply(module, silentRemote()).registered[0]!.spec
  assert.equal(spec.key, HOST_SETTINGS_NS, '槽位键必须等于宿主包的设置命名空间')
  assert.equal(spec.key, 'monk-llm')
})

test('卡片键与宿主包的常量不漂移', async () => {
  const module = await loadModule()
  // 这三个字符串是跨包契约：宿主侧改一个，卡片就静默收不到或写错地方。
  assert.equal(module.SETTINGS_NS, HOST_SETTINGS_NS)
  assert.equal(module.PROVIDER, MONK_PROVIDER)
  assert.equal(module.DEFAULT_API_KEY_ENV, DEFAULT_API_KEY_ENV)
  assert.equal(HOST_PLUGIN_NAME, HOST_SETTINGS_NS)
})

test('卡片声明 locale 命名空间并注册双语字典', async () => {
  const module = await loadModule()
  const observation = runApply(module, silentRemote())
  assert.equal(observation.registered[0]!.spec.locale, 'monk-llm-ui')
  assert.deepEqual(observation.locales.map(entry => entry.ns), ['monk-llm-ui'])
  const dictionaries = observation.locales[0]!.dictionaries
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'])
})

test('两种语言的键集合完全一致', async () => {
  const module = await loadModule()
  const zh = Object.keys(module.zh as Record<string, string>).sort()
  const en = Object.keys(module.en as Record<string, string>).sort()
  assert.ok(zh.length > 0)
  assert.deepEqual(en, zh, 'en 缺键会让英文界面显示键名')
})

// ── 纯函数 ────────────────────────────────────────────────────────────────────

test('密钥校验与宿主侧的字符集规则一致', async () => {
  const apiKeyFailure = (await loadModule()).apiKeyFailure as (raw: unknown) => string | undefined
  assert.equal(apiKeyFailure('sk-abc123'), undefined)
  assert.equal(apiKeyFailure('  sk-abc123  '), undefined, '首尾空白应当被静默去掉')
  assert.equal(apiKeyFailure(''), 'keyRequired')
  assert.equal(apiKeyFailure('   '), 'keyRequired')
  assert.equal(apiKeyFailure(undefined), 'keyRequired')
  assert.equal(apiKeyFailure('sk-abc 123'), 'keyIllegalCharacters', '空格进不了 HTTP 头')
  assert.equal(apiKeyFailure('sk-密钥'), 'keyIllegalCharacters', '非 ASCII 同样进不了')
  assert.equal(apiKeyFailure('sk-abc\ndef'), 'keyIllegalCharacters')
})

test('引用从设置区已解析值里读，缺省才回退', async () => {
  const profileApiKeyRef = (await loadModule()).profileApiKeyRef as (view: unknown) => string | undefined
  assert.equal(profileApiKeyRef({ ns: 'monk-llm', value: { apiKeyEnv: 'MY_KEY' } }), 'MY_KEY')
  assert.equal(profileApiKeyRef({ ns: 'monk-llm', value: { apiKeyEnv: '  MY_KEY  ' } }), 'MY_KEY')
  assert.equal(profileApiKeyRef({ ns: 'monk-llm', value: { apiKeyEnv: '' } }), undefined)
  assert.equal(profileApiKeyRef({ ns: 'monk-llm', value: {} }), undefined)
  assert.equal(profileApiKeyRef(undefined), undefined)
  assert.equal(profileApiKeyRef({ value: null }), undefined)
  assert.equal(profileApiKeyRef({ value: ['x'] }), undefined)
})

test('文案占位符替换', async () => {
  const fill = (await loadModule()).fill as (t: string, r: Record<string, string>) => string
  assert.equal(fill('保存失败：{message}', { message: 'boom' }), '保存失败：boom')
  assert.equal(fill('没有占位符', { message: 'x' }), '没有占位符')
  assert.equal(fill('{a}-{b}', { a: '1', b: '2' }), '1-2')
})

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('卡片渲染密钥输入框与保存按钮', async () => {
  const card = await mount()
  const input = card.find('monk-key-input')
  assert.ok(input !== undefined, '缺少密钥输入框')
  assert.equal(input.props.type, 'password', '密钥必须遮蔽')
  assert.equal(input.props.autoComplete, 'off')
  assert.equal(card.find('monk-key-save')!.props.type, 'button')
})

test('只在自己的设置命名空间上渲染', async () => {
  const card = await mount({ provider: monkRow({ settingsNs: 'llm-pi-ai' }) })
  assert.equal(card.tree, null, '别的命名空间的卡片不该看到 Monk 密钥框')
})

test('未配置时标红，已配置时标绿', async () => {
  const off = await mount({ keyConfigured: false })
  assert.match(String(off.find('monk-key-dot')!.props.className), /monk-key-dot-off/)
  const on = await mount({ keyConfigured: true })
  assert.match(String(on.find('monk-key-dot')!.props.className), /monk-key-dot-on/)
})

test('保存：非法密钥不发请求，直接给出解释', async () => {
  const calls: Array<[string, string]> = []
  const card = await mount({
    remote: {
      ...silentRemote(),
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async (ref: string, value: string) => {
          calls.push([ref, value])
          return { ok: true, value: undefined }
        },
      },
    },
  })
  const input = card.find('monk-key-input')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: 'sk-bad key' } })
  await (card.find('monk-key-save')!.props.onClick as () => Promise<void>)()
  await card.settle()
  assert.deepEqual(calls, [], '非法密钥不该发请求')
  assert.match(card.texts().join('|'), /不能含空格/)
})

test('保存：合法密钥写进解析出的引用，并清空输入', async () => {
  const calls: Array<[string, string]> = []
  const card = await mount({
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [{ ns: 'monk-llm', value: { apiKeyEnv: 'MY_MONK_KEY' } }],
          },
        }),
      },
      credentials: {
        describe: async (refs: string[]) => ({
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
        }),
        set: async (ref: string, value: string) => {
          calls.push([ref, value])
          return { ok: true, value: undefined }
        },
      },
    },
  })
  const input = card.find('monk-key-input')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: '  sk-monk-123  ' } })
  await (card.find('monk-key-save')!.props.onClick as () => Promise<void>)()
  await card.settle()
  assert.deepEqual(calls, [['MY_MONK_KEY', 'sk-monk-123']], '引用要跟随设置区，值要去空白')
  assert.equal(card.find('monk-key-input')!.props.value, '', '保存后必须清空输入框')
  assert.match(card.texts().join('|'), /已保存/)
})

test('保存：读不到设置区时回退到内置引用', async () => {
  const calls: Array<[string, string]> = []
  const card = await mount({
    remote: {
      ...silentRemote(),
      credentials: {
        describe: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
        set: async (ref: string, value: string) => {
          calls.push([ref, value])
          return { ok: true, value: undefined }
        },
      },
    },
  })
  const input = card.find('monk-key-input')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: 'sk-abc' } })
  await (card.find('monk-key-save')!.props.onClick as () => Promise<void>)()
  await card.settle()
  assert.deepEqual(calls, [[DEFAULT_API_KEY_ENV, 'sk-abc']])
})

test('保存：宿主拒绝时把原文带进界面', async () => {
  const card = await mount({
    remote: {
      ...silentRemote(),
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: false, error: { code: 'refused', message: '凭据存储是只读的' } }),
      },
    },
  })
  const input = card.find('monk-key-input')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: 'sk-abc' } })
  await (card.find('monk-key-save')!.props.onClick as () => Promise<void>)()
  await card.settle()
  assert.match(card.texts().join('|'), /凭据存储是只读的/)
})

test('界面从不回显密钥', async () => {
  const card = await mount({
    remote: {
      ...silentRemote(),
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
      },
    },
  })
  const secret = 'sk-super-secret-value'
  const input = card.find('monk-key-input')!
  ;(input.props.onChange as (event: unknown) => void)({ target: { value: secret } })
  // 键入过程中输入框持有它（这是受控输入的必然），但**任何文本节点都不该有**。
  assert.equal(card.texts().some(text => text.includes(secret)), false)
  await (card.find('monk-key-save')!.props.onClick as () => Promise<void>)()
  await card.settle()
  assert.equal(card.texts().some(text => text.includes(secret)), false)
  assert.equal(card.find('monk-key-input')!.props.value, '')
})

test('只读部署禁用保存并说明原因', async () => {
  const card = await mount({
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: { writable: false, hasDocument: false, namespaces: [{ ns: 'monk-llm', value: {} }] },
        }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
      },
    },
  })
  assert.equal(card.find('monk-key-save')!.props.disabled, true)
  assert.equal(card.find('monk-key-input')!.props.disabled, true)
  assert.match(card.texts().join('|'), /只读/)
})

test('已配置状态来自凭据描述，而不是猜的', async () => {
  const card = await mount({
    keyConfigured: false,
    remote: {
      ...silentRemote(),
      credentials: {
        describe: async (refs: string[]) => ({
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
        }),
        set: async () => ({ ok: true, value: undefined }),
      },
    },
  })
  assert.match(String(card.find('monk-key-dot')!.props.className), /monk-key-dot-on/)
})

// ── 样式 ──────────────────────────────────────────────────────────────────────

test('样式选择器全部带 monk-key- 前缀，不会撞到外壳类名', async () => {
  const styles = (await loadModule()).STYLES as string
  const selectors = styles.match(/^[.#][^{@]*\{/gm) ?? []
  assert.ok(selectors.length > 0, '应当匹配到选择器')
  for (const selector of selectors) {
    assert.match(selector, /^\.monk-key/, `${selector} 未带 monk-key- 前缀`)
  }
})

test('无 document 时注入样式是安全的空操作', async () => {
  const module = await loadModule()
  const saved = (globalThis as { document?: unknown }).document
  delete (globalThis as { document?: unknown }).document
  try {
    assert.doesNotThrow(() => runApply(module, silentRemote()))
  } finally {
    if (saved !== undefined) (globalThis as { document?: unknown }).document = saved
  }
})

test('有 document 时挂载样式元素', async () => {
  const created: Array<{ id: string; textContent: string }> = []
  const saved = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    getElementById: () => null,
    createElement: () => {
      const element = { id: '', textContent: '' }
      created.push(element)
      return element
    },
    head: { appendChild: () => {} },
  }
  try {
    await mount()
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = saved
  }
  assert.equal(created.length, 1, '应当创建 style 元素')
  assert.equal(created[0]!.id, 'monk-llm-ui-styles')
  assert.ok(created[0]!.textContent.includes('.monk-key-input'))
})
