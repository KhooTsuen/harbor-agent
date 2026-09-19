import { join, mkdirSync, require, rmSync, ROOT, writeFileSync } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-035：自动 Checkpoint ——「把台账读成人话」（Diagnose）

   文档三种能力：Resume / Rollback / **Diagnose**。前两个早有
   （task-resume.cjs、changeset.cjs 各有自己的组），Diagnose 是这次补的：
   台账摊开是几百行 JSON，人要的是「这条任务怎么了、我现在该干什么」。

   这一组的规矩只有一条：**只写台账里读得到的事实，不推测**
   —— 诊断报告一旦开始脑补，就没法用来判断了。所以：
     · 没计划就写「没有（这轮没写计划块）」
     · 没跑过命令就写「没有跑过」
     · 没授权记录就写「没有记录」，而不是编一段

   外加两条底线（都是真出过事的）：
     · 坏文件不能把台账带崩，也不能**静默**吞掉（拆文件时 `list()` 里残留的
       `fs` 引用被空 catch 吞了，列表永远空、界面毫无提示）
     · `unfinished()` 必须**先筛再截**（原来是先截最近 20 条再筛，时间戳撞上时
       刚建的任务会被挤出前 20，凭空消失）
   ══════════════════════════════════════════════════════════════ */

const diag = require(join(ROOT, 'electron/core/task-diagnose.cjs'))
const io = require(join(ROOT, 'electron/core/task-io.cjs'))
const taskCore = require(join(ROOT, 'electron/core/task.cjs'))

