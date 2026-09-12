/**
 * `monk-llm` 插件入口。
 *
 * 把 Monk 融合模型注册为 dsh 的一个提供方路由（`monk-official`）。连接事实
 * 按请求解析而不是加载时冻结：
 *
 * - 插件的 `cordis.yml` 条目 config 作为**组合基础**；
 * - 用户设置文档中的 `monk-llm:` 段落叠加在其上（热重载，无需重启）；
 * - API Key 通过凭据 seam 按请求解析，因此轮换后的密钥在紧接着的
 *   下一次请求中生效。
 *
 * 一个注册期捕获的事实例外：重试策略。它在注册时被注册表快照，变更时用
 * `registration.replace()` 原地替换路由——不做 dispose + 重新注册，因为那会
 * 在两步之间发布一个空路由集，让观察者看到提供方"消失又回来"。
 * @module @monk/monk-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
// 仅类型导入：为 `ctx.settings` 与 `ctx.credentials` 触发声明合并。
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import {
  DEFAULT_MONK_MODELS,
  resolveCatalog,
  type MonkCatalogModel,
  type MonkTier,
} from './catalog.ts'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MONK_PROVIDER,
  MonkAdapter,
  type ResolvedMonkOptions,
} from './adapter.ts'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

export const name = 'monk-llm'
export const inject = ['llm']

/**
 * 设置命名空间，对应 `$DSH_HOME/settings.yaml` 中的顶层键。
 *
 * 这是**跨包契约**，不是本包内部细节：Models 设置页按 `settingsNs` 给
 * `settings.models.provider-card` 槽位分键，因此伴生界面插件
 * （`@monk/monk-llm-ui`）必须用同一个字符串去认领本家族的卡片。改这个值
 * 会让界面插件静默收不到任何卡片，所以它被导出、并被两侧的测试钉住。
 */
export const SETTINGS_NS = 'monk-llm'

const NS = SETTINGS_NS

/** 缺省凭据引用：密钥所在的环境变量名。 */
export const DEFAULT_API_KEY_ENV = 'MONK_API_KEY'

/** 端点基址环境变量名；只在受信环境层生效。 */
const BASE_URL_ENV = 'MONK_BASE_URL'

/** monk.party 的公开端点。 */
export const PUBLIC_BASE_URL = 'https://monk.party/v1'

/** 目录项 schema。 */
const catalogModel: z<MonkCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string(),
  tier: z.union(['quality', 'fast', 'coding'] as const).default('quality'),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'] as const)).min(1).default(['text']),
})

/**
 * 插件配置。
 *
 * 每个字段在 yml 中都可省略：缺少密钥不会在加载时失败，而是在请求时以
 * `MISSING_CREDENTIAL` 报错；省略推理强度使用提供方默认值。
 */
export interface Config {
  /** 凭据引用（环境变量名）；缺省 `MONK_API_KEY`。 */
  apiKeyEnv?: string
  /** 端点基址；缺省读 `$MONK_BASE_URL`，再退到公开端点。 */
  baseURL?: string
  /** 是否开启 Monk 实时联网搜索（带 HTTP 头 X-Monk-Web-Search: true）。 */
  webSearch?: boolean
  /** 缺省推理强度。 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 缺省单次输出上限；模型的自身上限与请求显式值优先。 */
  maxTokens?: number
  /** 建议目录；缺省为 monk / monk-fast / monk-coding。 */
  models?: MonkCatalogModel[]
  /** 单次流读取的最长空闲时间（毫秒），缺省五分钟。 */
  streamIdleTimeoutMs?: number
  /** 提供方拥有的重试策略；省略表示正常模式、五次重试。 */
  retryPolicy?: RetryPolicyConfig
  /**
   * 默认分层：当请求未显式指定模型时，由 `monk-router` 按任务类型选路。
   * 本字段只作为**没有 router 时**的兜底默认。
   */
  defaultTier?: MonkTier
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  webSearch: z.boolean().default(false),
  reasoningEffort: z.union(['low', 'medium', 'high'] as const),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  models: z.array(catalogModel).default([...DEFAULT_MONK_MODELS]),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  defaultTier: z.union(['quality', 'fast', 'coding'] as const),
})

/** 本插件暴露给其它插件的服务名。 */
export const MONK_SERVICE = 'monk'

/**
 * 本插件向其它插件暴露的服务。
 *
 * 存在的理由：目录与"分层 → 模型 id"的解析属于**适配器**的知识，路由策略
 * 不该各自复制一份。`monk-router` 通过这个接缝读取目录，因此用户在设置里
 * 换了模型 id 后，路由会立刻跟着变，无需两处同步。
 */
