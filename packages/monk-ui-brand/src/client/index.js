/**
 * Monk 品牌客户端半边（浏览器）。
 *
 * 为什么是 JS 而不是 TS：本模块要注册的两个槽位
 * （`sidebar.brand.mark` / `sidebar.brand.name`）的类型住在
 * `@deepseek-ai/dsh-client-ui-slots`，而那是 dsh 内部的**虚拟模块**——它只以
 * 类型再导出的形式出现在 `dsh-client-ui-renderer` 里，不作为独立包发布，因此
 * 无法从本包解析。硬写一份本地 shim 会让类型在两侧各说一套，比不做更糟。
 * 宿主半边仍是完整 TS；这一半由 `scripts/build-client.mjs` 打包，并由
 * `tests/brand.spec.ts` 校验产物结构。
 *
 * 运行时契约来自官方品牌包 `dsh-client-ui-brand-official`（同一接缝的既有
 * 实现）与 `dsh-client-ui-theme` 的 `client/index.d.ts`（`overrideTokens`
 * 要求 light/dark 两态都给值，缺一态在另一配色下会失去可读性）。
 *
 * 空白会话首屏（hero）有两件事，待遇完全不同：
 *
 * - **图标**走正门。`conversation.hero.brand.mark` 是 `single` + `root` 的槽位，
 *   官方文档明确写着它在**所有构建中都保持无填充**——首屏那条动画鱼是声明包
 *   自己的 `fallback`，不是注册者。所以注册即接管，不需要像 sidebar 那样处理
 *   占用者。
 * - **文案没有槽位**。`hero.headline` / `hero.preview` 是 locale 字典里的键，
 *   而字典是**单一所有者**的：`locale.register` 对同一 (namespace, locale)
 *   直接抛错，且没有任何覆盖 API（"a namespace's texts have one owner"）。
 *   因此这里对它做一次**受控改写**，与上面的 `productTitle` 同一先例。
 *
 * 本文件是 ESM 源；构建脚本把下面这唯一一条 `import` 改写为工厂的 `require`。
 */

import { jsx, jsxs } from 'react/jsx-runtime'

/** 浏览器模块 id，必须等于包名（模块图按包名寻址）。 */
const PACKAGE_ID = '@monk/monk-ui-brand'

/** 注入样式的元素 id；重复挂载时按它去重。 */
const STYLE_ELEMENT_ID = 'monk-ui-brand-styles'

/**
 * 外壳把产品名硬编码在 `dsh-client-ui-layout` 里
 * （`productTitle: "DeepSeek Harness"`），既没有配置项也没有槽位可替换。
 * 浏览器标签页是界面身份的一部分，所以这里对它做一次**受控改写**——
 * 这是绕过硬编码常量的权宜做法，不是接缝。上游若把 `productTitle` 变成
 * 可配置项，这段应当整个删掉。
 */
const PRODUCT_TITLE = 'DeepSeek Harness'

/** 替换后的产品名。 */
const BRAND_TITLE = 'Monk'

/** monk.party 官方标志 SVG data URL，供浏览器标签页 favicon 使用。 */
const MONK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none"><defs><linearGradient id="b" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0F172A"/><stop offset="100%" stop-color="#020617"/></linearGradient><linearGradient id="f" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#EA580C"/><stop offset="50%" stop-color="#F97316"/><stop offset="100%" stop-color="#FDE047"/></linearGradient><linearGradient id="h" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FB923C" stop-opacity="0.6"/><stop offset="100%" stop-color="#F97316" stop-opacity="0.05"/></linearGradient></defs><rect width="512" height="512" rx="128" fill="url(#b)"/><rect width="512" height="512" rx="128" stroke="rgba(255,255,255,0.08)" stroke-width="4"/><circle cx="256" cy="246" r="150" stroke="url(#h)" stroke-width="12" stroke-linecap="round" fill="none"/><circle cx="256" cy="148" r="32" fill="url(#f)"/><path d="M 172 384 L 208 220 L 256 280 L 224 384 Z" fill="url(#f)" opacity="0.9"/><path d="M 340 384 L 304 220 L 256 280 L 288 384 Z" fill="url(#f)" opacity="0.9"/><path d="M 256 216 L 278 284 L 256 372 L 234 284 Z" fill="#FFFBEB"/><circle cx="380" cy="170" r="8" fill="#38BDF8"/><circle cx="132" cy="310" r="6" fill="#A855F7"/><circle cx="360" cy="340" r="7" fill="#F59E0B"/></svg>`

