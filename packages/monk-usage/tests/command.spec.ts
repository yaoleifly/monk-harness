import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

test('/monk 命令注册与基础响应', async () => {
  const ctx = new Context()
  let registeredCommand: { name: string; handler: (invocation: any) => Promise<any> } | undefined

  ctx.provide('tools', { register: () => {} } as never)
  ctx.provide('commands', {
    register: (cmd: any) => {
      registeredCommand = cmd
    },
  } as never)

  apply(ctx, { exposeCommand: true })
  await Promise.resolve()
  assert.ok(registeredCommand)
  assert.equal(registeredCommand.name, 'monk')

  // 测试 /monk 或 /monk usage
  const invocation = {
    rawInput: '',
    agent: { session: { id: 's1' } },
  }
  const resDefault = await registeredCommand.handler(invocation)
  assert.equal(resDefault.kind, 'success')
  assert.ok(resDefault.text.includes('Monk 订阅'))

  // 测试 /monk plan
  const resPlan = await registeredCommand.handler({ rawInput: 'plan', agent: invocation.agent })
  assert.equal(resPlan.kind, 'success')
  assert.ok(resPlan.text.includes('Monk 月度订阅'))

  // 测试 /monk doctor (未挂载 monk-bundle 时)
  const resDoctorFail = await registeredCommand.handler({ rawInput: 'doctor', agent: invocation.agent })
  assert.equal(resDoctorFail.kind, 'error')
  assert.ok(resDoctorFail.text.includes('monk-bundle 插件未挂载'))

  // 测试 /monk doctor (已挂载 monk-bundle 时)
  ctx.provide('monkHarness', {
    provider: 'monk-official',
    selfCheck: async () => ({
      routeRegistered: true,
      defaultIsMonk: true,
      keyConfigured: true,
      models: ['monk', 'monk-fast', 'monk-coding'],
      diagnostics: [],
    }),
  } as never)
  const resDoctorOk = await registeredCommand.handler({ rawInput: 'doctor', agent: invocation.agent })
  assert.equal(resDoctorOk.kind, 'success')
  assert.ok(resDoctorOk.text.includes('Monk Harness 系统自检'))
  assert.ok(resDoctorOk.text.includes('所有指标正常'))

  // 测试 /monk update
  const resUpdate = await registeredCommand.handler({ rawInput: 'update', agent: invocation.agent })
  assert.equal(resUpdate.kind, 'success')
  assert.ok(resUpdate.text.includes('Monk Harness 热更新'))

  // 测试 /monk search
  let mode = 'auto'
  ctx.provide('monkRouter', {
    observe: () => ({ turn: 1, toolNames: new Set(), assistantMessages: 1 }),
    classify: () => 'chat',
    stateOf: () => ({ pin: undefined }),
    policy: () => ({ webSearchMode: mode }),
    setWebSearchMode: (m: string) => { mode = m },
  } as never)

  const resSearchCheck = await registeredCommand.handler({ rawInput: 'search', agent: invocation.agent })
  assert.equal(resSearchCheck.kind, 'success')
  assert.ok(resSearchCheck.text.includes('auto'))

  const resSearchSet = await registeredCommand.handler({ rawInput: 'search on', agent: invocation.agent })
  assert.equal(resSearchSet.kind, 'success')
  assert.equal(mode, 'on')

  // 测试 /monk export
  const resExport = await registeredCommand.handler({ rawInput: 'export', agent: invocation.agent })
  assert.equal(resExport.kind, 'success')
  assert.ok(resExport.text.includes('Monk Harness 运行开销报告'))

  // 测试 /monk help
  const resHelp = await registeredCommand.handler({ rawInput: 'help', agent: invocation.agent })
  assert.equal(resHelp.kind, 'success')
  assert.ok(resHelp.text.includes('/monk search'))
})
