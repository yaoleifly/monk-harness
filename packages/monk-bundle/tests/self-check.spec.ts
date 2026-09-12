import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { MONK_PROVIDER } from '@monk/monk-llm'
import { apply, selfCheck } from '../src/index.ts'

test('bundle 注册 monkHarness 服务', () => {
  const ctx = new Context()
  apply(ctx)
  assert.equal(ctx.monkHarness.provider, MONK_PROVIDER)
  assert.equal(typeof ctx.monkHarness.selfCheck, 'function')
})

test('selfCheck: 未注册路由时给出诊断', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [],
    listModels: async () => [],
  } as never)
  const result = await selfCheck(ctx)
  assert.equal(result.routeRegistered, false)
  assert.equal(result.keyConfigured, false)
  assert.ok(result.diagnostics.some(d => d.includes('not registered')))
})

test('selfCheck: 已注册路由且配置 Key', async () => {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: MONK_PROVIDER }],
    listModels: async () => [{ id: 'monk' }, { id: 'monk-fast' }],
  } as never)
  ctx.provide('agentDefaultModel', {
    current: () => ({ provider: MONK_PROVIDER, model: 'monk' }),
  } as never)
  ctx.provide('credentials', {
    resolve: async (ref: string) => ref === 'MONK_API_KEY' ? { value: 'sk-test-key' } : undefined,
  } as never)

  const result = await selfCheck(ctx)
  assert.equal(result.routeRegistered, true)
  assert.equal(result.defaultIsMonk, true)
  assert.equal(result.keyConfigured, true)
  assert.equal(result.models.length, 2)
  assert.equal(result.diagnostics.length, 0)
})
