/**
 * 下载队列：谁是「正在下」、谁在排队、全局限速多少。
 *
 * 台账（`download-store.cjs`）说的是**磁盘上的持久事实**；这里说的是**这一进程
 * 的运行事实**（哪几条 task 分配了连接、各自的 AbortController）。两者分工：
 *   · 状态跃迁（queued→running→done/failed/paused）→ 写台账 + 推事件；
 *   · 进度（received / speedBps）→ 内存里实时算，**限流落盘**（每 2 秒最多一次），
 *     否则一个几十 MB 的文件会触发成百上千次原子写。
 *
 * ── 全局限速 ──
 * 令牌桶（`gate`）。引擎每收到一个 chunk 就 `await gate(bytes)`，在这里按
 * 「限速 × 已用时间」补令牌、不够就睡 —— 所以限的是**所有任务加起来**的速率，
 * 而不是每个任务各自限。`maxKBps = 0` 表示不限（桶里永远够）。
 *
 * 依赖（事件出口）用注入，不 require electron：自检能直接拿假 emit 真跑。
 */

const store = require('./download-store.cjs')
const engine = require('./download-engine.cjs')
const log = require('./log.cjs')

/** 进度落盘节流：两次原子写之间至少隔这么久 */
const PERSIST_MIN_MS = 2000

/** 正在下：id → { controller } */
const running = new Map()
/** 事件出口（主进程注入 send；自检注入假函数） */
let emit = null
/** 启动回落只做一次（见 store.settle 的注释） */
let settled = false

/** 注入事件出口。`emit(event)` 会被推给渲染层（见 handlers/downloads.cjs） */
function attach(options = {}) {
  if (!settled) {
    settled = true
    try {
      const fell = store.settle()
      if (fell > 0) log.info(`${fell} 条下载任务从上次运行回落为「已暂停」`)
    } catch (error) {
      log.warn(`下载状态回落失败：${messageOf(error)}`)
    }
  }
  if (typeof options.emit === 'function') emit = options.emit
}

function notify(event) {
  try {
    if (emit) emit(event)
  } catch {
    /* 推事件失败不该影响下载本身 */
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 正在下的 id 列表（界面据此显示「运行中」，进程一停就空） */
function runningIds() {
  return [...running.keys()]
}

/* ── 全局限速：令牌桶 ─────────────────────────────────────────── */

const bucket = { maxKBps: 0, tokens: 0, last: 0 }

function refill() {
  const now = Date.now()
  const elapsedMs = Math.max(0, now - bucket.last)
  bucket.last = now
  if (bucket.maxKBps <= 0) return
  const rate = bucket.maxKBps * 1024
  bucket.tokens = Math.min(rate, bucket.tokens + (elapsedMs / 1000) * rate)
}

/** 引擎每 chunk 调一次：够令牌就过，不够就睡到够 */
async function gate(bytes) {
  if (bucket.maxKBps <= 0) return
  refill()
  bucket.tokens -= bytes
  if (bucket.tokens >= 0) return
  const waitMs = (-bucket.tokens / (bucket.maxKBps * 1024)) * 1000
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(waitMs))))
  refill()
}

/* ── 调度 ─────────────────────────────────────────────────────── */

/** 有空位就把排队的拉起来。同步返回，真正的活在 startOne 里跑 */
function pump() {
  const limits = store.getLimits()
  bucket.maxKBps = limits.maxKBps
  let slots = limits.maxConcurrent - running.size
  if (slots <= 0) return
  for (const item of store.list()) {
    if (slots <= 0) break
    if (item.status !== 'queued') continue
    if (running.has(item.id)) continue
    slots -= 1
    void startOne(item, limits)
  }
}

