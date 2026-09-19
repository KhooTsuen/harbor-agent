import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-034：Smart Continue —— 「下一步」得知道**这次到底干了什么**

   文档两个例子差在哪？就差在「测试跑没跑过」：

     修改完成，测试尚未运行。 → [运行测试]
     任务已完成。            → [查看 Diff][查看测试结果][继续优化]

   这些事实全在任务台账里（改了哪些文件、跑过什么命令、命令结果如何），
   所以判读放在内核做一次，渲染层只管按结论挑措辞（和 AG-029 分工一致）。

   这一组盯三件事：
     · 什么算「跑测试」（`npm run build` 不能算）
     · 退出码怎么读 —— `result` 落库时截到 300 字，`[退出码 N]` 在**末尾**，
       常常正好被截掉，所以要在截断**之前**单独存一份
     · 台账 → 结论的映射（取最后一条测试命令，不冒充结果）
   ══════════════════════════════════════════════════════════════ */

const oc = require(join(ROOT, 'electron/core/task-outcome.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

export async function run() {
  /* ── ① 什么算跑测试 ──────────────────────────────────── */
  group('任务结果 / 什么算跑测试')
  for (const cmd of [
    'npm test',
    'npm run test',
    'npm run test:unit',
    'pnpm test -- --run',
    'npx vitest run',
    'pytest -q',
    'go test ./...',
    'cargo test',
    './run_tests.sh',
    'python tests.py',
  ]) {
    check(`算：${cmd}`, oc.isTestCommand(cmd) === true)
  }
  for (const cmd of [
    'npm run build',
    'npm run dev',
    'ls -la',
    'git status',
    'make',
    'npm run lint',
  ]) {
    check(`不算：${cmd}`, oc.isTestCommand(cmd) === false)
  }

  /* ── ② 退出码 ────────────────────────────────────────── */
  group('任务结果 / 退出码怎么读')
  check('退出码 0 → 成功', oc.exitOf('ok\n\n[退出码 0]') === true)
  check('退出码 1 → 失败', oc.exitOf('FAIL\n\n[退出码 1]') === false)
  check('退出码 127 → 失败', oc.exitOf('[退出码 127]') === false)
  check('超时被杀 → 失败', oc.exitOf('[进程被超时杀掉（30s）]') === false)
  check('★ 没有标记 → 读不出来（老记录，不冒充通过）', oc.exitOf('随便一段输出') === null)
  check('摘要只留开头几行', oc.summaryOf('一\n\n二\n三\n四\n五', 3) === '一\n二\n三')

  /* ── ③ 台账 → 结论 ───────────────────────────────────── */
  group('任务结果 / 台账 → 结论')
  const make = (commands, files = 0) => ({
    id: 'task_ag034',
    commands,
    changedFiles: Array.from({ length: files }, (_, i) => ({ path: `f${i}.js` })),
  })

  check('没跑过测试 → none', oc.outcomeOf(make([])).tests === 'none')
  check(
    '只构建过 → none（构建不是测试）',
    oc.outcomeOf(make([{ command: 'npm run build', exitOk: true }])).tests === 'none',
  )
  check(
    '测试通过 → passed',
    oc.outcomeOf(make([{ command: 'npm test', exitOk: true }])).tests === 'passed',
  )
  check(
    '测试失败 → failed',
    oc.outcomeOf(make([{ command: 'npm test', exitOk: false }])).tests === 'failed',
  )
  check(
    '★ 老记录没有 exitOk → unknown（不冒充通过）',
    oc.outcomeOf(make([{ command: 'npm test', result: '12 passed' }])).tests === 'unknown',
  )
  check(
    '★ 取最后一条测试命令（「跑 → 改 → 再跑」看的是最后那次）',
    oc.outcomeOf(
      make([
        { command: 'npm test', exitOk: false, result: 'FAIL' },
        { command: 'npm test', exitOk: true, result: '12 passed' },
      ]),
    ).tests === 'passed',
  )
  const shown = oc.outcomeOf(
    make([{ command: 'npm test -- --run', exitOk: false, result: 'FAIL\n✕ 甲' }]),
  )
  check(
    '带出命令与摘要（给「查看测试结果」）',
    shown.testCommand === 'npm test -- --run' && shown.testSummary.includes('✕ 甲'),
  )
  check('改了几个文件算得出来', oc.outcomeOf(make([], 3)).files === 3)
  check('带出任务 id（结果展开按它认）', oc.outcomeOf(make([])).taskId === 'task_ag034')
  check('没有台账也不炸', oc.outcomeOf(undefined).tests === 'none')

  /* ── ④ 接线：落库时在截断**之前**读退出码 ─────────────── */
  group('任务结果 / 命令落库带退出结果')
  const task = taskCore.create({ goal: 'AG-034 判读接线', sessionId: 'selftest-outcome' })
  taskCore.addCommand(task.id, 'npm test', `${'x'.repeat(400)}\n[退出码 1]`)
  taskCore.addCommand(task.id, 'npm test', 'all good\n[退出码 0]')
  const listed = taskCore.get(task.id)

  check(
    '命令落库带上了退出结果',
    listed.commands[0].exitOk === false && listed.commands[1].exitOk === true,
  )
  check(
    '★ 结果截到 300 字之后仍读得出（这正是单独存它的原因）',
    listed.commands[0].result.length <= 300,
  )
  check('端到端：最后一条通过 → passed', oc.outcomeOf(listed).tests === 'passed')
  taskCore.remove(task.id)
  check('测试任务已清理', taskCore.get(task.id) === null)
}
