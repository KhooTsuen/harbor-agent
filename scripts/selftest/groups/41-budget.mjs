import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'
/* 默认值 / 迁移 / 三层来源那几条在零件文件里（合并会让本文件顶破 300 行红线） */
import { runDefaultChecks } from './41-budget-parts.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-040：Execution Budget

   **五项默认全部不限（0）**（2026-09-29 用户要求：「关于这一类的全部都要默认不设限」），
   只有 maxRetries 保持 3（它不是「上限」而是「自动救一把几次」）。用户自己填了上限、
   真撞上去之后给 **[继续] [停止] [调整预算]**。软阈值 softRatio 0.8：用到 80% 先提醒一次。

   四条设计决定，都在这一组里钉住：

     · **默认不拦** —— 刹车不该在用户没要求时踩下去；旧盘上的 50/100/1800/100000
       必须迁移成 0（`legacyUnlimited`），不迁移这版对老用户等于没生效
     · **撞预算不是失败** —— 任务标 `paused` 可恢复，并记下撞了哪一项、用了多少、
       上限多少（界面要原样显示「50 / 50」）
     · 检查点在**轮次边界**（工具全跑完之后）—— 半路停会把文件留在改了一半的状态
     · 四项来源：内置默认 ← 设置 ← **任务自己的覆盖**（「这次活多给它两轮」）
   ══════════════════════════════════════════════════════════════ */

const budget = require(join(ROOT, 'electron/core/budget.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))
const taskNotify = require(join(ROOT, 'electron/core/task-notify.cjs'))
const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))