async function startOne(item, limits) {
  const controller = new AbortController()
  running.set(item.id, { controller })

  store.patch(item.id, {
    status: 'running',
    error: '',
    attempts: (Number(item.attempts) || 0) + 1,
    /* 记下这一轮实际开了几条连接（不记的话台账里永远是 0，等于撒谎） */
    connections: limits.connections,
    updatedAt: Date.now(),
  })
  notify({ type: 'started', id: item.id, name: item.name })

  let lastBytes = 0
  let lastAt = Date.now()
  let lastPersistAt = 0

  try {
    const result = await engine.downloadFile({
      url: item.url,
      file: item.file,
      connections: limits.connections,
      signal: controller.signal,
      gate: limits.maxKBps > 0 ? gate : undefined,
      onProgress: ({ received, total }) => {
        const now = Date.now()
        const dt = now - lastAt
        const speed = dt > 0 ? Math.max(0, Math.round(((received - lastBytes) / dt) * 1000)) : 0
        if (dt >= 500) {
          lastBytes = received
          lastAt = now
        }
        notify({ type: 'progress', id: item.id, received, total, speedBps: speed })
        if (now - lastPersistAt >= PERSIST_MIN_MS) {
          lastPersistAt = now
          store.patch(item.id, { received, total, speedBps: speed })
        }
      },
    })

    store.patch(item.id, {
      status: 'done',
      received: result.bytes,
      total: result.total,
      speedBps: 0,
      finishedAt: Date.now(),
    })
    notify({ type: 'done', id: item.id, name: item.name, bytes: result.bytes, resumed: result.resumed })
  } catch (error) {
    if (error?.name === 'AbortError') {
      store.patch(item.id, { status: 'paused', speedBps: 0 })
      notify({ type: 'paused', id: item.id, name: item.name })
    } else {
      const message = messageOf(error)
      store.patch(item.id, { status: 'failed', error: message, speedBps: 0 })
      notify({ type: 'failed', id: item.id, name: item.name, error: message })
    }
  } finally {
    running.delete(item.id)
    pump()
  }
}

/* ── 对外动作（handlers 调这几个） ────────────────────────────── */

/** 列表快照：台账 + 内存里的运行态 + 当前限速配置 */
function snapshot() {
  return { items: store.list(), running: runningIds(), limits: store.getLimits() }
}

/** 新建一条并尝试起跑 */
function add(input) {
  const result = store.add(input)
  if (result.ok) {
    log.info(`下载已加入队列：${result.item.name}`)
    notify({ type: 'added', id: result.item.id, name: result.item.name })
    pump()
  }
  return result
}

/** 取消（运行中→掐连接；排队的→直接标暂停） */
function pause(id) {
  const item = store.get(id)
  if (!item) return { ok: false, error: '没有这条下载任务' }
  const live = running.get(id)
  if (live) {
    live.controller.abort()
    return { ok: true }
  }
  if (item.status === 'queued') {
    store.patch(id, { status: 'paused', speedBps: 0 })
    notify({ type: 'paused', id, name: item.name })
  }
  return { ok: true }
}

/** 继续：从断点接着下（.part 还在） */
function resume(id) {
  const item = store.get(id)
  if (!item) return { ok: false, error: '没有这条下载任务' }
  if (item.status === 'done') return { ok: false, error: '这条已经下完了' }
  store.patch(id, { status: 'queued', error: '', speedBps: 0 })
  notify({ type: 'queued', id, name: item.name })
  pump()
  return { ok: true }
}

/** 重试失败的一条：只对 failed 有意义（别的等同于 resume） */
function retry(id) {
  const item = store.get(id)
  if (!item) return { ok: false, error: '没有这条下载任务' }
  store.patch(id, { status: 'queued', error: '', speedBps: 0 })
  notify({ type: 'queued', id, name: item.name })
  pump()
  return { ok: true }
}

/** 删一条：先掐连接，再把临时文件清干净（别在磁盘上留 .part） */
function remove(id) {
  const live = running.get(id)
  if (live) live.controller.abort()
  const item = store.get(id)
  if (item) engine.cleanupParts(item.file)
  const result = store.remove(id)
  if (result.ok) notify({ type: 'removed', id })
  return result
}

function clearFinished() {
  const result = store.clearFinished()
  if (result.ok && result.removed > 0) notify({ type: 'cleared', removed: result.removed })
  return result
}

/** 改限速 / 并发：立刻对正在跑的任务生效（gate 读的是同一个桶） */
function setLimits(patch) {
  const result = store.setLimits(patch)
  if (result.ok) {
    bucket.maxKBps = result.limits.maxKBps
    notify({ type: 'limits', limits: result.limits })
    pump()
  }
  return result
}

module.exports = {
  attach,
  snapshot,
  runningIds,
  add,
  pause,
  resume,
  retry,
  remove,
  clearFinished,
  setLimits,
  pump,
}
