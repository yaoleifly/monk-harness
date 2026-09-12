import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeMessages, serializeRequest, serializeTools } from '../src/serialize.ts'
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
