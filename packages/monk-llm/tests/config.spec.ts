/**
 * 插件配置解析测试。
 *
 * 这一层是"启动环境"与"运行时设置区"的交汇点，两边的优先级都必须在代码里
 * 钉死：环境变量能改端点，但改不动显式配置；缺省值必须与目录常量一致。
 * 这些事实一旦漂移，组合包在加载时不会报错，只会在请求打到错误端点时才
 * 显形——所以用测试把它们固定下来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  DEFAULT_API_KEY_ENV,
  MONK_SERVICE,
  PUBLIC_BASE_URL,
  inject,
  name,
  resolveAdapterOptions,
} from '../src/index.ts'
import { MONK_CONTEXT_WINDOW, MONK_MAX_OUTPUT_TOKENS } from '../src/catalog.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, MONK_PROVIDER } from '../src/adapter.ts'

/** 在给定环境变量下解析配置，并在结束后恢复原状。 */
function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key])
    const value = env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('插件元数据：名字、注入与提供方标识', () => {
  assert.equal(name, 'monk-llm')
  assert.deepEqual([...inject], ['llm'])
  assert.equal(MONK_PROVIDER, 'monk-official')
  assert.equal(MONK_SERVICE, 'monk')
})

test('缺省端点回落到公开地址', () => {
  withEnv({ MONK_BASE_URL: undefined }, () => {
    assert.equal(resolveAdapterOptions({}).baseURL, PUBLIC_BASE_URL)
  })
})

test('MONK_BASE_URL 覆盖公开端点', () => {
  withEnv({ MONK_BASE_URL: 'http://127.0.0.1:7788/v1' }, () => {
    assert.equal(resolveAdapterOptions({}).baseURL, 'http://127.0.0.1:7788/v1')
  })
})

test('显式配置优先于环境变量', () => {
  withEnv({ MONK_BASE_URL: 'http://127.0.0.1:7788/v1' }, () => {
    assert.equal(
      resolveAdapterOptions({ baseURL: 'https://gateway.example/v1' }).baseURL,
      'https://gateway.example/v1',
    )
  })
})

test('空白 MONK_BASE_URL 视为未设置', () => {
  withEnv({ MONK_BASE_URL: '' }, () => {
    assert.equal(resolveAdapterOptions({}).baseURL, PUBLIC_BASE_URL)
  })
})

test('缺省凭据引用是 MONK_API_KEY', () => {
  assert.equal(resolveAdapterOptions({}).apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(Config({}).apiKeyEnv, DEFAULT_API_KEY_ENV)
})

test('缺省目录是 monk / monk-fast / monk-coding', () => {
  const ids = resolveAdapterOptions({}).models.map(model => model.id)
  assert.deepEqual(ids, ['monk', 'monk-fast', 'monk-coding'])
})

test('目录项带上 1M 上下文与 64k 输出上限', () => {
  for (const model of resolveAdapterOptions({}).models) {
    assert.equal(model.contextWindow, MONK_CONTEXT_WINDOW)
    assert.equal(model.maxTokens, MONK_MAX_OUTPUT_TOKENS)
  }
})

test('缺省空闲超时为五分钟', () => {
  assert.equal(resolveAdapterOptions({}).streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 5 * 60 * 1000)
})

test('可选的推理强度与输出上限缺席时不被塞进默认值', () => {
  const resolved = resolveAdapterOptions({})
  assert.equal('reasoningEffort' in resolved, false)
  assert.equal('maxTokens' in resolved, false)
  assert.equal('retryPolicy' in resolved, false)
})

test('非法数值在解析时立刻失败，而不是留到请求时', () => {
  assert.throws(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 }), /streamIdleTimeoutMs/)
  assert.throws(() => resolveAdapterOptions({ streamIdleTimeoutMs: -1 }), /streamIdleTimeoutMs/)
  assert.throws(() => resolveAdapterOptions({ streamIdleTimeoutMs: 1.5 }), /streamIdleTimeoutMs/)
  assert.throws(() => resolveAdapterOptions({ maxTokens: 0 }), /maxTokens/)
  assert.throws(() => resolveAdapterOptions({ maxTokens: 2.5 }), /maxTokens/)
})

test('显式数值被原样保留', () => {
  const resolved = resolveAdapterOptions({
    reasoningEffort: 'high',
    maxTokens: 8192,
    streamIdleTimeoutMs: 1000,
  })
  assert.equal(resolved.reasoningEffort, 'high')
  assert.equal(resolved.maxTokens, 8192)
  assert.equal(resolved.streamIdleTimeoutMs, 1000)
})
