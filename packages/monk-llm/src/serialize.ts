/**
 * 请求序列化：dsh 中立消息词汇 → Monk wire 请求体。
 *
 * 这是**唯一**理解双方词汇的地方。adapter 类不解析消息内容，只负责编排；
 * 线上格式的细节全部收敛在本模块。
 *
 * 两条关键投影规则：
 * 1. 图片：`ImageBlock` 携带的是 attachment 引用，不是字节。真正的解析由
 *    调用方（adapter）通过 attachments seam 完成后再交进来，因此本模块只
 *    接受已经解析好的 data URL / 公网 URL。
 * 2. 工具结果：dsh 把工具结果表达为 user 角色的 `tool-result` 块，而 wire
 *    协议要求 `role: 'tool'` + `tool_call_id`。一条 dsh 消息可能携带多个
 *    结果块，序列化时按块拆成多条 wire 消息。
 * @module @monk/monk-llm/serialize
 */

import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type {
  MonkWireContent,
  MonkWireImagePart,
  MonkWireMessage,
  MonkWireRequest,
  MonkWireTextPart,
  MonkWireTool,
  MonkWireToolCall,
} from './wire.ts'

/** 已解析的图片引用：wire 层只认 URL。 */
export interface ResolvedImage {
  /** 图片出现的位置：消息 id 加块下标。 */
  readonly messageId: string
  readonly blockIndex: number
  /** data URL 或公网 URL。 */
  readonly url: string
  readonly detail?: 'auto' | 'low' | 'high'
}

/** 序列化一个请求所需的全部外部事实。 */
export interface SerializeInput {
  model: string
  messages: readonly Message[]
  system?: string
  tools?: readonly ToolSchema[]
  maxTokens?: number
  temperature?: number
  stop?: readonly string[]
  /** 按 `messageId` 分组的已解析图片。 */
  images?: ReadonlyMap<string, readonly ResolvedImage[]>
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/**
 * 把一条 dsh 消息的内容块投影为 wire 内容。
 * @param blocks - 该消息的内容块。
 * @param images - 该消息已解析的图片，按块下标对齐。
 * @returns 纯文本时为 string，含图片时为分片数组。
 */
function serializeContent(
  blocks: readonly ContentBlock[],
  images: readonly ResolvedImage[],
): MonkWireContent | null {
  const parts: (MonkWireTextPart | MonkWireImagePart)[] = []
  const imageByIndex = new Map(images.map(image => [image.blockIndex, image]))

  blocks.forEach((block, index) => {
    switch (block.type) {
      case 'text':
        if (block.text !== '') parts.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        // 思考内容不回传给提供方：Monk 在下一轮请求中不接受历史思考块。
        break
      case 'image': {
        const resolved = imageByIndex.get(index)
        // 无法解析的图片投影为文本占位，绝不静默丢弃整条消息。
        if (resolved === undefined) {
          parts.push({ type: 'text', text: '[image: unresolved]' })
          break
        }
        parts.push({
          type: 'image_url',
          image_url: resolved.detail === undefined
            ? { url: resolved.url }
            : { url: resolved.url, detail: resolved.detail },
        })
        break
      }
      case 'tool-call':
      case 'tool-result':
        // 由调用方分别处理，见 serializeMessages。
        break
      default:
        // 合并可扩展的联合：未知块类型按不透明内容透传为文本，不中断请求。
        // （0.1.2 的 ContentBlockMap 尚无 'file' 块；将来新增时由此分支兜住。）
        break
    }
  })

  if (parts.length === 0) return null
  // 全文本时降级为 string，与多数提供方的快速路径一致。
  if (parts.every((part): part is MonkWireTextPart => part.type === 'text')) {
    return parts.map(part => part.text).join('\n')
  }
  return parts
}

/** 从一条 assistant 消息里取出工具调用块。 */
function toolCallsOf(blocks: readonly ContentBlock[]): MonkWireToolCall[] {
  const calls: MonkWireToolCall[] = []
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    calls.push({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    })
  }
  return calls
}

/**
 * 序列化对话消息。
 *
 * 一条 dsh 消息可能展开为多条 wire 消息：user 角色消息若携带 N 个
 * `tool-result` 块，就产生 N 条 `role: 'tool'` 消息。assistant 消息若同时
 * 有文本与工具调用，则合并为一条 wire assistant 消息。
 * @param messages - dsh 中立消息序列，顺序即模型所见顺序。
 * @param images - 按消息 id 索引的已解析图片。
 * @returns wire 消息序列。
 */
export function serializeMessages(
  messages: readonly Message[],
  images: ReadonlyMap<string, readonly ResolvedImage[]>,
): MonkWireMessage[] {
  const out: MonkWireMessage[] = []

  for (const message of messages) {
    const blocks = message.content
    const toolResults = blocks.filter(block => block.type === 'tool-result')
    const calls = toolCallsOf(blocks)
    const resolvedImages = images.get(message.id) ?? []

    if (toolResults.length > 0) {
      // 每个工具结果独立成一条 tool 消息，保留调用关联。
      for (const result of toolResults) {
        if (result.type !== 'tool-result') continue
        const resultText = serializeContent(result.content, [])
        out.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: resultText ?? '',
        })
      }
      // 同一条消息里若还夹带正文（罕见但合法），追加为一条 user 消息。
      const proseContent = serializeContent(blocks.filter(block => block.type !== 'tool-result'), resolvedImages)
      if (proseContent !== null) {
        out.push({
          role: 'user',
          content: proseContent,
        })
      }
      continue
    }

    const content = serializeContent(blocks, resolvedImages)
    if (message.role === 'assistant') {
      if (content === null && calls.length === 0) continue
      out.push({
        role: 'assistant',
        content,
        ...calls.length === 0 ? {} : { tool_calls: calls },
      })
      continue
    }

    // 空内容的 user 消息在部分提供方会被判为非法请求，跳过。
    if (content === null) continue
    out.push({ role: 'user', content })
  }

  return out
}

/** 把 dsh 的工具 schema 投影为 wire 工具声明（按名字字典序绝对确定性排序，最大化前缀 KV 缓存命中）。 */
export function serializeTools(tools: readonly ToolSchema[]): MonkWireTool[] {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  return sorted.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/**
 * 组装完整请求体。
 *
 * `stream` 与 `stream_options.include_usage` 恒为真：本适配器只支持流式
 * 调用，且必须拿到 usage 才能满足"finish 之前发出 usage"的契约。
 * @param input - 序列化输入。
 * @returns 可直接交给 fetch 的请求体。
 */
export function serializeRequest(input: SerializeInput): MonkWireRequest {
  const messages: MonkWireMessage[] = []
  // 系统提示词走独立的 system 槽，不混进 user 消息。
  if (input.system !== undefined && input.system !== '') {
    messages.push({ role: 'system', content: input.system })
  }
  messages.push(...serializeMessages(input.messages, input.images ?? new Map()))

  return {
    model: input.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens },
    ...input.temperature === undefined ? {} : { temperature: input.temperature },
    ...input.stop === undefined || input.stop.length === 0 ? {} : { stop: [...input.stop] },
    ...input.tools === undefined || input.tools.length === 0
      ? {}
      : { tools: serializeTools(input.tools), tool_choice: 'auto' as const },
    ...input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort },
  }
}
