/**
 * `monk-router` 插件入口。
 *
 * 在 `agent/request` 瀑布事件上按任务类别选择 Monk 模型，把 monk.party 的
 * "三个模型各管一摊"变成**自动**行为：日常对话走 `monk-fast`，编码工作走
 * `monk-coding`，长对话与复杂推理走 `monk`。
 *
 * ## 路由隔离
 *
 * 只有当请求的 `provider` 恰好是本适配器的路由键时才改写模型。其它提供方
 * （例如 `deepseek-official`）的请求原样透传，因此 monk-harness 可以与
 * 原有提供方**并存**，用户随时切换而不必卸载插件。
 *
 * ## 与 agent loop 的协作
 *
 * `agent/request` 是 waterfall：监听器必须调用 `next()` 才能委托下去，因此
 * 本插件先取到 loop 已解析的配置，再在其上做最小改写。改写 `model` 会被
 * loop 记录为一次 `request/header` 变化，这正是我们想要的——历史里能看到
 * "这一轮换了模型"，回放与遥测因此保持可解释。
 * @module @monk/monk-router
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MonkService, MonkTier } from '@monk/monk-llm'
import {
  classifyTask,
  decide,
  DEFAULT_ROUTER_POLICY,
  RouterState,
  type MonkTaskClass,
  type RouterObservation,
  type RouterPolicy,
  type WebSearchMode,
} from './policy.ts'

export const name = 'monk-router'
export const inject = ['llm']

/**
 * 插件配置。
 *
 * 每个字段都可省略：出厂策略在 {@link DEFAULT_ROUTER_POLICY} 中声明，用户只需
 * 覆盖想改的那几项。
 */
export interface Config {
  /** 总开关；关闭后本插件对请求完全透明。 */
  enabled?: boolean
  /** 无法判定时的兜底类别。 */
  defaultClass?: MonkTaskClass
  /** 判定为"编码"的工具名。 */
  codingTools?: string[]
  /** assistant 消息数阈值，超过后升级为 deep。 */
  deepAssistantThreshold?: number
  /** 轮次序号阈值，超过后升级为 deep。 */
  deepTurnThreshold?: number
  /** 类别 → 分层。 */
  classToTier?: Record<MonkTaskClass, MonkTier>
  /**
   * 类别 → 推理强度。字段可缺省，缺省表示"不干预，用提供方默认值"——
   * 因此这里不能用 `z.union([...]).default()`，否则无法表达"不设置"。
   */
  classToEffort?: {
    chat?: 'low' | 'medium' | 'high'
    coding?: 'low' | 'medium' | 'high'
    deep?: 'low' | 'medium' | 'high'
  }
  /** 是否在轮次内保持粘滞。 */
  stickyWithinTurn?: boolean
  /** 智能联网搜索模式（'off' | 'on' | 'auto'）。 */
  webSearchMode?: 'off' | 'on' | 'auto'
}

const classSchema = z.union(['chat', 'coding', 'deep'] as const)
const tierSchema = z.union(['quality', 'fast', 'coding'] as const)
const effortSchema = z.union(['low', 'medium', 'high'] as const)

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  defaultClass: classSchema.default('chat'),
  codingTools: z.array(z.string()).default([...DEFAULT_ROUTER_POLICY.codingTools]),
  deepAssistantThreshold: z.number().step(1).min(1).default(DEFAULT_ROUTER_POLICY.deepAssistantThreshold),
  deepTurnThreshold: z.number().step(1).min(1).default(DEFAULT_ROUTER_POLICY.deepTurnThreshold),
  classToTier: z.object({
    chat: tierSchema.default('fast'),
    coding: tierSchema.default('coding'),
    deep: tierSchema.default('quality'),
  }).default({ ...DEFAULT_ROUTER_POLICY.classToTier }),
  // 刻意不给默认值：字段可缺省，缺省即"不干预，用提供方默认强度"。
  classToEffort: z.object({
    chat: effortSchema,
    coding: effortSchema,
    deep: effortSchema,
  }),
  stickyWithinTurn: z.boolean().default(true),
  webSearchMode: z.union(['off', 'on', 'auto'] as const).default('auto'),
})

/**
 * 归一化配置到完整策略。
 *
 * 编程式构造可以绕过 Schemastery 默认值，因此每个字段都在这里重新落一次默认。
 * @param config - 原始插件配置。
 * @returns 完整策略。
 */
export function resolvePolicy(config: Config): RouterPolicy {
  const effort = config.classToEffort ?? {}
  return {
    enabled: config.enabled ?? DEFAULT_ROUTER_POLICY.enabled,
    defaultClass: config.defaultClass ?? DEFAULT_ROUTER_POLICY.defaultClass,
    codingTools: config.codingTools ?? [...DEFAULT_ROUTER_POLICY.codingTools],
    deepAssistantThreshold: config.deepAssistantThreshold ?? DEFAULT_ROUTER_POLICY.deepAssistantThreshold,
    deepTurnThreshold: config.deepTurnThreshold ?? DEFAULT_ROUTER_POLICY.deepTurnThreshold,
    classToTier: config.classToTier ?? DEFAULT_ROUTER_POLICY.classToTier,
    classToEffort: {
      chat: effort.chat ?? DEFAULT_ROUTER_POLICY.classToEffort.chat,
      coding: effort.coding ?? DEFAULT_ROUTER_POLICY.classToEffort.coding,
      deep: effort.deep ?? DEFAULT_ROUTER_POLICY.classToEffort.deep,
    },
    stickyWithinTurn: config.stickyWithinTurn ?? DEFAULT_ROUTER_POLICY.stickyWithinTurn,
    webSearchMode: config.webSearchMode ?? DEFAULT_ROUTER_POLICY.webSearchMode,
  }
}

