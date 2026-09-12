/**
 * Monk 品牌包测试。
 *
 * 重点不是"文件存在"，而是三件在浏览器里才会显形、在构建期必须拦住的事实：
 *
 * 1. bundle 的模块 id 必须等于包名——模块图按包名寻址，写错的话浏览器里
 *    表现为品牌位空白且不报错。
 * 2. 工厂体里不能残留行首 `import`/`export`——那是语法错误，且只在浏览器里炸。
 * 3. 主题覆盖必须两种配色都给值——只给一态时，用户切到另一配色会拿到
 *    不可读的颜色，而且没有任何报错。
 *
 * 组件用假 `react/jsx-runtime` 渲染成普通对象树，因此不需要 React 也能断言
 * SVG 几何与槽位注册。
 *
 * bundle 用**同域**动态导入执行（而非 `node:vm`）：vm 里造出来的数组/对象带
 * 另一个 realm 的原型，`deepStrictEqual` 会因原型不同而失败，把真实断言淹没在
 * 假失败里。同域执行只需要在 `globalThis` 上摆一个 `window`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(PACKAGE_ROOT, 'lib/client.js')

/**
 * package.json 里本用例断言到的部分。
 *
 * 显式声明而不是让 `JSON.parse` 的 `any` 漏下去：`any` 会让 `Object.entries`
 * 推成 `unknown`，于是 `Object.values(conditions)` 变成 `unknown[]`，类型检查在
 * 一句与测试意图无关的地方报错。`exports` 的值可能是字符串，也可能是条件对象，
 * 两种都要能走。
 */
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
type Component = (props: never) => ElementTree

/** 假的 jsx 运行时。 */
const jsxRuntime = {
  jsx: (type: string, props: Record<string, unknown> | null, key?: string): ElementTree =>
    ({ type, props: props ?? {}, ...key === undefined ? {} : { key } }),
  jsxs: (type: string, props: Record<string, unknown> | null, key?: string): ElementTree =>
    ({ type, props: props ?? {}, ...key === undefined ? {} : { key } }),
  Fragment: 'Fragment',
}

