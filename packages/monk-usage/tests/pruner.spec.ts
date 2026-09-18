import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { pruneVerbatim } from '../src/pruner.ts'

test('pruneVerbatim: 节点较少时保留区生效，跳过剪枝', () => {
  const session = Session.create(SessionId('test-prune-1'))
  session.append('user/message', {
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

  const res = pruneVerbatim(session, { preserveRecentNodes: 6 })
  assert.equal(res.prunedCount, 0)
  assert.equal(res.charsSaved, 0)
})

test('pruneVerbatim: 修剪被后续 edit 覆盖的陈旧文件读取', () => {
  const session = Session.create(SessionId('test-prune-superseded'))

  // 1. 读取 a.ts (长内容)
  session.append('user/message', { content: [{ type: 'text', text: 'read a.ts' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    content: [{ type: 'tool-call', id: 'call-read-1', name: 'read', arguments: JSON.stringify({ path: 'src/a.ts' }) }],
    source: { kind: 'model', provider: 'monk-official', model: 'monk-coding' },
  }, { surfaceOp: 'append' })
  const readResultSeq = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-read-1',
        content: [{ type: 'text', text: 'export const a = 1;\n' + '// old code\n'.repeat(50) }],
      }],
      source: { kind: 'tool', callId: 'call-read-1' },
    },
  }, { surfaceOp: 'append' }).seq

  // 2. 后续调用 edit 修改了同一个文件 src/a.ts
  session.append('assistant/message', {
    content: [{ type: 'tool-call', id: 'call-edit-1', name: 'edit', arguments: JSON.stringify({ path: 'src/a.ts' }) }],
    source: { kind: 'model', provider: 'monk-official', model: 'monk-coding' },
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-edit-1',
        content: [{ type: 'text', text: 'edited ok' }],
      }],
      source: { kind: 'tool', callId: 'call-edit-1' },
    },
  }, { surfaceOp: 'append' })

  // 3. 追加保护区的多轮消息
  for (let i = 0; i < 6; i++) {
    session.append('user/message', { content: [{ type: 'text', text: `chat ${i}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  }

  const res = pruneVerbatim(session, { preserveRecentNodes: 6 })
  assert.ok(res.prunedCount >= 1)
  assert.ok(res.charsSaved > 0)

  // 验证被剪枝节点的内容已变为修剪标记
  const replacedNode = session.eventAt(session.surface.nodes[2]!)
  const text = (replacedNode?.data as any)?.message?.content[0]?.content[0]?.text
  assert.ok(text.includes('内容已被后续写操作更新'))
})

test('pruneVerbatim: 截断早期过长 bash 输出，保留首尾关键行', () => {
  const session = Session.create(SessionId('test-prune-bash'))

  session.append('user/message', { content: [{ type: 'text', text: 'run build' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    content: [{ type: 'tool-call', id: 'call-bash-1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm build' }) }],
    source: { kind: 'model', provider: 'monk-official', model: 'monk-coding' },
  }, { surfaceOp: 'append' })

  const longStdout = 'BUILD_START\n' + 'compiling package...\n'.repeat(100) + 'BUILD_SUCCESS_FINISHED'
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-bash-1',
        content: [{ type: 'text', text: longStdout }],
      }],
      source: { kind: 'tool', callId: 'call-bash-1' },
    },
  }, { surfaceOp: 'append' })

  for (let i = 0; i < 6; i++) {
    session.append('user/message', { content: [{ type: 'text', text: `pad ${i}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  }

  const res = pruneVerbatim(session, { preserveRecentNodes: 6, bashThresholdChars: 500 })
  assert.equal(res.prunedCount, 1)
  assert.ok(res.charsSaved > 1000)

  const replacedNode = session.eventAt(session.surface.nodes[2]!)
  const text = (replacedNode?.data as any)?.message?.content[0]?.content[0]?.text
  assert.ok(text.includes('BUILD_START'))
  assert.ok(text.includes('BUILD_SUCCESS_FINISHED'))
  assert.ok(text.includes('已修剪中间'))
})