const MONK_FAVICON_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(MONK_FAVICON_SVG)}`

/** 空白会话首屏的品牌位；官方文档保证该槽位在所有构建中都没有占用者。 */
const HERO_MARK_SLOT = 'conversation.hero.brand.mark'

/**
 * 首屏文案的改写表。
 *
 * `local` 是 CSS Module 里的**局部名**，不是最终类名：产物里它会被加上内容哈希
 * （当前是 `pXSMma_headlineText`）。哈希由内容算出，跨版本会变；局部名是人写
 * 的，只在有人重命名时才会变——所以按局部名匹配、用后缀比对，而不是硬编码哈希。
 *
 * `from` 是外壳当前会写进 DOM 的原文（中英两套），`to` 是我们的文案。两套都列
 * 出来是因为语言切换会让 React 把另一种语言写回同一个文本节点。
 *
 * 中文文案对两种语言都用同一份：monk.party 的品牌语就是中文，这里不做翻译。
 * 要改成按语言分叉的话，改 `to` 为 `{ zh, en }` 即可，其余逻辑不用动。
 */
const HERO_COPY = [
  { local: 'headlineText', from: ['探索未至之境', 'Into the Unknown'], to: '天下武功，唯快不破' },
  { local: 'previewBadge', from: ['预览版', 'Preview', 'Beta'], to: '' },
]

/** 首屏文案候选节点的选择器，用于一次性扫描与新增子树内的查找。 */
const HERO_COPY_SELECTOR = HERO_COPY.map(entry => `[class*="_${entry.local}"]`).join(',')

/**
 * monk.party 的调色板，取自该站 `app.css` 与 `monk-logo.svg`：
 * 近黑底 + 橙/琥珀强调。
 */
const MONK = {
  orange600: '#EA580C',
  orange500: '#F97316',
  orange400: '#FB923C',
  amber500: '#F59E0B',
  ink900: '#0F172A',
  ink950: '#020617',
}

/**
 * 覆盖层令牌。两种配色都必须给值——只给一态的话，用户切到另一配色时
 * 这层覆盖会变成不可读的颜色。
 *
 * 严格按照 vercel-DESIGN.md 规范映射扩展令牌：
 * - canvas-soft (#fafafa) / canvas (#ffffff) / canvas-soft-2 (#f5f5f5)
 * - hairline (#ebebeb) / hairline-strong (#a1a1a1)
 * - ink (#171717) / body (#4d4d4d)
 * - success / link (#0070f3 / #50e3c2) / error (#ee0000) / warning (#f5a623)
 * - brand-primary (#EA580C / #F97316)
 */
const MONK_THEME_TOKENS = {
  '--dsw-alias-brand-primary': { light: MONK.orange600, dark: MONK.orange500 },
  '--dsw-alias-brand-text': { light: MONK.orange600, dark: MONK.orange400 },
  '--dsw-alias-bg-base': { light: '#fafafa', dark: '#08090C' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#0F172A' },
  '--dsw-alias-bg-layer-2': { light: '#f5f5f5', dark: '#020617' },
  '--dsw-alias-border-l1': { light: '#ebebeb', dark: 'rgba(255, 255, 255, 0.1)' },
  '--dsw-alias-border-l2': { light: '#a1a1a1', dark: 'rgba(255, 255, 255, 0.2)' },
  '--dsw-alias-label-primary': { light: '#171717', dark: '#f2f2f2' },
  '--dsw-alias-label-secondary': { light: '#4d4d4d', dark: '#a1a1a1' },
  '--dsw-alias-state-error-primary': { light: '#ee0000', dark: '#ff4d4d' },
  '--dsw-alias-state-success-primary': { light: '#0070f3', dark: '#50e3c2' },
  '--dsw-alias-state-warn-primary': { light: '#f5a623', dark: '#f5a623' },
}

/**
 * 品牌样式表。
 *
 * 所有选择器都带 `monk-` 前缀，不会碰到外壳自己的类名；配色沿用 dsh 的
 * `--dsw-alias-*` 语义令牌并带兜底值，因此在本包单独存在时也能渲染。
 */
const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap");

:root {
  --dsw-font-family: Geist, Inter, system-ui, -apple-system, sans-serif !important;
  --ds-font-family-code: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace !important;
}

::selection {
  background: #171717 !important;
  color: #f2f2f2 !important;
}

body[data-ds-dark-theme] ::selection {
  background: #f2f2f2 !important;
  color: #171717 !important;
}

body {
  font-family: Geist, Inter, system-ui, -apple-system, sans-serif !important;
  -webkit-font-smoothing: antialiased !important;
  -moz-osx-font-smoothing: grayscale !important;
  background-color: #fafafa !important;
  color: #171717 !important;
}

body[data-ds-dark-theme] {
  background-color: #08090C !important;
  color: #f2f2f2 !important;
}

/* ── Vercel Atmospheric Mesh Gradient Backdrop ── */
.monk-mesh-gradient {
  position: absolute;
  top: 6%;
  left: 50%;
  transform: translateX(-50%);
  width: 720px;
  height: 380px;
  max-width: 92vw;
  pointer-events: none;
  z-index: 0;
  opacity: 0.18;
  filter: blur(80px);
  border-radius: 50%;
  background: radial-gradient(circle at 20% 20%, #007cf0 0%, transparent 55%),
              radial-gradient(circle at 80% 20%, #7928ca 0%, transparent 55%),
              radial-gradient(circle at 50% 65%, #ff0080 0%, transparent 55%),
              radial-gradient(circle at 85% 75%, #00dfd8 0%, transparent 55%),
              radial-gradient(circle at 15% 75%, #f9cb28 0%, transparent 55%);
}

body[data-ds-dark-theme] .monk-mesh-gradient {
  opacity: 0.35;
  filter: blur(90px);
}

/* ── Hero Container & Headline ── */
[class*="_root"]:has([class*="_headline"]) {
  position: relative;
  overflow: visible !important;
}

[class*="_stack"] {
  position: relative;
  z-index: 1;
}

[class*="_headline"] {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 12px !important;
}

[class*="_headlineText"] {
  font-family: Geist, Inter, system-ui, -apple-system, sans-serif !important;
  font-size: 32px !important;
  font-weight: 600 !important;
  line-height: 40px !important;
  letter-spacing: -1.28px !important;
  color: #171717 !important;
}

body[data-ds-dark-theme] [class*="_headlineText"] {
  color: #ffffff !important;
}

[class*="_previewBadge"] {
  display: none !important;
}

/* ── Input Card (Vercel Card-Marketing / Stacked Shadow) ── */
[class*="_card"] {
  background: #ffffff !important;
  border: 1px solid #ebebeb !important;
  border-radius: 16px !important;
  box-shadow: 0px 1px 1px rgba(0,0,0,0.03), 0px 2px 4px rgba(0,0,0,0.04), 0px 8px 16px -4px rgba(0,0,0,0.03) !important;
  transition: border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

[class*="_card"]:focus-within {
  border-color: #171717 !important;
  box-shadow: 0px 1px 1px rgba(0,0,0,0.03), 0px 4px 12px rgba(0,0,0,0.08), 0 0 0 1px #171717 !important;
}

body[data-ds-dark-theme] [class*="_card"] {
  background: #0F172A !important;
  border: 1px solid rgba(255,255,255,0.12) !important;
  box-shadow: 0px 2px 4px rgba(0,0,0,0.4), 0px 8px 24px -4px rgba(0,0,0,0.6) !important;
}

body[data-ds-dark-theme] [class*="_card"]:focus-within {
  border-color: rgba(255,255,255,0.35) !important;
  box-shadow: 0px 2px 4px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.35) !important;
}

/* ── Vercel Pill Buttons (button-primary: 100px pill) ── */
[class*="_primary"][role="button"],
button[class*="_primary"] {
  border-radius: 100px !important;
  background: #171717 !important;
  color: #ffffff !important;
  font-family: Geist, Inter, system-ui, -apple-system, sans-serif !important;
  font-weight: 500 !important;
  transition: background-color 0.15s ease !important;
}

[class*="_primary"][role="button"]:hover,
button[class*="_primary"]:hover {
  background: #333333 !important;
}

body[data-ds-dark-theme] [class*="_primary"][role="button"],
body[data-ds-dark-theme] button[class*="_primary"] {
  background: #ffffff !important;
  color: #171717 !important;
}

body[data-ds-dark-theme] [class*="_primary"][role="button"]:hover,
body[data-ds-dark-theme] button[class*="_primary"]:hover {
  background: #e5e5e5 !important;
}

/* ── Sidebar & Layout Frames ── */
[class*="_frame"] {
  background-color: #fafafa !important;
}

body[data-ds-dark-theme] [class*="_frame"] {
  background-color: #08090C !important;
}

[class*="_sidebarCol"] {
  background-color: #ffffff !important;
  border-right: 1px solid #ebebeb !important;
}

body[data-ds-dark-theme] [class*="_sidebarCol"] {
  background-color: #0B0F19 !important;
  border-right: 1px solid rgba(255,255,255,0.08) !important;
}

/* ── Code Blocks & Inline Mono ── */
pre, code, [class*="_code"] {
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace !important;
}

/* ── Monk Brand Mark & Animations ── */
.monk-brand-mark{display:block;flex:none;border-radius:12px;overflow:hidden}
.monk-brand-name{display:inline-flex;align-items:center;gap:8px;min-width:0;font-family:Geist,Inter,system-ui,-apple-system,sans-serif}
.monk-brand-word{font-size:16px;font-weight:600;letter-spacing:-0.6px;line-height:1.2;color:var(--dsw-alias-label-primary,#171717)}
.monk-brand-badge{font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;font-size:10px;font-weight:500;line-height:1.4;padding:2px 8px;border-radius:9999px;white-space:nowrap;color:#EA580C;background:rgba(249,115,22,.10);border:1px solid rgba(249,115,22,.24)}
body[data-ds-dark-theme] .monk-brand-badge{color:#FB923C;background:rgba(249,115,22,.14);border-color:rgba(249,115,22,.32)}

.monk-halo{stroke-dasharray:720 180;animation:monk-halo-spin 7s linear infinite}
.monk-head{transform-box:fill-box;transform-origin:center;animation:monk-head-pulse 2.2s ease-in-out infinite}
.monk-robe-l,.monk-robe-r,.monk-core{transform-box:fill-box;transform-origin:50% 85%}
.monk-robe-l{animation:monk-flame-l 1.7s ease-in-out infinite}
.monk-robe-r{animation:monk-flame-r 1.95s ease-in-out infinite}
.monk-core{animation:monk-core-rise 1.5s ease-in-out infinite}
.monk-spark-a{animation:monk-spark 2.1s ease-in-out infinite}
.monk-spark-b{animation:monk-spark 2.6s ease-in-out infinite .4s}
.monk-spark-c{animation:monk-spark 2.3s ease-in-out infinite .9s}
@keyframes monk-halo-spin{to{stroke-dashoffset:-900}}
@keyframes monk-head-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
@keyframes monk-flame-l{0%,100%{transform:scale(1,1) rotate(0);opacity:.9}35%{transform:scale(1.04,1.1) rotate(-3deg);opacity:1}70%{transform:scale(.96,.92) rotate(2deg);opacity:.8}}
@keyframes monk-flame-r{0%,100%{transform:scale(1,1) rotate(0);opacity:.9}40%{transform:scale(.97,.9) rotate(3deg);opacity:.82}68%{transform:scale(1.05,1.12) rotate(-2deg);opacity:1}}
@keyframes monk-core-rise{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.08)}}
@keyframes monk-spark{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
@media (prefers-reduced-motion:reduce){.monk-halo,.monk-head,.monk-robe-l,.monk-robe-r,.monk-core,.monk-spark-a,.monk-spark-b,.monk-spark-c{animation:none}}
`

