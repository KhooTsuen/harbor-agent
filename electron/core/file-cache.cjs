/*
 * AG-019：文件读取缓存（AG-020 时改成基于通用 `cache.cjs`）
 *
 * 目标**不是**「省 IO」—— 本地读一个文件几毫秒，省它没意义。真正要省的是
 * **别把同一份内容反复喂给模型**：一个源文件几千 token，同一轮里读两遍
 * 就白烧一倍；而且模型不知道「这份内容和刚才那份一样」，还会自己怀疑。
 *
 * 通用的那套（TTL / 容量 / 统计 / 失效流程）在 `cache.cjs`，这里只干两件事：
 *   ① 定义**文件特有的失效判据**：mtime
 *   ② 把 entry 上的字段名落到文档 AG-019 要求的样子（`fileModifiedTime` 等）
 *
 * ── 为什么写操作还要额外 invalidate 一次 ──
 *
 * 主判据是 mtime，但 Windows 上文件 last-write-time 的精度不保证到毫秒
 * （AG-016 在环境检查里踩过），「刚写完立刻读」有极小概率 stat 出同一个值，
 * 那时就会拿到**改之前的内容**。这是这条最危险的失败方式（比没缓存严重得多，
 * Agent 会基于一个已经不存在的版本继续改），所以 write_file / edit_file
 * 写完都显式作废。
 */

const fs = require('node:fs')
const { createCache } = require('./cache.cjs')

/** 默认 5 分钟。文件不像网络资源，变的是「内容」而不是「时效」 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** 缓存上限 —— 防长会话里无限涨。条数和字节两道闸都要（见 cache.cjs 的说明） */
const MAX_ENTRIES = 200

/** 总字节预算 8 MB。按条数限最坏能到 200 × 512KB = 100 MB（`MAX_READ_BYTES`） */
const MAX_BYTES = 8 * 1024 * 1024

/** 单条上限 256 KB —— 再大的文件缓存收益小于它挤掉别人位置的成本 */
const MAX_ENTRY_BYTES = 256 * 1024

/** 文件当前的 mtime；拿不到（文件没了/读不了）返回 null */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** 失效判据：文件没了 → gone；内容变了 → changed */
function validateFile(file, entry) {
  const mtime = mtimeOf(file)
  if (mtime === null) return 'gone'
  if (mtime !== entry.fileModifiedTime) return 'changed'
  return true
}

const inner = createCache({
  name: 'file',
  max: MAX_ENTRIES,
  maxBytes: MAX_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  defaultTtl: DEFAULT_TTL_MS,
  validate: validateFile,
})

/** 取缓存；命中时把 `value` 也叫作 `content`（调用方一直是这么用的） */
function get(file) {
  const result = inner.get(file)
  return result.hit ? { ...result, content: result.value } : result
}

/**
 * 存缓存。`mtimeMs` 不传就现取一次。
 *
 * 文件太大（超过单条上限）时 `inner.put` 返回 `null` —— 这里如实传出去，
 * 调用方不用管（不缓存就是了，读还是读过了）。
 */
function put(file, { content, source = 'unknown', mtimeMs = null, ttl = DEFAULT_TTL_MS } = {}) {
  const mtime = mtimeMs ?? mtimeOf(file)
  if (mtime === null) return null
  const entry = inner.put(file, String(content ?? ''), {
    source,
    ttl,
    fileModifiedTime: mtime,
  })
  if (!entry) return null
  /* 和 get 一样，把 `value` 也叫作 `content`（调用方一直是这么用的） */
  return { ...entry, content: entry.value }
}

function invalidate(file) {
  return inner.invalidate(file)
}

function clear() {
  inner.clear()
}

function stats() {
  return inner.stats()
}

module.exports = {
  get,
  put,
  invalidate,
  clear,
  stats,
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
  MAX_BYTES,
  MAX_ENTRY_BYTES,
}
