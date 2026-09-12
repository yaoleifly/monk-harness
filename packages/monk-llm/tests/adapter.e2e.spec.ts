/**
 * 适配器端到端测试。
 *
 * 起一个本地 OpenAI 兼容的 SSE 服务端，让 {@link MonkAdapter} 真的发一次请求、
 * 真的解析流、真的翻译分片。这验证的是**契约**而不是形状：
 *
 * - `usage` 是否早于 `finish`，且 `finish` 之后再无产出；
 * - 工具调用的 `arguments` 是否是完整原始 JSON 字符串（跨分片拼接）；
 * - 块 `index` 是否按首次出现顺序分配；
 * - 请求体是否符合 OpenAI 兼容协议（system 槽、tools、stream_options）。
 *
 * 这些是纯逻辑单测覆盖不到的——它们只有在真实 fetch + 真实字节流下才会暴露。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MonkAdapter, type ResolvedMonkOptions } from '../src/adapter.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { MonkWireRequest } from '../src/wire.ts'

/** 记录一次收到的请求，供断言检查。 */
interface Capture {
  body: MonkWireRequest
  authorization: string | undefined
}

/** 启动一个可编程的 mock Monk 服务端。 */
async function startMockServer(
  respond: (capture: Capture) => string,
  status = 200,
): Promise<{ url: string; capture: () => Capture | undefined; close: () => Promise<void> }> {
  let captured: Capture | undefined
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      captured = {
        body: JSON.parse(raw) as MonkWireRequest,
        authorization: req.headers.authorization,
      }
      const payload = respond(captured)
      res.writeHead(status, {
        'content-type': status === 200 ? 'text/event-stream' : 'application/json',
      })
      res.end(payload)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    capture: () => captured,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined || error === null ? resolve() : reject(error)))
    }),
  }
}

/** 把 wire 分片数组编成 SSE 文本。 */
function sse(chunks: readonly unknown[], done = true): string {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  return done ? `${body}data: [DONE]\n\n` : body
}

/** 构造一个适配器，指向给定端点。 */
function adapterFor(url: string, overrides: Partial<ResolvedMonkOptions> = {}): MonkAdapter {
  const options: ResolvedMonkOptions = {
    apiKeyEnv: credentialRef('MONK_API_KEY'),
    baseURL: url,
    models: [{
      id: 'monk-coding',
      name: 'Monk Coding',
      tier: 'coding',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    }],
    streamIdleTimeoutMs: 5_000,
    ...overrides,
  }
  return new MonkAdapter({
    options: () => options,
    resolveApiKey: async () => 'sk-test-key',
  })
}

/** 请求模板。 */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'monk-official',
    model: 'monk-coding',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }] } as never],
    system: '你是 Monk。',
    ...overrides,
  }
}

