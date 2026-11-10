/**
 * 自检 / 定时任务：授权上限与执行器（72-schedule 的零件）
 *
 * 为什么单独一个文件：这十段里真正需要**反复审**的就是这两块 ——
 *   · 授权上限（`configFor` 给 loop 的到底是哪几个开关）
 *   · 执行器（没人在场时 confirm 拿到的是什么）
 * 它们跟「时间算得对不对」是两码事，混在一起会让每次改动都要重读一遍时间逻辑，
 * 而且十段全放一个文件是 409 行，顶破 `AGENT.md` 硬约束 #2。
 *
 * 断言文案与组标题原样保留（免得既有的失败清单对不上号）。
 */

import { check, group } from '../harness.mjs'

/**
 * 假台账：只记调用，不落盘 —— 测执行器时用它，一条都不许碰到真实的
 * data/schedules.json（定时任务的自检污染了用户台账，比测试红还糟）。
 */
function fakeStore(seed = []) {
  const items = new Map(seed.map((item) => [item.id, { ...item }]))
  const calls = []
  return {
    calls,
    list: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
    recordRun: (id, patch) => {
      calls.push({ id, patch })
      const current = items.get(id)
      if (current) items.set(id, { ...current, ...patch })
      return { ok: true, item: items.get(id) }
    },
  }
}

/** 假的分类结果：只喂给 `risk.decide` 反查策略，不走真正的模式匹配 */
const CONFIG_HIGH = { level: 'high', reasons: [], opaque: [] }
const CONFIG_CRITICAL = { level: 'critical', reasons: [], opaque: [] }

/** 4~5 段：三档授权上限 + configFor 不许污染用户配置 */
export function runGrantChecks({ grant, riskCore, BASE_CONFIG }) {
  group('定时任务 / 授权上限')
  check('三档名单就这三个', grant.GRANTS.join(',') === 'readonly,workspace,full')
  for (const tier of grant.GRANTS) {
    const policy = grant.configFor(tier, BASE_CONFIG).tools.shellPolicy
    check(`★ ${tier}：high 必须是 block`, policy.high === 'block', String(policy.high))
    check(`★ ${tier}：critical 必须是 block`, policy.critical === 'block', String(policy.critical))
    check(
      `★ ${tier}：high / critical 在 decide() 里也不会变成 allow`,
      riskCore.decide(CONFIG_HIGH, policy).action !== 'allow' &&
        riskCore.decide(CONFIG_CRITICAL, policy).action !== 'allow',
    )
    check(
      `${tier}：界面上那句说明写了会拒什么（不许写得好听）`,
      Boolean(grant.GRANT_INFO[tier]?.label) && /拒/.test(grant.GRANT_INFO[tier]?.detail ?? ''),
    )
  }
  check('只有只读档拦中等风险', grant.configFor('readonly', BASE_CONFIG).tools.shellPolicy.medium === 'block')
  check('只读档不给写权限（permission 就是 readonly）', grant.configFor('readonly', BASE_CONFIG).tools.permission === 'readonly')
  check(
    '★ 工作目录之外：只有 full 档放开（workspace 靠 fileScope 挡住）',
    grant.configFor('workspace', BASE_CONFIG).tools.fileScope === 'workspace' &&
      grant.configFor('full', BASE_CONFIG).tools.fileScope === 'full',
  )
  check('被拒时给的是人话，带上命令', (() => {
    const sentence = grant.explainBlock('readonly', { tool: 'run_shell', command: 'rm -rf build' })
    return /只读/.test(sentence) && sentence.includes('rm -rf build')
  })())
  check('高危命令的被拒说明带上风险理由', (() => {
    const sentence = grant.explainBlock('workspace', { tool: 'run_shell', command: 'reg add HKLM\\Software\\x /v y /d z' })
    return /不批/.test(sentence) && /风险/.test(sentence)
  })())
  /* ★ 2026-10-03 补：`rm -rf /` 已经是 critical，说明里应该是「危险」——
     同一句话要分得出「问一下」和「直接拒」两档，不然用户看不出区别。 */
  check('★ 危急命令的被拒说明也带上理由（而且说得出是「危险」）', (() => {
    const sentence = grant.explainBlock('workspace', { tool: 'run_shell', command: 'rm -rf /' })
    return /不批/.test(sentence) && /危险/.test(sentence)
  })())

  group('定时任务 / configFor 不许污染用户配置')
  const base = {
    assistant: { model: 'deepseek-chat' },
    tools: {
      permission: 'full',
      fileScope: 'full',
      shellPolicy: { medium: 'allow', high: 'allow', critical: 'allow' },
      shellTimeout: 60,
    },
  }
  const snapshot = JSON.stringify(base)
  const out = grant.configFor('workspace', base)
  out.tools.permission = 'readonly'
  out.tools.fileScope = 'workspace'
  out.tools.shellPolicy.high = 'allow'
  out.tools.shellPolicy.medium = 'block'
  check('★ 改返回值之后 base 一模一样（深浅都验）', JSON.stringify(base) === snapshot, JSON.stringify(base))
  check(
    '★ 不会从 base 继承策略：base 说 high: allow，只读档仍然是 block',
    grant.configFor('readonly', base).tools.shellPolicy.high === 'block',
  )
  check('shellPolicy 是新对象，不和 base 共享', grant.configFor('full', base).tools.shellPolicy !== base.tools.shellPolicy)
  check('tools 里别的字段照旧带过去（不做多余裁剪）', grant.configFor('readonly', base).tools.shellTimeout === 60)
  check('认不出来的档按最严的算', grant.configFor('随便写的', base).tools.permission === 'readonly')
}

