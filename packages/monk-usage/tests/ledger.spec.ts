/**
 * 用量账本测试。
 *
 * 最要紧的一条：dsh 的 `TokenUsage` 计数是**互斥**的，`inputTokens` 只计
 * 未命中缓存的输入。账本必须做加法而不是把它当成总数，否则账单会系统性
 * 少算掉缓存命中的那部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accumulate,
  cacheHitRate,
  emptyTotals,
  evaluateQuota,
  formatTokens,
  formatTotals,
  monthKey,
  UsageLedger,
} from '../src/ledger.ts'

test('计费输入 = 未缓存 + 缓存读 + 缓存写', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 50 })
  assert.equal(totals.uncachedInputTokens, 100)
  assert.equal(totals.cacheReadTokens, 300)
  assert.equal(totals.cacheWriteTokens, 50)
  assert.equal(totals.billedInputTokens, 450)
})

test('缺省缓存字段按 0 处理', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 100, outputTokens: 20 })
  assert.equal(totals.billedInputTokens, 100)
  assert.equal(totals.cacheReadTokens, 0)
})

test('每次累积记一次调用', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 1, outputTokens: 1 })
  accumulate(totals, { inputTokens: 1, outputTokens: 1 })
  assert.equal(totals.calls, 2)
})

test('推理 token 单独累计', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 1, outputTokens: 50, reasoningTokens: 40 })
  assert.equal(totals.reasoningTokens, 40)
})

test('缓存命中率以计费输入为分母', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 300 })
  assert.equal(cacheHitRate(totals), 0.75)
})

test('零输入时命中率为 0 而不是 NaN', () => {
  assert.equal(cacheHitRate(emptyTotals()), 0)
})

test('账本按会话与月份分别累计', () => {
  const ledger = new UsageLedger()
  ledger.record('s1', '2026-09', { inputTokens: 10, outputTokens: 1 })
  ledger.record('s1', '2026-09', { inputTokens: 10, outputTokens: 1 })
  ledger.record('s2', '2026-09', { inputTokens: 5, outputTokens: 1 })
  ledger.record('s1', '2026-10', { inputTokens: 7, outputTokens: 1 })

  assert.equal(ledger.forSession('s1').billedInputTokens, 27)
  assert.equal(ledger.forSession('s2').billedInputTokens, 5)
  assert.equal(ledger.forMonth('2026-09').billedInputTokens, 25)
  assert.equal(ledger.forMonth('2026-10').billedInputTokens, 7)
})

test('未知会话与月份返回空汇总', () => {
  const ledger = new UsageLedger()
  assert.deepEqual(ledger.forSession('nope'), emptyTotals())
  assert.deepEqual(ledger.forMonth('1999-01'), emptyTotals())
})

test('返回的是副本，外部改写不影响账本', () => {
  const ledger = new UsageLedger()
  ledger.record('s1', '2026-09', { inputTokens: 10, outputTokens: 1 })
  const snapshot = ledger.forSession('s1')
  snapshot.billedInputTokens = 99999
  assert.equal(ledger.forSession('s1').billedInputTokens, 10)
})

test('月份键按本地时区生成并补零', () => {
  assert.equal(monthKey(new Date(2026, 8, 12)), '2026-09')
  assert.equal(monthKey(new Date(2026, 11, 31)), '2026-12')
})

test('月份列表按升序', () => {
  const ledger = new UsageLedger()
  ledger.record('s1', '2026-10', { inputTokens: 1, outputTokens: 1 })
  ledger.record('s1', '2026-09', { inputTokens: 1, outputTokens: 1 })
  assert.deepEqual(ledger.months(), ['2026-09', '2026-10'])
})

test('额度：未设上限时既不超限也不告警', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 10_000_000, outputTokens: 1 })
  const status = evaluateQuota(totals, { name: '不限量' })
  assert.equal(status.ratio, undefined)
  assert.equal(status.exceeded, false)
  assert.equal(status.warning, false)
})

test('额度：达到阈值时告警', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 850_000, outputTokens: 1 })
  const status = evaluateQuota(totals, { name: '月度', inputTokensLimit: 1_000_000, warnAt: 0.8 })
  assert.equal(status.warning, true)
  assert.equal(status.exceeded, false)
  assert.ok(Math.abs((status.ratio ?? 0) - 0.85) < 1e-9)
})

test('额度：越线时 exceeded', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 1_100_000, outputTokens: 1 })
  const status = evaluateQuota(totals, { name: '月度', inputTokensLimit: 1_000_000 })
  assert.equal(status.exceeded, true)
})

test('额度：取输入与输出中更紧张的一项', () => {
  const totals = emptyTotals()
  // 输入用 10%，输出用 90% —— 应报 90%。
  accumulate(totals, { inputTokens: 100, outputTokens: 900 })
  const status = evaluateQuota(totals, {
    name: '月度',
    inputTokensLimit: 1_000,
    outputTokensLimit: 1_000,
  })
  assert.equal(status.exceeded, false)
  assert.ok(Math.abs((status.ratio ?? 0) - 0.9) < 1e-9)
})

test('token 数格式化', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_500), '1.5k')
  assert.equal(formatTokens(2_410_000), '2.41M')
})

test('汇总行包含四项关键事实', () => {
  const totals = emptyTotals()
  accumulate(totals, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 })
  const line = formatTotals(totals)
  assert.ok(line.includes('调用 1 次'))
  assert.ok(line.includes('计费输入 400'))
  assert.ok(line.includes('输出 20'))
  assert.ok(line.includes('缓存命中 75.0%'))
})