export async function run() {
  const created = []
  function newTask(goal = '把配置读一遍') {
    const task = taskCore.create({ goal, sessionId: 'selftest-ag036' })
    created.push(task.id)
    return task
  }

  try {
    /* ── ① 报告该说什么 ─────────────────────────────────── */
    group('AG-035 / 诊断报告')
    check(
      '任务不在 → 报告不炸',
      diag.diagnose(null).text === '' && diag.diagnose(undefined).conclusion.includes('不在了'),
    )

    const t3 = newTask('删掉 README 的安装一节并跑测试')
    taskCore.recordModel(t3.id, 'deepseek-flash')
    taskCore.update(t3.id, { plan: ['[x] 读 README', '[ ] 跑测试'] })
    taskCore.addStep(t3.id, { tool: 'read_file', ok: true, summary: '读到 12 行' })
    taskCore.addStep(t3.id, { tool: 'run_shell', ok: false, summary: '错误：命令退出码 1' })
    taskCore.addChangedFile(t3.id, 'E:/demo/README.md')
    taskCore.addCommand(t3.id, 'python tests.py', ['FAIL: 没有安装一节', '[退出码 1]'].join('\n'))
    taskCore.checkpoint(t3.id, { label: '第 1 轮改动完成' })
    taskCore.update(t3.id, { status: 'paused', pausedAt: Date.now(), nextAction: '跑测试' })
    const report = diag.diagnose(taskCore.get(t3.id))

    check('报告有标题与状态', report.title.includes('README') && report.status === 'paused')
    check('★ 停住的任务先把「停在哪」说清楚', report.conclusion.includes('停在'))
    check('★ 报告里有模型', report.text.includes('模型：deepseek-flash'))
    check('报告里有计划进度', report.text.includes('计划：2 步，完成 1'))
    check('报告里有失败的那一步', report.text.includes('失败：run_shell'))
    check('报告里有改动文件', report.text.includes('README.md'))
    check('★ 命令带退出码（判读来自 task-outcome）', report.text.includes('退出码非 0'))
    check('★ 测试没过写进报告', report.text.includes('测试：没过'))
    check('授权段有内容', report.text.includes('授权：'))
    check(
      '检查点与恢复次数都在',
      report.text.includes('检查点：1 个') && report.text.includes('恢复过：0 次'),
    )

    /* 没计划、没命令、没授权时不能瞎编 */
    const bare = diag.diagnose(taskCore.get(newTask('什么也没干的任务').id))
    check('★ 没有计划就写「没有」', bare.text.includes('计划：没有'))
    check('★ 没跑过命令就写「没有跑过」', bare.text.includes('命令：没有跑过'))
    check('★ 没有授权记录不编（写「没有记录」）', bare.text.includes('没有记录'))
    check('没记录模型也照实说', bare.text.includes('模型：没有记录'))

    /* 失败的任务：结论要带出错原因 */
    const t4 = newTask('会失败的任务')
    taskCore.fail(t4.id, '供应商 401')
    check(
      '失败任务的结论带原因',
      diag.diagnose(taskCore.get(t4.id)).conclusion.includes('供应商 401'),
    )

    /* 完成但测试没过：不能让「做完了」把红旗盖掉 */
    const t5 = newTask('做完但测试红了的任务')
    taskCore.addCommand(t5.id, 'npm test', ['FAIL', '[退出码 1]'].join('\n'))
    taskCore.finish(t5.id, { status: 'completed', result: '我改好了' })
    check(
      '★ 已完成但测试没过 → 结论先说测试',
      diag.diagnose(taskCore.get(t5.id)).conclusion.includes('测试没过'),
    )

    /* ── ② 坏文件不能把台账带崩 ─────────────────────────── */
    group('AG-035 / 坏文件不能把台账带崩')
    const logCore = require(join(ROOT, 'electron/core/log.cjs'))
    const broken = join(io.root(), 'task_selftest_broken.json')
    mkdirSync(io.root(), { recursive: true })
    writeFileSync(broken, '{ 这不是 JSON', 'utf8')
    /* 任何失败都变成「一个值」而不是抛出去 —— 断言才有机会把话说清楚 */
    const safely = (fn) => {
      try {
        return { value: fn() }
      } catch (error) {
        return { threw: String(error?.message ?? error) }
      }
    }
    const listed = safely(() => taskCore.list({ limit: 5 }))
    check(
      '★ 一个坏文件不会让 list 崩（任务中心不能白屏）',
      listed.threw === undefined,
      String(listed.threw),
    )
    check(
      '坏文件当成「没有这条」',
      safely(() => taskCore.get('task_selftest_broken')).value === null,
    )
    check('不存在的任务也返回 null', safely(() => taskCore.get('task_不存在')).value === null)

    /*
     * ★ 「不静默」这一条得单独验。
     *   拆文件时 `list()` 里留了个已被删掉的 `fs` 引用，ReferenceError 被空
     *   catch 吞掉，列表永远空、界面毫无提示（只有自检里 20 条断言在报警）。
     *   所以「读不出来必须留痕」是个要求，不是顺手写的日志。
     */
    const warns = []
    const originalWarn = logCore.warn
    logCore.warn = (message) => warns.push(String(message))
    try {
      taskCore.get('task_selftest_broken')
    } finally {
      logCore.warn = originalWarn
    }
    check(
      '★ 读坏文件要留痕（不许静默吞掉）',
      warns.some((m) => m.includes('读任务失败')),
    )
    rmSync(broken, { force: true })

    /* ── ③ 未完成的任务不能被「最近 20 条」挤掉 ─────────── */
    group('AG-035 / 未完成清单先筛后截')
    const ghost = newTask('会被挤掉的那条')
    /* 再造 24 条，且让它们的 updatedAt 都比我新 —— 老写法先截最近 20 条
       （正好把它们截走），我那一条就凭空消失 */
    for (let i = 0; i < 24; i += 1) {
      const later = newTask(`后来的任务 ${i}`)
      taskCore.finish(later.id, { status: 'completed' })
    }
    check(
      '★ 未完成的那条仍在清单里（顺序是先筛再截）',
      taskCore.unfinished().some((item) => item.id === ghost.id),
    )
  } finally {
    for (const id of created) taskCore.remove(id)
    check(
      '测试任务已清理',
      created.every((id) => taskCore.get(id) === null),
    )
  }
}