/** 7~9 段：执行器（confirm 恒 false）、并发保护、心跳只跑到期的 */
export async function runRunnerChecks({ runner, configStub }) {
  group('定时任务 / 执行器（没人批准这条钉子）')
  const task = {
    id: 'sch_run_1',
    name: '看看项目',
    prompt: '看看项目',
    when: { type: 'interval', minutes: 30 },
    grant: 'workspace',
    workdir: '',
    enabled: true,
    runCount: 0,
    blockedCount: 0,
    sessionId: 'sess_schedule',
  }
  let captured = null
  let confirmAnswer = null
  const confirmLoop = {
    run: async (options) => {
      captured = options
      confirmAnswer = await options.confirm({ kind: 'write', name: 'write_file', summary: '写文件' })
      return {
        content: '总结：有两处改动',
        taskId: 'task_stub_9',
        toolRuns: [{ name: 'run_shell', ok: false, output: '用户拒绝了这个操作：rm -rf build' }],
      }
    },
  }
  const ledger = fakeStore([{ ...task }])
  const result = await runner.run(task, { loop: confirmLoop, config: configStub, store: ledger, emit: () => {} })

  check('★ 执行器问「能不能做」时拿到的是 false（没人在场 = 没人批准）', confirmAnswer === false)
  check('★ confirm 是个函数（缺了它写工具会**直接执行** —— fail-open）', typeof captured.confirm === 'function')
  check('★ 给 loop 的配置：high / critical 都是 block', captured.config.tools.shellPolicy.high === 'block' && captured.config.tools.shellPolicy.critical === 'block')
  check('配置是按 grant 算的（workspace 档 medium 放行）', captured.config.tools.shellPolicy.medium === 'allow')
  check('会话用台账里那个', captured.sessionId === 'sess_schedule')
  check('history 就是提示词那一条，goal 是任务名', captured.history.length === 1 && captured.history[0].content === '看看项目' && captured.goal === '看看项目')
  check('跑完写回台账', result.ok === true && ledger.calls[0]?.patch.runCount === 1 && ledger.calls[0]?.patch.lastTaskId === 'task_stub_9')
  check('★ 被拒的操作记进 blockedCount', result.blocked === true && ledger.calls[0]?.patch.blockedCount === 1)

  const ledger2 = fakeStore()
  let sessionAsked = 0
  const second = await runner.run(
    { ...task, id: 'sch_run_2', sessionId: '' },
    {
      loop: { run: async () => ({ content: '好', toolRuns: [] }) },
      config: configStub,
      store: ledger2,
      emit: () => {},
      ensureSession: async (item) => {
        sessionAsked += 1
        return `sess_${item.id}`
      },
    },
  )
  check('没有会话时建一个并写回台账', second.ok === true && sessionAsked === 1 && ledger2.calls[0]?.patch.sessionId === 'sess_sch_run_2')

  group('定时任务 / 并发保护')
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const slowLoop = {
    run: async () => {
      await gate
      return { content: '慢跑完了', toolRuns: [] }
    },
  }
  const busy = fakeStore([{ ...task, id: 'sch_busy' }])
  const first = runner.run({ ...task, id: 'sch_busy' }, { loop: slowLoop, config: configStub, store: busy, emit: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const again = await runner.run({ ...task, id: 'sch_busy' }, { loop: slowLoop, config: configStub, store: busy, emit: () => {} })
  check('★ 上一次还没跑完时再触发 → 直接失败', again.ok === false && /上一次/.test(again.error ?? ''))
  release()
  check('第一次仍然跑得完', (await first).ok === true)

  group('定时任务 / 心跳只跑到期的')
  const NOW = Date.now()
  const baseItem = {
    name: '看看',
    prompt: '看看',
    grant: 'readonly',
    workdir: '',
    enabled: true,
    lastRunAt: 0,
    runCount: 0,
    blockedCount: 0,
  }
  let active = 0
  let maxActive = 0
  const seenNames = []
  const serialLoop = {
    run: async (options) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      seenNames.push(options.goal)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { content: '好', toolRuns: [] }
    },
  }
  const tickStore = fakeStore([
    { ...baseItem, id: 'sch_due_a', name: '到期A', when: { type: 'interval', minutes: 5 }, createdAt: NOW - 3_600_000 },
    { ...baseItem, id: 'sch_due_b', name: '到期B', when: { type: 'interval', minutes: 5 }, createdAt: NOW - 3_600_000 },
    { ...baseItem, id: 'sch_off', name: '关掉的', when: { type: 'interval', minutes: 5 }, createdAt: NOW - 3_600_000, enabled: false },
    { ...baseItem, id: 'sch_just_ran', name: '刚跑过', when: { type: 'interval', minutes: 5 }, createdAt: NOW - 3_600_000, lastRunAt: NOW - 5_000 },
    { ...baseItem, id: 'sch_later', name: '还没到点', when: { type: 'interval', minutes: 30 }, createdAt: NOW - 1_000 },
  ])
  const tickResult = await runner.tick({ loop: serialLoop, config: configStub, store: tickStore, emit: () => {} }, NOW)

  check('★ 只跑到期的两条', tickResult.ran.join(',') === 'sch_due_a,sch_due_b', JSON.stringify(tickResult))
  check('★ 关掉的不跑、刚跑过的不跑、还没到点的不跑', seenNames.length === 2 && seenNames.join(',') === '到期A,到期B')
  check('★ 串行跑（同时只跑一个，不然会一瞬间打爆模型配额）', maxActive === 1)
  check('没到期的不算进 skipped（它只是还没到点）', tickResult.skipped.length === 0)
  check('跑到期的会刷新 lastRunAt（下个 tick 不会重复跑）', Number(tickStore.get('sch_due_a').lastRunAt) > 0)

  /*
   * ★★★ 已删除的任务不许跑（原清单第 8 项，2026-11-10 修）
   *
   * 原验收场景：第一条正在跑时把第二条删掉，第二条醒来后**照样执行了一轮**。
   * 根因是 `ledger.get(listed.id) ?? listed` —— `get()` 找不到返回 null，
   * `??` 让列表里那份旧快照顶上，而它的 enabled 仍是 true，于是孤儿任务照跑。
   * 这里构造「list 里有、get 返回 null」，钉住修好之后的行为。
   */
  group('定时任务 / 已删除的任务不许跑')
  const ghostRun = []
  const ghostStore = {
    list: () => [{ ...baseItem, id: 'sch_ghost', name: '已被删掉', when: { type: 'interval', minutes: 5 }, createdAt: NOW - 3_600_000 }],
    /* 列表里还有它，台账里已经没有 —— 这正是删除那一刻的窗口期 */
    get: () => null,
    recordRun: () => ({ ok: true }),
  }
  const ghost = await runner.tick(
    { loop: { run: async (o) => { ghostRun.push(o.goal); return { content: '不该发生', toolRuns: [] } } }, config: configStub, store: ghostStore, emit: () => {} },
    NOW,
  )
  check('★★★ 台账里找不到 → 就不跑（不许拿列表里那份旧快照顶上）', ghostRun.length === 0, ghostRun.join(','))
  check('★★ 它记进 skipped（如实说没跑成，而不是悄悄消失）', ghost.skipped.includes('sch_ghost'), JSON.stringify(ghost))

  /*
   * 第 26 项（2026-11-10）：定时任务的结果**按真实原因分类**。
   *
   * 病：`lastResult` 原来一律写「跑完了」。而定时任务没人在场，台账是用户唯一的
   * 线索 —— 撞预算停下、轮数用尽、被暂停，全显示成绿色「跑完了」，那一轮
   * 其实一件交付都没有。判据只看 `loop.run` 的返回值（真实执行记录），不看模型自述。
   */
  group('定时任务 / 结果按真实原因分类（第 26 项）')
  const briefOf = (result) => runner.run({ ...baseItem, id: 'sch_brief' }, {
    loop: { run: async () => result },
    config: configStub,
    store: fakeStore([{ ...baseItem, id: 'sch_brief' }]),
    emit: () => {},
  })
  const outcomeOf = async (result) => (await briefOf(result)).outcome ?? ''
  check('★ 顺利跑完 → 就说跑完了', (await outcomeOf({ content: '干好了', toolRuns: [] })) === '跑完了')
  check(
    '★★★ 撞预算 → 如实说达到上限（不许写「跑完了」）',
    /预算上限/.test(await outcomeOf({ content: '', budgetHit: { reason: 'maxTokens', label: 'Token' } })),
  )
  check('★★★ 被暂停 → 如实说已暂停', /已暂停/.test(await outcomeOf({ content: '', paused: true })))
  check('★★ 轮数用尽 → 如实说达到上限', /上限/.test(await outcomeOf({ content: '', exhausted: true })))
  check('★★ 有操作被拒 → 保留那句说明', /被拒/.test(await outcomeOf({ content: '', toolRuns: [{ ok: false, output: '用户拒绝了这个操作' }] })))
  check(
    '★★ 分类来自返回值，不看模型自述（暂停那轮 content 是提示语也不冒充交付）',
    /已暂停/.test(await outcomeOf({ content: '（任务已暂停，可以从这里继续）', paused: true })),
  )
}

/** 第 10 段：内核规矩（读源码文本，防「悄悄 require 主进程模块」回归） */
export function runKernelChecks({ readFileSync, join, ROOT }) {
  group('定时任务 / 内核规矩')
  const sources = ['schedule-next.cjs', 'schedule-store.cjs', 'schedule-grant.cjs', 'schedule-run.cjs']
    .map((name) => readFileSync(join(ROOT, 'electron/core', name), 'utf8'))
    .join('\n')
  check("★ 不 require electron（自检 / 单测能跑起来的前提）", sources.includes("require('electron')") === false)
  check('★ 不直接发网络请求（模型调用只走注入的 loop）', sources.includes('fetch(') === false && sources.includes('node:http') === false)
}
