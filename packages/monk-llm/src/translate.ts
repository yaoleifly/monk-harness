/**
 * 分片翻译：Monk wire 分片 → dsh 中立 `StreamChunk`。
 *
 * 翻译器是有状态的，因为 wire 协议的增量流与中立协议的分块流之间不是
 * 一一对应：中立协议要求每个块有稳定的 `index`、以 `block-end` 携带
 * **组装完成**的块，并且 usage 必须早于 finish、finish 之后不再发出任何内容。
 *
 * 三条契约义务在这里落地：
 * 1. 块 `index` 按**首次出现**的流顺序分配，同一块的每次增量复用该 index。
 * 2. 工具调用的 `arguments` 全程为**原始 JSON 字符串**；wire 只给增量，这里
 *    拼接后整体作为 `argumentsDelta` 发出。
 * 3. finish/usage 缓冲到流结束标记再统一 flush——Monk 可能在末尾单独发一个
 *    只含 usage 的分片，提前 flush 会把它排到 finish 之后。
 * @module @monk/monk-llm/translate
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { MonkWireChunk, MonkWireUsage } from './wire.ts'

/** 提供方带内失败：作为 finish 的 error 分支发出，而不是抛出。 */
export interface InBandFailure {
  message: string
  code: string
  status?: number
}

/** 一次流的最终结算事实。 */
export interface TranslatorSettlement {
  /** 组装完成的块，按 index 升序。 */
  blocks: readonly ContentBlock[]
  /** 已归一到 dsh 词汇的 token 用量。 */
  usage?: TokenUsage
  /** 提供方给出的原始 finish_reason，进入 replayState。 */
  rawFinishReason?: string
  /** 提供方响应 id，进入 replayState。 */
  responseId?: string
}

/**
 * 把 wire 的 usage 归一为 dsh 的 `TokenUsage`。
 *
 * dsh 的计数是**互斥**的：`inputTokens` 只计未命中缓存的输入，缓存命中单独
 * 记在 `cacheReadTokens`。OpenAI 兼容提供方把两者折叠进 `prompt_tokens`，
 * 因此这里必须做减法。
 * @param usage - wire usage。
 * @returns 归一后的用量；字段缺失时省略而非填零。
 */
export function normalizeUsage(usage: MonkWireUsage): TokenUsage {
  const prompt = usage.prompt_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  // 防御：提供方偶尔报告 cached > prompt，此时按 0 计未缓存输入。
  const uncachedInput = Math.max(0, prompt - cached)
  return {
    inputTokens: uncachedInput,
    outputTokens: usage.completion_tokens ?? 0,
    ...usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens },
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...usage.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens },
  }
}

/**
 * 映射提供方 finish_reason 到 dsh 的 `FinishReason`。
 *
 * 未知取值不抛错：落入 `stop` 并在 `replayState` 里保留原文，这样新提供方
 * 新增的终止原因不会让整个流失败。
 * @param raw - wire finish_reason。
 * @param hasToolCalls - 本次流是否产生了工具调用。
 * @returns 中立终止原因。
 */
export function mapFinishReason(raw: string | null | undefined, hasToolCalls: boolean): FinishReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'stop':
      return { kind: 'stop' }
    case null:
    case undefined:
      // 提供方没给终止原因：有工具调用就按工具调用收尾，否则视为正常停止。
      return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * 对工具调用的参数进行健壮性归一化。
 *
 * 背景：部分模型在调用 `web_search` 时，常把必需的 `queries: string[]`
 * 传成单个字符串 `queries: "..."`，或使用常见的别名 `query: "..."` / `q: "..."`。
 * dsh 核心的 JSON Schema 校验会直接以 `"queries" must be an array` 拒绝并报错。
 * 本函数在流组装阶段进行无损归一化，把非标参数自动提升为合法的参数形状。
 */
