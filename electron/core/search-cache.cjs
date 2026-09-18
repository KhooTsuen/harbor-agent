/*
 * AG-020：搜索结果缓存
 *
 * 这是 AG-020 六项里**最值得**做的一项：
 *
 *   ① 搜索走网络，一次几百毫秒到几秒
 *   ② 有的 provider **按次收费**（Tavily 这种），重复搜同一个词就是白花钱
 *   ③ 同一个查询短期内结果基本一样
 *
 * ── 失效只有 TTL ──
 *
 * 文件内容能靠 mtime 判断「变没变」，搜索结果**没有这种判据** ——
 * 外部世界随时在变，而我们观察不到。所以只按时间过期，而且给得短一点：
 * **10 分钟**。宁可偶尔重搜一次，也不要拿一小时前的新闻当现在。
 *
 * 键 = provider + 归一化后的查询词 + 要几条。归一化只做轻量处理
 * （去首尾空白、合并连续空格、大小写），**不改词序、不去标点** ——
 * 那已经是另一个查询了。
 */

const { createCache } = require('./cache.cjs')

const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 100

/** 搜索结果是结构化数据，比文件文本小得多；但同样加字节闸（见 cache.cjs） */
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRY_BYTES = 256 * 1024

const inner = createCache({
  name: 'search',
  max: MAX_ENTRIES,
  maxBytes: MAX_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  defaultTtl: DEFAULT_TTL_MS,
})

/** 查询词的归一化：空白 + 大小写。保守处理 —— 动得多就越可能把不同查询混成一个 */
function normalize(query) {
  return String(query ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function keyOf(provider, query, maxResults) {
  return `${provider}::${normalize(query)}::${maxResults}`
}

/**
 * @returns {{ hit: boolean, value?: Array, reason?: string, age?: number }}
 */
function get(provider, query, maxResults) {
  return inner.get(keyOf(provider, query, maxResults))
}

/** 存结果。`source` 记的是 provider 的名字，诊断时看得出「这条是谁留下的」 */
function put(provider, query, maxResults, results, { source = provider } = {}) {
  return inner.put(keyOf(provider, query, maxResults), results, { source })
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
  clear,
  stats,
  normalize,
  DEFAULT_TTL_MS,
  MAX_ENTRIES,
  MAX_BYTES,
  MAX_ENTRY_BYTES,
}
