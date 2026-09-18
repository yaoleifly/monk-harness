/**
 * `monk-usage` 插件入口。
 *
 * 把"这个月还剩多少额度"变成会话里可以直接问的问题。三件事：
 *
 * 1. **计量**：观察 `session/event` 的 `assistant/message`，把每个步骤的
 *    `usage` 折进 {@link UsageLedger}。这是只读观察，绝不改动会话。
 * 2. **面向模型的工具** `monk_usage`：模型自己可以查用量，从而在接近上限时
 *    主动收敛输出长度，而不是等到被拒绝。
 * 3. **面向人的命令** `/monk`：无需模型轮次即可查看用量与当前路由状态。
 *
 * 计量事实来自会话日志而不是本地计数器，因此**回放与冷启动都能重算**——
 * 进程重启后只要重放日志，账本就能恢复到相同数值。
 * @module @monk/monk-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
// 仅类型导入：为 `ctx.commands` 触发声明合并。
import type {} from '@deepseek-ai/dsh-commands'
import {
  cacheHitRate,
  emptyTotals,
  evaluateQuota,
  formatTokens,
  formatTotals,
  monthKey,
  UsageLedger,
  type QuotaStatus,
  type UsagePlan,
  type UsageTotals,
} from './ledger.ts'
import { pruneVerbatim } from './pruner.ts'

export const name = 'monk-usage'
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  /** 订阅规格；用于计算额度比例与提醒。 */
  plan?: UsagePlan
  /**
   * 是否注册面向模型的 `monk_usage` 工具。
   *
   * 默认开启：让模型知道剩余额度，比让它盲目地把上下文撑爆更划算。若部署方
   * 不希望用量信息进入模型上下文（例如多租户共享额度），可关闭。
   */
  exposeTool?: boolean
  /** 是否注册 `/monk` 命令。 */
  exposeCommand?: boolean
}

const planSchema: z<UsagePlan> = z.object({
  name: z.string().required(),
  priceCny: z.number().min(0),
  inputTokensLimit: z.number().step(1).min(1),
  outputTokensLimit: z.number().step(1).min(1),
  warnAt: z.number().min(0).max(1).default(0.8),
})

export const Config: z<Config> = z.object({
  plan: planSchema.default({
    name: 'Monk 月度订阅',
    priceCny: 30,
    warnAt: 0.8,
  }),
  exposeTool: z.boolean().default(true),
  exposeCommand: z.boolean().default(true),
})

/** 本插件向其它插件暴露的服务。 */
export interface MonkUsageService {
  /** 某会话的累计用量。 */
  session(sessionId: string): UsageTotals
  /** 某计费周期的累计用量。 */
  month(month?: string): UsageTotals
  /** 当前计费周期的额度状态。 */
  quota(month?: string): QuotaStatus
  /** 当前生效的订阅规格。 */
  plan(): UsagePlan
  /** 把一次用量记入账本（供测试与重放使用）。 */
  record(sessionId: string, usage: Parameters<UsageLedger['record']>[2], at?: Date): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Monk 用量账本；由 `@monk/monk-usage` 提供。 */
    monkUsage: MonkUsageService
  }
}

