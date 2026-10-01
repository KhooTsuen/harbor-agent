/**
 * 澄清卡的「离场超时」巡查（AG-053 批③）
 *
 * 定时器这一头：每 `sweepMs` 走一步 `core/clarify-timeout.cjs` 的状态机，
 * 把「用户走开太久了」变成两件事 ——
 *   ① **推进那条请求**（按超时结算 → 模型按默认选项继续，任务不会永远挂着）
 *   ② **发一条系统通知**（用户回来得知道「刚才我没在，它替我定了什么」）
 *
 * ── 三条设计 ──
 *   ① **不 require electron**：`powerMonitor` 由 `main.cjs` 注入（照
 *      `handlers/notify.cjs` 注入 `Notification` 的写法）。所以自检能用假空闲值
 *      把这条链路整跑一遍（`createWatcher`），不必开窗口。
 *   ② **读不到空闲值就按「在场」**：状态机那边已经这么定了（宁可永远不超时，
 *      也不要在他在场时替他做决定），这里只负责把 powerMonitor 包成不会抛的函数。
 *   ③ **只推一次**：状态机在到点时会把那张卡从表里摘掉，所以同一张卡不可能
 *      连推两次；这是「通知不重复」的实现位置（自检 102 组钉它）。
 *
 * ⚠️ 模块级单例只给生产用（`start()` 之后 `chat-confirm.cjs` 能 `arm()`）；
 *   自检要的是 `createWatcher()` 那个工厂 —— 一份代码两条路，别让它长出第二份逻辑。
 */

const clarifyTimeout = require('../core/clarify-timeout.cjs')
const log = require('../core/log.cjs')

const DEFAULT_SWEEP_MS = 5000

/**
 * 造一个巡查器（不启定时器）。
 *
 * @param {{ now?: () => number, idleSeconds?: () => number,
 *           readLimits?: () => { clarifyIdleSeconds?: number, clarifyTimeoutMs?: number,
 *                                  clarifyMaxWaitMs?: number },
 *           onTimeout?: (event: { id: string, sessionId: string, taskId: string, questions: unknown[],
 *                                 taskTitle?: string }) => void,
 *           onMuted?: (event: { taskId: string, sessionId: string }) => void }} [deps]
 * @returns {{ arm: Function, resolve: Function, sweep: Function, pending: Function, tracker: object }}
 *
 * ⚠️ `readLimits()` 返回的是 **`core/clarify-config.cjs` 那个形状**（键名带 `clarify` 前缀）。
 *   别在调用方再翻译一层：批③ 真机跑第一遍就是死在这里 —— 调用方给的是
 *   `{ idleSeconds, timeoutMs, maxWaitMs }`，这里读的是 `clarifyXxx`，对不上 →
 *   `undefined` → **静默退回默认 10 分钟**，现象是「巡查起了、日志也有，就是不超时」。
 *   一种形状、一处定义，测试也直接拿 `clarify-config.normalize()` 的输出当输入（自检 102）。
 */
function createWatcher(deps = {}) {
  const readLimitsRaw = typeof deps.readLimits === 'function' ? deps.readLimits : () => ({})
  /*
   * 读配置失败 → 用默认值。
   * 这不只是防御：自检沙箱里注册 handler 时给的 config 是个**没有 get() 的假对象**
   * （真机上是 core/config.cjs），而巡查是每 5 秒自己跑一次的定时器 ——
   * 一次没接住的异常就是整个主进程挂掉（实测：自检跑到一半整个进程没了）。
   */
  const readLimits = () => {
    try {
      return readLimitsRaw() ?? {}
    } catch {
      return {}
    }
  }
  const idleSeconds = typeof deps.idleSeconds === 'function' ? deps.idleSeconds : () => 0
  /** cardId → { questions, taskTitle }（只留结算时要用的东西） */
  const cards = new Map()

  const tracker = clarifyTimeout.createTracker({
    /* 自检注入假时钟用（生产不传） */
    now: deps.now,
    idleSeconds,
    /* 上限传函数：设置里改完，下一跳生效（不用重启应用） */
    idleThresholdSec: () => readLimits().clarifyIdleSeconds,
    timeoutMs: () => readLimits().clarifyTimeoutMs,
    maxWaitMs: () => readLimits().clarifyMaxWaitMs,
  })

  /**
   * 挂一张卡（`chat-confirm.askClarify` 把请求发出去之后立刻调）。
   *
   * @param {{ id: string, sessionId?: string, taskId?: string, questions?: unknown[],
   *           taskTitle?: string, onSettle?: (event: object) => void }} card
   *          `onSettle` = 判到离场时**把那条请求推进去**（一般就是 `settleAsTimeout`）。
   *          没有它的话，巡查只是发个通知，任务照样要等到 5 分钟的兜底定时器。
   * @returns {{ ok: boolean, muted?: boolean }}
   */
  function arm(card = {}) {
    const id = String(card.id ?? '')
    if (!id) return { ok: false }
    cards.set(id, {
      questions: card.questions ?? [],
      taskTitle: card.taskTitle ?? '',
      saidAway: false,
      onSettle: typeof card.onSettle === 'function' ? card.onSettle : null,
    })
    const armed = tracker.arm({ id, sessionId: card.sessionId, taskId: card.taskId })
    return { ok: true, muted: armed?.muted === true }
  }

  /** 卡结束了（用户答了 / 跳过了 / 被撤了）—— 别再计时 */
  function resolve(id) {
    cards.delete(String(id ?? ''))
    return tracker.resolve(id)
  }

  /** 走一步：到点的卡按超时推进 + 报通知 */
  function sweep() {
    const events = tracker.sweep()
    /*
     * 只记两行（每张卡各一次），不刷屏：
     *   · 第一次发现他离场 —— 「任务为什么挂着」从这里看得见
     *   · 到点 —— 后面那行（含采纳了什么）在上层 onTimeout 里
     * 别改成「每跳一行」：5 秒一跳会把主日志刷满。
     */
    for (const entry of cards.values()) {
      if (entry.saidAway || !tracker.away()) continue
      entry.saidAway = true
      log.info(
        `用户离场了，澄清卡开始计时（离场上限 ${Math.round((tracker.limits.timeoutMs() || 0) / 1000)} 秒后按默认选项继续）`,
      )    }
    for (const event of events) {
      const card = cards.get(event.id) ?? {}
      if (event.type === 'timeout') {
        cards.delete(event.id)
        try {
          deps.onTimeout?.({ ...event, questions: card.questions ?? [], taskTitle: card.taskTitle ?? '' })
        } catch (error) {
          /* 通知发不出去不该影响「把任务推进下去」 */
          log.warn(`澄清超时通知失败：${error instanceof Error ? error.message : error}`)
        }
        try {
          card.onSettle?.({ ...event, questions: card.questions ?? [] })
        } catch (error) {
          /* 同理：这一步抛了也得让其他卡继续走 */
          log.warn(`澄清超时结算失败：${error instanceof Error ? error.message : error}`)
        }
        continue
      }
      /* 本任务累计等太久 → 不再弹卡（用户回来只会看到一次总结） */
      try {
        deps.onMuted?.({ ...event })
      } catch {
        /* 忽略 */
      }
    }
    return events
  }

  return {
    arm,
    resolve,
    sweep,
    pending: () => tracker.pending(),
    away: () => tracker.away(),
    /** 这个任务累计离场等待超上限了吗（超了就别再弹卡了，见 chat-confirm 的预检） */
    mutedFor: (taskId) => tracker.muted(taskId),
    tracker,
  }
}

