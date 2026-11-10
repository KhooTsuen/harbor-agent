/**
 * 会话全文搜索（从 `session-read.cjs` 拆出来的，2026-11-11 第 18 项）
 *
 * ── 为什么要动它 ────────────────────────────────────────────────
 * 原来 `search()` 写成：
 *     for (const item of list()) { const data = load(item.id); ... indexOf ... }
 * 两处都在做无用功，实测（92 MB 的真实会话副本，含一个 71 MB 单会话）：
 *   · `list()` 默认要数消息条数 → 把**每个会话整篇读一遍** = 1143 ms
 *   · `load()` 又把同一个文件**整个读一遍**并组装 messages = 850 ms
 *   · 合起来每次搜索 ≈ 1.2 秒，而侧栏是**每敲一个字搜一次**（没防抖），
 *     搜索又是同步跑在主进程 —— 打字时整个界面卡住。
 *
 * ── 两处省 ──────────────────────────────────────────────────────
 *   ① **不数条数**：搜索根本不需要 `messageCount`，`list({ skipCount: true })`
 *      就跳过那一遍全量读。
 *   ② **按 mtime+size 缓存「可搜文本」**：每个会话只留
 *      `{ ts, role, content }`（搜索要的最小字段），文件没变就不重读。
 *      会话文件是追加式 JSONL —— 一旦有新增，mtime 和 size 都会变，
 *      所以这个失效判据不会漏（不需要更复杂的版本号）。
 *
 * ── 不算什么 ────────────────────────────────────────────────────
 * 没有倒排索引：仍然是一次线性扫描，只是不重复读盘、不组装整篇。真正的
 * 索引留给「会话数上千」的规模再谈；本模块只把「读盘 + 组装」的重复开销去掉。
 *
 * ── 与 product 的一致性 ──────────────────────────────────────────
 * 返回结构与原实现逐字段相同（threadId / title / workdir / timestamp / role /
 * snippet），前端与 IPC 不需要任何改动。
 */

const fs = require('node:fs')
const { fileFor } = require('./session-io.cjs')
const { openLineDetailed } = require('./session-crypto.cjs')

/** 文件 → { stamp, rows }；stamp = `mtimeMs:size` */
const textCache = new Map()
/** 缓存条目上限（每个会话只存搜索要的字段，几十 MB 的会话也就几百条文本） */
const MAX_CACHE_ENTRIES = 120

function stampOf(file) {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** 这个会话里可被搜到的那几项（已解密、已只留必要字段） */
function rowsOf(id) {
  const file = fileFor(id)
  const stamp = stampOf(file)
  if (!stamp) return []
  const hit = textCache.get(file)
  if (hit && hit.stamp === stamp) return hit.rows

  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    /* 逐行解密；解不开的行跳过（换 Windows 账户 / 半行损坏时的正常情形） */
    const opened = openLineDetailed(line)
    if (!opened.ok) continue
    let parsed = null
    try {
      parsed = JSON.parse(opened.text)
    } catch {
      continue
    }
    /* 只收 message 行 —— meta / compact / conversation_state 都不参与搜索 */
    if (parsed?.type !== 'message') continue
    rows.push({
      ts: parsed.ts,
      role: parsed.role,
      content: String(parsed.content ?? ''),
    })
  }

  if (textCache.size >= MAX_CACHE_ENTRIES) textCache.clear()
  textCache.set(file, { stamp, rows })
  return rows
}

/**
 * 搜一遍。
 *
 * @param {string} query 搜索词（空串 → 空结果，与原来一致）
 * @param {number} limit 最多几条
 * @param {Array<{id: string, title?: string, workdir?: string, updatedAt?: number}>} items
 *        会话列表（由调用方给 —— 这样本模块不必 require `session-read.cjs`，
 *        避免两个模块互相 require 成环）
 */
function search(query, limit = 50, items = []) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return []

  const hits = []
  for (const item of items) {
    for (const row of rowsOf(item.id)) {
      const content = row.content
      const index = content.toLowerCase().indexOf(q)
      if (index < 0) continue
      hits.push({
        threadId: item.id,
        title: item.title,
        workdir: item.workdir ?? '',
        timestamp: row.ts ?? item.updatedAt,
        role: row.role,
        snippet: content.slice(Math.max(0, index - 80), index + q.length + 160),
      })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** 清掉缓存（测试用；也方便「刷新会话目录」这类场景） */
function clearCache() {
  textCache.clear()
}

module.exports = { search, clearCache }
