/**
 * `MonkAdapter`：Monk 融合模型 API 的 dsh LLM 适配器。
 *
 * 设计要点（与 dsh 适配器契约一一对应）：
 *
 * - **每次请求重新解析连接事实**。构造函数接收的是 `options()` 解析函数而非
 *   冻结的值，因此 baseURL、目录、密钥的变更会在**下一次请求**生效，而
 *   正在飞行的流保留它启动时的那份事实。这是 dsh 的"动态适配器"约定。
 * - **`prepareCall` 绑定一代事实**。模型元数据解析与最终分派必须来自同一代
 *   配置，否则一次设置变更可能把 A 代的容量与 B 代的端点拼在一起。
 * - **失败分两条合法路径**。传输与协议故障从 `stream()` 抛出 `LlmError`
 *   （带稳定 code）；提供方带内故障以 `finish{kind:'error'}` 结束流。
 * @module @monk/monk-llm/adapter
 */

import {
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { findCatalogModel, MONK_CONTEXT_WINDOW, type MonkCatalogModel, type MonkModality } from './catalog.ts'
import { parseSse, SSE_DONE } from './sse.ts'
import { serializeRequest, type ResolvedImage } from './serialize.ts'
import { ChunkTranslator, type InBandFailure } from './translate.ts'
import type { MonkWireChunk, MonkWireErrorBody } from './wire.ts'

/** 本适配器拥有的唯一提供方路由键。 */
export const MONK_PROVIDER = 'monk-official'

/** 已解析的连接事实。密钥与端点属于同一份快照，避免新旧事实混搭。 */
export interface ResolvedMonkOptions {
  /** 凭据引用（环境变量名），每次请求解析。 */
  apiKeyEnv: CredentialRef
  /** 端点基址。 */
  baseURL: string
  /** 是否开启 Monk 实时联网搜索。 */
  webSearch?: boolean
  /** 出厂目录。 */
  models: readonly MonkCatalogModel[]
  /** 缺省推理强度。 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 缺省单次输出上限。 */
  maxTokens?: number
  /** 单个流读取的最长空闲时间（毫秒）。 */
  streamIdleTimeoutMs: number
  /** 提供方拥有的重试策略。 */
  retryPolicy?: RetryPolicyConfig
}

/** 适配器构造参数。 */
export interface MonkAdapterOptions {
  /** 每次调用都重新解析连接事实。 */
  options: () => ResolvedMonkOptions
  /** 解析一次请求要用的 API Key。 */
  resolveApiKey: (connection: ResolvedMonkOptions) => Promise<string>
  /** 解析消息中的图片引用；缺省时图片投影为占位文本。 */
  resolveImages?: (messages: GenerateOptions['messages']) => Promise<ReadonlyMap<string, readonly ResolvedImage[]>>
  /** 获取当前 Cordis 上下文，用于读取关联服务（如 monkRouter）。 */
  getContext?: () => any
  /** 注入的 fetch 实现，供测试替换。 */
  fetch?: typeof globalThis.fetch
}

/** 默认流空闲超时：五分钟。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** 将 wire 的 detail 值映射为中立词汇。 */
const DETAIL_VALUES = new Set(['auto', 'low', 'high'])

/**
 * 把目录项投影为 dsh 的模型信息。
 * @param model - 目录项。
 * @returns 模型信息。
 */
function toModelInfo(model: MonkCatalogModel): LlmModelInfo {
  const modalities: MonkModality[] = [...(model.inputModalities ?? ['text'])]
  return {
    provider: MONK_PROVIDER,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: modalities,
  }
}

/**
 * 读取一次非 2xx 响应并抛出带稳定 code 的 `LlmError`。
 *
 * 传输层与协议层故障走"抛出"路径；`stream()` 的调用方（`LlmRuntime`）会把它
 * 归一为终态的 error finish。
 * @param response - 非 2xx 响应。
 * @returns 永不返回；函数签名以 `never` 表达"总是抛出"。
 */
async function throwHttpFailure(response: Response): Promise<never> {
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // 读取响应体失败不应掩盖状态码本身，忽略。
  }
  let parsed: MonkWireErrorBody | undefined
  try {
    parsed = JSON.parse(detail) as MonkWireErrorBody
  } catch {
    parsed = undefined
  }
  const providerMessage = parsed?.error?.message ?? detail.slice(0, 500)
  const code = response.status === 401 || response.status === 403
    ? 'INVALID_CREDENTIAL'
    : response.status === 402
      ? 'QUOTA'
      : response.status === 429
        ? 'RATE_LIMIT'
        : response.status >= 500
          ? 'PROVIDER_UNAVAILABLE'
          : 'BAD_REQUEST'
  throw new LlmError(
    `monk: provider responded ${response.status}${providerMessage === '' ? '' : `: ${providerMessage}`}`,
    code,
  )
}

