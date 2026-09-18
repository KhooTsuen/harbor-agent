/*
 * AG-019：文件读取缓存
 *
 * 目标**不是**「省 IO」—— 本地读一个文件几毫秒，省它没意义。真正要省的是
 * **别把同一份内容反复喂给模型**：一个源文件几千 token，同一轮里读两遍
 * 就白烧一倍；而且模型不知道「这份内容和刚才那份一样」，还会自己怀疑。
 *
 * 文档点名要记的字段，都在 entry 上：
 *
 *   createdAt         第一次读进来的时候
 *   updatedAt         最后一次命中/更新的时间
 *   ttl               过期时长
 *   source            谁读的（工具名，便于诊断「这缓存是谁留下的」）
 *   validity          现在还有效吗（命中时会重算）
 *   fileModifiedTime  文件自己的 mtime —— **主要失效判据**
 *
 * ── 失效靠什么 ──
 *
 * 主判据是 `fileModifiedTime`：读的时候把 mtime 记下来，命中时再 stat 一次比对，
 * 不一样就当没缓存。
 *
 * 但**写操作还要额外调一次 `invalidate`** —— 因为 Windows 上文件的
 * last-write-time 精度有时到不了毫秒（AG-016 在环境检查里踩过这个坑），
 * 「刚写完立刻读」有极小概率 stat 出同一个 mtime，那时就会拿到旧内容。
 * 双保险：mtime 比对 + 写后显式失效。
 */

const fs = require('node:fs')

/** 默认 5 分钟。文件不像网络资源，变的是「内容」而不是「时效」 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** 缓存上限 —— 防长会话里无限涨（按插入顺序淘汰最老的） */
const MAX_ENTRIES = 200

/** @type {Map<string, {content: string, createdAt: number, updatedAt: number, ttl: number, source: string, fileModifiedTime: number, hits: number}>} */
const store = new Map()

let hitsCount = 0
let missesCount = 0

/** 文件当前的 mtime；拿不到（文件没了/读不了）返回 null */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/**
 * 取缓存。
 *
 * @param {string} file 绝对路径
 * @returns {{ hit: boolean, content?: string, reason?: string, age?: number, hits?: number }}
 *   `reason` 说明为什么没命中（诊断用）：`miss` / `expired` / `changed` / `gone`
 */
function get(file) {
  const entry = store.get(file)
  if (!entry) {
    missesCount += 1
    return { hit: false, reason: 'miss' }
  }

  /* ① 文件没了 → 缓存作废 */
  const mtime = mtimeOf(file)
  if (mtime === null) {
    store.delete(file)
    missesCount += 1
    return { hit: false, reason: 'gone' }
  }

  /* ② 内容变了 → 缓存作废（这是主判据） */
  if (mtime !== entry.fileModifiedTime) {
    store.delete(file)
    missesCount += 1
    return { hit: false, reason: 'changed' }
  }

  /* ③ 太老了 → 作废（文件没变但隔太久，当作新读一次） */
  const age = Date.now() - entry.updatedAt
  if (age > entry.ttl) {
    store.delete(file)
    missesCount += 1
    return { hit: false, reason: 'expired' }
  }

  entry.updatedAt = Date.now()
  entry.hits += 1
  hitsCount += 1
  return { hit: true, content: entry.content, age, hits: entry.hits }
}

/** 存缓存。`mtimeMs` 不传就现取一次 */
function put(file, { content, source = 'unknown', mtimeMs = null, ttl = DEFAULT_TTL_MS } = {}) {
  const mtime = mtimeMs ?? mtimeOf(file)
  if (mtime === null) return null

  /* 淘汰最老的（Map 保持插入顺序） */
  if (store.size >= MAX_ENTRIES && !store.has(file)) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }

  const now = Date.now()
  const entry = {
    content: String(content ?? ''),
    createdAt: now,
    updatedAt: now,
    ttl,
    source,
    fileModifiedTime: mtime,
    hits: 0,
  }
  store.set(file, entry)
  return entry
}

/**
 * 显式作废（写操作之后调）。
 *
 * 理论上 mtime 变了缓存会自己失效，但 Windows 的 last-write-time 精度不保证
 * —— 「刚写完立刻读」有可能 stat 出同一个值。所以写完主动删一次。
 */
function invalidate(file) {
  return store.delete(file)
}

/** 清空（测试用，也留给「换工作目录」这类场景） */
function clear() {
  store.clear()
  hitsCount = 0
  missesCount = 0
}

/** 看一眼现在的状态（诊断 / 自检用） */
function stats() {
  return { size: store.size, hits: hitsCount, misses: missesCount, max: MAX_ENTRIES }
}

module.exports = { get, put, invalidate, clear, stats, DEFAULT_TTL_MS, MAX_ENTRIES }
