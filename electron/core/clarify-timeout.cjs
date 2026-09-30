/**
 * 澄清卡的超时（AG-053）—— 「用户离场了才计时」的状态机
 *
 * 为什么需要它：卡片是**阻塞**的（用户不答，任务就一直等）。用户可能出门、
 * 睡着、跑一整天测试 —— 没有超时，任务会永远挂在那儿。
 *
 * 四条机制里这个文件管三条（默认选项在 `clarify.cjs` / 提示词层，通知与留痕在批③）：
 *
 *   ② 离场检测：`idleSeconds()` ≥ 30 秒 → 离场
 *   ③ 两段超时：**在场不计时**（放一小时也不催）；离场后累计 10 分钟 → 采纳默认
 *   ④ 累计上限：同一任务累计离场等待超过 30 分钟 → 本任务不再弹卡（自己拍板 + 总结）
 *
 * ★ 三个刻意的设计：
 *   ① **依赖注入，不 require electron** —— 自检/单测要在没有 Electron 的环境里
 *      把这个状态机跑完（`idleSeconds` / `now` 都从外面给）。真机上由 `main.cjs`
 *      把 `powerMonitor` 传进来（照 `handlers/notify.cjs` 注入 `Notification` 的写法）。
 *   ② **只累加离场时间，不累加总时长** —— 用户盯着屏幕想 20 分钟是新需求在长出来，
 *      不该被超时打断；他走开 10 分钟才是「卡住了」。
 *   ③ **不猜「unknown」** —— 平台说 `unknown`（比如锁屏边界情况）时按**在场**处理：
 *      宁可永远不超时（用户回来自己点），也不要在他在场时替他做决定。
 */

const DEFAULT_IDLE_SECONDS = 30
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000

/**
 * 造一个追踪器。
 *
 * @param {{ now?: () => number, idleSeconds?: () => number, idleThresholdSec?: number,
 *           timeoutMs?: number, maxWaitMs?: number }} [deps]
 */
function createTracker(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const idleSeconds =
    typeof deps.idleSeconds === 'function' ? deps.idleSeconds : () => 0
  const idleThresholdSec = Number(deps.idleThresholdSec) > 0 ? Number(deps.idleThresholdSec) : DEFAULT_IDLE_SECONDS
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxWaitMs = Number(deps.maxWaitMs) > 0 ? Number(deps.maxWaitMs) : DEFAULT_MAX_WAIT_MS

  /** cardId → { taskId, sessionId, armedAt, lastTick, waitedMs } */
  const cards = new Map()
  /** taskId → 已经因离场等掉的时间（累计，跨多张卡） */
  const taskWaited = new Map()
  /** taskId → 静音（累计超上限之后本任务不再弹卡） */
  const taskMuted = new Set()

  /** 现在离场了吗（unknown / 读不到 → 按在场） */
  function away() {
    try {
      const seconds = Number(idleSeconds())
      if (!Number.isFinite(seconds) || seconds < 0) return false
      return seconds >= idleThresholdSec
    } catch {
      return false
    }
  }

  /** 挂一张等待回答的卡（进这个表才开始被计时） */
  function arm({ id, taskId = '', sessionId = '' } = {}) {
    const cardId = String(id ?? '')
    if (!cardId) return null
    const entry = {
      taskId: String(taskId ?? ''),
      sessionId: String(sessionId ?? ''),
      armedAt: now(),
      lastTick: now(),
      waitedMs: 0,
    }
    cards.set(cardId, entry)
    return { ...entry, muted: taskMuted.has(entry.taskId) }
  }

  /** 卡结束了（用户答了 / 跳过了 / 被撤了）→ 把这次等掉的时间记到任务头上 */
  function resolve(id) {
    const cardId = String(id ?? '')
    const entry = cards.get(cardId)
    if (!entry) return { ok: false, waitedMs: 0 }
    cards.delete(cardId)
    if (entry.taskId && entry.waitedMs > 0) {
      const total = (taskWaited.get(entry.taskId) ?? 0) + entry.waitedMs
      taskWaited.set(entry.taskId, total)
    }
    return { ok: true, waitedMs: entry.waitedMs, muted: taskMuted.has(entry.taskId) }
  }

  /**
   * 走一步（主进程每隔几秒调一次）。
   *
   * @returns {Array<{type: 'timeout'|'muted', id: string, taskId: string, sessionId: string, waitedMs: number}>}
   *          `timeout` = 该采纳默认了；`muted` = 这个任务累计等太久，别再弹卡
   */
  function sweep() {
    const events = []
    const at = now()
    const awayNow = away()

    for (const [id, entry] of cards) {
      if (!awayNow) {
        /* 在场：不计时，只把「上次看表」往前推 */
        entry.lastTick = at
        continue
      }
      const delta = Math.max(0, at - entry.lastTick)
      entry.lastTick = at
      entry.waitedMs += delta

      if (entry.waitedMs < timeoutMs) continue

      /* 这张卡到点了：从表里摘掉（避免重复触发），累计记到任务头上 */
      cards.delete(id)
      const total = (taskWaited.get(entry.taskId) ?? 0) + entry.waitedMs
      if (entry.taskId) taskWaited.set(entry.taskId, total)
      events.push({
        type: 'timeout',
        id,
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        waitedMs: entry.waitedMs,
      })

      /* 同一任务累计离场等待超上限 → 本任务不再弹卡（用户回来看一次总结） */
      if (entry.taskId && total >= maxWaitMs && !taskMuted.has(entry.taskId)) {
        taskMuted.add(entry.taskId)
        events.push({
          type: 'muted',
          id,
          taskId: entry.taskId,
          sessionId: entry.sessionId,
          waitedMs: total,
        })
      }
    }

    return events
  }

  return {
    arm,
    resolve,
    sweep,
    away,
    /** 这个任务现在不许再弹卡了吗 */
    muted: (taskId) => taskMuted.has(String(taskId ?? '')),
    /** 现在已经等掉多少（离场累计）—— 排查用 */
    waited: (taskId) => taskWaited.get(String(taskId ?? '')) ?? 0,
    /** 现在还挂着几张卡（自检与「任务卡住了吗」排查用） */
    pending: () => [...cards.entries()].map(([id, entry]) => ({ id, ...entry })),
    limits: { idleThresholdSec, timeoutMs, maxWaitMs },
  }
}

module.exports = {
  DEFAULT_IDLE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_WAIT_MS,
  createTracker,
}
