/**
 * 定时任务：执行器 + 心跳
 *
 * ⚠️ **不 require electron** —— 依赖全部注入（`deps.loop` / `deps.config` /
 *    `deps.emit` / `deps.ensureSession`），所以自检能直接跑它，不联网也能测。
 *
 * 三条底线，改这个文件之前先看清楚：
 *
 *   ① **`confirm` 永远是 `async () => false`。** 没人在场 = 没人能批准。
 *      任何「先返回 true 让它跑通」的改动都是把这个功能变成一把没人看着的钥匙。
 *   ② **同一条不许并发跑。** 上一次还没结束就再触发（心跳抖动、用户手点
 *      「立即运行」），直接返回失败 —— 两条一起改同一个目录是数据损坏级别的。
 *   ③ **异常不许吞。** 抛了就写进台账的 `lastResult`，并把错误返回给调用方；
 *      定时任务失败时用户不在场，台账是唯一的线索。
 *
 * 心跳是**串行**跑到期的条目：同时起好几个 agent 循环会把模型配额一瞬间打爆。
 */

const log = require('./log.cjs')
const { isDue } = require('./schedule-next.cjs')
const { configFor } = require('./schedule-grant.cjs')
/* 默认台账；测试用 deps.store 换掉，别去碰用户真实的 schedules.json */
const store = require('./schedule-store.cjs')

/** 正在跑的 id —— 同一条不许并发 */
const running = new Set()

/** tick 重入保护（上一次还没跑完，这一次直接跳过） */
let ticking = false
let timer = null

/**
 * 这次运行里有操作被拒吗。
 *
 * 工具被拒时返回的是**一段文字**（不是异常），所以只能认字：
 * `用户拒绝了这个操作：…` / `错误：这条命令被拦下了…` /
 * `错误：当前是「只读」权限…被拒绝`。这是启发式，宁可多算一次
 * （`blockedCount` 是给用户看的线索，不是账）。
 */
const BLOCK_MARKS = [/拒绝/, /被拦/, /只读权限/, /已关闭工具调用/]

function blockedOf(result) {
  const runs = Array.isArray(result?.toolRuns) ? result.toolRuns : []
  return runs.some(
    (run) => run?.ok === false && BLOCK_MARKS.some((pattern) => pattern.test(String(run.output ?? ''))),
  )
}

