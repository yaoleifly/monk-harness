/**
 * Monk 模型目录：monk.party 对外提供的三条融合模型路由。
 *
 * 目录是**建议性**的（advisory）：adapter 接受目录之外的 model id，消费方
 * 不得把"不在目录里"当成请求拒绝的理由。这一约定与 dsh 的
 * `LlmModelInfo` 语义一致。
 *
 * `tier` 是本适配器独有的分类标签，供 `monk-router` 按任务类型选路使用，
 * 不进入 wire 请求，也不进入模型可见文本。
 * @module @monk/monk-llm/catalog
 */

/** Monk 融合模型的定位分层。 */
export type MonkTier =
  /** 质量优先：复杂推理、长上下文、跨文件重构。 */
  | 'quality'
  /** 极速日常：对话、问答、轻量改写。 */
  | 'fast'
  /** 编码 Agent：工具调用密集、需要稳定结构化输出。 */
  | 'coding'

/** 请求可接受的输入模态。 */
export type MonkModality = 'text' | 'image'

/** 一条 Monk 模型目录项。 */
export interface MonkCatalogModel {
  /** 传给 `GenerateOptions.model` 的提供方模型 ID。 */
  id: string
  /** 选择器与诊断中展示的名称。 */
  name: string
  /** 面向用户的一句话定位说明。 */
  description?: string
  /** 该模型的定位分层，驱动 monk-router 的默认选路。 */
  tier: MonkTier
  /** 最大合并上下文（请求 + 响应）token 数。 */
  contextWindow?: number
  /** 单次响应最大输出 token 数。 */
  maxTokens?: number
  /** 接受的输入模态；缺省视为 text。 */
  inputModalities?: MonkModality[]
}

/** monk.party 公开的三个模型 id。 */
export const MONK_MODEL_IDS = ['monk', 'monk-fast', 'monk-coding'] as const

/** Monk 模型 id 的字面量联合。 */
export type MonkModelId = (typeof MONK_MODEL_IDS)[number]

/**
 * 目录默认值。
 *
 * 上下文窗口与输出上限取自 monk.party 的公开规格：100 万 token 输入、
 * 6.4 万 token 输出。数值仅作为**未显式配置时的缺省**，可用
 * `Config.models` 整体覆盖。
 */
export const MONK_CONTEXT_WINDOW = 1_000_000
export const MONK_MAX_OUTPUT_TOKENS = 64_000

/** 出厂目录。 */
export const DEFAULT_MONK_MODELS: readonly MonkCatalogModel[] = [
  {
    id: 'monk',
    name: 'Monk',
    description: '质量优先的主力模型：复杂推理、长上下文与深度代码理解。',
    tier: 'quality',
    contextWindow: MONK_CONTEXT_WINDOW,
    maxTokens: MONK_MAX_OUTPUT_TOKENS,
  },
  {
    id: 'monk-fast',
    name: 'Monk Fast',
    description: '日常对话与高吞吐工作流，数倍于旗舰模型的响应速度。',
    tier: 'fast',
    contextWindow: MONK_CONTEXT_WINDOW,
    maxTokens: MONK_MAX_OUTPUT_TOKENS,
  },
  {
    id: 'monk-coding',
    name: 'Monk Coding',
    description: '编码 Agent 专用：工具调用密集、结构化输出稳定。',
    tier: 'coding',
    contextWindow: MONK_CONTEXT_WINDOW,
    maxTokens: MONK_MAX_OUTPUT_TOKENS,
    inputModalities: ['text', 'image'],
  },
]

/**
 * 校验并脱离一份目录快照。
 *
 * 编程式构造可以绕过 Schemastery 归一化，因此每个默认值与边界都在这里
 * 重新判定一次：组合入口在加载时失败要"响亮"，而不是留下半个目录。
 * @param models - 原始目录，缺省使用 {@link DEFAULT_MONK_MODELS}。
 * @returns 一份脱离且已校验的目录副本。
 * @throws 当 id 为空、重复，或数值字段非法时。
 */
export function resolveCatalog(models?: readonly MonkCatalogModel[]): MonkCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MONK_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('monk-llm: catalog model ids must be non-empty')
    if (model.name.length === 0) throw new Error(`monk-llm: catalog model "${model.id}" has an empty name`)
    if (model.contextWindow !== undefined
      && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`monk-llm: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`monk-llm: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    const modalities = model.inputModalities ?? ['text']
    if (modalities.length === 0) {
      throw new Error(`monk-llm: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (modalities.some(modality => modality !== 'text' && modality !== 'image')) {
      throw new Error(`monk-llm: catalog model "${model.id}" inputModalities must contain only "text" and "image"`)
    }
    if (new Set(modalities).size !== modalities.length) {
      throw new Error(`monk-llm: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    if (seen.has(model.id)) throw new Error(`monk-llm: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      tier: model.tier,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...modalities],
    }
  })
}

/**
 * 按 id 查一条目录项。
 * @param catalog - 已校验的目录。
 * @param id - 精确模型 id。
 * @returns 命中的目录项，未命中返回 `undefined`。
 */
export function findCatalogModel(
  catalog: readonly MonkCatalogModel[],
  id: string,
): MonkCatalogModel | undefined {
  return catalog.find(model => model.id === id)
}

/**
 * 按分层查第一条目录项。
 * @param catalog - 已校验的目录。
 * @param tier - 目标分层。
 * @returns 命中的目录项，未命中返回 `undefined`。
 */
export function findCatalogTier(
  catalog: readonly MonkCatalogModel[],
  tier: MonkTier,
): MonkCatalogModel | undefined {
  return catalog.find(model => model.tier === tier)
}
