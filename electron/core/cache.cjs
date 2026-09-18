/*
 * AG-020：通用缓存
 *
 * AG-019 给文件内容写了一套「TTL + 容量 + 失效 + 统计」，现在搜索也要同样一套。
 * 与其复制一遍，不如抽出来 —— 各处真正的差别只有**失效判据**：
 *
 *   文件内容   mtime 变了就失效        （file-cache.cjs）
 *   搜索结果   没有 mtime，纯 TTL      （search-cache.cjs）
 *
 * 所以这里只留一个 `validate(key, entry)` 回调，返回 `true` 算有效、
 * 返回字符串算失效（那串东西就是「为什么失效」，便于诊断）、不传就是纯 TTL。
 *
 * ── 为什么要限「字节」而不只限「条数」──
 *
 * 一开始只有 `max`（条数）。但条数和内存不是一回事：
 * `readTextFile` 的单文件上限是 512 KB，而 `max = 200` 条 ——
 * 最坏情况 **200 × 512 KB = 100 MB** 文本，JS 字符串还是 UTF-16，
 * 实际可能翻到 200 MB。主进程 RSS 之前已经到过 198M。
 *
 * 而且这些缓存**不会主动释放**：只有 TTL 到期且恰好被 `get` 到才会删。
 * 换句话说，堆了一个下午的缓存，可能到进程退出才还回去。
 *
 * 所以现在两道闸：`max`（条数）+ `maxBytes`（总预算），外加
 * `maxEntryBytes`（单条上限 —— 一个 400KB 的大文件**不该**因为「别人都小」
 * 就挤掉几十个小文件的位置）。
 */

/** 默认总预算 8 MB —— 比「200 条」有意义得多 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 默认单条上限 256 KB —— 超过就不缓存（读它本来也贵，缓存收益小于风险） */
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024

/**
 * 估算一条值占多少内存。
 *
 * 字符串按 UTF-16 算（`length * 2`），这是 Node 里字符串的实际占用 ——
 * 按 `length` 算会低报一半。别的类型退化成 JSON 长度，估不准也没关系，
 * 反正这只是一个闸门，不是精确计量。
 */
function defaultSizeOf(value) {
  if (typeof value === 'string') return value.length * 2
  try {
    const text = JSON.stringify(value)
    return text ? text.length * 2 : 0
  } catch {
    return 0
  }
}

/**
 * @param {{ name?: string, max?: number, defaultTtl?: number,
 *           maxBytes?: number, maxEntryBytes?: number,
 *           sizeOf?: (value: unknown) => number,
 *           validate?: (key: string, entry: object) => true | string }} options
 */
function createCache({
  name = 'cache',
  max = 200,
  defaultTtl = 5 * 60 * 1000,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  sizeOf = defaultSizeOf,
  validate = null,
} = {}) {
  /** @type {Map<string, object>} */
  const store = new Map()
  let totalBytes = 0
  let hits = 0
  let misses = 0
  let skipped = 0

  /** 删一条，并把它占的字节还回去 */
  function drop(key) {
    const entry = store.get(key)
    if (!entry) return false
    totalBytes -= entry.size ?? 0
    return store.delete(key)
  }

  /**
   * 淘汰到两条闸之内。
   *
   * `store.size > 1` 是故意的：刚 put 进来的那条**永远留着** ——
   * 否则一条比 `maxBytes` 还大的值会把自己当场淘汰掉（等于白算一遍）。
   * 单条上限已经拦住了绝大部分这种情况，这里是兜底。
   */
  function evict() {
    while ((store.size > max || totalBytes > maxBytes) && store.size > 1) {
      drop(store.keys().next().value)
    }
  }

  /**
   * 取。
   *
   * 返回 `{ hit, value?, reason?, age?, hits?, entry? }` ——
   * `reason` 说明为什么没命中（`miss` / `expired` / 自定义的失效原因），诊断用。
   */
  function get(key) {
    const entry = store.get(key)
    if (!entry) {
      misses += 1
      return { hit: false, reason: 'miss' }
    }

    /* ① 过了 TTL */
    const age = Date.now() - entry.updatedAt
    if (age > entry.ttl) {
      drop(key)
      misses += 1
      return { hit: false, reason: 'expired' }
    }

    /* ② 调用方自己的判据（文件 mtime / 目录 mtime …） */
    if (validate) {
      const verdict = validate(key, entry)
      if (verdict !== true) {
        drop(key)
        misses += 1
        return { hit: false, reason: String(verdict || 'invalid') }
      }
    }

    entry.updatedAt = Date.now()
    entry.hits += 1
    hits += 1
    return { hit: true, value: entry.value, age, hits: entry.hits, entry }
  }

  /**
   * 存。`extra` 会展开到 entry 上（`fileModifiedTime` 这类特有字段走这里）。
   *
   * 单条超过 `maxEntryBytes` → **不缓存**，返回 `null`（要区分「存了但立刻被
   * 淘汰」和「根本不该缓存」，所以不能返回一个可能已经不存在的 entry）。
   */
  function put(key, value, { ttl = defaultTtl, source = 'unknown', ...extra } = {}) {
    const size = sizeOf(value)
    if (size > maxEntryBytes) {
      skipped += 1
      return null
    }

    /* 覆盖同一条时要先把旧的字节扣掉，否则 totalBytes 会一路虚高 */
    if (store.has(key)) drop(key)

    const now = Date.now()
    const entry = {
      value,
      size,
      createdAt: now,
      updatedAt: now,
      ttl,
      source,
      hits: 0,
      ...extra,
    }
    store.set(key, entry)
    totalBytes += size
    evict()
    return entry
  }

  /** 显式作废一条 */
  function invalidate(key) {
    return drop(key)
  }

  function clear() {
    store.clear()
    totalBytes = 0
    hits = 0
    misses = 0
    skipped = 0
  }

  function stats() {
    return {
      name,
      size: store.size,
      bytes: totalBytes,
      hits,
      misses,
      skipped,
      max,
      maxBytes,
      maxEntryBytes,
      ttl: defaultTtl,
    }
  }

  return { get, put, invalidate, clear, stats, name }
}

module.exports = { createCache, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRY_BYTES }