export function normalizeToolArguments(name: string, rawArgs: string): string {
  if (!rawArgs || rawArgs.trim() === '') return '{}'
  try {
    const parsed = JSON.parse(rawArgs)
    if (typeof parsed !== 'object' || parsed === null) return rawArgs

    if (name === 'web_search') {
      let qList: string[] | undefined

      if (typeof parsed.queries === 'string') {
        const q = parsed.queries.trim()
        if (q) qList = [q]
      } else if (Array.isArray(parsed.queries)) {
        qList = parsed.queries.map((q: unknown) => String(q ?? '').trim()).filter((q: string) => q.length > 0)
      } else if (typeof parsed.query === 'string') {
        const q = parsed.query.trim()
        if (q) qList = [q]
      } else if (Array.isArray(parsed.query)) {
        qList = parsed.query.map((q: unknown) => String(q ?? '').trim()).filter((q: string) => q.length > 0)
      } else if (typeof parsed.q === 'string') {
        const q = parsed.q.trim()
        if (q) qList = [q]
      } else if (typeof parsed.search === 'string') {
        const q = parsed.search.trim()
        if (q) qList = [q]
      } else if (typeof parsed.keyword === 'string') {
        const q = parsed.keyword.trim()
        if (q) qList = [q]
      }

      if (qList !== undefined && qList.length > 0) {
        parsed.queries = qList
        delete parsed.query
        delete parsed.q
        delete parsed.search
        delete parsed.keyword
        return JSON.stringify(parsed)
      }
    }

    if (name === 'web_fetch') {
      const urlCandidate = parsed.url ?? parsed.link ?? parsed.uri ?? parsed.href
      if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) {
        parsed.url = urlCandidate.trim()
        delete parsed.link
        delete parsed.uri
        delete parsed.href
        return JSON.stringify(parsed)
      }
    }

    if (name === 'bash' || name === 'pwsh') {
      const cmdCandidate = parsed.command ?? parsed.cmd ?? parsed.code
      if (typeof cmdCandidate === 'string') {
        parsed.command = cmdCandidate
        delete parsed.cmd
        delete parsed.code
        return JSON.stringify(parsed)
      }
    }

    return JSON.stringify(parsed)
  } catch {
    return rawArgs
  }
}

/**
 * 有状态的 wire → 中立分片翻译器。
 *
 * 用法：对每个 wire 分片调用 {@link push} 并转发其返回值，流结束后调用
 * {@link settle} 取得收尾分片。`push` 与 `settle` 都是纯同步函数，便于单测。
 */
export class ChunkTranslator {
  private nextIndex = 0
  private textIndex: number | undefined
  private reasoningIndex: number | undefined
  private readonly toolIndexes = new Map<number, number>()
  private readonly toolCalls = new Map<number, { id: string; name: string; args: string }>()
  private text = ''
  private reasoning = ''
  private usage: TokenUsage | undefined
  private rawFinishReason: string | undefined
  private responseId: string | undefined
  private finished = false