/** 一条模块注册记录。 */
interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** 一次 apply 的观测结果。 */
interface Observation {
  effects: number
  injectedSlots: string[]
  registered: Array<{ name: string; component: Component }>
  tokenLayers: Array<{ source: string; tokens: Record<string, { light: string; dark: string }> }>
  themedDeps: string[][]
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
async function loadModule(): Promise<Record<string, unknown>> {
  const records = await registrationsOf()
  assert.equal(records.length, 1, 'bundle 应当只注册一个模块')
  return records[0]!.factory((specifier: string) => {
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require: ${specifier}`)
  })
}

/** 用假上下文执行一次 apply。 */
function runApply(module: Record<string, unknown>): Observation {
  const observation: Observation = {
    effects: 0,
    injectedSlots: [],
    registered: [],
    tokenLayers: [],
    themedDeps: [],
  }

  /** 消费注册回调：可能是函数，也可能是生成器（官方品牌包的既有写法）。 */
  const consume = (callback: () => unknown): void => {
    const produced = callback()
    if (produced !== null && typeof produced === 'object'
      && typeof (produced as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
      for (const _step of produced as Iterable<unknown>) void _step
    }
  }

  const themed = {
    effect: (callback: () => unknown) => {
      observation.effects += 1
      callback()
    },
    theme: {
      overrideTokens: (source: string, tokens: Record<string, { light: string; dark: string }>) => {
        observation.tokenLayers.push({ source, tokens })
        return () => {}
      },
    },
  }

  const ctx = {
    effect: (callback: () => unknown) => {
      observation.effects += 1
      callback()
    },
    slots: {
      inject: (name: string, callback: () => unknown) => {
        observation.injectedSlots.push(name)
        consume(callback)
        return () => {}
      },
      register: (spec: { name: string }, component: Component) => {
        observation.registered.push({ name: spec.name, component })
        return () => {}
      },
    },
    inject: (deps: string[], callback: (c: unknown) => void) => {
      observation.themedDeps.push(deps)
      callback(themed)
    },
  }

  ;(module.apply as (c: unknown) => void)(ctx)
  return observation
}

/** 取出某个槽位注册的组件。 */
function componentAt(observation: Observation, name: string): Component {
  const entry = observation.registered.find(candidate => candidate.name === name)
  assert.ok(entry !== undefined, `槽位 ${name} 未注册`)
  return entry.component
}

/** 递归收集元素树里的类名与路径数据。 */
function collect(node: unknown, classes: Set<string>, paths: string[]): void {
  if (node === null || typeof node !== 'object') return
  const element = node as ElementTree
  if (typeof element.props?.className === 'string') classes.add(element.props.className)
  if (typeof element.props?.d === 'string') paths.push(element.props.d)
  const children = element.props?.children
  if (Array.isArray(children)) for (const child of children) collect(child, classes, paths)
  else if (children !== undefined) collect(children, classes, paths)
}

/** 取出品牌标志组件并渲染。 */
async function renderMark(size: unknown): Promise<ElementTree> {
  const observation = runApply(await loadModule())
  return componentAt(observation, 'sidebar.brand.mark')({ size } as never)
}

/**
 * 假 DOM 节点。
 *
 * 只做改写函数真正用到的那几个成员：`nodeType`、`firstChild`、`nodeValue`、
 * `getAttribute('class')`、`textContent`、`querySelectorAll`。用对象字面量而不是
 * 真 DOM，是为了让这些用例不必启动浏览器或 jsdom。
 */
interface FakeNode {
  nodeType: number
  nodeValue?: string | null
  firstChild?: FakeNode | null
  parentElement?: FakeNode | null
  textContent?: string
  getAttribute?: (name: string) => string | null
  querySelectorAll?: (selector: string) => FakeNode[]
}

/**
 * 造一个元素：带类名、带一个文本子节点。
 *
 * `textContent` 做成 getter 而不是普通属性——真实的 DOM 里它反映子节点，写成
 * 快照属性的话，改写后断言 `textContent` 会看到旧值，用例会在错误的方向上通过。
 * @param className - `class` 属性的值。
 * @param value - 文本子节点的内容。
 * @returns 假元素节点。
 */
function fakeElement(className: string, value: string): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    getAttribute: (name: string) => (name === 'class' ? className : null),
    querySelectorAll: () => [],
  }
  const child: FakeNode = { nodeType: 3, nodeValue: value, parentElement: node }
  node.firstChild = child
  Object.defineProperty(node, 'textContent', {
    get: () => child.nodeValue,
    // 真实 DOM 的 setter 会替换子节点；这里只把文本写回子节点。留一个 setter 是
    // 为了别让"实现里改了 textContent"变成一句 `which has only a getter` 的
    // TypeError——那条报错会掩盖真正的断言失败。
    set: (next: string) => {
      child.nodeValue = next
    },
  })
  return node
}

/** 取出某个假元素里那个文本节点的内容。 */
function fakeText(node: FakeNode): string | null | undefined {
  return node.firstChild?.nodeValue
}

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

test('package.json 声明了客户端半边', () => {
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.deepEqual(MANIFEST.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-theme',
  ])
  const client = MANIFEST.exports['./client']
  assert.equal(typeof client === 'string' ? client : client?.default, './lib/client.js')
})

test('exports 广告的每个路径都真实存在', () => {
  // 客户端半边是 JS（构建脚本产出），没有 .d.ts 可指。曾经这里广告了一个
  // 不存在的 `./lib/types/client/index.d.ts`——不报错，只是让第一个 TS 消费者
  // 撞上"找不到声明"。这条断言让清单不再能说谎。
  for (const [key, conditions] of Object.entries(MANIFEST.exports)) {
    const targets = typeof conditions === 'string' ? [conditions] : Object.values(conditions)
    for (const target of targets) {
      assert.ok(existsSync(join(PACKAGE_ROOT, target)), `exports["${key}"] 指向不存在的 ${target}`)
    }
  }
})

test('工厂体导出 apply 与 inject', async () => {
  const module = await loadModule()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
})

test('apply 占住三个品牌槽位', async () => {
  const observation = runApply(await loadModule())
  assert.deepEqual(observation.injectedSlots, [
    'sidebar.brand.mark',
    'sidebar.brand.name',
    'conversation.hero.brand.mark',
  ])
  assert.deepEqual(observation.registered.map(entry => entry.name), [
    'sidebar.brand.mark',
    'sidebar.brand.name',
    'conversation.hero.brand.mark',
  ])
})

test('首屏槽位名与官方契约一致', async () => {
  // 这个名字来自 dsh-client-ui-conversation 的 slot 声明。写错的话浏览器里
  // 只是首屏那条鱼继续存在，不会有任何报错。
  assert.equal((await loadModule()).HERO_MARK_SLOT, 'conversation.hero.brand.mark')
})

test('首屏标志按 owner 给的尺寸渲染', async () => {
  // 外壳给的是 34（与 headline 网格的 34px 首列对齐）。
  const observation = runApply(await loadModule())
  const svg = componentAt(observation, 'conversation.hero.brand.mark')({ size: 34 } as never)
  assert.equal(svg.props.width, 34)
  assert.equal(svg.props['aria-label'], 'Monk')
})

test('apply 在活动主题之上叠一层 Monk 令牌覆盖', async () => {
  const observation = runApply(await loadModule())
  assert.deepEqual(observation.themedDeps, [['theme']])
  assert.equal(observation.tokenLayers.length, 1)
  assert.equal(observation.tokenLayers[0]!.source, MANIFEST.name)
})

test('令牌覆盖对每种配色都给值', async () => {
  const tokens = runApply(await loadModule()).tokenLayers[0]!.tokens
  assert.ok(Object.keys(tokens).length > 0)
  for (const [name, modes] of Object.entries(tokens)) {
    assert.match(name, /^--dsw-alias-/, `${name} 应当是别名令牌`)
    assert.equal(typeof modes.light, 'string', `${name} 缺 light 值`)
    assert.equal(typeof modes.dark, 'string', `${name} 缺 dark 值`)
    assert.notEqual(modes.light.length, 0)
    assert.notEqual(modes.dark.length, 0)
  }
})

test('品牌色被覆写为 monk.party 的橙', async () => {
  const tokens = runApply(await loadModule()).tokenLayers[0]!.tokens
  assert.deepEqual(tokens['--dsw-alias-brand-primary'], { light: '#EA580C', dark: '#F97316' })
})

test('标志渲染为带 Monk 语义的 SVG', async () => {
  const svg = await renderMark(36)
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 36)
  assert.equal(svg.props.height, 36)
  assert.equal(svg.props['aria-label'], 'Monk')
  assert.equal(svg.props.viewBox, '0 0 512 512')
})

test('标志保留 monk.party 的几何：光环、头部、双袖、核心、火花', async () => {
  const svg = await renderMark(36)
  const classes = new Set<string>()
  const paths: string[] = []
  collect(svg, classes, paths)
  for (const expected of [
    'monk-halo', 'monk-head', 'monk-robe-l', 'monk-robe-r', 'monk-core',
    'monk-spark-a', 'monk-spark-b', 'monk-spark-c',
  ]) {
    assert.ok(classes.has(expected), `缺少 ${expected}`)
  }
  assert.equal(paths.length, 3, '三条路径：左袖、右袖、核心')
})

test('标志对非法 size 有兜底，不会渲染成 0 尺寸', async () => {
  for (const bad of [0, -1, Number.NaN, undefined] as unknown[]) {
    assert.equal((await renderMark(bad)).props.width, 32, `size=${String(bad)} 应当兜底`)
  }
})

test('字标渲染 Monk 与副标', async () => {
  const observation = runApply(await loadModule())
  const element = componentAt(observation, 'sidebar.brand.name')(undefined as never)
  const texts = (element.props.children as ElementTree[]).map(child => child.props.children)
  assert.deepEqual(texts, ['Monk', 'Flash Fusion'])
})

test('样式含动画与减弱动效兜底', async () => {
  const styles = (await loadModule()).STYLES as string
  for (const keyframe of [
    'monk-halo-spin', 'monk-head-pulse', 'monk-flame-l', 'monk-flame-r',
    'monk-core-rise', 'monk-spark',
  ]) {
    assert.ok(styles.includes(`@keyframes ${keyframe}`), `缺少 ${keyframe}`)
  }
  assert.match(styles, /prefers-reduced-motion:reduce/)
})

test('样式选择器全部带 monk- 前缀，不会撞到外壳类名', async () => {
  const styles = (await loadModule()).STYLES as string
  const selectors = styles.match(/^[.#][^{@]*\{/gm) ?? []
  assert.ok(selectors.length > 0, '应当匹配到选择器')
  for (const selector of selectors) {
    assert.match(selector, /^\.monk-/, `${selector} 未带 monk- 前缀`)
  }
})

test('无 document 时注入样式是安全的空操作', async () => {
  const saved = (globalThis as { document?: unknown }).document
  delete (globalThis as { document?: unknown }).document
  try {
    const module = await loadModule()
    assert.doesNotThrow(() => runApply(module))
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
    runApply(await loadModule())
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = saved
  }
  assert.equal(created.length, 1, '应当创建 style 元素')
  assert.equal(created[0]!.id, 'monk-ui-brand-styles')
  assert.ok(created[0]!.textContent.includes('@keyframes monk-halo-spin'))
})

test('标题改写：产品段换成 Monk', async () => {
  const module = await loadModule()
  const monkTitle = module.monkTitle as (current: string) => string | undefined
  assert.equal(monkTitle('DeepSeek Harness'), 'Monk')
  assert.equal(monkTitle('修一个 bug — DeepSeek Harness'), '修一个 bug — Monk')
})

test('Favicon 观察与改写：自动将 head 中的 icon link 替换为 Monk SVG Data URL', async () => {
  const savedDocument = (globalThis as { document?: unknown }).document
  const mockLink: { href?: string; type?: string; getAttribute: (k: string) => string | undefined; setAttribute: (k: string, v: string) => void } = {
    href: 'old-favicon.ico',
    getAttribute(k: string) {
      return k === 'href' ? this.href : k === 'type' ? this.type : undefined
    },
    setAttribute(k: string, v: string) {
      if (k === 'href') this.href = v
      if (k === 'type') this.type = v
    },
  }
  ;(globalThis as { document?: unknown }).document = {
    querySelector: (selector: string) => selector.includes('icon') ? mockLink : null,
    createElement: () => mockLink,
    head: { appendChild: () => {} },
  }

  try {
    const module = await loadModule()
    const observeFavicon = module.observeFavicon as () => () => void
    const dispose = observeFavicon()
    assert.ok(mockLink.href?.startsWith('data:image/svg+xml'), 'favicon 应被替换为 Monk SVG Data URL')
    assert.equal(mockLink.type, 'image/svg+xml')
    assert.equal(typeof dispose, 'function')
    dispose()
  } finally {
    if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = savedDocument
  }
})

test('标题改写：不改会话标题里出现的产品名', async () => {
  const monkTitle = (await loadModule()).monkTitle as (current: string) => string | undefined
  // 产品名在**中间**——那是用户自己起的会话名，不能动。
  assert.equal(monkTitle('DeepSeek Harness 怎么用 — 会话'), undefined)
})

test('标题改写：已改写或无关标题返回 undefined', async () => {
  const monkTitle = (await loadModule()).monkTitle as (current: string) => string | undefined
  assert.equal(monkTitle('Monk'), undefined)
  assert.equal(monkTitle('会话 — Monk'), undefined)
  assert.equal(monkTitle(''), undefined)
})

type HasLocalClass = (element: FakeNode | null, local: string) => boolean
type RewriteHeroCopy = (element: FakeNode | null) => boolean
type SweepHeroCopy = (node: FakeNode | null) => void

test('类名匹配认 CSS Module 的三种形态', async () => {
  const hasLocalClass = (await loadModule()).hasLocalClass as HasLocalClass
  const withClass = (className: string): FakeNode => ({ nodeType: 1, getAttribute: () => className })
  // 产物形态（哈希前缀）、开发形态（哈希后缀）、裸局部名——哈希由内容算出，
  // 跨版本会变，所以不能只认其中一种。
  assert.equal(hasLocalClass(withClass('pXSMma_headlineText'), 'headlineText'), true)
  assert.equal(hasLocalClass(withClass('headlineText_ab12cd'), 'headlineText'), true)
  assert.equal(hasLocalClass(withClass('headlineText'), 'headlineText'), true)
  assert.equal(hasLocalClass(withClass('other headlineText'), 'headlineText'), true)
})

test('类名匹配不认前缀相同的邻居类', async () => {
  const hasLocalClass = (await loadModule()).hasLocalClass as HasLocalClass
  const withClass = (className: string): FakeNode => ({ nodeType: 1, getAttribute: () => className })
  // `headlineTextExtra` 以 `headlineText` 开头——用 `includes` 匹配会连它一起
  // 改掉，这是"顺手改到别人"的典型入口。
  assert.equal(hasLocalClass(withClass('pXSMma_headlineTextExtra'), 'headlineText'), false)
  assert.equal(hasLocalClass(withClass('headlineTextual'), 'headlineText'), false)
  assert.equal(hasLocalClass(withClass('other'), 'headlineText'), false)
  assert.equal(hasLocalClass(withClass(''), 'headlineText'), false)
  assert.equal(hasLocalClass(null, 'headlineText'), false)
  assert.equal(hasLocalClass({ nodeType: 1 }, 'headlineText'), false)
})

test('首屏标题改写成 Monk 文案（中英两套原文）', async () => {
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  for (const original of ['探索未至之境', 'Into the Unknown']) {
    const element = fakeElement('pXSMma_headlineText', original)
    assert.equal(rewrite(element), true, `${original} 应当被改写`)
    assert.equal(fakeText(element), '天下武功，唯快不破')
  }
})

test('首屏徽标置空移除（中英两套原文）', async () => {
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  for (const original of ['预览版', 'Preview', 'Beta']) {
    const element = fakeElement('pXSMma_previewBadge', original)
    assert.equal(rewrite(element), true, `${original} 应当被改写`)
    assert.equal(fakeText(element), '')
  }
})

test('改写保留 React 持有的那个文本节点', async () => {
  // React 的 fiber 里存着文本节点引用。换成新节点（`textContent =`）的话，
  // React 之后每次更新都在改一个已脱离文档的节点，界面永远停在旧值。
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  const element = fakeElement('pXSMma_headlineText', '探索未至之境')
  const before = element.firstChild
  rewrite(element)
  assert.equal(element.firstChild, before, '文本节点实例应当被原地改写')
})

test('改写是幂等的：已是目标文案就不再写', async () => {
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  const element = fakeElement('pXSMma_headlineText', '天下武功，唯快不破')
  // 返回 false 才不会让改写自身触发的观察回调继续自激。
  assert.equal(rewrite(element), false)
  assert.equal(fakeText(element), '天下武功，唯快不破')
})

test('上游换了文案就放手，不覆盖不认识的文字', async () => {
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  const element = fakeElement('pXSMma_headlineText', '全新的标语')
  assert.equal(rewrite(element), false)
  assert.equal(fakeText(element), '全新的标语')
})

test('类名对但文本是用户内容时不动它', async () => {
  // 双闸门：类名决定"是不是首屏那个节点"，原文决定"要不要动手"。缺前者会改到
  // 用户自己写的消息。
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  const element = fakeElement('user-message', '探索未至之境')
  assert.equal(rewrite(element), false)
  assert.equal(fakeText(element), '探索未至之境')
})

test('改写容错：null 与缺 firstChild 都不炸', async () => {
  const rewrite = (await loadModule()).rewriteHeroCopy as RewriteHeroCopy
  assert.equal(rewrite(null), false)
  assert.equal(rewrite({ nodeType: 1 }), false)
  const noChild: FakeNode = {
    nodeType: 1,
    getAttribute: () => 'pXSMma_headlineText',
    textContent: '探索未至之境',
  }
  assert.equal(rewrite(noChild), true)
  assert.equal(noChild.textContent, '天下武功，唯快不破')
})

test('扫描从文本节点往上看一层', async () => {
  // React 把 `{t("hero.headline")}` 渲染成文本节点，变更记录的 target 就是它，
  // 类名在父元素上。
  const sweep = (await loadModule()).sweepHeroCopy as SweepHeroCopy
  const element = fakeElement('pXSMma_headlineText', '探索未至之境')
  sweep(element.firstChild as FakeNode)
  assert.equal(fakeText(element), '天下武功，唯快不破')
})

test('扫描深入新增子树', async () => {
  const sweep = (await loadModule()).sweepHeroCopy as SweepHeroCopy
  const headline = fakeElement('pXSMma_headlineText', '探索未至之境')
  const badge = fakeElement('pXSMma_previewBadge', '预览版')
  const subtree: FakeNode = {
    nodeType: 1,
    getAttribute: () => 'pXSMma_root',
    querySelectorAll: () => [headline, badge],
  }
  sweep(subtree)
  assert.equal(fakeText(headline), '天下武功，唯快不破')
  assert.equal(fakeText(badge), '')
})

test('扫描忽略注释节点等非元素节点', async () => {
  const sweep = (await loadModule()).sweepHeroCopy as SweepHeroCopy
  assert.doesNotThrow(() => sweep({ nodeType: 8 }))
  assert.doesNotThrow(() => sweep(null))
})

test('改写选择器覆盖两个首屏文案位', async () => {
  const selector = (await loadModule()).HERO_COPY_SELECTOR as string
  assert.equal(selector, '[class*="_headlineText"],[class*="_previewBadge"]')
})

test('外壳首屏的类名局部名与文案仍与改写表对得上', async () => {
  // 改写没有接缝可用（locale 字典是单一所有者），只能靠"类名 + 原文"两道闸门
  // 认人。两者都取决于外壳的当前形态：上游重命名那个类，或者换了/加了一种语言
  // 的文案，改写就会**静默**失效——界面上只是文案没换，没有任何报错。这条用例
  // 把那两个失败模式钉在测试里。
  //
  // 解析不到外壳包时跳过：peer 依赖没装全不该让仓库测试变红。
  const require = createRequire(join(PACKAGE_ROOT, 'package.json'))
  let bundle: string
  try {
    const manifestPath = require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json')
    bundle = readFileSync(join(dirname(manifestPath), 'lib/client.js'), 'utf8')
  } catch {
    return
  }

  /** 局部名 → 该节点文案所在的 locale 键。 */
  const KEYS: Record<string, string> = {
    headlineText: 'hero.headline',
    previewBadge: 'hero.preview',
  }

  const heroCopy = (await loadModule()).HERO_COPY as Array<{ local: string; from: string[] }>
  assert.ok(heroCopy.length > 0)

  for (const entry of heroCopy) {
    // 类名局部名必须还在外壳的 CSS Module 类表里。
    assert.ok(bundle.includes(`"${entry.local}": "`), `外壳里找不到类名局部名 ${entry.local}`)

    const key = KEYS[entry.local]
    assert.ok(key !== undefined, `改写表里的 ${entry.local} 没有对应的 locale 键`)
    const shipped = [...bundle.matchAll(new RegExp(`"${key}": "([^"]*)"`, 'g'))]
      .map(match => match[1])
    assert.ok(shipped.length > 0, `外壳里找不到 ${key}`)
    // 每一种语言的文案都要认得，否则切到那种语言时改写会放手。
    for (const text of shipped) {
      assert.ok(
        entry.from.includes(text as string),
        `${key} 的 ${JSON.stringify(text)} 不在改写表的原文里`,
      )
    }
  }
})

test('无 document 时首屏改写是安全的空操作', async () => {
  const saved = (globalThis as { document?: unknown }).document
  const savedObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver
  delete (globalThis as { document?: unknown }).document
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver
  try {
    const observe = (await loadModule()).observeHeroCopy as () => () => void
    assert.doesNotThrow(() => observe())
  } finally {
    if (saved !== undefined) (globalThis as { document?: unknown }).document = saved
    if (savedObserver !== undefined) {
      ;(globalThis as { MutationObserver?: unknown }).MutationObserver = savedObserver
    }
  }
})

test('首屏改写观察者启动时全量扫一次，并随变更增量改写', async () => {
  // 本插件的激活可能晚于首屏挂载（客户端插件是异步加载的），那时首屏已经在
  // 屏幕上，没有任何变更记录会告诉我们它存在——所以启动时那一次全量扫描是必须
  // 的，这条用例就是钉它。
  const savedDocument = (globalThis as { document?: unknown }).document
  const savedObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver

  const mounted = fakeElement('pXSMma_headlineText', '探索未至之境')
  const body: FakeNode = {
    nodeType: 1,
    getAttribute: () => null,
    querySelectorAll: () => [mounted],
  }
  let notify: ((records: unknown[]) => void) | undefined
  class FakeObserver {
    constructor(callback: (records: unknown[]) => void) {
      notify = callback
    }
    observe(): void {}
    disconnect(): void {}
  }
  ;(globalThis as { document?: unknown }).document = { body }
  ;(globalThis as { MutationObserver?: unknown }).MutationObserver = FakeObserver

  try {
    const module = await loadModule()
    const dispose = (module.observeHeroCopy as () => () => void)()
    assert.equal(fakeText(mounted), '天下武功，唯快不破', '启动时应当扫一次')

    // 语言切换：React 把英文写回同一个文本节点（characterData）。
    const switched = fakeElement('pXSMma_headlineText', 'Into the Unknown')
    notify?.([{ type: 'characterData', target: switched.firstChild }])
    assert.equal(fakeText(switched), '天下武功，唯快不破')

    // 首屏挂载：变更记录里是新增的子树。
    const added = fakeElement('pXSMma_previewBadge', '预览版')
    notify?.([{ type: 'childList', addedNodes: [added] }])
    assert.equal(fakeText(added), '')

    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  } finally {
    if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = savedDocument
    if (savedObserver === undefined) delete (globalThis as { MutationObserver?: unknown }).MutationObserver
    else (globalThis as { MutationObserver?: unknown }).MutationObserver = savedObserver
  }
})

test('有 document 但没有 MutationObserver 时只做一次改写', async () => {
  const savedDocument = (globalThis as { document?: unknown }).document
  const savedObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver
  const mounted = fakeElement('pXSMma_headlineText', '探索未至之境')
  ;(globalThis as { document?: unknown }).document = {
    body: { nodeType: 1, getAttribute: () => null, querySelectorAll: () => [mounted] },
  }
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver
  try {
    const observe = (await loadModule()).observeHeroCopy as () => () => void
    const dispose = observe()
    assert.equal(fakeText(mounted), '天下武功，唯快不破')
    assert.equal(typeof dispose, 'function')
  } finally {
    if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = savedDocument
    if (savedObserver !== undefined) {
      ;(globalThis as { MutationObserver?: unknown }).MutationObserver = savedObserver
    }
  }
})