/**
 * 挂载品牌样式表。
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
 * 渲染 Monk 标志。
 *
 * 几何与渐变逐项取自 monk.party 的 `monk-logo.svg`（512 方框、圆角 128、
 * 光环 + 头部 + 双袖 + 核心 + 三颗火花），只把渐变 id 加上 `monkBrand`
 * 前缀，避免与页面上其它内联 SVG 撞名。
 *
 * 侧栏与首屏共用同一个组件：首屏的 owner 会传 `size: 34`，与侧栏图标尺寸一
 * 致，两处品牌因此不会长得不一样。首屏 owner 还会传一个 `className`（原本挂
 * 在那条动画鱼上的类，带悬停游动动画），这里**故意不采纳**——它描述的是鱼的
 * 几何与动效，套到标志上会让 logo 像鱼一样摆尾。方形尺寸由 `size` 单独给出，
 * 布局不依赖那个类。
 * @param props - 外壳给出的方形边长（px）。
 * @returns Monk 标志元素。
 */
function MonkBrandMark({ size }) {
  const edge = Number.isFinite(size) && size > 0 ? size : 32
  return jsxs('svg', {
    className: 'monk-brand-mark',
    width: edge,
    height: edge,
    viewBox: '0 0 512 512',
    fill: 'none',
    role: 'img',
    'aria-label': 'Monk',
    children: [
      jsxs('defs', {
        children: [
          jsxs('linearGradient', {
            id: 'monkBrandBg',
            x1: '0%',
            y1: '0%',
            x2: '100%',
            y2: '100%',
            children: [
              jsx('stop', { offset: '0%', stopColor: MONK.ink900 }),
              jsx('stop', { offset: '100%', stopColor: MONK.ink950 }),
            ],
          }, 'bg'),
          jsxs('linearGradient', {
            id: 'monkBrandFlame',
            x1: '0%',
            y1: '100%',
            x2: '100%',
            y2: '0%',
            children: [
              jsx('stop', { offset: '0%', stopColor: MONK.orange600 }),
              jsx('stop', { offset: '50%', stopColor: MONK.orange500 }),
              jsx('stop', { offset: '100%', stopColor: '#FDE047' }),
            ],
          }, 'flame'),
          jsxs('linearGradient', {
            id: 'monkBrandHalo',
            x1: '0%',
            y1: '0%',
            x2: '0%',
            y2: '100%',
            children: [
              jsx('stop', { offset: '0%', stopColor: MONK.orange400, stopOpacity: '0.6' }),
              jsx('stop', { offset: '100%', stopColor: MONK.orange500, stopOpacity: '0.05' }),
            ],
          }, 'halo'),
          jsx('filter', {
            id: 'monkBrandGlow',
            x: '-30%',
            y: '-30%',
            width: '160%',
            height: '160%',
            children: [
              jsx('feGaussianBlur', { stdDeviation: '16', result: 'blur' }),
              jsx('feComposite', { in: 'SourceGraphic', in2: 'blur', operator: 'over' }),
            ],
          }, 'glow'),
        ],
      }, 'defs'),
      jsx('rect', { width: '512', height: '512', rx: '128', fill: 'url(#monkBrandBg)' }),
      jsx('rect', {
        width: '512',
        height: '512',
        rx: '128',
        stroke: 'rgba(255,255,255,0.08)',
        strokeWidth: '4',
      }),
      jsx('circle', {
        className: 'monk-halo',
        cx: '256',
        cy: '246',
        r: '150',
        stroke: 'url(#monkBrandHalo)',
        strokeWidth: '12',
        strokeLinecap: 'round',
        fill: 'none',
      }),
      jsxs('g', {
        filter: 'url(#monkBrandGlow)',
        children: [
          jsx('circle', {
            className: 'monk-head',
            cx: '256',
            cy: '148',
            r: '32',
            fill: 'url(#monkBrandFlame)',
          }),
          jsx('path', {
            className: 'monk-robe-l',
            d: 'M 172 384 L 208 220 L 256 280 L 224 384 Z',
            fill: 'url(#monkBrandFlame)',
            opacity: '0.9',
          }),
          jsx('path', {
            className: 'monk-robe-r',
            d: 'M 340 384 L 304 220 L 256 280 L 288 384 Z',
            fill: 'url(#monkBrandFlame)',
            opacity: '0.9',
          }),
          jsx('path', {
            className: 'monk-core',
            d: 'M 256 216 L 278 284 L 256 372 L 234 284 Z',
            fill: '#FFFBEB',
          }),
        ],
      }, 'figure'),
      jsx('circle', { className: 'monk-spark-a', cx: '380', cy: '170', r: '8', fill: '#38BDF8' }),
      jsx('circle', { className: 'monk-spark-b', cx: '132', cy: '310', r: '6', fill: '#A855F7' }),
      jsx('circle', { className: 'monk-spark-c', cx: '360', cy: '340', r: '7', fill: MONK.amber500 }),
    ],
  })
}

