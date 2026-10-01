import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053：开工前澄清 —— 超时状态机（`core/clarify-timeout.cjs`）

   为什么要超时：澄清卡是**阻塞**的（用户不答，任务就一直等）。用户可能出门、
   睡着、跑一整天测试 —— 没有超时，任务会永远挂在那儿。

   四条机制的这个文件管三条：
     ② 离场检测：空闲 ≥ 30 秒 → 离场（真机由 main.cjs 注入 powerMonitor；
        这里注入假函数，所以没 Electron 也能验）
     ③ 两段超时：**在场不计时**（盯着屏幕想一小时也不催）；离场后累计 10 分钟 → 采纳默认
     ④ 累计上限：同一任务累计离场等待超 30 分钟 → 本任务不再弹卡

   ⚠️ 拆分说明：这一组本来在 `99-clarify.mjs` 里，两边合起来 330 行（破硬约束 #2），
      按关注点拆开：文件那边管校验/静音/工具/规则，这边只管时间。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const timeouts = require(join(ROOT, 'electron/core/clarify-timeout.cjs'))

  group('AG-053 / 超时状态机：在场不计时')
  let clock = 1000
  let idle = 0
  const tracker = timeouts.createTracker({
    now: () => clock,
    idleSeconds: () => idle,
    idleThresholdSec: 30,
    timeoutMs: 600000,
    maxWaitMs: 1800000,
  })
  tracker.arm({ id: 'card-1', taskId: 'task-a', sessionId: 's1' })
  check('刚挂上时不算离场', tracker.away() === false, `idle=${idle}`)
  /* 用户就坐在电脑前想了一小时（每 5 秒 sweep 一次，共 720 次） */
  for (let i = 0; i < 720; i += 1) {
    clock += 5000
    tracker.sweep()
  }
  check('★ 在场一小时也不超时（想多久都行）', tracker.pending().length === 1)
  check(
    '等待时长仍然是 0（只累加离场时间，不累加总时长）',
    tracker.pending()[0]?.waitedMs === 0,
    String(tracker.pending()[0]?.waitedMs),
  )

  group('AG-053 / 超时状态机：离场才累加，到点报 timeout')
  idle = 45
  check('空闲 45 秒 → 算离场', tracker.away() === true)
  let events = []
  /* 离场 9 分钟：每步 +5 秒 → 108 步 */
  for (let i = 0; i < 108; i += 1) {
    clock += 5000
    events = events.concat(tracker.sweep())
  }
  check('★ 离场 9 分钟还不够（阈值 10 分钟）', events.length === 0, JSON.stringify(events))
  for (let i = 0; i < 24; i += 1) {
    clock += 5000
    events = events.concat(tracker.sweep())
  }
  const timeout = events.find((one) => one.type === 'timeout')
  check('★ 离场满 10 分钟 → 报 timeout（该采纳默认了）', Boolean(timeout), JSON.stringify(events))
  check('报的是那张卡与那条任务', timeout?.id === 'card-1' && timeout?.taskId === 'task-a')
  check('之后不再重复报（卡已摘掉）', tracker.sweep().length === 0 && tracker.pending().length === 0)
  check(
    '这张卡累计的等待被记到任务头上',
    tracker.waited('task-a') >= 600000,
    String(tracker.waited('task-a')),
  )

  group('AG-053 / 超时状态机：用户答了就撤卡（不再超时）')
  const answered = timeouts.createTracker({ now: () => clock, idleSeconds: () => 60, timeoutMs: 5000 })
  answered.arm({ id: 'card-ok', taskId: 'task-ok' })
  check('撤卡前挂着', answered.pending().length === 1)
  const done = answered.resolve('card-ok')
  check('用户答完 → 卡被撤掉', done.ok === true && answered.pending().length === 0)
  clock += 60000
  check('★ 撤掉之后不会再报 timeout（别替已经答过的问题做决定）', answered.sweep().length === 0)
  check('重复撤同一张卡不炸（找不到就说找不到）', answered.resolve('card-ok').ok === false)

  group('AG-053 / 超时状态机：读不到空闲值按在场处理（宁可不超时）')
  const blind = timeouts.createTracker({ now: () => 0, idleSeconds: () => Number.NaN, timeoutMs: 1000 })
  blind.arm({ id: 'card-x' })
  check(
    '★ NaN（平台返回 unknown）→ 当成在场，绝不自动采纳默认',
    blind.away() === false && blind.sweep().length === 0,
  )
  const throwing = timeouts.createTracker({
    now: () => 0,
    idleSeconds: () => {
      throw new Error('这台机器没有这个 API')
    },
    timeoutMs: 1000,
  })
  throwing.arm({ id: 'card-y' })
  check(
    '★ 抛异常也当成在场（不让一个探测失败把用户的决定权拿走）',
    throwing.sweep().length === 0,
  )

  group('AG-053 / 超时状态机：同一任务累计超上限 → muted')
  clock = 0
  idle = 60
  const cap = timeouts.createTracker({
    now: () => clock,
    idleSeconds: () => idle,
    timeoutMs: 600000,
    maxWaitMs: 1800000,
  })
  /** 让一张卡走到超时（10 分钟 = 120 步 × 5 秒，多走一步确保过线） */
  const burn = () => {
    for (let i = 0; i < 121; i += 1) {
      clock += 5000
      cap.sweep()
    }
  }
  cap.arm({ id: 'c1', taskId: 'task-b' })
  burn()
  check('第一张卡超时后任务没被静音（10 分钟 < 30 分钟上限）', cap.muted('task-b') === false)
  cap.arm({ id: 'c2', taskId: 'task-b' })
  burn()
  check('两张卡 = 20 分钟，还不够上限', cap.muted('task-b') === false, String(cap.waited('task-b')))
  cap.arm({ id: 'c3', taskId: 'task-b' })
  burn()
  check('★ 三张卡 → 累计超 30 分钟', cap.waited('task-b') >= 1800000, String(cap.waited('task-b')))
  check('★ 累计超上限 → 这个任务不再弹卡（用户回来看一次总结）', cap.muted('task-b') === true)
  check('别的任务不受影响', cap.muted('task-other') === false)

  group('AG-053 / 超时状态机：接线与限制值')
  const src = readFileSync(join(ROOT, 'electron/core/clarify-timeout.cjs'), 'utf8')
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
  check(
    '★ 不 require electron（真机由 main.cjs 注入 powerMonitor；自检要能裸跑）',
    !code.includes("require('electron')"),
  )
  check('三个限制值都在 defaults 里导出（别处只引用）', typeof timeouts.DEFAULT_TIMEOUT_MS === 'number')
  check('默认阈值：离场 30 秒 / 等 10 分钟 / 累计上限 30 分钟', timeouts.DEFAULT_IDLE_SECONDS === 30 && timeouts.DEFAULT_TIMEOUT_MS === 600000 && timeouts.DEFAULT_MAX_WAIT_MS === 1800000)
  /* limits 里存的是**函数**（现读）：设置里改完下一跳生效，不用重启 */
  const limits = timeouts.createTracker({}).limits
  check(
    '传空依赖时用默认值（不让调用方必须记三个数）',
    limits.idleThresholdSec() === 30 && limits.timeoutMs() === 600000 && limits.maxWaitMs() === 1800000,
  )
  check(
    '★ 配置项可覆盖（真机验证把超时调成几秒就靠这个）',
    timeouts.createTracker({ idleThresholdSec: 3, timeoutMs: 3000 }).limits.timeoutMs() === 3000,
  )
  const live = { timeoutMs: 3000 }
  const liveTracker = timeouts.createTracker({ timeoutMs: () => live.timeoutMs })
  check('★ 上限可以传函数：改完立刻生效（不用重建追踪器）', liveTracker.limits.timeoutMs() === 3000)
  live.timeoutMs = 50
  check('★ 同一个追踪器读得到新值（设置改完下一跳就按新的算）', liveTracker.limits.timeoutMs() === 50)
  check('脏值（0 / NaN / 负数）回落到默认，不是回落到「立刻超时」', timeouts.createTracker({ timeoutMs: () => 0 }).limits.timeoutMs() === timeouts.DEFAULT_TIMEOUT_MS)
}
