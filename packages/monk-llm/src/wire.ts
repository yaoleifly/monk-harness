/**
 * Monk wire 协议类型。
 *
 * monk.party 暴露 OpenAI 兼容的 Chat Completions 接口，因此这里的类型是
 * 该协议在 Monk 语境下的**最小无损投影**：只声明本适配器真正读写到的字段，
 * 不追求覆盖整个协议。字段名保持 snake_case，与线上报文一致，避免在
 * 类型层引入一层不必要的改名。
 *
 * 职责边界：本文件只有类型，没有行为。
 * @module @monk/monk-llm/wire
 */

/** 文本内容分片。 */
export interface MonkWireTextPart {
  type: 'text'
  text: string
}

/** 图片内容分片（data URL 或公网 URL）。 */
export interface MonkWireImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

/** 一条消息的内容：纯文本或分片数组。 */
export type MonkWireContent = string | readonly (MonkWireTextPart | MonkWireImagePart)[]

/** 请求侧的一个工具调用。 */
export interface MonkWireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 请求/响应通用的一条消息。 */
export interface MonkWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: MonkWireContent | null
  /** assistant 消息携带的工具调用。 */
  tool_calls?: readonly MonkWireToolCall[]
  /** tool 角色消息关联的调用 id。 */
  tool_call_id?: string
  /** tool 角色消息的工具名。 */
  name?: string
}

/** 面向模型的工具声明。 */
export interface MonkWireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 一个完整的 Chat Completions 请求体。 */
export interface MonkWireRequest {
  model: string
  messages: MonkWireMessage[]
  stream: true
  /** 请求流式 usage 统计。Monk 在末尾分片返回 usage。 */
  stream_options: { include_usage: true }
  max_tokens?: number
  temperature?: number
  stop?: string[]
  tools?: MonkWireTool[]
  tool_choice?: 'auto' | 'none'
  reasoning_effort?: 'low' | 'medium' | 'high'
}

/** 流式分片里的一段增量。 */
export interface MonkWireDelta {
  role?: 'assistant'
  content?: string | null
  /** 部分提供方使用 reasoning_content 承载思考内容。 */
  reasoning_content?: string | null
  tool_calls?: readonly {
    index: number
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }[]
}

/** 流式响应中的一个 choice。 */
export interface MonkWireChoice {
  index: number
  delta?: MonkWireDelta
  finish_reason?: string | null
}

/** OpenAI 形状的 usage 统计。 */
export interface MonkWireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** 一个流式分片。 */
export interface MonkWireChunk {
  id?: string
  model?: string
  choices?: readonly MonkWireChoice[]
  usage?: MonkWireUsage | null
}

/** 非流式错误响应体。 */
export interface MonkWireErrorBody {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}