/**
 * 渲染 Monk 字标与副标。
 *
 * 排版照搬 monk.party 头部：粗体紧排的 "Monk" 加一枚橙色圆角徽标。
 * @returns 字标元素。
 */
function MonkBrandName() {
  return jsxs('span', {
    className: 'monk-brand-name',
    children: [
      jsx('span', { className: 'monk-brand-word', children: 'Monk' }),
      jsx('span', { className: 'monk-brand-badge', children: 'Flash Fusion' }),
    ],
  })
}

/** 需要的服务：槽位注册表。 */
const inject = ['slots']

/**
 * 把浏览器标题里的产品段换成 Monk。
 *
 * 只认**以产品名结尾**的标题：外壳拼的是 `${会话标题} — ${产品名}`，而会话
 * 标题是用户内容——用户完全可能把会话命名成含 "DeepSeek Harness" 的字样，
 * 用 `includes` 会改到用户自己写的那一段。
 * @param current - 当前 `document.title`。
 * @returns 需要写入的新标题；无需改动时返回 `undefined`。
 */
function monkTitle(current) {
  if (typeof current !== 'string' || !current.endsWith(PRODUCT_TITLE)) return undefined
  const branded = current.slice(0, current.length - PRODUCT_TITLE.length) + BRAND_TITLE
  return branded === current ? undefined : branded
}

