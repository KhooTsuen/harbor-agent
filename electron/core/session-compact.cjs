/**
 * 会话文件压实（D 案，2026-10-07）
 *
 * ── 来由 ──────────────────────────────────────────────────────
 * 流式回复**分段落盘**（见 `session-read.cjs` 的 `collapseByKey`）：同一个 key 会在
 * 文件里留下好几行快照（追加式 JSONL，没地方原地更新），收尾再追加一条完整的。
 * 读的一侧会把这些行收敛成一条 —— 但**磁盘上那些被收敛掉的旧快照一直躺着**。
 * 实测一条长回复的会话到了 83MB，其中 1385 / 1606 行是 partial。
 *
 * ── 做法 ──────────────────────────────────────────────────────
 * 读的一侧**已经**按 key 收敛，所以压实只是把「读的时候本来就不会用到的行」
 * 从磁盘上删掉 —— **不改任何读出来的结果**。规则与 `collapseByKey` 逐条对齐：
 *   · 某个 key 有**完整**那条 → 只留最后一个完整的（位置取该 key **第一次出现**处，
 *     否则重载后消息顺序会和压实前不一样）；
 *   · 只有快照 → 只留**最后一条**快照；
 *   · 没有 key 的行（meta / compact / conversation_state / 老记录）原样保留。
 *
 * ── 三条自我约束（照 error-retention / data-retention）──────────
 *   1. **只动「解得出 JSON 且带 key 的 message 行」**：解不开的行、meta、压缩点、
 *      conversation_state 一律**原样逐字保留** —— 坏行是 `session-io.writeMetaLine`
 *      特意保下来的东西，压实不能顺手删掉它们；
 *   2. **只在文件超阈值、且比上次尝试又长了一截才真做**：否则「没有可删的快照」的
 *      长会话会被每次追加都拖进一次全文件重写；
 *   3. **原子写**（`writeAtomic`），删了多少写一行日志 —— 删数据这件事不能静默。
 */

const fs = require('node:fs')
const log = require('./log.cjs')
const { fileFor } = require('./session-io.cjs')
const { openLineDetailed } = require('./session-crypto.cjs')
const { writeAtomic } = require('./safe-write.cjs')

/** 超过它才考虑压实（8MB —— 正常会话远到不了） */
const COMPACT_MIN_BYTES = 8 * 1024 * 1024
/** 上次尝试之后至少再长这么多才值得重试 */
const REGROW_BYTES = 4 * 1024 * 1024

/** id → 上次处理后的文件大小（进程内；重启后重来一次也无所谓） */
const lastHandled = new Map()

/** 把一行分类：解不开的一律不碰 */
function classify(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'blank' }
  const opened = openLineDetailed(trimmed)
  if (!opened.ok) return { kind: 'opaque', raw }
  let value
  try {
    value = JSON.parse(opened.text)
  } catch {
    return { kind: 'opaque', raw }
  }
  const key = typeof value?.key === 'string' && value.key ? value.key : ''
  if (value?.type === 'message' && key) {
    return { kind: value.partial === true ? 'partial' : 'final', raw, key }
  }
  return { kind: 'keep', raw }
}

/** 两条同 key 的记录留哪条：有完整那条就它；同类型留后来的（与 collapseByKey 一致） */
function betterOf(current, incoming) {
  if (current.kind === 'final' && incoming.kind === 'partial') return 'current'
  return 'incoming'
}

/**
 * 算出压实后的行。纯函数（不碰磁盘），便于自检直接钉规则。
 * @param {string[]} rawLines 文件的原始行
 * @returns {{ lines: string[], removed: number }} `removed` = 少了几行
 */
function collapseRawLines(rawLines) {
  /* 空行不算内容（文件尾那个换行就是），不计入 removed、也不输出 */
  const items = rawLines.map(classify).filter((item) => item.kind !== 'blank')
  const firstIndex = new Map()
  const winner = new Map()
  items.forEach((item, i) => {
    if (item.kind !== 'partial' && item.kind !== 'final') return
    if (!firstIndex.has(item.key)) firstIndex.set(item.key, i)
    const cur = winner.get(item.key)
    if (cur === undefined) winner.set(item.key, i)
    else if (betterOf(items[cur], item) === 'incoming') winner.set(item.key, i)
  })

  const out = []
  items.forEach((item, i) => {
    if (item.kind === 'partial' || item.kind === 'final') {
      /* 只在**第一次出现的位置**输出保留的那条（否则重载后顺序会变） */
      if (firstIndex.get(item.key) !== i) return
      out.push(items[winner.get(item.key)].raw)
      return
    }
    out.push(item.raw)
  })
  return { lines: out, removed: items.length - out.length }
}

/**
 * 压实一个会话文件。
 *
 * @param {string} id
 * @returns {{ ok: boolean, removed: number, before?: number, after?: number, reason?: string }}
 *   绝不抛（压实失败不该影响对话）
 */
function compact(id) {
  try {
    const file = fileFor(id)
    const raw = fs.readFileSync(file, 'utf8')
    const { lines, removed } = collapseRawLines(raw.split('\n'))
    if (removed <= 0) return { ok: true, removed: 0, reason: '没有可压实的快照' }
    const text = `${lines.join('\n')}\n`
    writeAtomic(file, text)
    const before = Buffer.byteLength(raw, 'utf8')
    const after = Buffer.byteLength(text, 'utf8')
    log.info(
      `压实会话 ${id}：删了 ${removed} 行被收敛的流式快照` +
        `（${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB）`,
    )
    return { ok: true, removed, before, after }
  } catch (error) {
    log.warn(`压实会话失败：${error instanceof Error ? error.message : error}`)
    return { ok: false, removed: 0, reason: String(error) }
  }
}

/**
 * 值不值得做：文件够大、且比上次处理后又长了一截才真做（约束 2）。
 * 调用点在 `session-write.append`（只在**收尾那条**落盘后），所以开销可忽略。
 */
function maybeCompact(id, { minBytes = COMPACT_MIN_BYTES } = {}) {
  try {
    const file = fileFor(id)
    const size = fs.statSync(file).size
    if (size <= minBytes) return { skipped: true, reason: '没到阈值' }
    if (size < (lastHandled.get(id) ?? 0) + REGROW_BYTES) return { skipped: true, reason: '刚看过' }
    const result = compact(id)
    lastHandled.set(id, result.ok ? (result.after ?? size) : size)
    return result
  } catch (error) {
    return { ok: false, removed: 0, reason: String(error) }
  }
}

module.exports = { COMPACT_MIN_BYTES, REGROW_BYTES, collapseRawLines, compact, maybeCompact }