/**
 * Monk 提供方适配器。
 */
export class MonkAdapter extends LlmAdapter {
  private readonly resolve: () => ResolvedMonkOptions
  private readonly resolveApiKey: (connection: ResolvedMonkOptions) => Promise<string>
  private readonly resolveImages: MonkAdapterOptions['resolveImages']
  private readonly getContext: MonkAdapterOptions['getContext']
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: MonkAdapterOptions) {
    super()
    this.resolve = options.options
    this.resolveApiKey = options.resolveApiKey
    this.resolveImages = options.resolveImages
    this.getContext = options.getContext
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Monk' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    const policy = this.resolve().retryPolicy
    return policy === undefined
      ? undefined
      : resolveRetryPolicy(policy, 'monk-llm: retryPolicy')
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.resolve().models.map(toModelInfo)
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.resolve()
    const entry = findCatalogModel(connection.models, model)
    // exactOptionalPropertyTypes 下必须先把可缺省值收成一个变量，
    // 否则 `{ defaultMaxTokens: number | undefined }` 不能赋给 `{ defaultMaxTokens?: number }`。
    const defaultMaxTokens = connection.maxTokens ?? entry?.maxTokens
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.description === undefined ? {} : { description: entry.description },
      inputModalities: entry?.inputModalities ?? ['text'],
      context: { contextWindow: entry?.contextWindow ?? MONK_CONTEXT_WINDOW },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
      reasoning: {
        efforts: [
          { id: 'low' as never, name: 'Low', description: '更快的响应，更少的思考 token。' },
          { id: 'medium' as never, name: 'Medium' },
          { id: 'high' as never, name: 'High', description: '复杂推理与跨文件重构。' },
        ],
        ...connection.reasoningEffort === undefined
          ? {}
          : { defaultEffort: connection.reasoningEffort as never },
      },
    }
    return info
  }

  /**
   * 绑定一代连接事实与最终分派。
   *
   * 与默认实现的差别：模型元数据与 `stream` 闭包共用**同一次** `resolve()`
   * 结果，设置变更无法在两者之间插入。
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const connection = this.resolve()
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.streamWith(options, connection),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWith(options, this.resolve())
  }

  /**
   * 用一份固定连接事实执行一次流式调用。
   * @param options - 完全组装好的请求。
   * @param connection - 本次调用绑定的一代连接事实。
   * @yields 中立分片序列。
   */
  private async * streamWith(
    options: GenerateOptions,
    connection: ResolvedMonkOptions,
  ): AsyncGenerator<StreamChunk> {
    const apiKey = await this.resolveApiKey(connection)
    assertUsableApiKey(apiKey, 'monk-llm', connection.apiKeyEnv)

    const images = this.resolveImages === undefined
      ? new Map<string, readonly ResolvedImage[]>()
      : await this.resolveImages(options.messages)

    const body = serializeRequest({
      model: options.model,
      messages: options.messages,
      ...options.system === undefined ? {} : { system: options.system },
      ...options.tools === undefined ? {} : { tools: options.tools },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.stop === undefined ? {} : { stop: options.stop },
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: String(options.reasoningEffort) as 'low' | 'medium' | 'high' },
      images,
    })

    const isWebSearchEnabled = connection.webSearch === true || (() => {
      if (connection.webSearch === false) return false
      const router = this.getContext?.()?.get('monkRouter')
      if (router === undefined) return false
      const pol = router.policy()
      if (pol.webSearchMode === 'off') return false
      if (pol.webSearchMode === 'on') return true
      const lastUserMsg = [...options.messages].reverse().find(m => m.role === 'user')
      const text = lastUserMsg?.content.map(b => b.type === 'text' ? b.text : '').join(' ') ?? ''
      const tools = new Set((options.tools ?? []).map(t => t.name))
      const WEB_KEYWORDS = ['最新', '今天', '新闻', '实时', '搜索', '天气', '2026', '近况', 'latest', 'today', 'news', 'recent', 'search', 'weather', 'current']
      const hitKeyword = WEB_KEYWORDS.some(kw => text.toLowerCase().includes(kw))
      const hitTool = Array.from(tools).some(t => t.toLowerCase().includes('search') || t.toLowerCase().includes('fetch'))
      return hitKeyword || hitTool
    })()

    const translator = new ChunkTranslator()
    let response: Response
    try {
      response = await this.fetchImpl(`${connection.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
          ...isWebSearchEnabled ? { 'X-Monk-Web-Search': 'true' } : {},
        },
        body: JSON.stringify(body),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error) {
      // 调用方取消不算传输故障，交由上层按 aborted 处理。
      if (options.signal?.aborted === true) {
        yield* translator.settle(undefined, true)
        return
      }
      throw new LlmError(
        `monk: transport failure contacting ${connection.baseURL}`,
        'TRANSPORT_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) await throwHttpFailure(response)
    if (response.body === null) {
      throw new LlmError('monk: provider returned an empty response body', 'PROTOCOL_ERROR')
    }

    // 空闲看门狗：提供方长时间不吐字节时，主动中断而不是无限等待。
    const idle = createIdleWatchdog(options.signal, connection.streamIdleTimeoutMs)

    try {
      for await (const event of parseSse(response.body, idle.signal)) {
        if (event.event === 'error') {
          yield* translator.settle({ message: `monk: provider stream error: ${event.data}`, code: 'PROVIDER_STREAM_ERROR' })
          return
        }
        if (event.data === SSE_DONE) break
        if (event.data === '') continue
        let chunk: MonkWireChunk
        try {
          chunk = JSON.parse(event.data) as MonkWireChunk
        } catch (error) {
          throw new LlmError('monk: provider emitted a malformed JSON frame', 'PROTOCOL_ERROR', { cause: error })
        }
        idle.touch()
        yield* translator.push(chunk)
      }
      if (options.signal?.aborted === true) {
        yield* translator.settle(undefined, true)
        return
      }
      if (idle.expired()) {
        yield* translator.settle({ message: 'monk: provider stream idle timeout', code: 'STREAM_IDLE_TIMEOUT' })
        return
      }
      yield* translator.settle()
    } finally {
      idle.dispose()
    }
  }
}

/**
 * 构造一个"流空闲"看门狗。
 *
 * 语义与请求级 `AbortSignal` 不同：它只约束**单次读取之间的间隔**，任何到达
 * 的字节都会重置计时。到期时不直接抛错，而是让迭代结束，由调用方按带内失败
 * 结算——这样已经产出的内容不会丢失。
 * @param upstream - 调用方信号，级联到看门狗。
 * @param timeoutMs - 允许的最长空闲时间。
 * @returns 看门狗句柄。
 */
function createIdleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; touch: () => void; expired: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
  }
  const onUpstreamAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }

  if (upstream?.aborted === true) controller.abort()
  else {
    upstream?.addEventListener('abort', onUpstreamAbort, { once: true })
    arm()
  }

  return {
    signal: controller.signal,
    touch: () => {
      if (!expired) arm()
    },
    expired: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      upstream?.removeEventListener('abort', onUpstreamAbort)
    },
  }
}

/** 供上层复用的 detail 校验，避免未使用导出告警。 */
export const isSupportedImageDetail = (value: string): value is 'auto' | 'low' | 'high' =>
  DETAIL_VALUES.has(value)
