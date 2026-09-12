/**
 * 任务分类与选路策略（纯函数）。
 *
 * 本模块不接触 Cordis、不读时钟、不做 I/O，因此可以被穷举单测。插件层
 * （`index.ts`）只负责把会话事实喂进来、把决策写回去。
 *
 * ## 为什么必须"轮次内粘滞"
 *
 * `agent/request` 每个**步骤**都会触发一次，而一个轮次可能包含多个步骤
 * （模型请求 → 工具调用 → 再请求）。如果每个步骤都重新选路，同一轮次内
 * 就可能从 `monk-fast` 切到 `monk-coding`：
 *
 * 1. 请求前缀变化会**击穿 KV 缓存**，把本已复用的前缀 token 全部重算；
 * 2. agent loop 会把配置变化记录成一个新的 `request/header`，历史被切成
 *    两段，回放与遥测都要多背一份头；
 * 3. 同一轮次里模型自我认知不稳定，工具调用风格会漂移。
 *
 * 因此策略在**轮次边界**做决策，并在该轮次内保持粘滞。
 * @module @monk/monk-router/policy
 */

import type { MonkTier } from '@monk/monk-llm'

/** 任务类别：决定默认分层与推理强度。 */
export type MonkTaskClass =
  /** 日常对话、问答、轻量改写。 */
  | 'chat'
  /** 编码与工具驱动的工作：编辑文件、跑命令、跨文件检索。 */
  | 'coding'
  /** 长对话或复杂推理：需要更大的有效思考预算。 */
  | 'deep'

/** 从会话日志观察到的事实，用于分类。 */
export interface RouterObservation {
  /** 当前轮次序号（从 0 起）。 */
  turn: number
  /** 本会话已出现过的工具名。 */
  toolNames: ReadonlySet<string>
  /** 本会话已提交的 assistant 消息数。 */
  assistantMessages: number
}

/** 联网搜索控制模式。 */
export type WebSearchMode = 'on' | 'off' | 'auto'

/** 选路策略配置。 */
export interface RouterPolicy {
  /** 总开关；关闭后本插件对请求完全透明。 */
  enabled: boolean
  /** 无法判定时的兜底类别。 */
  defaultClass: MonkTaskClass
  /**
   * 判定为"编码"的工具名。命中任意一个即把会话钉在 coding 分层——
   * 一旦会话里出现过写文件或执行命令，后续继续按编码对待是更稳的假设。
   */
  codingTools: readonly string[]
  /** assistant 消息数超过该值后升级为 deep。 */
  deepAssistantThreshold: number
  /** 轮次序号超过该值后升级为 deep。 */
  deepTurnThreshold: number
  /** 类别到目录分层的映射。 */
  classToTier: Readonly<Record<MonkTaskClass, MonkTier>>
  /** 类别到推理强度的映射；`undefined` 表示不干预，用提供方默认值。 */
  classToEffort: Readonly<Record<MonkTaskClass, 'low' | 'medium' | 'high' | undefined>>
  /** 是否在轮次内保持粘滞（强烈建议开启，见模块文档）。 */
  stickyWithinTurn: boolean
  /** 智能联网搜索模式；缺省为 'auto'。 */
  webSearchMode: WebSearchMode
}

/** 出厂策略。 */
export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  enabled: true,
  defaultClass: 'chat',
  codingTools: [
    'bash', 'pwsh', 'edit', 'write', 'str_replace_editor',
    'glob', 'grep', 'read', 'read_image',
  ],
  deepAssistantThreshold: 12,
  deepTurnThreshold: 8,
  classToTier: { chat: 'fast', coding: 'coding', deep: 'quality' },
  classToEffort: { chat: 'low', coding: 'medium', deep: 'high' },
  stickyWithinTurn: true,
  webSearchMode: 'auto',
}

/** 识别需要实时联网提示的关键词。 */
const WEB_SEARCH_KEYWORDS = [
  '最新', '今天', '新闻', '实时', '搜索', '天气', '2026', '近况',
  'latest', 'today', 'news', 'recent', 'search', 'weather', 'current',
]

/**
 * 判断是否应触发 Monk 原生联网搜索 (X-Monk-Web-Search: true)。
 * @param mode - 模式：on / off / auto。
 * @param promptText - 本轮用户的输入文本（可选）。
 * @param toolNames - 已触发的工具列表。
 */
