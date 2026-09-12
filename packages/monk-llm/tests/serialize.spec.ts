import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeMessages, serializeRequest, serializeTools } from '../src/serialize.ts'
import { normalizeToolArguments } from '../src/translate.ts'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'

test('序列化消息：用户普通文本与助手回复', () => {
  const messages: Message[] = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }] },
    { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '你好！我是 Monk。' }] },
  ]
  const res = serializeMessages(messages, new Map())
  assert.equal(res.length, 2)
  assert.deepEqual(res[0], { role: 'user', content: '你好' })
  assert.deepEqual(res[1], { role: 'assistant', content: '你好！我是 Monk。' })
})

test('序列化消息：助手工具调用与工具返回结果', () => {
  const messages: Message[] = [
    {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'text', text: '正在读取文件...' },
        { type: 'tool-call', id: 'call_123', name: 'read', arguments: '{"path":"a.txt"}' },
      ],
    },
    {
      id: 'm2',
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_123', content: [{ type: 'text', text: 'file content' }] },
      ],
    },
  ]
  const res = serializeMessages(messages, new Map())
  assert.equal(res.length, 2)
  assert.deepEqual(res[0], {
    role: 'assistant',
    content: '正在读取文件...',
    tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  })
  assert.deepEqual(res[1], {
    role: 'tool',
    tool_call_id: 'call_123',
    content: 'file content',
  })
})

test('序列化请求：带 system 提示词与工具声明', () => {
  const tools: ToolSchema[] = [
    { name: 'bash', description: 'Run bash command', parameters: { type: 'object' } },
  ]
  const req = serializeRequest({
    model: 'monk-coding',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'ls' }] }],
    system: 'You are Monk.',
    tools,
  })

  assert.equal(req.model, 'monk-coding')
  assert.equal(req.stream, true)
  assert.deepEqual(req.stream_options, { include_usage: true })
  assert.equal(req.messages[0].role, 'system')
  assert.equal(req.messages[0].content, 'You are Monk.')
  assert.equal(req.messages[1].role, 'user')
  assert.equal(req.messages[1].content, 'ls')
  assert.equal(req.tools?.length, 1)
  assert.equal(req.tools?.[0].function.name, 'bash')
})

test('工具声明确定性按字典序排序，保证前缀 KV 缓存稳定', () => {
  const tools: ToolSchema[] = [
    { name: 'write', description: 'write file', parameters: {} },
    { name: 'bash', description: 'run bash', parameters: {} },
    { name: 'edit', description: 'edit file', parameters: {} },
  ]
  const serialized = serializeTools(tools)
  assert.deepEqual(
    serialized.map(t => t.function.name),
    ['bash', 'edit', 'write'],
  )
})

test('工具调用参数健壮性归一化：web_search 字符串参数提升为数组', () => {
  // 传 queries 为单个字符串
  const res1 = normalizeToolArguments('web_search', JSON.stringify({ queries: '南方网新闻' }))
  assert.deepEqual(JSON.parse(res1), { queries: ['南方网新闻'] })

  // 传 query 别名
  const res2 = normalizeToolArguments('web_search', JSON.stringify({ query: 'DeepSeek news' }))
  assert.deepEqual(JSON.parse(res2), { queries: ['DeepSeek news'] })

  // 传 q 别名
  const res3 = normalizeToolArguments('web_search', JSON.stringify({ q: 'test' }))
  assert.deepEqual(JSON.parse(res3), { queries: ['test'] })

  // 原生标准数组不变
  const res4 = normalizeToolArguments('web_search', JSON.stringify({ queries: ['a', 'b'] }))
  assert.deepEqual(JSON.parse(res4), { queries: ['a', 'b'] })
})
