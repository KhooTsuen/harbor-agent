/**
 * 自检 / 稳定性指标
 *
 * 这一组盯的全是**口径**，不是「函数能不能跑」：
 *   · 成功率的分母里**没有 paused**（它还能接着做，算进去会显示成假的低分）
 *   · 分母是 0 时比率是 **null 而不是 0**（0 会被读成「一次都没成」）
 *   · 一次工具调用在台账里留**两条**记录，只准数一次
 *   · 读不动的任务文件**单独计数**，不进分母
 * 这些数字是给人做判断用的，口径漂了就比没有还坏。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, group } from '../harness.mjs'
import { ROOT, SANDBOX, require } from '../env.mjs'

const stats = require(join(ROOT, 'electron/core/run-stats.cjs'))

/** 往夹具里写一条任务（自动建目录） */
function putTask(dir, task) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task), 'utf8')
}

const task = (id, status, extra = {}) => ({ id, status, createdAt: 1000, finishedAt: 61000, ...extra })

export function run() {
  group('稳定性指标 / 成功率的分母')
  const dir = join(SANDBOX, 'stats/tasks')
  rmSync(join(SANDBOX, 'stats'), { recursive: true, force: true })
  putTask(dir, task('t1', 'completed'))
  putTask(dir, task('t2', 'completed'))
  putTask(dir, task('t3', 'completed'))
  putTask(dir, task('t4', 'failed'))
  putTask(dir, task('t5', 'failed'))
  putTask(dir, task('t6', 'cancelled'))
  putTask(dir, task('t7', 'paused', { pauseReason: 'budget', resumeCount: 2 }))
  putTask(dir, task('t8', 'running'))
  writeFileSync(join(dir, 't9.json'), '{ 坏', 'utf8')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 't10.json'), '{ 也坏', 'utf8')

  const { tasks, broken } = stats.readTasks(join(SANDBOX, 'stats'))
  const report = stats.summarize(tasks, { broken })

  check('读得动的任务都进来了', report.tasks.total === 8, String(report.tasks.total))
  check('读不动的单独计数（没混进分母）', report.tasks.broken === 2 && broken.length === 2)
  check('分母 = 完成 + 失败 + 放弃 = 6', report.tasks.settled === 6, String(report.tasks.settled))
  check('★ paused 不算分母（它还能接着做）', !stats.SETTLED.includes('paused'))
  check('成功率 = 3/6', Math.abs(report.tasks.successRate - 0.5) < 1e-9, String(report.tasks.successRate))
  check('按状态分好了组', report.tasks.byStatus.paused === 1 && report.tasks.byStatus.running === 1)
  check('暂停原因单独归拢', report.pause.byReason.budget === 1)

  group('稳定性指标 / 没有样本 ≠ 0')
  const emptyReport = stats.summarize([], {})
  check('★ 一条任务都没有时，成功率是 null 不是 0', emptyReport.tasks.successRate === null)
  check('平均轮数同样是 null', emptyReport.avg.turns === null)
  check('报告里写「还没有样本」而不是「0%」', stats.format(emptyReport).includes('还没有样本'))

  group('稳定性指标 / 工具调用不许数两遍')
  const doubled = stats.summarize([
    {
      id: 't',
      status: 'completed',
      steps: [
        /* 同一次调用的两条：一条带意图（+ 结果），一条带参数 */
        { tool: 'run_shell', ok: true, intent: { tool: 'run_shell' }, completed: true },
        { tool: 'run_shell', ok: true, args: { command: 'dir' } },
        { tool: 'edit_file', ok: false, intent: { tool: 'edit_file' }, completed: true },
        { tool: 'edit_file', ok: false, args: { path: 'a.ts' } },
      ],
    },
  ])
  check('★ 两次调用就是两次，不是四次', doubled.tools.calls === 2, String(doubled.tools.calls))
  check('失败数也不翻倍', doubled.tools.failed === 1)
  check('失败率 = 1/2', doubled.tools.failureRate === 0.5)
  check('口径标明是 intent 那批', doubled.tools.counting === 'intent')
  check('最爱失败的排在前面', doubled.tools.topFailing[0].name === 'edit_file')

  const legacy = stats.summarize([
    { id: 't', status: 'completed', steps: [{ tool: 'read_file', ok: true, args: { path: 'a' } }] },
  ])
  check('★ 老台账（没有 intent）退回到带参数那批，并注明', legacy.tools.calls === 1 && legacy.tools.counting === 'args')

  group('稳定性指标 / 错误分类复用 errors.cjs')
  const withErrors = stats.summarize([
    {
      id: 't',
      status: 'failed',
      errors: [{ at: 1, message: '文件不存在：E:\\x\\y.txt' }, { at: 2, message: 'fetch failed' }],
    },
  ])
  check('错误总数对', withErrors.errors.total === 2)
  check('★ 分类用的是同一份规则（file_missing）', withErrors.errors.byKind.file_missing === 1)
  check('网络错误也认得出', withErrors.errors.byKind.network === 1)

  group('稳定性指标 / 恢复')
  const withResume = stats.summarize([
    task('a', 'completed', { resumeCount: 1 }),
    task('b', 'completed', { resumeCount: 2 }),
    task('c', 'failed', { resumeCount: 1 }),
    task('d', 'completed', { resumeCount: 0 }),
  ])
  check('被恢复过的条数', withResume.recovery.resumed === 3)
  check('恢复之后做成的比例 = 2/3', Math.abs(withResume.recovery.successRate - 2 / 3) < 1e-9)
  check('恢复占比 = 3/4', withResume.recovery.share === 0.75)

  group('稳定性指标 / 真机任务集')
  check('不是数组 → 当没有', stats.fromBattery(null) === null && stats.fromBattery({}) === null)
  const battery = stats.fromBattery([
    { 任务: 'T1-只读答疑', 通过: true },
    { 任务: 'T1-只读答疑', 通过: true },
    { 任务: 'T2-单文件修改', 通过: false },
  ])
  check('按任务归类', battery.runs === 3 && battery.passed === 2 && battery.byTask['T1-只读答疑'].passed === 2)
  const text = stats.format({ ...report, battery })
  check('报告里带上真机任务集那段', text.includes('真机任务集：跑过 3 次，通过 2 次'))
  check('成功率那行写明了分母是什么（口径不许藏）', text.includes('分母是「已经定了的」'))
  check('平均用时按分钟给人看', /平均：.*分钟/.test(text), text.split('\n').pop())

  group('稳定性指标 / 空目录与坏目录不当崩溃')
  const missing = stats.readTasks(join(SANDBOX, '根本没有这个目录'))
  check('目录不存在 → 空台账、不抛错', missing.tasks.length === 0 && missing.broken.length === 0)
  check('空台账的报告也能打印出来', stats.format(stats.summarize([], {})).includes('一条都没有'))
}
