import { join, readFileSync, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

/* ══════════════════════════════════════════════════════════════
   AG-053 批③：无人值守（定时任务）、离场巡查、超时通知

   这一组钉三块**跨模块**的事（各自单测都能过、接起来却会断的那种）：

     ① **定时任务不许弹澄清卡**：语义是「没人在场」——
        不弹卡、不挂请求、直接按默认选项开工（默认选项由提示词层要求标成
        改动最小那个），并且**留痕**（那段文本会作为工具结果进会话记录）。
     ② **离场巡查**（`handlers/clarify-watch.cjs`）：每跳读一次
        `powerMonitor.getSystemIdleTime()`，到点只推一次（通知不重复）。
     ③ **超时通知**的文案与注入：
        · 内容是「哪条任务 + 替他定了什么」（用户回来得认得出）
        · `main.cjs` 注入的确实是 Electron 的 powerMonitor，内核不自己 require
   ══════════════════════════════════════════════════════════════ */

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/** 剥掉注释行再扫（同类坑：注释里的示例代码会被当成真代码） */
const codeOf = (src) =>
  src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')

const good = (patch = {}) => ({
  question: '用哪个包管理器？',
  options: [
    { label: 'pnpm', effect: '仓库里有 pnpm-lock.yaml，换 npm 会多装 1 份依赖' },
    { label: 'npm', effect: '要重新生成 lock 文件，多花约 30 秒' },
  ],
  defaultValue: 'pnpm',
  ...patch,
})

export async function run() {
  const clarify = require(join(ROOT, 'electron/core/clarify.cjs'))
  const askUser = require(join(ROOT, 'electron/core/tools/ask_user.cjs'))
  const bridge = require(join(ROOT, 'electron/core/confirm-bridge.cjs'))
  const notice = require(join(ROOT, 'electron/core/clarify-notice.cjs'))
  const watch = require(join(ROOT, 'electron/handlers/clarify-watch.cjs'))

  group('AG-053 / 无人值守：定时任务不弹卡、不挂请求、按默认开工')
  const unattendedSession = 'selftest-clarify-unattended'
  const unmark = clarify.markUnattended(unattendedSession)
  check('标上之后查得到（登记表按 sessionId）', clarify.isUnattended(unattendedSession) === true)
  check('别的对话不受影响', clarify.isUnattended('别的对话') === false)

  /* 故意给一个「能问到东西」的通道：真去问了就会挂上一条请求 */
  const asked = []
  bridge.reset()
  const out = String(
    await askUser.run(
      { questions: [good()] },
      {
        sessionId: unattendedSession,
        emit: (event) => asked.push(event),
        clarify: async () => ({ answers: [{ question: '用哪个包管理器？', choice: 'npm' }] }),
      },
    ),
  )
  check('★ 没弹卡（一个事件都没发出去）', asked.length === 0, JSON.stringify(asked).slice(0, 60))
  check('★ 没挂请求（主进程不会干等到超时）', bridge.pendingCount() === 0)
  check('★ 说清这是无人值守，而不是「用户跳过了」', /无人值守/.test(out) && !/跳过了这次澄清/.test(out), out.slice(0, 60))
  check('★ 采纳的是默认选项（pnpm）并标了［默认］', /→ ［默认］pnpm/.test(out), out.slice(0, 120))
  /*
   * ⚠️ 不能拿「文本里没出现 npm」当判据：pnpm 那条的 effect 里就写着
   *   「换 npm 会多装 1 份依赖」—— npm 本来就该出现。要判的是**被采纳的那条**。
   */
  check('★ 没采纳「回答」里的 npm（那条通道根本没被调用）', !/→ ［默认］npm/.test(out))
  check('★ 留痕：这段文本就是工具结果，会进会话记录', /按每条的默认选项开工/.test(out))

  /* 参数全坏时也别装模作样地「按默认开工」——照样回一句说明 */
  const badOut = String(await askUser.run({ questions: [{ question: ' ' }] }, { sessionId: unattendedSession }))
  check('无人值守 + 参数全坏 → 仍然返回「没能问出去」', /没能问出去/.test(badOut), badOut.slice(0, 50))

  unmark()
  check('★ 跑完必须摘掉标记（不摘 = 这条会话永远不再问）', clarify.isUnattended(unattendedSession) === false)
  const backOut = String(
    await askUser.run(
      { questions: [good()] },
      { sessionId: unattendedSession, clarify: async () => ({ answers: [{ question: '用哪个包管理器？', choice: 'pnpm' }] }) },
    ),
  )
  check('摘掉之后又恢复正常提问（人回来了）', /用户的答复/.test(backOut), backOut.slice(0, 40))

  group('AG-053 / 离场巡查：每跳读一次空闲值，到点只推一次')
  let clock = 1000 /* 假时钟：不靠 sleep，断言才不是碰运气 */
  let idle = 9999 /* 一开始就「人不在」（阈值 5 秒） */
  const fired = []
  /*
   * ★ 上限用**真实的配置形状**（`clarify-config.normalize()` 的输出）：
   *   巡查器读的就是这个形状。批③ 真机第一遍的坑就是这里 —— 调用方翻译成
   *   `{ timeoutMs }`、巡查器读 `clarifyTimeoutMs`，对不上 → 静默退回默认 10 分钟。
   *   拿真形状当夹具，这种改名会被当场抓住。
   */
  const limits = () => ({
    clarifyIdleSeconds: 5,
    clarifyTimeoutMs: 10,
    clarifyMaxWaitMs: 60000,
  })
  const watcher = watch.createWatcher({
    now: () => clock,
    idleSeconds: () => idle,
    readLimits: limits,
    onTimeout: (event) => fired.push(event),
  })
  const armed = watcher.arm({ id: 'clr_x', sessionId: 's', taskId: 't', questions: [good()] })
  check('挂上了（巡查表里一条）', armed.ok === true && watcher.pending().length === 1)
  clock += 5
  watcher.sweep()
  check('离场累计还不够（5ms < 10ms）→ 不推', fired.length === 0, String(fired.length))
  clock += 10
  watcher.sweep()
  check('★ 到点 → 推一个事件', fired.length === 1 && fired[0].id === 'clr_x', String(fired.length))
  check('★ 事件带着会话与任务（点通知要能跳回去 + 说得清是哪条）', fired[0].sessionId === 's' && fired[0].taskId === 't')
  clock += 100000
  watcher.sweep()
  watcher.sweep()
  check('★ 再跳多少次都不重复推（卡已经从表里摘掉了）', fired.length === 1, String(fired.length))
  check('到点后巡查表里没有它了', watcher.pending().length === 0)

  idle = 0
  clock += 1000
  watcher.arm({ id: 'clr_y', sessionId: 's', taskId: 't2', questions: [good()] })
  for (let i = 0; i < 5; i += 1) {
    clock += 60000
    watcher.sweep()
  }
  check('★ 人在场（空闲 0）→ 过一小时也不超时（他想 20 分钟不该被打断）', fired.length === 1, String(fired.length))
  idle = 9999
  clock += 5
  watcher.sweep()
  check('他走开之后才重新开始计时（这一步只累计 5ms）', fired.length === 1, String(fired.length))
  clock += 10
  watcher.sweep()
  check('★ 离场累计够了才推', fired.length === 2, String(fired.length))

  const watched = watch.createWatcher({
    now: () => clock,
    idleSeconds: () => 9999,
    readLimits: limits,
  })
  watched.arm({ id: 'clr_z', sessionId: 's', taskId: 't3', questions: [good()] })
  watched.resolve('clr_z')
  clock += 1000
  watched.sweep()
  check('用户答完（resolve）之后不再计时', watched.pending().length === 0)

  /* ── 键名这一层单独钉：脏配置（缺字段 / 读不出来）也不该比默认更激进 ── */
  const realCfg = require(join(ROOT, 'electron/core/clarify-config.cjs')).normalize({
    clarifyIdleSeconds: 5,
    /* ⚠️ 这里只能给 1000：配置层对超时的下限就是 1 秒（夹取规则在 clarify-config.cjs）*/
    clarifyTimeoutMs: 1000,
    clarifyMaxWaitMs: 60000,
  })
  const fromRealConfig = watch.createWatcher({
    now: () => clock,
    idleSeconds: () => 9999,
    readLimits: () => realCfg,
    onTimeout: (event) => fired.push(event),
  })
  fromRealConfig.arm({ id: 'clr_real', sessionId: 's', taskId: 't4', questions: [good()] })
  clock += 1100
  fromRealConfig.sweep()
  check(
    '★ 直接吃 clarify-config 的输出就能到点（键名对不上就会静默退回默认 10 分钟）',
    fired.length === 3 && fired[2].id === 'clr_real',
    `${fired.length} 次`,)
  const broken = watch.createWatcher({ now: () => clock, idleSeconds: () => 9999, readLimits: () => ({}) })
  check('配置读空 → 用默认值（不报错也不立刻超时）', broken.tracker.limits.timeoutMs() === 600000, String(broken.tracker.limits.timeoutMs()))

  /*
   * ★ 到点必须**真的把那条往返推进去**（不是只发个通知）。
   *   批③ 真机第一遍的坑：日志里通知发了、卡片也收了，模型却再没被叫过 ——
   *   因为 `arm()` 只挂了计时，没人 `settleAsTimeout`，任务要干等 5 分钟的兜底定时器。
   */
  const settleClock = { at: 1000 }
  const settled = []
  bridge.reset()
  const settleWatch = watch.createWatcher({
    now: () => settleClock.at,
    idleSeconds: () => 9999,
    readLimits: limits,
  })
  bridge.ask({
    timeoutMs: 60000,
    idPrefix: 'clr',
    emitReply: (payload) => {
      settleWatch.arm({
        id: payload.confirmId,
        onSettle: () => {
          settled.push(payload.confirmId)
          bridge.settleAsTimeout(payload.confirmId)
        },
      })
    },
  })
  settleClock.at += 20
  settleWatch.sweep()
  check('★ 到点会调 onSettle（把那条往返推进去）', settled.length === 1, String(settled.length))
  check('★ 推进之后不再挂着（工具那边立刻能继续）', bridge.pendingCount() === 0, String(bridge.pendingCount()))
  bridge.reset()

  /*
   * ── 累计离场等待超上限 → **这个任务不再弹卡** ──
   *
   * `clarifyMaxWaitMs`（默认 30 分钟）是给「同一个任务里问了好几轮、每轮都等不到人」准备的。
   * 批③ 只把标记打上了、顺手记了行日志 —— **没人拦**，于是「本任务不再弹卡」是句空话；
   * 批④ 真机验这条才现形。这一组钉三件事：标记打得对、预检读得到、问了也不发卡。
   *
   * ⚠️ 必须驱动**单例**（`start()`）：`askClarify` 的预检读的就是它 ——
   *   用局部 `createWatcher` 建的实例，那边根本看不到（第一版就写错过）。
   */
  const muteClock = { at: 1000 }
  watch.start({
    now: () => muteClock.at,
    powerMonitor: { getSystemIdleTime: () => 9999 },
    readLimits: () => ({ clarifyIdleSeconds: 5, clarifyTimeoutMs: 10, clarifyMaxWaitMs: 100 }),
    /* 定时器拉长：这一组自己手动 sweep，不靠它 */
    sweepMs: 999999,
  })
  /* 三张卡各等掉 100ms（上限就是 100ms）→ 第三张把任务等超 */
  for (const id of ['m1', 'm2', 'm3']) {
    watch.arm({ id, taskId: 'task_mute', sessionId: 's' })
    muteClock.at += 100
    watch.watcher().sweep()
  }
  check('★ 累计离场等待超上限 → 这个任务被标成「别再弹卡」', watch.mutedFor('task_mute') === true)
  check('别的任务不受影响', watch.mutedFor('task_other') === false)
  check(
    '累计值查得到（排查用）',
    watch.watcher().tracker.waited('task_mute') >= 100,
    String(watch.watcher().tracker.waited('task_mute')),
  )

  /* 预检读得到 → 澄清往返**根本不发起**（不发事件、不挂请求） */
  const chatConfirm = require(join(ROOT, 'electron/handlers/chat-confirm.cjs'))
  const sent = []
  bridge.reset()
  const busy = await chatConfirm.askClarify({
    sessionId: 's',
    taskId: 'task_mute',
    questions: [good()],
    emit: (event) => sent.push(event),
  })
  check('★ 静音后不弹卡（一个事件都没发）', sent.length === 0 && busy.muted === true, JSON.stringify(busy))
  check('★ 静音后不挂请求（主进程不会多等一秒）', bridge.pendingCount() === 0)
  bridge.reset()
  watch.stop()

  /*
   * ★ 验收替身 `HARBOR_IDLE_SECONDS`：真机验收脚本就坐在**同一台机器**前，
   *   人一碰鼠标系统空闲就清零 —— 「离场」这件事在真机上没法稳定复现。
   *   所以设了它就以它为准，没设照旧读注入进来的 powerMonitor。
   *   （2026-10-02 真机就是这么卡住的：诊断行 `cards=1 away=false`，
   *     看着像应用挂了，其实是设计如此「在场不计时」+ 测试前提错了。）
   */
  const envBefore = process.env.HARBOR_IDLE_SECONDS
  const awayWith = (env) => {
    if (env === undefined) delete process.env.HARBOR_IDLE_SECONDS
    else process.env.HARBOR_IDLE_SECONDS = env
    watch.stop()
    watch.start({
      powerMonitor: { getSystemIdleTime: () => 999 },
      readLimits: () => ({ clarifyIdleSeconds: 5 }),
    })
    const away = watch.watcher().away()
    watch.stop()
    return away
  }
  check('★ 没设替身 → 读注入的 powerMonitor（系统说走了 999 秒 = 离场）', awayWith(undefined) === true)
  check('★ 设了替身 → 以它为准（0 秒 = 在场，哪怕系统说走了 999 秒）', awayWith('0') === false)
  check('替身是正常数字时也认（不是只认 0）', awayWith('999') === true)
  if (envBefore === undefined) delete process.env.HARBOR_IDLE_SECONDS
  else process.env.HARBOR_IDLE_SECONDS = envBefore
  check('收尾：巡查停了、环境变量也清干净了（别影响后面的组）', watch.watcher() === null)
}
