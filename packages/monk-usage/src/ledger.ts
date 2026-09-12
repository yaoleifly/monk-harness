/**
 * 用量账本（纯逻辑）。
 *
 * monk.party 是按月订阅制，用户最关心的问题是"这个月还剩多少"。dsh 的会话
 * 日志里已经有权威答案：每个 `assistant/message` 事件都携带该步骤的
 * `usage`。账本只做一件事——把散落在会话日志里的用量折叠成一个可查询的
 * 汇总，不做任何网络调用，也不改动会话。
 *
 * ## 为什么按"计费输入"而不是 `inputTokens` 汇总
 *
 * dsh 的 `TokenUsage` 计数是**互斥**的：`inputTokens` 只计未命中缓存的输入，
 * 缓存命中的部分单独记在 `cacheReadTokens`。账单关心的是总吞吐，因此本模块
 * 统一用 `billedInput = inputTokens + cacheReadTokens + cacheWriteTokens`，
 * 同时把缓存命中率单独暴露出来——那才是"省了多少钱"的证据。
 * @module @monk/monk-usage/ledger
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** 一次累积后的用量汇总。 */
export interface UsageTotals {
  /** 计费输入 = 未缓存 + 缓存读 + 缓存写。 */
  billedInputTokens: number
  /** 未命中缓存的输入。 */
  uncachedInputTokens: number
  /** 命中缓存的输入。 */
  cacheReadTokens: number
  /** 写入缓存的输入。 */
  cacheWriteTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 其中的推理 token。 */
  reasoningTokens: number
  /** 累计模型调用次数（每个 assistant/message 记一次）。 */
  calls: number
}

/** 空汇总。 */
export function emptyTotals(): UsageTotals {
  return {
    billedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    calls: 0,
  }
}

/**
 * 把一个 usage 累加进汇总。
 * @param totals - 就地累加的汇总。
 * @param usage - 一个步骤的用量。
 */
export function accumulate(totals: UsageTotals, usage: TokenUsage): void {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  totals.uncachedInputTokens += usage.inputTokens
  totals.cacheReadTokens += cacheRead
  totals.cacheWriteTokens += cacheWrite
  totals.billedInputTokens += usage.inputTokens + cacheRead + cacheWrite
  totals.outputTokens += usage.outputTokens
  totals.reasoningTokens += usage.reasoningTokens ?? 0
  totals.calls += 1
}

/**
 * 计算缓存命中率。
 * @param totals - 汇总。
 * @returns 0..1 的命中率；没有输入时为 0。
 */
export function cacheHitRate(totals: UsageTotals): number {
  if (totals.billedInputTokens === 0) return 0
  return totals.cacheReadTokens / totals.billedInputTokens
}

/** 额度档位：monk.party 的月度订阅规格。 */
export interface UsagePlan {
  /** 展示名。 */
  name: string
  /** 月度价格（人民币元），仅用于展示。 */
  priceCny?: number
  /** 计费输入 token 上限；未设置表示不限量。 */
  inputTokensLimit?: number
  /** 输出 token 上限；未设置表示不限量。 */
  outputTokensLimit?: number
  /** 达到该比例时开始提醒（0..1）。 */
  warnAt?: number
}

/** 额度状态。 */
export interface QuotaStatus {
  /** 计费输入使用比例；无上限时为 `undefined`。 */
  inputRatio?: number
  /** 输出使用比例；无上限时为 `undefined`。 */
  outputRatio?: number
  /** 更紧张的那一项的比例；都无上限时为 `undefined`。 */
  ratio?: number
  /** 是否已越线。 */
  exceeded: boolean
  /** 是否进入提醒区。 */
  warning: boolean
}

/**
 * 评估额度状态。
 * @param totals - 当前汇总。
 * @param plan - 订阅规格。
 * @returns 额度状态。
 */
export function evaluateQuota(totals: UsageTotals, plan: UsagePlan): QuotaStatus {
  const inputRatio = plan.inputTokensLimit === undefined || plan.inputTokensLimit <= 0
    ? undefined
    : totals.billedInputTokens / plan.inputTokensLimit
  const outputRatio = plan.outputTokensLimit === undefined || plan.outputTokensLimit <= 0
    ? undefined
    : totals.outputTokens / plan.outputTokensLimit
  const ratios = [inputRatio, outputRatio].filter((value): value is number => value !== undefined)
  if (ratios.length === 0) return { exceeded: false, warning: false }
  const ratio = Math.max(...ratios)
  const warnAt = plan.warnAt ?? 0.8
  // exactOptionalPropertyTypes 下必须**省略**可选键，而不是赋 undefined。
  return {
    ...inputRatio === undefined ? {} : { inputRatio },
    ...outputRatio === undefined ? {} : { outputRatio },
    ratio,
    exceeded: ratio >= 1,
    warning: ratio >= warnAt,
  }
}

/** 一个计费周期内的账本。 */
export class UsageLedger {
  private readonly bySession = new Map<string, UsageTotals>()
  /** 注意：字段名不能叫 `months`——那会遮蔽同名的 `months()` 方法。 */
  private readonly byMonth = new Map<string, UsageTotals>()

  /**
   * 记一次用量。
   * @param sessionId - 归属会话。
   * @param month - 计费周期键，形如 `2026-09`。
   * @param usage - 该步骤用量。
   */
  record(sessionId: string, month: string, usage: TokenUsage): void {
    const session = this.bySession.get(sessionId) ?? emptyTotals()
    accumulate(session, usage)
    this.bySession.set(sessionId, session)

    const period = this.byMonth.get(month) ?? emptyTotals()
    accumulate(period, usage)
    this.byMonth.set(month, period)
  }

  /**
   * 读取某会话的累计用量。
   * @param sessionId - 会话 id。
   * @returns 汇总的副本；未知会话返回空汇总。
   */
  forSession(sessionId: string): UsageTotals {
    return { ...(this.bySession.get(sessionId) ?? emptyTotals()) }
  }

  /**
   * 读取某计费周期的累计用量。
   * @param month - 形如 `2026-09` 的周期键。
   * @returns 汇总的副本；未知周期返回空汇总。
   */
  forMonth(month: string): UsageTotals {
    return { ...(this.byMonth.get(month) ?? emptyTotals()) }
  }

  /**
   * 列出全部已记录的计费周期。
   * @returns 按字典序升序的周期键。
   */
  months(): string[] {
    return [...this.byMonth.keys()].sort()
  }
}

/**
 * 把 `Date` 投影为计费周期键。
 *
 * 使用本地时区：订阅按自然月结算，用户看到的"本月"应当是本地时间的本月。
 * @param date - 时刻。
 * @returns 形如 `2026-09` 的键。
 */
export function monthKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}`
}

/**
 * 把汇总渲染成一行人类可读的文本。
 * @param totals - 汇总。
 * @returns 单行摘要。
 */
export function formatTotals(totals: UsageTotals): string {
  const rate = (cacheHitRate(totals) * 100).toFixed(1)
  return [
    `调用 ${totals.calls} 次`,
    `计费输入 ${formatTokens(totals.billedInputTokens)}`,
    `输出 ${formatTokens(totals.outputTokens)}`,
    `缓存命中 ${rate}%`,
  ].join(' · ')
}

/**
 * 以 k/M 为单位格式化 token 数。
 * @param value - token 数。
 * @returns 人类可读字符串。
 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}
