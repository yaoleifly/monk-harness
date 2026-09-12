/**
 * `monk-bundle` 的运行时胶水插件。
 *
 * 组合包（bundle）本身只是 `cordis.patch.yml` 里的一层行；本插件承载那些
 * **必须是代码而不是配置**的部分。当前它只做一件事：启动自检。
 *
 * 为什么值得单独一个插件：配置错位在 dsh 里是**静默**的。patch 按 id 定位，
 * 找不到目标 id 的行会被忽略；把 `agent-default-model` 写成别的 provider 也
 * 不会报错，只会在用户发第一条消息时以 `NO_ADAPTER` 失败。启动自检把这个
 * 失败提前到进程启动的第一秒，并且把"该怎么修"直接写进日志。
 * @module @monk/monk-bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MONK_PROVIDER } from '@monk/monk-llm'

export const name = 'monk-bundle'
export const inject = ['llm']

/** 自检结果。 */
export interface SelfCheckResult {
  /** 提供方路由是否已注册。 */
  routeRegistered: boolean
  /** 默认模型是否指向 Monk。 */
  defaultIsMonk: boolean
  /** API 密钥是否已配置。 */
  keyConfigured: boolean
  /** 已注册的模型 id。 */
  models: readonly string[]
  /** 面向人的诊断信息；无问题时为空数组。 */
  diagnostics: readonly string[]
}

/**
 * 执行启动自检。
 *
 * 只读取注册表，不修改任何状态——自检必须可以在任何时候安全地重跑。
 * @param ctx - Cordis 上下文。
 * @returns 自检结果。
 */
export async function selfCheck(ctx: Context): Promise<SelfCheckResult> {
  const diagnostics: string[] = []
  const providers = ctx.llm.listProviders()
  const routeRegistered = providers.some(provider => provider.id === MONK_PROVIDER)

  if (!routeRegistered) {
    diagnostics.push(
      `monk-bundle: provider route "${MONK_PROVIDER}" is not registered. `
      + 'Check that the "@monk/monk-llm" row is present and enabled in the composed profile tree '
      + '(run `dsh --profile monk --dump-config` to inspect it).',
    )
  }

  const models = routeRegistered
    ? (await ctx.llm.listModels(MONK_PROVIDER)).map(model => model.id)
    : []

  if (routeRegistered && models.length === 0) {
    diagnostics.push(
      `monk-bundle: provider route "${MONK_PROVIDER}" registered but advertises no models. `
      + 'The catalog in the monk-llm settings section is probably empty.',
    )
  }

  const defaultModel = ctx.get('agentDefaultModel')?.current?.()
  const defaultIsMonk = defaultModel?.provider === MONK_PROVIDER
  if (routeRegistered && defaultModel !== undefined && !defaultIsMonk) {
    // 不是错误：用户完全可以把默认模型指到别的提供方。但 monk-harness 的
    // 默认意图是走 Monk，因此说清楚当前实际用的是谁。
    diagnostics.push(
      `monk-bundle: the default model is "${defaultModel.provider}/${defaultModel.model}" `
      + `rather than "${MONK_PROVIDER}". New sessions will not use Monk unless the user picks it.`,
    )
  }

  let keyConfigured = false
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(credentialRef('MONK_API_KEY'))
    if (hit !== undefined && hit.value.length > 0) {
      keyConfigured = true
    }
  }
  if (!keyConfigured && process.env.MONK_API_KEY && process.env.MONK_API_KEY.length > 0) {
    keyConfigured = true
  }

  if (routeRegistered && !keyConfigured) {
    diagnostics.push(
      `monk-bundle: MONK_API_KEY credential is not configured. `
      + 'Paste your key in the Models settings card or export MONK_API_KEY="sk-..." in your environment.',
    )
  }

  return { routeRegistered, defaultIsMonk, keyConfigured, models, diagnostics }
}

/**
 * 插件挂载点。
 *
 * 自检在挂载时跑一次并把结果写进日志，同时把结果放进服务供 `/monk doctor`
 * 之类的入口随时重查。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  const run = async (): Promise<SelfCheckResult> => selfCheck(ctx)

  ctx.provide('monkHarness', {
    provider: MONK_PROVIDER,
    selfCheck: run,
  } satisfies MonkHarnessService)

  // 用微任务推迟到组合树稳定之后：挂载顺序不保证 monk-llm 已经先注册。
  queueMicrotask(() => {
    void run().then((result) => {
      if (result.diagnostics.length === 0) {
        ctx.logger.info(`monk-harness ready: ${result.models.length} model(s) on route "${MONK_PROVIDER}"`)
        return
      }
      for (const diagnostic of result.diagnostics) ctx.logger.warn(diagnostic)
    }).catch((error: unknown) => {
      ctx.logger.error('monk-bundle: self-check failed')
      ctx.logger.error(error)
    })
  })
}

/** 本插件向其它插件暴露的服务。 */
export interface MonkHarnessService {
  /** 本发行版使用的提供方路由键。 */
  readonly provider: string
  /** 重跑启动自检。 */
  selfCheck(): Promise<SelfCheckResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Monk 发行版自检面；由 `@monk/monk-bundle` 提供。 */
    monkHarness: MonkHarnessService
  }
}