/** 逐会话的观察累积。 */
interface SessionFacts {
  toolNames: Set<string>
  assistantMessages: number
  lastTurn: number
}

/**
 * 插件挂载点。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const policy = resolvePolicy(config)

  ctx.inject(['monk'], (monkCtx) => {
    const monk: MonkService = monkCtx.monk
    const facts = new WeakMap<Session, SessionFacts>()
    const states = new WeakMap<Agent, RouterState>()

    const factsOf = (session: Session): SessionFacts => {
      let current = facts.get(session)
      if (current === undefined) {
        current = { toolNames: new Set(), assistantMessages: 0, lastTurn: -1 }
        facts.set(session, current)
      }
      return current
    }

    const stateOf = (agent: Agent): RouterState => {
      let current = states.get(agent)
      if (current === undefined) {
        current = new RouterState()
        states.set(agent, current)
      }
      return current
    }

    /**
     * 把累积事实投影成分类器要的观察快照。
     * @param record - 该会话累积的事实。
     * @param turn - 调用方已知的当前轮次；省略时回落到最后一次 `turn/start`。
     */
    const observationOf = (record: SessionFacts, turn?: number): RouterObservation => ({
      turn: turn ?? record.lastTurn,
      toolNames: record.toolNames,
      assistantMessages: record.assistantMessages,
    })

    // 观察面：只累积事实，不做决策，也不改动会话。
    ctx.on('session/event', (_session, event) => {
      const session = _session as Session
      const record = factsOf(session)
      switch (event.type) {
        case 'tool/call':
          record.toolNames.add(event.data.name)
          break
        case 'assistant/message':
          record.assistantMessages += 1
          break
        case 'turn/start':
          record.lastTurn = event.data.turn
          break
        default:
          break
      }
    })

    // 决策面：agent/request 是 waterfall，必须先委托再改写。
    ctx.on(
      'agent/request',
      async (payload, next): Promise<LlmCallConfig> => {
        const resolved = await next()
        if (!policy.enabled) return resolved
        // 路由隔离：不是本适配器的路由就完全不动。
        if (resolved.provider !== monk.provider) return resolved

        const state = stateOf(payload.agent)
        const turn = payload.turn

        // 1. 用户显式钉住的模型优先。
        const pin = state.pin
        if (pin !== undefined) {
          return { ...resolved, model: pin.model, ...pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort as never } }
        }

        // 2. 轮次内粘滞：避免中途换模型击穿 KV 缓存。
        const sticky = state.stickyFor(turn, policy.stickyWithinTurn)
        if (sticky !== undefined) {
          return { ...resolved, model: sticky.model, ...sticky.reasoningEffort === undefined ? {} : { reasoningEffort: sticky.reasoningEffort as never } }
        }

        // 3. 轮次边界：按会话事实分类并决策。
        const sessionFacts = factsOf(payload.agent.session)
        const taskClass = classifyTask(observationOf(sessionFacts, turn), policy)
        const decision = decide(taskClass, policy, tier => monk.resolveTier(tier), undefined, sessionFacts.toolNames)
        if (decision === undefined) {
          // 目录里没有对应分层：保持 loop 的配置，不猜。
          ctx.logger.warn(`monk-router: catalog has no model for tier "${policy.classToTier[taskClass]}"; keeping the resolved model`)
          return resolved
        }
        state.remember(turn, decision)
        return {
          ...resolved,
          model: decision.model,
          ...decision.reasoningEffort === undefined ? {} : { reasoningEffort: decision.reasoningEffort as never },
        }
      },
    )

    // 暴露给 `/monk` 命令与工具的查询面：当前会话的分类与决策依据。
    ctx.provide('monkRouter', {
      /** 读取某会话当前的分类事实（诊断用）。 */
      observe: (session: Session): RouterObservation => {
        const record = factsOf(session)
        return {
          turn: record.lastTurn,
          toolNames: new Set(record.toolNames),
          assistantMessages: record.assistantMessages,
        }
      },
      /** 读取某会话当前的分类结果。 */
      classify: (session: Session): MonkTaskClass => classifyTask(observationOf(factsOf(session)), policy),
      /** 读取某 agent 的路由状态。 */
      stateOf,
      /** 当前生效的策略快照。 */
      policy: () => policy,
      /** 动态切换智能联网搜索模式。 */
      setWebSearchMode: (mode: WebSearchMode) => {
        policy.webSearchMode = mode
      },
    } satisfies MonkRouterService)
  })
}

/** 本插件向其它插件暴露的服务。 */
export interface MonkRouterService {
  observe(session: Session): RouterObservation
  classify(session: Session): MonkTaskClass
  stateOf(agent: Agent): RouterState
  policy(): RouterPolicy
  setWebSearchMode(mode: WebSearchMode): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Monk 路由诊断面；由 `@monk/monk-router` 提供。 */
    monkRouter: MonkRouterService
  }
}

export {
  classifyTask,
  decide,
  DEFAULT_ROUTER_POLICY,
  RouterState,
} from './policy.ts'
export type {
  MonkTaskClass,
  RouterObservation,
  RouterPolicy,
  RoutingDecision,
  TierResolver,
} from './policy.ts'