/** 台账里存的一句话结果（单行、掐短 —— 台账是给人扫的，不是日记） */
function brief(content, limit = 160) {
  const text = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 默认的「建一个专属会话」（`session.cjs` 不依赖 Electron，能用） */
function defaultEnsureSession(item) {
  const session = require('./session.cjs')
  const meta = session.create({
    title: `⏰ ${String(item.name ?? '').slice(0, 40)}`,
    mode: 'pair',
    workdir: String(item.workdir ?? ''),
  })
  return meta?.id ?? ''
}

/**
 * 这条任务用哪个会话。
 *
 * 定时任务干的事必须能在侧栏看见 —— 所以每次都跑在同一个专属会话里
 * （第一次跑时建，id 记进台账，之后复用）。`deps.ensureSession` 只负责
 * 「建一个并返回 id」，写回台账在这里做，只有一处。
 */
async function sessionFor(item, deps) {
  if (typeof item.sessionId === 'string' && item.sessionId) return item.sessionId
  try {
    const build = typeof deps.ensureSession === 'function' ? deps.ensureSession : defaultEnsureSession
    const id = await build(item)
    return typeof id === 'string' ? id : ''
  } catch (error) {
    /* 建会话失败不该让任务跑不了 —— 没会话照样能跑，只是侧栏看不到 */
    log.warn(`定时任务建会话失败（还是照跑）：${messageOf(error)}`)
    return ''
  }
}

/**
 * 跑一条定时任务。
 *
 * @param {object} item 台账条目
 * @param {object} deps { loop, config, store?, emit?, ensureSession?, signal? }
 * @returns {Promise<{ ok: boolean, taskId?: string, blocked?: boolean, sessionId?: string, error?: string }>}
 */
async function run(item, deps = {}) {
  const id = String(item?.id ?? '')
  if (!id) return { ok: false, error: '这条定时任务没有 id，跑不了' }
  if (!deps.loop || typeof deps.loop.run !== 'function') {
    return { ok: false, error: '没有可用的 agent 循环' }
  }
  if (!deps.config || typeof deps.config.get !== 'function') {
    return { ok: false, error: '没有可用的配置读取口' }
  }
  if (running.has(id)) return { ok: false, error: '上一次还没跑完' }

  running.add(id)
  const ledger = deps.store ?? store
  const startedAt = Date.now()

  try {
    const sessionId = await sessionFor(item, deps)
    if (sessionId && sessionId !== item.sessionId) ledger.recordRun(id, { sessionId })

    const controller = new AbortController()
    const result = await deps.loop.run({
      history: [{ role: 'user', content: String(item.prompt ?? '') }],
      config: configFor(item.grant, deps.config.get()),
      workdir: String(item.workdir ?? ''),
      sessionId,
      goal: String(item.name ?? ''),
      signal: deps.signal ?? controller.signal,
      emit: typeof deps.emit === 'function' ? deps.emit : () => {},
      /* ★★ 底线：没人在场 = 没有人能批准。这一行不许改成任何返回真值的东西 ★★ */
      confirm: async () => false,
    })

    const blocked = blockedOf(result)
    const patch = {
      lastRunAt: Date.now(),
      lastTaskId: String(result?.taskId ?? ''),
      lastResult: brief(result?.content) || (blocked ? '跑完了，但有操作被拒' : '跑完了'),
      runCount: (Number(item.runCount) || 0) + 1,
      blockedCount: (Number(item.blockedCount) || 0) + (blocked ? 1 : 0),
      sessionId,
    }
    ledger.recordRun(id, patch)

    log.info(`定时任务「${item.name ?? id}」跑完（${Date.now() - startedAt}ms）`)
    return { ok: true, taskId: patch.lastTaskId, blocked, sessionId }
  } catch (error) {
    const message = messageOf(error)
    log.warn(`定时任务「${item.name ?? id}」没跑完：${message}`)
    try {
      ledger.recordRun(id, {
        lastRunAt: Date.now(),
        lastResult: `出错：${brief(message, 120)}`,
        runCount: (Number(item.runCount) || 0) + 1,
      })
    } catch (writeError) {
      log.warn(`定时任务结果写不回台账：${messageOf(writeError)}`)
    }
    return { ok: false, error: message }
  } finally {
    running.delete(id)
  }
}

/**
 * 走一轮心跳：到期的挨个跑（**串行**）。
 *
 * `skipped` = 「到期了但没跑成」（上一次还没跑完 / 跑的时候抛了），
 * 没到期的不算 skipped —— 那只是还没到点。
 *
 * @returns {Promise<{ ran: string[], skipped: string[] }>}
 */
async function tick(deps = {}, now = Date.now()) {
  const ledger = deps.store ?? store
  const ran = []
  const skipped = []
  if (ticking) return { ran, skipped }

  ticking = true
  try {
    for (const listed of ledger.list()) {
      if (!isDue(listed, now)) continue

      /* 串行跑，中间可能过了几十秒：再读一次，确认它没被关掉 / 删掉 */
      const fresh = ledger.get(listed.id) ?? listed
      if (!isDue(fresh, now)) {
        skipped.push(listed.id)
        continue
      }

      const result = await run(fresh, { ...deps, store: ledger })
      if (result.ok) ran.push(listed.id)
      else skipped.push(listed.id)
    }
  } finally {
    ticking = false
  }

  return { ran, skipped }
}

/**
 * 起心跳。
 *
 * `unref()`：定时器不许拖住进程退出（关窗口后应用该退就退）。
 */
function start(deps = {}, { intervalMs = 30_000 } = {}) {
  const every = Math.max(1000, Number(intervalMs) || 30_000)
  stop()
  timer = setInterval(() => {
    void tick(deps).catch((error) => log.warn(`定时任务心跳出错：${messageOf(error)}`))
  }, every)
  timer.unref?.()
  return { ok: true, intervalMs: every }
}

function stop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  return { ok: true }
}

/**
 * 正在跑的 id 列表。
 *
 * 给界面用：要显示「这条正在跑」。这个状态**只在内存里**、不落盘 ——
 * 进程一停，事实就是「没在跑」，写进台账反而会让界面显示一个不存在的运行。
 */
function runningIds() {
  return [...running]
}

module.exports = { run, tick, start, stop, runningIds }