export function shouldEnableWebSearch(
  mode: WebSearchMode,
  promptText?: string,
  toolNames?: ReadonlySet<string>,
): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  if (toolNames !== undefined) {
    for (const name of toolNames) {
      const lower = name.toLowerCase()
      if (lower.includes('search') || lower.includes('fetch') || lower.includes('browse')) {
        return true
      }
    }
  }
  if (promptText !== undefined && promptText.length > 0) {
    const textLower = promptText.toLowerCase()
    return WEB_SEARCH_KEYWORDS.some(kw => textLower.includes(kw))
  }
  return false
}

/**
 * 按会话事实分类任务。
 *
 * 判定顺序即优先级：编码信号最强（一旦出现就不再回退），其次是对话长度
 * 带来的推理深度需求，最后是兜底类别。
 * @param observation - 从会话日志累积的事实。
 * @param policy - 选路策略。
 * @returns 任务类别。
 */
export function classifyTask(observation: RouterObservation, policy: RouterPolicy): MonkTaskClass {
  for (const name of observation.toolNames) {
    const lower = name.toLowerCase()
    if (policy.codingTools.some(tool => tool.toLowerCase() === lower)) return 'coding'
  }
  if (observation.assistantMessages >= policy.deepAssistantThreshold) return 'deep'
  if (observation.turn >= policy.deepTurnThreshold) return 'deep'
  return policy.defaultClass
}

/** 一次选路决策。 */
export interface RoutingDecision {
  /** 决策依据的类别。 */
  taskClass: MonkTaskClass
  /** 目标目录分层。 */
  tier: MonkTier
  /** 目标模型 id。 */
  model: string
  /** 目标推理强度；`undefined` 表示不干预。 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 是否需要带上 X-Monk-Web-Search: true 关联标头。 */
  webSearch?: boolean
  /** 决策来源，用于诊断与遥测。 */
  source: 'policy' | 'pin' | 'sticky'
}

/** 目录查询函数签名，避免 policy 依赖 catalog 模块的具体实现。 */
export type TierResolver = (tier: MonkTier) => string | undefined

/**
 * 依据类别与策略算出一个决策。
 * @param taskClass - 已分类的任务类别。
 * @param policy - 选路策略。
 * @param resolveTier - 把分层解析为具体模型 id。
 * @returns 决策；目录里找不到对应分层时返回 `undefined`，调用方应保持原配置。
 */
export function decide(
  taskClass: MonkTaskClass,
  policy: RouterPolicy,
  resolveTier: TierResolver,
  promptText?: string,
  toolNames?: ReadonlySet<string>,
): RoutingDecision | undefined {
  const tier = policy.classToTier[taskClass]
  const model = resolveTier(tier)
  if (model === undefined) return undefined
  const effort = policy.classToEffort[taskClass]
  const webSearch = shouldEnableWebSearch(policy.webSearchMode, promptText, toolNames)
  return {
    taskClass,
    tier,
    model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
    ...webSearch ? { webSearch: true } : {},
    source: 'policy',
  }
}

/**
 * 逐会话的路由状态。
 *
 * 保存粘滞决策：`(turn, decision)` 一旦确定，该轮次内后续步骤复用它。
 */
export class RouterState {
  private lastTurn = -1
  private sticky: RoutingDecision | undefined
  /** 用户显式钉住的模型；优先于策略。 */
  private pinned: RoutingDecision | undefined

  /**
   * 读取轮次内的粘滞决策。
   * @param turn - 当前轮次序号。
   * @param stickyWithinTurn - 策略是否开启粘滞。
   * @returns 该轮次已确定的决策，或 `undefined`。
   */
  stickyFor(turn: number, stickyWithinTurn: boolean): RoutingDecision | undefined {
    if (!stickyWithinTurn) return undefined
    if (this.lastTurn !== turn) return undefined
    return this.sticky
  }

  /**
   * 记录本轮的决策。
   * @param turn - 当前轮次序号。
   * @param decision - 决策。
   */
  remember(turn: number, decision: RoutingDecision): void {
    this.lastTurn = turn
    this.sticky = decision
  }

  /** 读取用户显式钉住的模型。 */
  get pin(): RoutingDecision | undefined {
    return this.pinned
  }

  /**
   * 钉住 / 解除钉住一个模型。
   * @param decision - 要钉住的决策；`undefined` 表示解除。
   */
  setPin(decision: RoutingDecision | undefined): void {
    this.pinned = decision
    // 钉住变更必须立即作用于下一步，因此清掉本轮粘滞。
    this.sticky = undefined
    this.lastTurn = -1
  }
}
