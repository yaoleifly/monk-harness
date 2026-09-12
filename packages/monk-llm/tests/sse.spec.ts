/**
 * SSE 分帧测试。
 *
 * 重点覆盖真实网络里会出问题的地方：分片在任意字节处断开、多字节 UTF-8
 * 字符被切断、`\r\n` 与 `\r` 行结束符、注释行、以及 `[DONE]` 哨兵。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSse, SSE_DONE } from '../src/sse.ts'

/** 把若干字符串按给定切点组装成一个分块字节流。 */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/**
 * 把一段文本切成固定大小的**原始字节**分片流。
 *
 * 关键：必须在字节层切分，而不是先解码成字符串再切片。否则一个多字节字符会
 * 在测试夹具里就被非流式解码器替换成 U+FFFD，测的就不是解析器了。重组多字节
 * 字符是解析器内部流式解码器的职责，也正是本测试要验证的东西。
 * @param text - 源文本。
 * @param size - 每个分片的字节数。
 * @returns 按字节切分的分块流。
 */
function byteStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size))
      }
      controller.close()
    },
  })
}

/** 收集全部事件。 */
async function collect(chunks: readonly string[]) {
  const events = []
  for await (const event of parseSse(streamOf(chunks))) events.push(event)
  return events
}

/** 从字节分片流收集全部事件。 */
async function collectBytes(text: string, size: number) {
  const events = []
  for await (const event of parseSse(byteStream(text, size))) events.push(event)
  return events
}

test('解析单条事件', async () => {
  const events = await collect(['data: {"a":1}\n\n'])
  assert.deepEqual(events, [{ event: 'message', data: '{"a":1}' }])
})

test('空行分隔多条事件', async () => {
  const events = await collect(['data: one\n\ndata: two\n\n'])
  assert.deepEqual(events.map(e => e.data), ['one', 'two'])
})

test('同事件内多个 data 行以换行连接', async () => {
  const events = await collect(['data: line1\ndata: line2\n\n'])
  assert.deepEqual(events, [{ event: 'message', data: 'line1\nline2' }])
})

test('注释行（keep-alive）被丢弃', async () => {
  const events = await collect([': keep-alive\n\ndata: real\n\n'])
  assert.deepEqual(events, [{ event: 'message', data: 'real' }])
})

test('\\r\\n 与 \\r 都被当作行结束符', async () => {
  const crlf = await collect(['data: a\r\n\r\n'])
  assert.deepEqual(crlf.map(e => e.data), ['a'])
  const cr = await collect(['data: a\r\r'])
  assert.deepEqual(cr.map(e => e.data), ['a'])
})

test('冒号后的单个空格不属于值', async () => {
  const events = await collect(['data:  two-spaces\n\n'])
  // 只剥一个空格：`data:  x` 的值是 ` x`。
  assert.deepEqual(events[0]?.data, ' two-spaces')
})

test('data 无冒号时值为空字符串', async () => {
  const events = await collect(['data\n\n'])
  assert.deepEqual(events, [{ event: 'message', data: '' }])
})

test('事件跨网络分片被正确重组', async () => {
  const text = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
  const events = await collectBytes(text, 3)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data, '{"choices":[{"delta":{"content":"你好"}}]}')
})

test('逐字节切分仍能解析（最坏情况）', async () => {
  const text = 'data: 你好世界\n\n'
  const events = await collectBytes(text, 1)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data, '你好世界')
})

test('event 字段被保留', async () => {
  const events = await collect(['event: error\ndata: boom\n\n'])
  assert.deepEqual(events, [{ event: 'error', data: 'boom' }])
})

test('[DONE] 哨兵原样透出，由调用方判断', async () => {
  const events = await collect([`data: ${SSE_DONE}\n\n`])
  assert.equal(events[0]?.data, SSE_DONE)
})

test('末尾无换行的最后一行仍被产出', async () => {
  const events = await collect(['data: tail'])
  assert.deepEqual(events, [{ event: 'message', data: 'tail' }])
})

test('空流产出零事件', async () => {
  assert.deepEqual(await collect([]), [])
})

test('多字节字符跨分片边界不产生替换字符', async () => {
  const text = 'data: 中文字符测试\n\n'
  const events = await collectBytes(text, 2)
  assert.equal(events[0]?.data, '中文字符测试')
  assert.ok(!String(events[0]?.data).includes('\uFFFD'), '不应出现 U+FFFD 替换字符')
})

test('预先中止的信号立即结束迭代', async () => {
  const controller = new AbortController()
  controller.abort()
  const events = []
  for await (const event of parseSse(streamOf(['data: a\n\n']), controller.signal)) {
    events.push(event)
  }
  assert.deepEqual(events, [])
})