export async function run() {
  const created = []

  /* ── ① 默认值 / 迁移 / 三层来源 ─────────────────────── */
  /* 零件文件（加完「默认全不限 + 旧值迁移」这几条就顶破 300 行了） */
  runDefaultChecks()

  /* ── ② 查账 ─────────────────────────────────────────── */
  group('AG-040 / 查账')
  /* ★ 显式给上限：默认那份是不限，拿它当检查对象的话下面每条都在验「什么都不拦」 */
  const plan = {
    ...budget.DEFAULTS,
    maxSteps: 50,
    maxToolCalls: 100,
    maxRuntime: 1800,
    maxTokens: 100_000,
  }
  check(
    '★ 默认那份（全 0）真的什么都不拦：轮数/工具/时长/token 拉满也不停',
    budget.check({
      budget: budget.DEFAULTS,
      startedAt: Date.now() - 9_999_000,
      steps: 9999,
      toolCalls: 9999,
      tokens: 9_999_999,
    }).exceeded === false,
  )
  const ok = budget.check({
    budget: plan,
    startedAt: Date.now(),
    steps: 3,
    toolCalls: 5,
    tokens: 100,
  })
  check('没到上限就不拦', ok.exceeded === false && ok.reason === '')

  const hitSteps = budget.check({
    budget: plan,
    startedAt: Date.now(),
    steps: 50,
    toolCalls: 5,
    tokens: 1,
  })
  check(
    '★ 轮数到顶 → 拦，并说明是哪一项',
    hitSteps.exceeded && hitSteps.reason === 'maxSteps',
    hitSteps.reason,
  )
  check('带上用了多少 / 上限多少（界面要显示）', hitSteps.used === 50 && hitSteps.limit === 50)
  check(
    '消息说人话（不是故障）',
    hitSteps.message.includes('不是故障'),
    hitSteps.message.slice(0, 30),
  )

  check(
    '工具调用到顶',
    budget.check({ budget: plan, startedAt: Date.now(), steps: 1, toolCalls: 100 }).reason ===
      'maxToolCalls',
  )
  check(
    '★ 运行时长到顶（轮数与工具次数管不住「一条命令卡在那儿」）',
    budget.check({ budget: plan, startedAt: Date.now() - 1800_000, steps: 1, toolCalls: 1 })
      .reason === 'maxRuntime',
  )
  check(
    '本任务 token 到顶',
    budget.check({ budget: plan, startedAt: Date.now(), steps: 1, toolCalls: 1, tokens: 100_000 })
      .reason === 'maxTokens',
  )
  check(
    '时长的措辞按分钟（1800 秒 → 30 分钟）',
    budget
      .check({ budget: plan, startedAt: Date.now() - 1800_000, steps: 0, toolCalls: 0 })
      .message.includes('30 分钟'),
  )
  check(
    '0 = 不限的那一项不拦',
    budget.check({ budget: { ...plan, maxSteps: 0 }, steps: 99999, toolCalls: 0 }).exceeded ===
      false,
  )

  /* ── ③ 停下来等人的样子 ─────────────────────────────── */
  group('AG-040 / 撞了预算怎么记')
  const patch = budget.pausePatch(hitSteps)
  check('标成 paused（**不是 failed**）', patch.status === 'paused')
  check('记下原因', patch.pauseReason === 'budget' && patch.pauseDetail === 'maxSteps')
  check(
    '★ 记下数字（界面显示 50 / 50）',
    patch.budgetHit.used === 50 &&
      patch.budgetHit.limit === 50 &&
      patch.budgetHit.label === '轮数上限',
  )

  const task = taskCore.create({ goal: 'AG-040 预算测试', sessionId: 'selftest-ag040' })
  created.push(task.id)
  check('新任务默认没有预算覆盖', Object.keys(taskCore.get(task.id).budget ?? {}).length === 0)
  check('新任务没有「撞预算」标记', taskCore.get(task.id).pauseReason === '')

  taskCore.update(task.id, patch)
  const paused = taskCore.get(task.id)
  check('台账里记得住', paused.pauseReason === 'budget' && paused.budgetHit?.reason === 'maxSteps')
  taskCore.update(task.id, { budget: { maxSteps: 200 } })
  check('任务的预算覆盖存得下', taskCore.get(task.id).budget.maxSteps === 200)

  /* 继续做要把标记清掉，否则界面一直挂着那三个按钮 */
  const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
  taskResume.reopen(task.id)
  check('★ 「继续」之后标记清掉（按钮不再挂着）', taskCore.get(task.id).pauseReason === '')
  check('而预算是留着的（下次还按它跑）', taskCore.get(task.id).budget.maxSteps === 200)

  /* ── ⑤ 接线：循环里真的查账 ─────────────────────────── */
  group('AG-040 / 接线（循环里真的查账）')
  const loopSrc = readFileSync(join(ROOT, 'electron/core/loop.cjs'), 'utf8')
  check('★ 轮次边界查预算', loopSrc.includes('budget.atTurnBoundary({'))
  check(
    '★ 轮数边界只有一处（for 条件不许再拿 maxSteps 当上限）',
    loopSrc.includes('for (; turn < MAX_TURNS; turn += 1)') &&
      !loopSrc.includes('turn < (plan.maxSteps'),
  )
  check(
    '★ 兜底轮数明显高于默认预算（是保险丝不是功能）',
    /const MAX_TURNS = (\d+)/.exec(loopSrc)?.[1] === '200',
  )
  check('★ 撞了就标 waiting_user 并带着 budgetHit 返回', loopSrc.includes('budgetHit: hit'))
  const runSrc = readFileSync(join(ROOT, 'electron/core/loop-run.cjs'), 'utf8')
  check(
    '★ 停下来时走 pausedPatch（记原因与数字）',
    runSrc.includes('budget.pausePatch(result.budgetHit)'),
  )
  check('重试次数来自预算', loopSrc.includes('maxRetries: plan.maxRetries'))

  const toolsSrc = readFileSync(join(ROOT, 'electron/core/loop-tools.cjs'), 'utf8')
  check('★ 工具自动重试也用预算里的次数', toolsSrc.includes('options.budget?.maxRetries'))

  const handlers = readFileSync(join(ROOT, 'electron/handlers/safety.cjs'), 'utf8')
  check(
    '★ 列表里带上「算好的预算」（界面要显示与预填）',
    handlers.includes('budgetResolved: budget.resolve('),
  )

  /* ── ⑥ 真跑一遍：预算撞了就停下等人 ─────────────────── */
  /*
   * 上面测的都是零件。这一条**真跑循环**：把 maxSteps 设成 2，
   * 让模型每轮都要工具 → 第 3 轮开头应当撞上限、停下来、任务标 paused。
   * 接线（谁调 budget.check、撞了怎么记）只有真跑才照得到。
   */
  group('AG-040 / 真跑一遍（预算 2 轮）')
  const llmModule = require(join(ROOT, 'electron/core/llm.cjs'))
  const loopCore = require(join(ROOT, 'electron/core/loop.cjs'))
  const credentialsCore = require(join(ROOT, 'electron/core/credentials.cjs'))
  const { SANDBOX: WORKDIR, configModule } = require(join(ROOT, 'scripts/selftest/env.mjs'))
  const originalChatStream = llmModule.chatStream
  credentialsCore.set('provider:selftest-ag040', 'sk-selftest-ag040-123456')
  const provider = {
    id: 'selftest-ag040',
    name: '自检供应商',
    baseUrl: 'https://example.invalid/v1',
    credentialRef: 'provider:selftest-ag040',
    chatPath: '/chat/completions',
    models: ['probe-model'],
    enabled: true,
  }
  const budgetConfig = {
    ...configModule.get(),
    activeProvider: provider,
    providers: [provider],
    assistant: { ...configModule.get().assistant, model: 'probe-model' },
    /* ★ 预算：最多 2 轮（顶层 `budget` 这一节） */
    budget: { maxSteps: 2, maxToolCalls: 100, maxRuntime: 1800, maxRetries: 3, maxTokens: 0 },
    tools: { ...configModule.get().tools, permission: 'full' },
    memory: { ...configModule.get().memory, autoWrite: 'off' },
  }
  const emitted = []
  /* 走过哪些相位（AG-043：撞预算停下必须落 paused，不能是 waiting_user） */
  const phases = []
  const offPhases = life.onTransition((e) => phases.push(e.to))
  try {
    /* 模型每轮都要读文件 —— 永远不「说完」 */
    llmModule.chatStream = async () => ({
      content: '',
      reasoning: '',
      toolCalls: [
        {
          id: `c${emitted.length}`,
          name: 'read_file',
          arguments: JSON.stringify({ path: 'hello.txt' }),
        },
      ],
      usage: null,
    })

    const result = await loopCore.run({
      history: [{ role: 'user', content: '一直读文件' }],
      config: budgetConfig,
      workdir: WORKDIR,
      mode: 'pair',
      goal: '一直读文件',
      sessionId: 'selftest-ag040',
      signal: new AbortController().signal,
      emit: (event) => emitted.push(event),
      confirm: async () => true,
    })
    created.push(result.taskId)

    check('★ 到上限就停（不再往下跑）', result.exhausted === true)
    check(
      '★ 结果里带着「撞了哪一项」',
      result.budgetHit?.reason === 'maxSteps',
      JSON.stringify(result.budgetHit),
    )
    check('停在第 2 轮（= 上限）', result.turns === 2, String(result.turns))
    check('给用户的话里有继续 / 停止 / 调整预算', String(result.content).includes('调整预算'))
    check(
      '推了 budget 事件（界面据此说话）',
      emitted.some((e) => e.type === 'budget' && e.reason === 'maxSteps'),
    )
    /* 相位转移是全局广播的（chat.cjs 的转发器也订阅它）*/
    check(
      '★ 停下来推的是 paused 相位（不是 waiting_user）',
      phases.includes('paused') && !phases.includes('waiting_user'),
      JSON.stringify(phases),
    )
    check(
      '工具确实跑了 2 次（不是空转）',
      result.toolRuns.length === 2,
      String(result.toolRuns.length),
    )

    const stopped = taskCore.get(result.taskId)
    check('★ 任务标成 paused（不是 failed）', stopped.status === 'paused', stopped.status)
    check(
      '★ 台账里记着原因与数字',
      stopped.pauseReason === 'budget' && stopped.budgetHit.limit === 2,
      JSON.stringify(stopped.budgetHit),
    )

    /* 继续 → 标记清掉，任务还能接着做 */
    const taskResume = require(join(ROOT, 'electron/core/task-resume.cjs'))
    check('能接着做（可恢复）', taskResume.canResume(result.taskId) === true)
    taskResume.reopen(result.taskId)
    check('继续之后标记清掉', taskCore.get(result.taskId).pauseReason === '')
  } finally {
    offPhases()
    llmModule.chatStream = originalChatStream
    credentialsCore.remove('provider:selftest-ag040')
  }

  /* 清理 */
  for (const id of created) taskCore.remove(id)
  check(
    '测试任务已清理',
    created.every((id) => taskCore.get(id) === null),
  )
}
