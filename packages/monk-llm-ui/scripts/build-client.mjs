/**
 * 把 `src/client/index.js` 打包成浏览器模块系统的惰性工厂格式。
 *
 * dsh 的客户端模块系统在浏览器里是一张**惰性 CJS 表**：每个 bundle 执行时只
 * 注册自己的工厂（`window.__ModuleLoader__.load({ id, factory })`），工厂体要等
 * 第一次被 import/require 时才运行。官方 bundle 由 tsdown 产出，本包没有那条
 * 工具链，所以在这里做同一件事——但只做一次**受校验**的改写，而不是手写产物：
 * 产物与源码不会漂移，因为产物是每次构建重新生成的。
 *
 * 改写规则是一张表，每条都**必须**命中：静默产出半成品 bundle 的代价是浏览器
 * 里一个不报错的空白密钥框，排查成本远高于构建期报错。表末还有一道兜底——
 * 改写后任何残留的行首 `import`/`export` 都会让构建失败。
 *
 * 用法：node scripts/build-client.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const SOURCE = join(PACKAGE_ROOT, 'src/client/index.js')
const TARGET = join(PACKAGE_ROOT, 'lib/client.js')

/**
 * 允许出现的 ESM 导入，以及它们各自的工厂体写法。
 *
 * 表是**封闭**的：没列在这里的导入不会被改写，于是会被兜底检查拦下。
 * @type {ReadonlyArray<{ name: string, pattern: RegExp, replacement: string }>}
 */
const IMPORTS = [
  {
    name: 'react/jsx-runtime',
    pattern: /^import\s*\{\s*jsx,\s*jsxs\s*\}\s*from\s*'react\/jsx-runtime'\s*$/m,
    replacement: "const { jsx, jsxs } = require('react/jsx-runtime');",
  },
  {
    name: 'react',
    pattern: /^import\s*\*\s*as\s*React\s*from\s*'react'\s*$/m,
    replacement: "const React = require('react');",
  },
]

/** 源码末尾的具名导出清单。 */
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*$/m

/** 任何残留的行首 ESM 语句都说明有未被处理的东西。 */
const LEFTOVER_ESM = /^\s*(?:import|export)\s/m

/**
 * 读取包名——浏览器模块 id 必须等于它，因为模块图按包名寻址。
 * @returns 包名。
 */
async function packageName() {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  return manifest.name
}

/**
 * 逐条改写导入、把具名导出清单转成 `exports.x = x`，任一不匹配即抛错。
 * @param source - ESM 源码。
 * @returns 工厂体可用的 CJS 源码。
 */
function toCommonJsBody(source) {
  let rewritten = source
  for (const entry of IMPORTS) {
    if (!entry.pattern.test(rewritten)) {
      throw new Error(`build-client: ${entry.name} 导入未找到——源码结构与构建脚本已不一致`)
    }
    rewritten = rewritten.replace(entry.pattern, entry.replacement)
  }

  const exportMatch = EXPORT_LIST.exec(rewritten)
  if (exportMatch === null) {
    throw new Error('build-client: 具名导出清单未找到——源码结构与构建脚本已不一致')
  }
  const names = exportMatch[1].split(',').map(part => part.trim()).filter(Boolean)
  if (names.length === 0) throw new Error('build-client: 导出清单为空')
  const assignments = names.map(name => `exports.${name} = ${name};`).join('\n\t\t')
  const withExports = rewritten.replace(EXPORT_LIST, assignments)

  if (LEFTOVER_ESM.test(withExports)) {
    throw new Error('build-client: 改写后仍残留行首 import/export——工厂体会在浏览器里语法报错')
  }
  return withExports
}

/**
 * 包成模块系统的工厂。
 *
 * 工厂体**原样嵌入，不做逐行缩进**：缩进会连带改写模板字符串的内容（样式表
 * 就是一段模板字符串），把"代码排版"变成"改数据"。将来若有人在这里放一段带
 * 语义缩进的文本（生成的 Markdown、代码片段），缩进会静默破坏它。换来的只是
 * 产物少两格缩进，不值得。
 * @param id - 浏览器模块 id（包名）。
 * @param body - CJS 工厂体。
 * @returns bundle 文本。
 */
function wrap(id, body) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`
}

const id = await packageName()
const body = toCommonJsBody(await readFile(SOURCE, 'utf8'))
const bundle = wrap(id, body)
await mkdir(dirname(TARGET), { recursive: true })
await writeFile(TARGET, bundle)

const lines = bundle.split('\n').length
console.log(`build-client: ${id} -> lib/client.js (${lines} 行)`)
