import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-001 生命周期状态机

   这一组盯的是「状态只能有一个来源」。改造前前端自己
   `setThreadStatus('running')`，UI 说在跑就是在跑 —— 后台真停了
   UI 也不知道。现在状态机是唯一真相源，所以边界要钉死：

     · 13 个状态，和需求文档 §2 一字不差
     · 非法转移**必须被拒**（宁可报错，也不要状态悄悄跑偏）
     · 终态出不去（completed 之后不会又变 executing）
     · 每次**真的**转移都要通知订阅者（同状态重复设置不算）
     · `executing → executing` 是有意的：一轮里会跑很多次工具
   ══════════════════════════════════════════════════════════════ */

const life = require(join(ROOT, 'electron/core/lifecycle.cjs'))

export async function run() {
  group('AG-001 生命周期 / 状态集')
  const expected = [
    'idle',
    'preparing',
    'thinking',
    'planning',
    'executing',
    'verifying',
    'responding',
    'completed',
    'waiting_user',
    'paused',
    'retrying',
    'cancelled',
    'failed',
  ]
  check('恰好 13 个状态', life.PHASES.length === 13)
  check(
    '和文档 §2 的状态集一致',
    expected.every((p) => life.PHASES.includes(p)),
    life.PHASES.join(','),
  )
  check('isPhase 认得合法值', life.isPhase('executing'))
  check('isPhase 拒绝瞎编的值', !life.isPhase('running'))
  check('running 不再是合法状态（已被 AgentPhase 取代）', !life.isPhase('running'))

  group('AG-001 生命周期 / 终态')
  check('completed 是终态', life.isTerminal('completed'))
  check('failed 是终态', life.isTerminal('failed'))
  check('cancelled 是终态', life.isTerminal('cancelled'))
  check('executing 不是终态', !life.isTerminal('executing'))
  check(
    '区分了三种结束方式',
    ['completed', 'failed', 'cancelled'].every((p) => life.isTerminal(p)),
  )

  group('AG-001 生命周期 / 转移规则')
  check('idle → preparing 合法', life.canTransition('idle', 'preparing'))
  check('thinking → executing 合法', life.canTransition('thinking', 'executing'))
  check(
    'executing → executing 合法（一轮里多次工具）',
    life.canTransition('executing', 'executing'),
  )
  check('executing → verifying 合法', life.canTransition('executing', 'verifying'))
  check('★ idle → completed 非法（没干活就完成）', !life.canTransition('idle', 'completed'))
  check('★ completed → executing 非法（终态出不去）', !life.canTransition('completed', 'executing'))
  check('★ cancelled → thinking 非法', !life.canTransition('cancelled', 'thinking'))
  check('可暂停：executing → paused', life.canTransition('executing', 'paused'))
  check('可恢复：paused → executing', life.canTransition('paused', 'executing'))
  check('可重试：executing → retrying', life.canTransition('executing', 'retrying'))

  group('AG-001 生命周期 / 状态机行为')
  const events = []
  const off = life.onTransition((e) => events.push(`${e.from}→${e.to}`))
  const m = life.createMachine({ taskId: 't1', initial: 'idle' })
  check('初始是 idle', m.phase === 'idle')

  m.to('preparing')
  m.to('thinking')
  m.to('planning')
  m.to('executing')
  check('走到 executing', m.phase === 'executing')
  check('每次转移都通知了订阅者', events.length === 4, events.join(' '))

  /* 同状态重复设置：不算转移，也不发事件 */
  const before = events.length
  const same = m.to('executing')
  check('同状态重复设置被标记为 skipped', same.skipped === true)
  check('同状态重复设置不发事件', events.length === before)

  /* 终态。注意：executing 不能直接跳 completed —— 要经过 verifying / responding，
     这是有意设计的（AG-004 的 Understand→Plan→Execute→Verify→Respond） */
  check('★ executing 不能直接到 completed', m.to('completed').ok === false)
  m.to('verifying')
  m.to('responding')
  m.to('completed')
  check('进终态', m.phase === 'completed' && m.terminal)
  const afterTerminal = m.to('executing')
  check('★ 终态之后的转移被拒绝', afterTerminal.ok === false)
  check('★ 拒绝时状态没变', m.phase === 'completed')

  const hist = m.history
  check('历史记下了每一步', hist.length === 8, String(hist.length))
  check(
    '历史带时间戳',
    hist.every((h) => typeof h.at === 'number' && h.at > 0),
  )

  off()
  const n = events.length
  const fresh = life.createMachine({ taskId: 't2', initial: 'idle' })
  fresh.to('preparing')
  check('退订后不再收到事件', events.length === n)

  group('AG-001 生命周期 / 未知状态')
  let threw = false
  try {
    life.createMachine({ taskId: 't3', initial: '不存在的状态' })
  } catch {
    threw = true
  }
  check('★ 未知初始状态直接抛错（不静默）', threw)

  let threw2 = false
  const m4 = life.createMachine({ taskId: 't4' })
  try {
    m4.to('乱写的状态')
  } catch {
    threw2 = true
  }
  check('★ 转移到未知状态抛错', threw2)

  group('AG-001 生命周期 / 注册表')
  life.clearAll()
  const a = life.forTask('task-a')
  const b = life.forTask('task-a')
  check('同一个 taskId 拿到同一个状态机', a === b)
  a.to('preparing')
  check('状态保留', life.forTask('task-a').phase === 'preparing')
  life.forget('task-a')
  check('forget 之后是新机器', life.forTask('task-a').phase === 'idle')
  life.clearAll()

  check(
    '「没干完」的状态表可用（重启提示续做要靠它）',
    life.UNFINISHED.has('paused') && life.UNFINISHED.has('executing'),
  )
  check('终态不在「没干完」里', !life.UNFINISHED.has('completed'))
}