/** 收齐一次流的全部分片。 */
async function drain(adapter: MonkAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

test('端到端：文本流 + usage 顺序 + finish 收尾', async () => {
  const server = await startMockServer(() => sse([
    { id: 'resp-1', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { choices: [{ index: 0, delta: { content: '你好' } }] },
    { choices: [{ index: 0, delta: { content: '，世界' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 100 } } },
  ]))

  try {
    const chunks = await drain(adapterFor(server.url), request())

    // 拼接出的可见文本。
    const text = chunks
      .filter(c => c.type === 'text-delta')
      .map(c => (c.type === 'text-delta' ? c.text : ''))
      .join('')
    assert.equal(text, '你好，世界')

    // 契约：usage 必须早于 finish。
    const usageAt = chunks.findIndex(c => c.type === 'usage')
    const finishAt = chunks.findIndex(c => c.type === 'finish')
    assert.ok(usageAt >= 0, '应发出 usage')
    assert.ok(finishAt >= 0, '应发出 finish')
    assert.ok(usageAt < finishAt, 'usage 必须早于 finish')
    assert.equal(finishAt, chunks.length - 1, 'finish 之后不得再有任何分片')

    // 契约：block-end 携带组装完成的块。
    const blockEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'text')
    assert.ok(blockEnd !== undefined)
    assert.equal(blockEnd.type === 'block-end' && blockEnd.block.type === 'text' ? blockEnd.block.text : '', '你好，世界')

    // 缓存 token 必须从 prompt_tokens 里减出来（dsh 计数互斥）。
    const usage = chunks[usageAt]
    assert.ok(usage?.type === 'usage')
    assert.deepEqual(usage.usage, {
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadTokens: 100,
    })

    // 请求体符合 OpenAI 兼容协议。
    const capture = server.capture()
    assert.equal(capture?.authorization, 'Bearer sk-test-key')
    assert.equal(capture?.body.stream, true)
    assert.deepEqual(capture?.body.stream_options, { include_usage: true })
    assert.equal(capture?.body.model, 'monk-coding')
    assert.equal(capture?.body.messages[0]?.role, 'system')
    assert.equal(capture?.body.messages[0]?.content, '你是 Monk。')
    assert.equal(capture?.body.messages[1]?.role, 'user')
  } finally {
    await server.close()
  }
})

test('端到端：工具调用跨分片拼接为完整原始 JSON', async () => {
  const server = await startMockServer(() => sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/a.txt"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]))

  try {
    const chunks = await drain(adapterFor(server.url), request({ tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }] }))

    const blockEnd = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.ok(blockEnd !== undefined, '应产出 tool-call 块')
    const block = blockEnd.type === 'block-end' ? blockEnd.block : undefined
    assert.ok(block?.type === 'tool-call')
    // 契约：arguments 全程是原始 JSON 字符串，不是已解析对象。
    assert.equal(typeof block.arguments, 'string')
    assert.deepEqual(JSON.parse(block.arguments), { path: '/tmp/a.txt' })
    assert.equal(block.name, 'read')

    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.equal(finish.reason.kind, 'tool-calls')

    // tools 被投影进请求体。
    assert.equal(server.capture()?.body.tools?.[0]?.function.name, 'read')
  } finally {
    await server.close()
  }
})

test('端到端：HTTP 401 走抛出路径，带稳定 code', async () => {
  const server = await startMockServer(
    () => JSON.stringify({ error: { message: 'invalid api key' } }),
    401,
  )
  try {
    await assert.rejects(
      () => drain(adapterFor(server.url), request()),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: string }).code, 'INVALID_CREDENTIAL')
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('端到端：429 归类为 RATE_LIMIT', async () => {
  const server = await startMockServer(() => JSON.stringify({ error: { message: 'slow down' } }), 429)
  try {
    await assert.rejects(
      () => drain(adapterFor(server.url), request()),
      (error: unknown) => (error as { code?: string }).code === 'RATE_LIMIT',
    )
  } finally {
    await server.close()
  }
})

test('端到端：流中途 event: error 走带内路径，已产出内容保留', async () => {
  const server = await startMockServer(() => [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '部分内容' } }] })}\n\n`,
    'event: error\ndata: upstream exploded\n\n',
  ].join(''))
  try {
    const chunks = await drain(adapterFor(server.url), request())
    const text = chunks
      .filter(c => c.type === 'text-delta')
      .map(c => (c.type === 'text-delta' ? c.text : ''))
      .join('')
    // 带内失败：已产出的内容必须保留，不是抛错丢弃。
    assert.equal(text, '部分内容')
    const finish = chunks.at(-1)
    assert.ok(finish?.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
  } finally {
    await server.close()
  }
})

test('端到端：块 index 按首次出现顺序分配', async () => {
  const server = await startMockServer(() => sse([
    { choices: [{ index: 0, delta: { reasoning_content: '想一下' } }] },
    { choices: [{ index: 0, delta: { content: '答案' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]))
  try {
    const chunks = await drain(adapterFor(server.url), request())
    const starts = chunks.filter(c => c.type === 'block-start')
    assert.deepEqual(starts.map(c => (c.type === 'block-start' ? c.index : -1)), [0, 1, 2])
    assert.deepEqual(
      starts.map(c => (c.type === 'block-start' ? c.blockType : '')),
      ['reasoning', 'text', 'tool-call'],
    )
  } finally {
    await server.close()
  }
})

test('端到端：开启 webSearch 时带上 X-Monk-Web-Search 头', async () => {
  let capturedHeaders: Record<string, string | undefined> = {}
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    capturedHeaders = req.headers as Record<string, string | undefined>
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const url = `http://127.0.0.1:${port}`

  try {
    const adapter = adapterFor(url, { webSearch: true })
    await drain(adapter, request())
    assert.equal(capturedHeaders['x-monk-web-search'], 'true')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