/**
 * 观察 `<title>` 并改写产品段。
 *
 * 外壳的标题是 React 受控写入的，会随会话标题反复变化，因此必须持续观察
 * 而不是只改一次。改写自身会再触发一次观察回调，但那时标题已不再以产品名
 * 结尾，回调直接返回——不会自激。
 * @returns 断开观察的清理函数。
 */
function observeTitle() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const apply = () => {
    const next = monkTitle(document.title)
    if (next !== undefined) document.title = next
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * 观察并替换浏览器 `<head>` 中的 favicon 节点。
 *
 * 把外壳默认的 icon link 改写为 Monk 僧侣标志 SVG；若不存在 icon link 则动态追加。
 * @returns 断开观察与清理函数。
 */
function observeFavicon() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return () => {}

  const applyFavicon = () => {
    let link = document.querySelector('link[rel*="icon"]')
    if (link === null) {
      link = document.createElement('link')
      link.setAttribute('rel', 'icon')
      document.head.appendChild(link)
    }
    if (link.getAttribute('href') !== MONK_FAVICON_DATA_URL) {
      link.setAttribute('type', 'image/svg+xml')
      link.setAttribute('href', MONK_FAVICON_DATA_URL)
    }
  }

  applyFavicon()

  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(applyFavicon)
  observer.observe(document.head, { childList: true, subtree: true, attributes: true })
  return () => observer.disconnect()
}