export interface MonkService {
  /** 本适配器拥有的提供方路由键。 */
  readonly provider: string
  /** 当前的目录快照（已校验、已脱离）。 */
  catalog(): readonly MonkCatalogModel[]
  /**
   * 把定位分层解析为具体模型 id。
   * @param tier - 目标分层。
   * @returns 该分层对应的模型 id；目录中没有该分层时返回 `undefined`。
   */
  resolveTier(tier: MonkTier): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Monk 适配器服务；由 `@monk/monk-llm` 提供。 */
    monk: MonkService
  }
}

/**
 * 解析、校验并脱离一份连接事实。
 *
 * 编程式构造可以绕过 Schemastery 归一化，因此每个默认值与边界都在这里重新
 * 判定一次——组合入口在加载时失败要"响亮"。
 * @param config - 原始插件配置或已解析的设置快照。
 * @returns 已校验的连接事实。
 */
export function resolveAdapterOptions(config: Config): ResolvedMonkOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isSafeInteger(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('monk-llm: streamIdleTimeoutMs must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('monk-llm: maxTokens must be a positive safe integer')
  }
  // 环境变量属于**启动环境**这一受信层，因此可以覆盖公开端点；设置区（可被
  // 运行时改写）仍然优先于它，因为显式配置比环境更具体。
  const ambientBaseURL = process.env[BASE_URL_ENV]
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? (ambientBaseURL !== undefined && ambientBaseURL.length > 0 ? ambientBaseURL : PUBLIC_BASE_URL),
    models: resolveCatalog(config.models),
    ...config.webSearch === undefined ? {} : { webSearch: config.webSearch },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    streamIdleTimeoutMs,
    ...config.retryPolicy === undefined ? {} : { retryPolicy: config.retryPolicy },
  }
}

/**
 * 插件挂载点。
 *
 * 所有注册都是**副作用**：卸载本插件即撤销路由与可配置提供方条目。
 * @param ctx - Cordis 上下文。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedMonkOptions | undefined

  const options = (): ResolvedMonkOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // 静态组合在任何注册之前解析，因此这里只可能是"实时设置快照越过了
      // schema 之外的边界"：继续服务上一份好事实，并每次坏快照报一次错。
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('monk-llm: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedMonkOptions): Promise<string> => {
    // 每个凭据事实都取自调用方的快照，被拒的设置世代无法把它的密钥
    // 泄漏到上一代的端点上。
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'monk-llm', ref)
    } else {
      // 没有 seam 时不存在受管存储可排序，环境变量就是整个凭据平面。
      const ambient = process.env[ref]
      if (ambient !== undefined && ambient.length > 0) {
        return assertUsableApiKey(ambient, 'monk-llm', ref)
      }
    }
    throw new LlmError(
      `monk-llm: no API key for provider route "${MONK_PROVIDER}"; store ${ref} through the credentials`
      + ` service, or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new MonkAdapter({ options, resolveApiKey, getContext: () => ctx })

  // 目录接缝：路由策略读它，而不是各自复制一份模型表。
  ctx.provide(MONK_SERVICE, {
    provider: MONK_PROVIDER,
    catalog: () => options().models,
    resolveTier: (tier: MonkTier) => options().models.find(model => model.tier === tier)?.id,
  } satisfies MonkService)

  ctx.llm.registerConfigurableProviders([
    { provider: MONK_PROVIDER, displayName: 'Monk', settingsNs: NS, settingsPath: [] },
  ])

  const registration = ctx.llm.registerAdapter([MONK_PROVIDER], adapter)

  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([MONK_PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source: () => Config) => {
        current = source
      },
      onChange: ensureRegistrationFacts,
    })
  })
}

export { MONK_PROVIDER } from './adapter.ts'
export { MonkAdapter } from './adapter.ts'
export type { MonkAdapterOptions, ResolvedMonkOptions } from './adapter.ts'
export {
  DEFAULT_MONK_MODELS,
  MONK_CONTEXT_WINDOW,
  MONK_MAX_OUTPUT_TOKENS,
  MONK_MODEL_IDS,
  findCatalogModel,
  findCatalogTier,
  resolveCatalog,
} from './catalog.ts'
export type { MonkCatalogModel, MonkModelId, MonkModality, MonkTier } from './catalog.ts'
export { ChunkTranslator, mapFinishReason, normalizeUsage } from './translate.ts'
export { parseSse, SSE_DONE } from './sse.ts'
export type { SseEvent } from './sse.ts'
export { serializeMessages, serializeRequest, serializeTools } from './serialize.ts'
export type { ResolvedImage, SerializeInput } from './serialize.ts'
export type * from './wire.ts'
