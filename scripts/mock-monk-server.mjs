/**
 * 本地 mock Monk API 服务端。
 *
 * 目的：让 monk-harness 在没有真实 Monk 订阅的情况下也能跑通一次完整 agent 回合。
 * 它按 OpenAI 兼容协议提供 `/v1/chat/completions`，并把收到的请求落到
 * `/tmp/monk-mock-requests.jsonl`，便于事后核对 harness 究竟发了什么
 * （system 槽、工具 schema、消息历史）。
 *
 * 用法：node scripts/mock-monk-server.mjs [port]
 */

import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 7788)
const LOG = '/tmp/monk-mock-requests.jsonl'
writeFileSync(LOG, '')

/** 把一次回复编成 SSE。 */
function sseReply(text, model) {
  const chunks = [
    { id: `mock-${Date.now()}`, model, choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { model, choices: [{ index: 0, delta: { content: text } }] },
    { model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      model,
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 42,
        total_tokens: 1042,
        prompt_tokens_details: { cached_tokens: 768 },
      },
    },
  ]
  return `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
}

const server = createServer((req, res) => {
  const parts = []
  req.on('data', b => parts.push(b))
  req.on('end', () => {
    const raw = Buffer.concat(parts).toString('utf8')
    let body
    try { body = JSON.parse(raw) } catch { body = { _raw: raw } }

    appendFileSync(LOG, `${JSON.stringify({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body,
    })}\n`)

    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }))
      return
    }

    const model = body.model ?? 'unknown'
    const text = `[mock-monk:${model}] 收到 ${body.messages?.length ?? 0} 条消息、`
      + `${body.tools?.length ?? 0} 个工具。这条回复来自本地 mock 服务端。`

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(sseReply(text, model))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock monk api listening on http://127.0.0.1:${PORT}/v1`)
  console.log(`requests -> ${LOG}`)
})