/**
 * 判断元素是否带着某个 CSS Module 局部名。
 *
 * 产物里的类名形如 `pXSMma_headlineText`；开发构建（未经压缩的 CSS Module）
 * 可能产出 `headlineText_hash` 或裸 `headlineText`。三种形态都认，因此这里不
 * 写死哈希。用 `getAttribute` 而不是 `element.className`：后者的类型在 HTML
 * 元素上是字符串、在 SVG 元素上是 `SVGAnimatedString`，而 `getAttribute` 对两
 * 者都返回字符串。
 * @param element - 候选元素。
 * @param local - CSS Module 的局部名。
 * @returns 是否命中。
 */
function hasLocalClass(element, local) {
  if (element === null || element === undefined) return false
  const raw = typeof element.getAttribute === 'function' ? element.getAttribute('class') : undefined
  if (typeof raw !== 'string') return false
  return raw.split(/\s+/).some(token =>
    token === local || token.endsWith(`_${local}`) || token.startsWith(`${local}_`))
}

/**
 * 把首屏某个文案节点改写成 Monk 文案。
 *
 * 两道闸门，缺一不可：
 *
 * - **类名**决定"这是不是首屏那个节点"。文案本身没有任何标记，只按文本内容找
 *   会改到用户自己写的消息。
 * - **原文**决定"要不要动手"。上游把文案换掉之后这里就放手，宁可少改一次也
 *   不去覆盖一段我们不认识的文字；已经是目标文案时直接返回，因此改写自身触发
 *   的观察回调不会自激。
 *
 * 写入用 `firstChild.nodeValue` 而不是 `element.textContent`：React 的 fiber 里
 * 存着那个文本节点的引用，`textContent =` 会把它换成新节点，此后 React 再更新
 * 这段文字就是在改一个**已经脱离文档**的节点——界面上永远停在旧值。改
 * `nodeValue` 保住引用，React 之后的每次写入都还能生效。
 * @param element - 候选元素。
 * @returns 是否发生了改写。
 */