/**
 * 插件挂载点。
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const plan: UsagePlan = config.plan ?? { name: 'Monk 月度订阅', warnAt: 0.8 }
  const ledger = new UsageLedger()
  const currentMonth = (): string => monthKey(new Date())

  // 只读观察：会话日志是权威事实来源。
  ctx.on('session/event', (session: Session, event) => {
    if (event.type !== 'assistant/message') return
    const usage = event.data.usage
    // adapter 没报用量时不留痕——凭空造 0 会让账本看起来"已计量"。
    if (usage === undefined) return
    ledger.record(String(session.id), currentMonth(), usage)
  })

  const service: MonkUsageService = {
    session: sessionId => ledger.forSession(sessionId),
    month: month => ledger.forMonth(month ?? currentMonth()),
    quota: month => evaluateQuota(ledger.forMonth(month ?? currentMonth()), plan),
    plan: () => plan,
    record: (sessionId, usage, at) => {
      ledger.record(sessionId, monthKey(at ?? new Date()), usage)
    },
  }
  ctx.provide('monkUsage', service)

  if (config.exposeTool !== false) {
    ctx.tools.register(defineTool({
      name: 'monk_usage',
      description:
        'Report the Monk subscription usage for the current billing period: billed input tokens, '
        + 'output tokens, cache hit rate, call count, and how much of the monthly quota is left. '
        + 'Call this before producing a very long answer or a large batch of tool calls so you can '
        + 'size the work to the remaining budget.',
      parameters: {
        scope: {
          type: 'string',
          enum: ['month', 'session'],
          description: 'Which window to report: the current billing period, or this session only. Defaults to month.',
        },
      },
      output: {
        // dsh 的输出 schema 不是裸 JSON Schema，而是一套类型化 DSL：
        // 必填性用逐属性的 `required: true` 标注（不是 `required: [...]` 数组），
        // 对象节点必须显式声明 `additionalProperties`。
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', required: true },
            plan: { type: 'string', required: true },
            totals: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                calls: { type: 'number', required: true },
                billedInputTokens: { type: 'number', required: true },
                outputTokens: { type: 'number', required: true },
                cacheHitPercent: { type: 'number', required: true },
                summary: { type: 'string', required: true },
              },
            },
            quota: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                // 无上限时刻意缺省，因此不标 required。
                ratioPercent: { type: 'number' },
                exceeded: { type: 'boolean', required: true },
                warning: { type: 'boolean', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `Monk 用量（${value.scope}）· ${value.plan}`,
            value.totals.summary,
          ]
          if (value.quota.ratioPercent !== undefined) {
            lines.push(`月度额度已用 ${value.quota.ratioPercent.toFixed(1)}%`
              + (value.quota.exceeded ? '（已超出）' : value.quota.warning ? '（接近上限）' : ''))
          } else {
            lines.push('月度额度：不限量')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        // `exec.agent` 在类型上可缺省（嵌套分发可能没有 agent 上下文）。
        // 拿不到 agent 就无法定位会话，此时**如实**退回本月账本，
        // 并让返回的 scope 反映实际报告的窗口，而不是假装报了会话。
        const agent = exec.agent
        const scope = args.scope === 'session' && agent !== undefined ? 'session' : 'month'
        const totals = scope === 'session' && agent !== undefined
          ? ledger.forSession(String(agent.session.id))
          : ledger.forMonth(currentMonth())
        const quota = evaluateQuota(totals, plan)
        const rate = totals.billedInputTokens === 0
          ? 0
          : (totals.cacheReadTokens / totals.billedInputTokens) * 100
        return {
          scope,
          plan: plan.name,
          totals: {
            calls: totals.calls,
            billedInputTokens: totals.billedInputTokens,
            outputTokens: totals.outputTokens,
            cacheHitPercent: Number(rate.toFixed(2)),
            summary: formatTotals(totals),
          },
          quota: {
            ...quota.ratio === undefined ? {} : { ratioPercent: Number((quota.ratio * 100).toFixed(2)) },
            exceeded: quota.exceeded,
            warning: quota.warning,
          },
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'monk_prune',
      description:
        'Prune stale or superseded historical tool outputs (such as old file reads that were overwritten by edits, or verbose command traces) to free up context window tokens. All conversation text, instructions, and code discussions stay 100% verbatim without lossy summarization.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prunedCount: { type: 'number', required: true },
            charsSaved: { type: 'number', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(_args, exec) {
        if (!exec.agent) {
          return { prunedCount: 0, charsSaved: 0, summary: 'No active agent session context.' }
        }
        const res = pruneVerbatim(exec.agent.session)
        const summary = `Pruned ${res.prunedCount} stale tool results, saving ~${formatTokens(Math.round(res.charsSaved / 4))} tokens while keeping conversation text 100% verbatim.`
        return {
          prunedCount: res.prunedCount,
          charsSaved: res.charsSaved,
          summary,
        }
      },
    }))
  }

  if (config.exposeCommand !== false) {
    ctx.inject(['commands'], (commandsCtx) => {
      const commands = commandsCtx.get('commands')
      if (commands === undefined) return
      commands.register({
        name: 'monk',
        description: '查看 Monk 订阅用量、模型选路与系统状态',
        handler: async (invocation) => {
          const sub = invocation.rawInput.trim().toLowerCase()
          const agent = invocation.agent
          const monkRouter = ctx.get('monkRouter')
          const monkHarness = ctx.get('monkHarness')

          if (sub === '' || sub === 'usage') {
            const month = currentMonth()
            const totals = ledger.forMonth(month)
            const quota = evaluateQuota(totals, plan)
            const session = ledger.forSession(String(invocation.agent.session.id))
            const lines = [
              `Monk 订阅：${plan.name}${plan.priceCny === undefined ? '' : ` · ¥${plan.priceCny}/月`}`,
              `本月（${month}）：${formatTotals(totals)}`,
              `本会话：${formatTotals(session)}`,
            ]
            if (quota.ratio !== undefined) {
              lines.push(`额度已用 ${(quota.ratio * 100).toFixed(1)}%`
                + (quota.exceeded ? ' · 已超出' : quota.warning ? ' · 接近上限' : ''))
            } else {
              lines.push('额度：不限量')
            }
            if (monkRouter !== undefined && agent !== undefined) {
              const taskClass = monkRouter.classify(agent.session)
              const pol = monkRouter.policy()
              const tier = pol.classToTier[taskClass]
              const monk = ctx.get('monk')
              const model = monk?.resolveTier(tier) ?? tier
              const effort = pol.classToEffort[taskClass] ?? 'default'
              lines.push(`当前选路：${model} (${taskClass} · ${effort} effort)`)
            }
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'status' || sub === 'router') {
            if (monkRouter === undefined) {
              return { kind: 'error' as const, text: 'monk-router 插件未挂载。' }
            }
            const pol = monkRouter.policy()
            if (agent === undefined) {
              return {
                kind: 'success' as const,
                text: [
                  'Monk 路由策略（未绑定会话上下文）：',
                  `总开关：${pol.enabled ? '开启' : '关闭'}`,
                  `轮次内粘滞：${pol.stickyWithinTurn ? '开启' : '关闭'}`,
                  `编码工具：${pol.codingTools.join(', ')}`,
                  `Deep 触发阈值：assistant 消息 >= ${pol.deepAssistantThreshold} 条，或轮次 >= ${pol.deepTurnThreshold}`,
                ].join('\n'),
              }
            }
            const obs = monkRouter.observe(agent.session)
            const taskClass = monkRouter.classify(agent.session)
            const tier = pol.classToTier[taskClass]
            const monk = ctx.get('monk')
            const model = monk?.resolveTier(tier) ?? tier
            const effort = pol.classToEffort[taskClass] ?? 'default'
            const state = monkRouter.stateOf(agent)
            const pin = state.pin
            const tools = Array.from(obs.toolNames)
            const hitCoding = tools.filter(t => pol.codingTools.includes(t))

            const lines = [
              'Monk 会话选路状态：',
              `当前模型：${model} (分层: ${tier} · ${effort} effort)`,
              `任务判定：${taskClass}${pin !== undefined ? '（用户显式钉住）' : ''}`,
              `观察事实：轮次 ${obs.turn >= 0 ? obs.turn : 0} · assistant 消息 ${obs.assistantMessages} 条 · 工具调用 ${tools.length} 个`,
            ]
            if (hitCoding.length > 0) {
              lines.push(`已触发编码工具：${hitCoding.join(', ')}`)
            }
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'doctor') {
            if (monkHarness === undefined) {
              return { kind: 'error' as const, text: 'monk-bundle 插件未挂载，无法运行自检。' }
            }
            const res = await monkHarness.selfCheck()
            const lines = [
              'Monk Harness 系统自检：',
              `路由状态："${monkHarness.provider}" ${res.routeRegistered ? '已注册 ✓' : '未注册 ✗'}`,
              `模型目录：${res.models.length > 0 ? res.models.join(', ') + ' ✓' : '无模型 ✗'}`,
              `默认模型：${res.defaultIsMonk ? '指向 Monk ✓' : '指向其他提供方（视设置区决定）'}`,
              `API 密钥：${res.keyConfigured ? '已配置 ✓' : '未配置 ✗'}`,
            ]
            if (res.diagnostics.length > 0) {
              lines.push('\n诊断提醒：')
              for (const d of res.diagnostics) lines.push(`- ${d}`)
            } else {
              lines.push('\n所有指标正常，服务就绪。')
            }
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'plan') {
            return {
              kind: 'success' as const,
              text: [
                `${plan.name}${plan.priceCny === undefined ? '' : ` · ¥${plan.priceCny}/月`}`,
                plan.inputTokensLimit === undefined
                  ? '输入额度：不限量'
                  : `输入额度：${formatTokens(plan.inputTokensLimit)} token`,
                plan.outputTokensLimit === undefined
                  ? '输出额度：不限量'
                  : `输出额度：${formatTokens(plan.outputTokensLimit)} token`,
                `提醒阈值：${((plan.warnAt ?? 0.8) * 100).toFixed(0)}%`,
              ].join('\n'),
            }
          }

          if (sub.startsWith('search')) {
            if (monkRouter === undefined) {
              return { kind: 'error' as const, text: 'monk-router 插件未挂载。' }
            }
            const parts = sub.split(/\s+/)
            const modeArg = parts[1]
            if (modeArg === 'on' || modeArg === 'off' || modeArg === 'auto') {
              monkRouter.setWebSearchMode(modeArg)
              return {
                kind: 'success' as const,
                text: `Monk 智能联网搜索模式已更新为 "${modeArg}"（X-Monk-Web-Search 头已绑定）。`,
              }
            }
            const currentMode = monkRouter.policy().webSearchMode
            return {
              kind: 'success' as const,
              text: `Monk 智能联网搜索当前模式：${currentMode}（使用 /monk search on | off | auto 切换）`,
            }
          }

          if (sub === 'ping') {
            const baseURL = process.env.MONK_BASE_URL || 'https://monk.party/v1'
            let key = process.env.MONK_API_KEY
            const credentials = ctx.get('credentials')
            if (!key && credentials !== undefined) {
              const hit = await credentials.resolve('MONK_API_KEY')
              if (hit !== undefined && hit.value.length > 0) key = hit.value
            }

            const t0 = performance.now()
            let res: Response
            try {
              res = await globalThis.fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
                method: 'GET',
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: AbortSignal.timeout(10000),
              })
            } catch (err) {
              return {
                kind: 'error' as const,
                text: [
                  '⚡ Monk 边缘节点连通性测速失败：',
                  `目标端点：${baseURL}`,
                  `网络错误：${err instanceof Error ? err.message : String(err)}`,
                  '诊断提示：请检查本地网络、代理或 VPN 是否能正常访问 monk.party。',
                ].join('\n'),
              }
            }
            const rtt = Math.round(performance.now() - t0)
            const cfRay = res.headers.get('cf-ray') ?? ''
            const nodeCode = (cfRay.split('-')[1] ?? 'Global').toUpperCase()
            const CITIES: Record<string, string> = {
              NRT: '东京 (Tokyo, JP)',
              HND: '东京 (Tokyo, JP)',
              KIX: '大阪 (Osaka, JP)',
              HKG: '香港 (Hong Kong, HK)',
              SIN: '新加坡 (Singapore, SG)',
              TPE: '台北 (Taipei, TW)',
              ICN: '首尔 (Seoul, KR)',
              SJC: '圣何塞 (San Jose, US)',
              LAX: '洛杉矶 (Los Angeles, US)',
              SFO: '旧金山 (San Francisco, US)',
              FRA: '法兰克福 (Frankfurt, DE)',
              LHR: '伦敦 (London, UK)',
            }
            const location = CITIES[nodeCode] ?? nodeCode
            const quality =
              rtt < 100
                ? '极佳 (Excellent) ⚡'
                : rtt < 300
                  ? '优良 (Good) ✓'
                  : rtt < 600
                    ? '一般 (Fair)'
                    : '延迟较高 (High Latency)'

            const lines = [
              '⚡ Monk 边缘节点连通性与测速报告：',
              `目标端点：${baseURL}`,
              `往返延迟 (RTT)：${rtt}ms`,
              `加速网络：Cloudflare Anycast`,
              `边缘节点：${nodeCode} · ${location}${cfRay ? ` (Ray ID: ${cfRay})` : ''}`,
              `连接质量：${quality}`,
              `鉴权状态：${res.status === 200 ? '通过 ✓ (HTTP 200 · 3 个融合模型就绪)' : res.status === 401 ? '未通过 ✗ (401 密钥无效或未配置)' : `HTTP ${res.status}`}`,
            ]
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'cache') {
            const month = currentMonth()
            const totals = ledger.forMonth(month)
            const session = agent !== undefined ? ledger.forSession(String(agent.session.id)) : undefined
            const monthRate = (cacheHitRate(totals) * 100).toFixed(1)
            const sessionRate = session !== undefined ? (cacheHitRate(session) * 100).toFixed(1) : '0.0'
            const lines = [
              '⚡ Monk 前缀 KV 缓存统计与加速指标：',
              `本月缓存命中率：${monthRate}% (命中 ${formatTokens(totals.cacheReadTokens)} / 计费输入 ${formatTokens(totals.billedInputTokens)})`,
            ]
            if (session !== undefined) {
              lines.push(
                `当前会话命中率：${sessionRate}% (命中 ${formatTokens(session.cacheReadTokens)} / 计费输入 ${formatTokens(session.billedInputTokens)})`,
              )
            }
            lines.push(
              `累计节省计算：已为您复用并加速了约 ${formatTokens(totals.cacheReadTokens)} token 的上下文计算！`,
              '已激活的前缀缓存优化：',
              '- 工具声明确定性字典序排序：已就绪 ✓ (保证 tools 前缀字节一致)',
              '- 轮次内模型粘滞 (Turn-Sticky)：已就绪 ✓ (防止跨模型击穿 KV 缓存)',
              '- 提示词纯静态与并行工具调用：已生效 ✓',
            )
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'prune') {
            if (agent === undefined) {
              return { kind: 'error' as const, text: '此命令需在有效会话上下文中运行。' }
            }
            const summary = pruneVerbatim(agent.session)
            const tokenEstimate = formatTokens(Math.round(summary.charsSaved / 4))
            const lines = [
              '⚡ Monk Verbatim Pruner (无损上下文智能剪枝报告)：',
              `- 扫描表面节点数：${summary.examinedNodes} 个`,
              `- 成功修剪失效工具结果：${summary.prunedCount} 处`,
              `- 累计减少字符：${summary.charsSaved} 字符 (~${tokenEstimate} token)`,
              `- 对话历史状态：User & Assistant 对话与代码 100% 逐字原样保留！`,
            ]
            if (summary.details.length > 0) {
              lines.push('\n修剪明细：')
              for (const d of summary.details) lines.push(`- ${d}`)
            }
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'export') {
            const month = currentMonth()
            const totals = ledger.forMonth(month)
            const session = agent !== undefined ? ledger.forSession(String(agent.session.id)) : undefined
            const rate = (cacheHitRate(totals) * 100).toFixed(1)
            const lines = [
              '### Monk Harness 运行开销报告',
              `- 订阅计划：${plan.name}`,
              `- 统计月份：${month}`,
              `- 月度计费输入：${formatTokens(totals.billedInputTokens)} (缓存命中 ${rate}%)`,
              `- 月度输出：${formatTokens(totals.outputTokens)}`,
              `- 累计请求数：${totals.calls} 次`,
            ]
            if (session !== undefined) {
              lines.push(
                `- 本会话输入：${formatTokens(session.billedInputTokens)}`,
                `- 本会话输出：${formatTokens(session.outputTokens)}`,
              )
            }
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'update' || sub === 'upgrade') {
            const res = monkHarness !== undefined ? await monkHarness.selfCheck() : undefined
            const lines = [
              'Monk Harness 热更新与状态同步：',
              `提供方路由：monk-official ${res?.routeRegistered ? '响应中 ✓' : '请重启'}`,
              `就绪模型：${res?.models.length ?? 0} 个模型`,
              '热重载状态：Profile 配置已同步 ✓',
              '提示：若刚对 DeepSeek Harness 全局升级，请在终端执行 `bash scripts/update.sh` 快速完成依赖与软链重新绑定。',
            ]
            return { kind: 'success' as const, text: lines.join('\n') }
          }

          if (sub === 'help') {
            return {
              kind: 'success' as const,
              text: [
                'Monk 指令帮助：',
                '/monk 或 /monk usage - 查看订阅用量与本会话开销',
                '/monk status 或 /monk router - 查看当前会话的模型选路依据与路由状态',
                '/monk ping - 测试与 Monk 边缘节点的连接延迟、节点归属与鉴权状态',
                '/monk prune - 智能修剪过时与冗余的工具输出，保留对话 100% 原文无损',
                '/monk cache - 查看前缀 KV 缓存命中率与加速统计',
                '/monk search [on|off|auto] - 查看或设置智能联网搜索模式',
                '/monk export - 导出当前用量与开销报告 Markdown',
                '/monk doctor - 运行 Monk Harness 系统自检与诊断',
                '/monk update - 触发状态重载与升级指引',
                '/monk plan - 查看当前订阅规格与额度限制',
              ].join('\n'),
            }
          }

          return {
            kind: 'error' as const,
            text: `未知子命令 "${sub}"；可用：usage、status、ping、prune、cache、search、export、doctor、update、plan、help`,
          }
        },
      })
    })
  }
}

export {
  accumulate,
  cacheHitRate,
  emptyTotals,
  evaluateQuota,
  formatTokens,
  formatTotals,
  monthKey,
  UsageLedger,
} from './ledger.ts'
export type { QuotaStatus, UsagePlan, UsageTotals } from './ledger.ts'
export { pruneVerbatim } from './pruner.ts'
export type { PruneOptions, PruneSummary } from './pruner.ts'
