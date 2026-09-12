/**
 * 宿主侧插件体。
 *
 * 这个包只贡献**浏览器表现**：宿主侧是一个空 `apply()`，存在的意义是给
 * Loader 一个宿主行，好让 `dsh.client` 声明被扫描到、把 `./client` 那一半
 * 投递到浏览器。这与官方品牌包的结构一致——品牌是纯前端关切，宿主侧没有
 * 任何服务、事件或工具要注册。
 *
 * 客户端半边在 `src/client/index.ts`，经 `scripts/build-client.mjs` 打成
 * `lib/client.js`（`window.__ModuleLoader__.load` 惰性工厂格式）。
 *
 * @module @monk/monk-ui-brand
 */

/** 稳定的 Cordis 插件名。 */
export const name = 'monk-ui-brand'

/**
 * 宿主侧插件体——本包只贡献浏览器表现。
 */
export function apply(): void {}