function rewriteHeroCopy(element) {
  if (element === null || element === undefined) return false
  for (const entry of HERO_COPY) {
    if (!hasLocalClass(element, entry.local)) continue
    const text = element.firstChild
    const current = text !== null && text !== undefined && text.nodeType === 3
      ? text.nodeValue
      : element.textContent
    if (current === entry.to) return false
    if (!entry.from.includes(current)) return false
    if (text !== null && text !== undefined && text.nodeType === 3) text.nodeValue = entry.to
    else element.textContent = entry.to
    return true
  }
  return false
}

/**
 * 确保在空白会话首屏中插入 Vercel 签名多色 Mesh Gradient 氛围底色。
 */
function ensureMeshGradient() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
  const headline = document.querySelector(HERO_COPY_SELECTOR)
  if (headline === null) return
  const root = typeof headline.closest === 'function' ? headline.closest('[class*="_root"]') : null
  if (root === null) return
  if (typeof root.querySelector === 'function' && root.querySelector('.monk-mesh-gradient') !== null) return
  const gradient = document.createElement('div')
  gradient.className = 'monk-mesh-gradient'
  gradient.setAttribute('aria-hidden', 'true')
  if (typeof root.prepend === 'function') root.prepend(gradient)
}

/**
 * 在一个（新增的）节点及其子树里查找首屏文案节点并改写。
 *
 * 文本节点要往上看一层：React 把 `{t("hero.headline")}` 渲染成一个文本节点，
 * 变更记录里的 target 就是它，类名在它的父元素上。
 * @param node - 变更记录涉及或新插入的节点。
 */