  /** 翻译一个 wire 分片。 */
  push(chunk: MonkWireChunk): StreamChunk[] {
    const out: StreamChunk[] = []
    if (chunk.id !== undefined) this.responseId ??= chunk.id

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      if (delta !== undefined) {
        // 思考内容优先于正文处理，保持首次出现顺序。
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          out.push(...this.openReasoning(), { type: 'reasoning-delta', index: this.reasoningIndex!, text: delta.reasoning_content })
          this.reasoning += delta.reasoning_content
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          out.push(...this.openText(), { type: 'text-delta', index: this.textIndex!, text: delta.content })
          this.text += delta.content
        }
        for (const call of delta.tool_calls ?? []) {
          out.push(...this.pushToolCall(call))
        }
      }
      if (typeof choice.finish_reason === 'string') this.rawFinishReason = choice.finish_reason
    }

    // usage 只缓冲，不立即发出——它必须排在 finish 之前、且可能在最后一个分片。
    if (chunk.usage !== null && chunk.usage !== undefined) {
      this.usage = normalizeUsage(chunk.usage)
    }
    return out
  }

  /**
   * 结算本次流，产出收尾分片。
   *
   * 顺序固定为：全部 `block-end` → `usage` → `finish`。finish 之后绝不再产出。
   * @param failure - 带内失败；提供时以 `finish{kind:'error'}` 收尾。
   * @param aborted - 调用方取消；优先于 `failure`，以 `finish{kind:'aborted'}` 收尾。
   * @returns 收尾分片序列。
   */
  settle(failure?: InBandFailure, aborted?: boolean): StreamChunk[] {
    if (this.finished) return []
    this.finished = true
    const out: StreamChunk[] = []
    const blocks = this.assembledBlocks()
    for (const [index, block] of blocks) {
      out.push({ type: 'block-end', index, block })
    }
    if (this.usage !== undefined) out.push({ type: 'usage', usage: this.usage })

    if (aborted === true) {
      out.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'monk: request aborted by caller', code: 'ABORTED' } } })
      return out
    }
    if (failure !== undefined) {
      out.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: failure.message,
            code: failure.code,
            ...failure.status === undefined ? {} : { status: failure.status },
          },
        },
      })
      return out
    }

    const hasToolCalls = this.toolCalls.size > 0
    out.push({
      type: 'finish',
      reason: mapFinishReason(this.rawFinishReason, hasToolCalls),
      replayState: {
        response: {
          ...this.responseId === undefined ? {} : { id: this.responseId },
          ...this.rawFinishReason === undefined ? {} : { finishReason: this.rawFinishReason },
        },
      },
    })
    return out
  }

  /** 已组装块的快照，供结算与断言使用。 */
  get settlement(): TranslatorSettlement {
    return {
      blocks: [...this.assembledBlocks().values()],
      ...this.usage === undefined ? {} : { usage: this.usage },
      ...this.rawFinishReason === undefined ? {} : { rawFinishReason: this.rawFinishReason },
      ...this.responseId === undefined ? {} : { responseId: this.responseId },
    }
  }

  private openText(): StreamChunk[] {
    if (this.textIndex !== undefined) return []
    this.textIndex = this.nextIndex++
    return [{ type: 'block-start', index: this.textIndex, blockType: 'text' }]
  }

  private openReasoning(): StreamChunk[] {
    if (this.reasoningIndex !== undefined) return []
    this.reasoningIndex = this.nextIndex++
    return [{ type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' }]
  }

  private pushToolCall(call: {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }): StreamChunk[] {
    const out: StreamChunk[] = []
    let index = this.toolIndexes.get(call.index)
    if (index === undefined) {
      index = this.nextIndex++
      this.toolIndexes.set(call.index, index)
      this.toolCalls.set(call.index, { id: call.id ?? `monk-call-${call.index}`, name: '', args: '' })
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
    }
    const state = this.toolCalls.get(call.index)!
    // 后续增量分片可能补发 id（OpenAI 兼容提供方的常见行为）。
    if (call.id !== undefined && call.id !== '') state.id = call.id
    if (call.function?.name !== undefined) state.name = call.function.name
    const argsDelta = call.function?.arguments ?? ''
    state.args += argsDelta
    if (state.name === '') {
      // 名字还没到，先不发 tool-call-delta：中立协议要求 name 已确定。
      return out
    }
    out.push({
      type: 'tool-call-delta',
      index,
      id: state.id as never,
      name: state.name,
      argumentsDelta: argsDelta,
    })
    return out
  }

  private assembledBlocks(): Map<number, ContentBlock> {
    const blocks = new Map<number, ContentBlock>()
    if (this.reasoningIndex !== undefined) {
      blocks.set(this.reasoningIndex, { type: 'reasoning', text: this.reasoning })
    }
    if (this.textIndex !== undefined) {
      blocks.set(this.textIndex, { type: 'text', text: this.text })
    }
    for (const [wireIndex, blockIndex] of this.toolIndexes) {
      const call = this.toolCalls.get(wireIndex)
      // 名字为空说明流在中途被中断，或提供方输出了空工具帧：跳过无名字的破坏帧，
      // 保留已收到的文本与有效工具调用，避免整回合崩溃。
      if (call === undefined || call.name === '') continue
      blocks.set(blockIndex, {
        type: 'tool-call',
        id: call.id as never,
        name: call.name,
        // 契约：arguments 全程为原始 JSON 字符串。
        arguments: normalizeToolArguments(call.name, call.args),
      })
    }
    return new Map([...blocks.entries()].sort((a, b) => a[0] - b[0]))
  }
}
