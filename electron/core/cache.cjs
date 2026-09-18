/*
 * AG-020：通用缓存
 *
 * AG-019 给文件内容写了一套「TTL + 容量 + 失效 + 统计」，现在搜索也要同样一套。
 * 与其复制一遍，不如抽出来 —— 各处真正的差别只有**失效判据**：
 *
 *   文件内容   mtime 变了就失效        （file-cache.cjs）
 *   搜索结果   没有 mtime，纯 TTL      （search-cache.cjs）
 *   目录树     目录自己的 mtime 变了就失效
 *
 * 所以这里只留一个 `validate(key, entry)` 回调，返回 `true` 算有效、
 * 返回字符串算失效（那串东西就是「为什么失效」，便于诊断）、不传就是纯 TTL。
 *
 * 文档 AG-020 要求 entry 上能看到的东西（`createdAt` / `updatedAt` / `ttl` /
 * `source`）都在这里；`fileModifiedTime` 这类**各自特有**的字段由调用方通过
 * `...extra` 塞进来（`put` 的第三个参数）。
 */

/**
 * @param {{ name?: string, max?: number, defaultTtl?: number,
 *           validate?: (key: string, entry: object) => true | string }} options
 */
function createCache({
  name = 'cache',
  max = 200,
  defaultTtl = 5 * 60 * 1000,
  validate = null,
} = {}) {
  /** @type {Map<string, object>} */
  const store = new Map()
  let hits = 0
  let misses = 0

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
      store.delete(key)
      misses += 1
      return { hit: false, reason: 'expired' }
    }

    /* ② 调用方自己的判据（文件 mtime / 目录 mtime …） */
    if (validate) {
      const verdict = validate(key, entry)
      if (verdict !== true) {
        store.delete(key)
        misses += 1
        return { hit: false, reason: String(verdict || 'invalid') }
      }
    }

    entry.updatedAt = Date.now()
    entry.hits += 1
    hits += 1
    return { hit: true, value: entry.value, age, hits: entry.hits, entry }
  }

  /** 存。`extra` 会展开到 entry 上（`fileModifiedTime` 这类特有字段走这里） */
  function put(key, value, { ttl = defaultTtl, source = 'unknown', ...extra } = {}) {
    /* 淘汰最老的（Map 保持插入顺序） */
    if (store.size >= max && !store.has(key)) {
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
    const now = Date.now()
    const entry = {
      value,
      createdAt: now,
      updatedAt: now,
      ttl,
      source,
      hits: 0,
      ...extra,
    }
    store.set(key, entry)
    return entry
  }

  /** 显式作废一条 */
  function invalidate(key) {
    return store.delete(key)
  }

  /** 批量作废（写文件之后清掉所有受影响的键） */
  function invalidateWhere(predicate) {
    let removed = 0
    for (const key of [...store.keys()]) {
      if (predicate(key)) {
        store.delete(key)
        removed += 1
      }
    }
    return removed
  }

  function clear() {
    store.clear()
    hits = 0
    misses = 0
  }

  function stats() {
    return { name, size: store.size, hits, misses, max, ttl: defaultTtl }
  }

  return { get, put, invalidate, invalidateWhere, clear, stats, name }
}

module.exports = { createCache }
