/**
 * 选路策略测试。
 *
 * 策略是纯函数，因此可以穷举。重点验证两件事：分类的**优先级顺序**，以及
 * 轮次内粘滞 / 显式钉住这两个会改变行为的开关。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTask,
  decide,
  DEFAULT_ROUTER_POLICY,
  RouterState,
  type RouterObservation,
} from '../src/policy.ts'

/** 构造一个观察快照。 */
function observe(partial: Partial<RouterObservation> = {}): RouterObservation {
  return {
    turn: partial.turn ?? 0,
    toolNames: partial.toolNames ?? new Set<string>(),
    assistantMessages: partial.assistantMessages ?? 0,
  }
}

/** 固定的分层 → 模型解析器。 */
const resolveTier = (tier: string): string | undefined => ({
  quality: 'monk',
  fast: 'monk-fast',
  coding: 'monk-coding',
})[tier]

test('空会话落入兜底类别', () => {
  assert.equal(classifyTask(observe(), DEFAULT_ROUTER_POLICY), 'chat')
})

test('出现大小写变体编码工具依然判为 coding', () => {
  const observation = observe({ toolNames: new Set(['BASH', 'Edit']) })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'coding')
})

test('coding 优先级高于 deep', () => {
  // 同时满足编码工具与长对话两个条件。
  const observation = observe({
    toolNames: new Set(['edit']),
    assistantMessages: 999,
    turn: 999,
  })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'coding')
})

test('无关工具不触发 coding', () => {
  const observation = observe({ toolNames: new Set(['todo_write', 'ask_user_question']) })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'chat')
})

test('对话变长后升级为 deep（assistant 消息数）', () => {
  const observation = observe({ assistantMessages: DEFAULT_ROUTER_POLICY.deepAssistantThreshold })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'deep')
})

test('对话变长后升级为 deep（轮次数）', () => {
  const observation = observe({ turn: DEFAULT_ROUTER_POLICY.deepTurnThreshold })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'deep')
})

test('恰好低于阈值时不升级', () => {
  const observation = observe({ assistantMessages: DEFAULT_ROUTER_POLICY.deepAssistantThreshold - 1 })
  assert.equal(classifyTask(observation, DEFAULT_ROUTER_POLICY), 'chat')
})

test('decide 把类别映射到分层与模型', () => {
  const decision = decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)
  assert.equal(decision?.tier, 'coding')
  assert.equal(decision?.model, 'monk-coding')
  assert.equal(decision?.reasoningEffort, 'medium')
})

test('decide 在目录缺该分层时返回 undefined', () => {
  assert.equal(decide('deep', DEFAULT_ROUTER_POLICY, () => undefined), undefined)
})

test('decide 在 effort 为 undefined 时不带 reasoningEffort 字段', () => {
  const policy = {
    ...DEFAULT_ROUTER_POLICY,
    classToEffort: { ...DEFAULT_ROUTER_POLICY.classToEffort, chat: undefined },
  }
  const decision = decide('chat', policy, resolveTier)
  assert.ok(decision !== undefined)
  assert.ok(!('reasoningEffort' in decision))
})

test('粘滞：同一轮次内复用已确定决策', () => {
  const state = new RouterState()
  const first = decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)!
  state.remember(3, first)
  assert.equal(state.stickyFor(3, true)?.model, 'monk-coding')
})

test('粘滞：跨轮次不生效', () => {
  const state = new RouterState()
  state.remember(3, decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)!)
  assert.equal(state.stickyFor(4, true), undefined)
})

test('粘滞：开关关闭时永不生效', () => {
  const state = new RouterState()
  state.remember(3, decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)!)
  assert.equal(state.stickyFor(3, false), undefined)
})

test('钉住优先于粘滞', () => {
  const state = new RouterState()
  state.remember(3, decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)!)
  const pin = { taskClass: 'deep' as const, tier: 'quality' as const, model: 'monk', source: 'pin' as const }
  state.setPin(pin)
  assert.equal(state.pin?.model, 'monk')
})

test('设置钉住会清掉本轮粘滞，使变更立即生效', () => {
  const state = new RouterState()
  state.remember(3, decide('coding', DEFAULT_ROUTER_POLICY, resolveTier)!)
  state.setPin({ taskClass: 'chat', tier: 'fast', model: 'monk-fast', source: 'pin' })
  assert.equal(state.stickyFor(3, true), undefined)
})

test('解除钉住', () => {
  const state = new RouterState()
  state.setPin({ taskClass: 'chat', tier: 'fast', model: 'monk-fast', source: 'pin' })
  state.setPin(undefined)
  assert.equal(state.pin, undefined)
})
