/**
 * Monk Verbatim Pruner (无损上下文智能剪枝)。
 *
 * 借鉴 fast-jev-compaction 的核心思想：
 * 绝不重写、绝不总结用户与助手的对话和代码解释，只删除或修剪已失效、过时的工具结果。
 * 保持完整对话 100% 逐字无损（Verbatim），同时将长程上下文体积削减 40%~70%。
 *
 * @module @monk/monk-usage/pruner
 */

import type { Session, SessionSeq, SessionEvent } from '@deepseek-ai/dsh-session'
import { formatTokens } from './ledger.ts'

export interface PruneOptions {
  /** 保留最近不触碰的表面节点数量（缺省 6 个节点）。 */
  preserveRecentNodes?: number
  /** 终端/Bash 输出修剪阈值（字符数，缺省 800）。 */
  bashThresholdChars?: number
  /** 搜索/抓取输出修剪阈值（字符数，缺省 1200）。 */
  webThresholdChars?: number
}

export interface PruneSummary {
  readonly examinedNodes: number
  readonly prunedCount: number
  readonly charsSaved: number
  readonly details: readonly string[]
}

/**
 * 对会话表面执行无损剪枝。
 * @param session - 当前目标会话。
 * @param options - 剪枝选项。
 * @returns 剪枝结果摘要。
 */
export function pruneVerbatim(session: Session, options: PruneOptions = {}): PruneSummary {
  const preserveRecent = options.preserveRecentNodes ?? 6
  const bashThreshold = options.bashThresholdChars ?? 800
  const webThreshold = options.webThresholdChars ?? 1200

  const nodes = [...session.surface.nodes]
  if (nodes.length <= preserveRecent) {
    return {
      examinedNodes: nodes.length,
      prunedCount: 0,
      charsSaved: 0,
      details: ['表面节点数较少，已全部处于保留区，跳过剪枝。'],
    }
  }

  // 1. 建立 callId -> toolCall 信息索引，以及记录文件写入历史
  interface ToolCallMeta {
    seq: SessionSeq
    name: string
    path?: string | undefined
  }
  const toolCallByCallId = new Map<string, ToolCallMeta>()
  const fileWrittenSeqs = new Map<string, SessionSeq>()

  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message') {
      const msg = (event.data as any).message || event.data
      const content = msg?.content || []
      for (const block of content) {
        if (block.type === 'tool-call') {
          let path: string | undefined
          try {
            const parsed = JSON.parse(block.arguments || '{}')
            path = parsed.path ?? parsed.file_path ?? parsed.filePath
          } catch {}

          toolCallByCallId.set(block.id, { seq, name: block.name, path })

          if (['edit', 'write', 'str_replace_editor'].includes(block.name) && path) {
            fileWrittenSeqs.set(path, seq)
          }
        }
      }
    }
  }

  // 2. 检查除最近保护区以外的工具结果节点
  const candidates: Array<{ seq: SessionSeq; event: SessionEvent<'tool/result'> }> = []
  const eligibleSeqs = nodes.slice(0, nodes.length - preserveRecent)

  for (const seq of eligibleSeqs) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/result') {
      candidates.push({ seq, event: event as SessionEvent<'tool/result'> })
    }
  }

  const details: string[] = []
  let charsSaved = 0
  let prunedCount = 0

  for (const { seq, event } of candidates) {
    const eventData = event.data as any
    const currentMsg = eventData.message || eventData
    const resultBlock = currentMsg?.content?.[0]
    if (!resultBlock || resultBlock.type !== 'tool-result') continue
    const textBlocks = resultBlock.content?.filter((b: any) => b.type === 'text') || []
    const originalText = textBlocks.map((b: any) => b.type === 'text' ? b.text : '').join('\n')
    if (originalText.length === 0) continue

    const callId = currentMsg?.source?.callId || resultBlock.toolCallId
    const meta = toolCallByCallId.get(callId)
    let newText: string | undefined
    let reason = ''

    // 规则 1：被后续编辑覆盖的陈旧文件读取
    if (meta && ['read', 'read_image'].includes(meta.name) && meta.path) {
      const writtenSeq = fileWrittenSeqs.get(meta.path)
      if (writtenSeq !== undefined && writtenSeq > seq && originalText.length > 300) {
        newText = `[... 已修剪 ${originalText.length} 字符：文件 ${meta.path} 的内容已被后续写操作更新 ...]`
        reason = `覆盖陈旧读取 (${meta.path})`
      }
    }

    // 规则 2：早期超长 Bash 输出
    if (!newText && meta && ['bash', 'pwsh'].includes(meta.name) && originalText.length > bashThreshold) {
      const head = originalText.slice(0, 200)
      const tail = originalText.slice(-100)
      const omitted = originalText.length - 300
      newText = `${head}\n\n[... 已修剪中间 ${omitted} 字符终端输出 ...]\n\n${tail}`
      reason = `修剪早期长命令输出 (${omitted} 字符)`
    }

    // 规则 3：早期超长网页搜索/抓取结果
    if (!newText && meta && ['web_search', 'web_fetch'].includes(meta.name) && originalText.length > webThreshold) {
      const head = originalText.slice(0, 300)
      const omitted = originalText.length - 300
      newText = `${head}\n\n[... 已修剪后续 ${omitted} 字符网络检索内容 ...]`
      reason = `修剪早期网页检索输出 (${omitted} 字符)`
    }

    if (newText !== undefined && newText.length < originalText.length) {
      const savings = originalText.length - newText.length
      charsSaved += savings
      prunedCount += 1
      details.push(`${reason} · 释放约 ${formatTokens(Math.round(savings / 4))} token`)

      // 在会话表面上原子化替换该节点
      session.append('tool/result', {
        ...eventData,
        message: {
          ...currentMsg,
          content: [{
            ...resultBlock,
            content: [{ type: 'text', text: newText }],
          }],
        },
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
    }
  }

  return {
    examinedNodes: nodes.length,
    prunedCount,
    charsSaved,
    details,
  }
}
