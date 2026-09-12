/**
 * `monk-llm-ui` 插件入口（宿主半边）。
 *
 * 本包是 `@monk/monk-llm` 的**伴生界面插件**：它唯一的产物是浏览器半边
 * （`lib/client.js`），在 Models 设置页给 `monk-official` 路由补上一个真正的
 * 密钥输入框。宿主半边刻意是空的——但**必须存在**，因为 dsh 的加载器按包名
 * 挂载插件，客户端半边由 `dsh-client-modules` 扫描加载器条目后从同一份
 * `package.json` 里读 `dsh.client` 发现。没有宿主半边就没有加载器条目，
 * 浏览器半边永远不会被请求。
 *
 * 为什么密钥字段要另开一个包，而不是塞进 Models 页：那个页面的手写编辑器
 * 只认两个设置命名空间（`llm-deepseek` / `llm-pi-ai`），其它命名空间一律落到
 * `layout: "unknown"`——只渲染一句"其余字段在 settings.yaml 中"，并把「保存」
 * 置灰。第三方适配器家族拿到的正式接缝是
 * `settings.models.provider-card`（按 `settingsNs` 分键的槽位），本包就是它的
 * 一个占用者。
 *
 * @module @monk/monk-llm-ui
 */

/** 插件名，与包名一致。 */
export const name = 'monk-llm-ui'

/**
 * 挂载点：无副作用。
 *
 * 宿主侧没有任何要注册的东西——凭据写入是浏览器半边经 `remote.credentials`
 * 走的既有 wire 面，不经过本进程。
 */
export function apply(): void {}
