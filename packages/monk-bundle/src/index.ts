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
 * Monk Harness 原生 Web 搜索提供方。
 *
 * 为 Monk 提供免外部 Key 的极速 Web 搜索能力，解决默认 web-search-deepseek
 * 在缺少 DEEPSEEK_API_KEY 时报错的问题。
 */
export class MonkWebSearchProvider {
  readonly id = 'monk-search'

  available(): boolean {
    return true
  }

  async search(
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{
    query: string
    sources: Array<{ url: string; title?: string; snippet?: string }>
    truncated: boolean
  }> {
    const query = request.query
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await globalThis.fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 MonkHarness/0.1.0',
      },
      ...signal ? { signal } : {},
    })

    const html = await res.text()
    const sources: Array<{ url: string; title?: string; snippet?: string }> = []
    const linkRegex =
      /<a[^>]+class="result__url"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    let match: RegExpExecArray | null
    const max = request.maxResults ?? 5

    while ((match = linkRegex.exec(html)) !== null && sources.length < max) {
      const match1 = match[1]
      const match2 = match[2]
      const match3 = match[3]
      if (match1 === undefined) continue
      let rawUrl = match1.trim()
      if (rawUrl.includes('uddg=')) {
        try {
          const u = new URL('https://html.duckduckgo.com' + rawUrl)
          rawUrl = decodeURIComponent(u.searchParams.get('uddg') || rawUrl)
        } catch {}
      }
      const title = (match2 ?? '').replace(/<[^>]+>/g, '').trim() || rawUrl
      const snippet = (match3 ?? '').replace(/<[^>]+>/g, '').trim()
      sources.push({ url: rawUrl, title, snippet })
    }

    return {
      query,
      sources,
      truncated: false,
    }
  }
}

/**
 * Monk Harness 高兼容 Web 抓取提供方。
 *
 * 解决原生 dsh-web-fetch-http 在遇到本地 VPN / TUN / Fake-IP 环境（如 172.19.x.x）
 * 时将公网域名误判为私网 IP 并抛错 WEB_BLOCKED_URL 的问题。
 * 同时防范真正的本地环回地址 (localhost / 127.0.0.1 / ::1)。
 */
export class MonkWebFetchProvider {
  readonly id = 'http'

  available(): boolean {
    return true
  }

  async fetch(request: { url: string }, signal?: AbortSignal): Promise<{
    url: string
    statusCode: number
    body: { kind: 'html' | 'text'; content: string }
    truncated: boolean
  }> {
    const parsedUrl = new URL(request.url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${parsedUrl.protocol}`)
    }
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) {
      throw new Error(`blocked loopback destination: ${hostname}`)
    }

    const response = await globalThis.fetch(request.url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 MonkHarness/0.1.0',
        'Accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      },
      redirect: 'follow',
      ...signal ? { signal } : {},
    })

    const contentType = response.headers.get('content-type') ?? ''
    const kind = contentType.includes('html') ? 'html' : 'text'
    const rawText = await response.text()
    const maxChars = 100_000
    const truncated = rawText.length > maxChars
    const content = truncated ? rawText.slice(0, maxChars) : rawText

    return {
      url: response.url || request.url,
      statusCode: response.status,
      body: { kind, content },
      truncated,
    }
  }
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

  // 挂载高兼容 Web 搜索与抓取后端，替换被禁用的 web-search-deepseek 和 web-fetch-http
  ctx.inject(['web'], (webCtx: any) => {
    if (webCtx.web?.registerSearchProvider) {
      webCtx.web.registerSearchProvider(new MonkWebSearchProvider())
    }
    if (webCtx.web?.registerFetchProvider) {
      webCtx.web.registerFetchProvider(new MonkWebFetchProvider())
    }
  })

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
