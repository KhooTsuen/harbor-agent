/**
 * 自检 / 「结果不明」与重跑风险
 *
 * 这是整个项目里**唯一一类「没做成」和「已经做成了」分不出来**的情况：
 * 进程在一条有副作用的命令跑到一半时被强杀 —— 磁盘上只剩一条
 * `completed:false` 的意图。恢复时如果当它没跑过，直接重跑，
 * 就可能做出两份（建两个 issue、发两次请求）。
 *
 * 所以这一组钉四件事：
 *   ① 判断依据只有一处（`isReplayUnsafe`）：读操作重跑没事、写操作不许盲目重跑
 *   ② 恢复清单里**带得上**这条提醒（带不上 = 用户永远看不到）
 *   ③ 诊断报告里也写一句（事后复盘查得到）
 *   ④ 收尾之后提醒消失（不能一直吓唬人）
 */

import { check, group } from '../harness.mjs'
import { ROOT, disposeTasks, join, require, taskCore } from '../env.mjs'

const taskIntent = require(join(ROOT, 'electron/core/task-intent.cjs'))
const recovery = require(join(ROOT, 'electron/core/task-recovery.cjs'))
const diagnose = require(join(ROOT, 'electron/core/task-diagnose.cjs'))

const step = (extra) => ({ tool: 'run_shell', at: Date.now(), ...extra })

export function run() {
  group('重跑风险 / 哪些工具重跑不能盲目')
  check('★ run_shell 算危险', taskIntent.isReplayUnsafe('run_shell'))
  check('写文件算危险', taskIntent.isReplayUnsafe('write_file') && taskIntent.isReplayUnsafe('edit_file'))
  check('MCP 调用算危险', taskIntent.isReplayUnsafe('mcp__fs__write_file'))
  check('浏览器动作算危险', taskIntent.isReplayUnsafe('browse_click'))
  check('★ 读操作不算（重跑一百遍没事）', !taskIntent.isReplayUnsafe('read_file') && !taskIntent.isReplayUnsafe('list_dir'))
  check('联网搜索也不算（没有副作用）', !taskIntent.isReplayUnsafe('search_web'))
  check('空值不当危险', !taskIntent.isReplayUnsafe('') && !taskIntent.isReplayUnsafe(undefined))

  group('重跑风险 / 什么样的步骤算「结果不明」')
  check('有意图、没结果 → 在飞', taskIntent.isPending(step({ intent: { tool: 'run_shell' }, completed: false })))
  check('有意图、有结果 → 不算', !taskIntent.isPending(step({ intent: { tool: 'run_shell' }, completed: true })))
  check(
    '★ 老式子（没有 intent）算不可判定，不算「在飞」',
    !taskIntent.isPending(step({ ok: true })),
  )
  check('没有 steps 时不炸', taskIntent.replayRisk({}).count === 0)
  check('干净的任务没有提醒', taskIntent.replayRisk({ steps: [] }).note === '')

  const mixed = {
    steps: [
      /* 结果不明的写操作 —— 要报 */
      { tool: 'run_shell', intent: { tool: 'run_shell', commandHash: 'abc123', startedAt: 1700000000000 }, completed: false },
      /* 结果不明的读操作 —— 不用报 */
      { tool: 'read_file', intent: { tool: 'read_file', commandHash: 'def456', startedAt: 1700000000000 }, completed: false },
      /* 已经落结果的写操作 —— 不用报 */
      { tool: 'edit_file', intent: { tool: 'edit_file', commandHash: 'ghi789', startedAt: 1 }, completed: true, ok: true },
    ],
  }
  const risk = taskIntent.replayRisk(mixed)
  check('★ 只数有副作用的那条', risk.count === 1, String(risk.count))
  check('条目里带上工具 / 指纹 / 时间', risk.risky[0].tool === 'run_shell' && risk.risky[0].hash === 'abc123' && risk.risky[0].at === 1700000000000)
  check('★ 人话里说清「别直接重跑」', risk.note.includes('别直接重跑'))
  check('没落结果之前不假装知道跑的是什么', !risk.note.includes('dir'))

  group('重跑风险 / 恢复清单与诊断报告都带得上')
  const task = taskCore.create({ goal: '自检：重跑风险提醒', sessionId: 'selftest-replay' })
  try {
    /* 造一条「在飞」的意图：这正是强杀之后磁盘上留下的形状 */
    taskIntent.markIntent(task.id, 's_test_1', {
      tool: 'run_shell',
      commandHash: 'deadbeef01',
      startedAt: Date.now(),
    })
    const item = recovery.scan({}).find((row) => row.id === task.id)
    check('★ 恢复清单里带上了 replay', item?.replay?.count === 1, JSON.stringify(item?.replay))
    check('恢复清单里也给了人话', String(item?.replay?.note ?? '').includes('结果不明'))

    const report = diagnose.diagnose(taskCore.get(task.id))
    const text = typeof report === 'string' ? report : JSON.stringify(report)
    check('★ 诊断报告里写了一句', text.includes('结果不明'))
    check('报告里没有瞎猜命令原文', text.includes('deadbeef01'))

    /* 收尾之后必须消失 —— 一直挂着就是吓唬人 */
    taskIntent.endShell(task.id, 's_test_1', { ok: true, summary: 'ok' })
    const after = recovery.scan({}).find((row) => row.id === task.id)
    check('★ 落了结果之后提醒就没了', (after?.replay?.count ?? -1) === 0)
  } finally {
    disposeTasks([task.id])
  }
}