/* ── 生产用的单例 ─────────────────────────────────────────── */

let current = null
let timer = null

/**
 * 起巡查（`main.cjs` → `register-handlers.cjs` 在 app ready 之后调一次）。
 *
 * @param {{ powerMonitor?: { getSystemIdleTime?: () => number }, readLimits?: Function,
 *           onTimeout?: Function, onMuted?: Function, sweepMs?: number }} deps
 */
function start(deps = {}) {
  const monitor = deps.powerMonitor
  /*
   * ★ `HARBOR_IDLE_SECONDS`：**真机验收专用的替身**，生产里没人设它 = 一行都不走。
   *
   * 为什么需要它：真机上「离场」只能靠用户**真的走开**（不动键鼠 ≥ clarifyIdleSeconds），
   * 而验收脚本跑的正是同一台机器 —— 人一碰鼠标，系统的空闲计时就清零、`away()` 变 false，
   * 「累计离场等待」永远到不了上限。2026-10-02 就是这么卡住的：诊断行显示
   * `cards=1 away=false`，看着像应用挂了，其实是**设计如此**（在场不计时）+ 测试的前提错了。
   *
   * 所以：显式给了这个值就用它，否则照旧读 `powerMonitor.getSystemIdleTime()`。
   * 启动日志里会写明用的是哪一个 —— 免得「验收用替身」和「真注入」被看串。
   */
  const fakeIdle = Number(process.env.HARBOR_IDLE_SECONDS)
  const useFake = Number.isFinite(fakeIdle) && fakeIdle >= 0
  const idleSeconds = useFake
    ? () => fakeIdle
    : () => {
        try {
          const value = Number(monitor?.getSystemIdleTime?.())
          return Number.isFinite(value) && value >= 0 ? value : 0
        } catch {
          /* 拿不到就按「在场」—— 宁可永远不超时，也不要在他面前替他做决定 */
          return 0
        }
      }
  current = createWatcher({
    now: deps.now,
    idleSeconds,
    readLimits: deps.readLimits,
    onTimeout: deps.onTimeout,
    onMuted: deps.onMuted,
  })
  const sweepMs = Number(deps.sweepMs) > 0 ? Number(deps.sweepMs) : DEFAULT_SWEEP_MS
  clearInterval(timer)
  /* unref：这个定时器不该拖着进程不让退出（关窗口后该退就退） */
  timer = setInterval(() => current?.sweep(), sweepMs)
  timer.unref?.()
  log.info(
    `澄清超时巡查已启动（每 ${sweepMs / 1000} 秒一跳，${
      useFake ? `空闲值＝验收替身 ${fakeIdle} 秒` : '靠 powerMonitor 判离场'
    }）`,
  )
  return { ok: true, sweepMs, limits: current.tracker.limits }
}

/** 现在这个巡查器（没 start 过就是 null —— 自检/无窗口时不该假装在巡查） */
function watcher() {
  return current
}

/** 挂一张卡（转发；没 start 过就什么都不做，让 chat-confirm 自己的定时器兜底） */
function arm(card) {
  return current ? current.arm(card) : { ok: false }
}

/** 卡结束了 */
function resolve(id) {
  return current ? current.resolve(id) : { ok: false }
}

/**
 * 这个任务已经不该再弹卡了吗（累计离场等待超上限）。
 *
 * 批③ 只把这件事记成了日志 —— 标记在了、但没人拦，于是「本任务不再弹卡」是句空话。
 * 批④ 真机验这条时才发现，现在由 `chat-confirm.askClarify` 在问之前预检。
 * 没 start 过（无窗口 / 自检）就是 false。
 */
function mutedFor(taskId) {
  return current ? current.mutedFor(taskId) : false
}

/** 停掉（退出 / 自检收尾用） */
function stop() {
  clearInterval(timer)
  timer = null
  current = null
}

module.exports = { createWatcher, start, arm, resolve, mutedFor, watcher, stop, DEFAULT_SWEEP_MS }