function sweepHeroCopy(node) {
  if (node === null || node === undefined) return
  if (node.nodeType === 3) {
    rewriteHeroCopy(node.parentElement)
    ensureMeshGradient()
    return
  }
  if (node.nodeType !== 1) return
  rewriteHeroCopy(node)
  if (typeof node.querySelectorAll === 'function') {
    for (const element of node.querySelectorAll(HERO_COPY_SELECTOR)) rewriteHeroCopy(element)
  }
  ensureMeshGradient()
}

/**
 * 观察 DOM 并保持首屏文案是 Monk 文案。
 *
 * 只做增量：文本节点的改动直接看 target 的父元素，新增子树只扫新增的那一棵。
 * 首屏在空白会话里挂载、离开会话时卸载，全量扫描 `document.body` 会落在每一
 * 条流式输出的 DOM 变更上，代价与收益不成比例。
 *
 * 唯一的全量扫描是**启动时那一次**：本插件的激活可能晚于首屏挂载（客户端插件
 * 是异步加载的），那时首屏已经在屏幕上，没有任何变更记录会告诉我们它存在。
 *
 * 返回清理函数交给 `ctx.effect`，插件卸载与 HMR 一并撤销观察。
 * @returns 断开观察的清理函数。
 */
function observeHeroCopy() {
  if (typeof document === 'undefined') return () => {}
  sweepHeroCopy(document.body)
  ensureMeshGradient()
  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        rewriteHeroCopy(record.target.parentElement)
        ensureMeshGradient()
        continue
      }
      for (const node of record.addedNodes) sweepHeroCopy(node)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * 客户端插件体。
 *
 * 五件事，都是可撤销副作用：注入样式、占住三个品牌槽位（侧栏标志、侧栏字标、
 * 首屏标志）、在活动主题之上叠一层 Monk 令牌覆盖、改写两处外壳硬编码的文案
 * （浏览器标题与首屏标题/徽标）。主题覆盖走 `ctx.inject` 而不是写进 `inject`
 * ——主题服务缺席时品牌仍应照常渲染，不该整包不加载。
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
  ctx.effect(() => injectStyles())
  ctx.effect(() => observeTitle())
  ctx.effect(() => observeFavicon())
  ctx.effect(() => observeHeroCopy())
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MonkBrandMark)
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, MonkBrandName)
  }))
  ctx.slots.inject(HERO_MARK_SLOT, () => ctx.slots.register({ name: HERO_MARK_SLOT }, MonkBrandMark))
  ctx.inject(['theme'], (themed) => {
    themed.effect(() => themed.theme.overrideTokens(PACKAGE_ID, MONK_THEME_TOKENS))
  })
}

export {
  PACKAGE_ID,
  MONK,
  MONK_THEME_TOKENS,
  PRODUCT_TITLE,
  BRAND_TITLE,
  MONK_FAVICON_DATA_URL,
  HERO_MARK_SLOT,
  HERO_COPY,
  HERO_COPY_SELECTOR,
  STYLES,
  monkTitle,
  observeFavicon,
  hasLocalClass,
  rewriteHeroCopy,
  sweepHeroCopy,
  observeHeroCopy,
  inject,
  apply,
}
