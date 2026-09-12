/**
 * SSE（Server-Sent Events）分帧。
 *
 * 只做一件事：把 `text/event-stream` 的字节流切成一条条 `data:` 负载。
 * 刻意保持零依赖，使本包可以脱离 dsh 仓库单独测试——`eventsource-parser`
 * 是可替换的实现选择，不是协议本身。
 *
 * 遵循 WHATWG EventSource 的分帧规则中与 `data:` 相关的部分：
 * - 以空行分隔事件；
 * - 同事件内多个 `data:` 行以 `\n` 连接；
 * - 以 `:` 开头的行是注释（keep-alive），丢弃；
 * - 负载恰为 `[DONE]` 表示流正常结束；
 * - `\r\n` 与 `\r` 均视为行结束符。
 * @module @monk/monk-llm/sse
 */

/** 一条 SSE 事件的负载。 */
export interface SseEvent {
  /** 事件类型；缺省为 `message`。 */
  event: string
  /** 连接后的 data 负载。 */
  data: string
}

/** 流结束哨兵，与 OpenAI 兼容协议一致。 */
export const SSE_DONE = '[DONE]'

/**
 * 逐条解析 SSE 事件。
 *
 * 解析器是增量式的：网络分片可以在任意字节处断开，包括一个 UTF-8 字符
 * 中间。因此本函数消费的是已解码的字符串，调用方负责用
 * `TextDecoder({ stream: true })` 解码字节，避免多字节字符被切断。
 * @param body - 响应体可读流。
 * @param signal - 调用方取消信号；触发后迭代立刻结束。
 * @yields 每一条已完整到达的 SSE 事件。
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0 && eventName === '') return undefined
    const event: SseEvent = { event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') }
    eventName = ''
    dataLines = []
    return event
  }

  const consumeLine = (rawLine: string): SseEvent | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') return flush()
    // 注释行（keep-alive），不产生事件。
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // 规范规定冒号后若紧跟一个空格，该空格不属于值。
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    // id / retry 字段对本适配器无意义，显式忽略。
    return undefined
  }

  try {
    for (;;) {
      if (signal?.aborted === true) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        // `\r\n` 与 `\r` 都是合法行结束符；统一按 `\n` 切分后在上层剥 `\r`。
        const newline = buffer.search(/\r\n|\r|\n/)
        if (newline === -1) break
        const terminatorLength = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + terminatorLength)
        const event = consumeLine(line)
        if (event !== undefined) yield event
      }
    }
    // 流结束时缓冲里可能还留着没有换行符的最后一行。
    buffer += decoder.decode()
    if (buffer !== '') {
      const event = consumeLine(buffer)
      if (event !== undefined) yield event
    }
    const tail = flush()
    if (tail !== undefined) yield tail
  } finally {
    reader.releaseLock()
  }
}
