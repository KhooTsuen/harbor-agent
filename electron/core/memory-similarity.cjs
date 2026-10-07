/**
 * 记忆：相似度与冲突检测
 *
 * 从 memory-store.cjs 拆出来的（那边过 300 行了）。
 *
 * 中文没有空格，按整句取词的话「用户喜欢简短回复」和
 * 「用户喜欢简短回复，不要长篇」会变成两个完全不同的词、相似度 0 ——
 * 冲突检测永远不会触发。所以中文**按 2-gram 切**（用户 / 户喜 / 喜欢 …），
 * 这是不引分词库的前提下性价比最高的做法。
 */

/* ── 冲突检测 ─────────────────────────────────────────────── */

/**
 * 分词：中英文都粗一点。够用来判断「两句话是不是在说同一件事」。
 *
 * 中文没有空格，按整句取词的话「用户喜欢简短回复」和
 * 「用户喜欢简短回复，不要长篇」会变成两个完全不同的词，相似度 0 ——
 * 冲突检测就永远不会触发。所以中文**按 2-gram 切**（用户 / 户喜 / 喜欢 …），
 * 这是不引分词库的前提下性价比最高的做法。
 */
function tokens(text) {
  const raw = String(text ?? '').toLowerCase()
  const out = new Set()

  for (const word of raw.replace(/[^\w\u4e00-\u9fa5]+/g, ' ').split(' ')) {
    if (word.length > 1) out.add(word)
  }

  for (const run of raw.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }

  return out
}

/** 共有的词数 */
function sharedCount(left, right) {
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared
}

/** Jaccard 相似度（用于「和查询词有多相关」） */
function similarity(a, b) {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 || right.size === 0) return 0
  const shared = sharedCount(left, right)
  return shared / (left.size + right.size - shared)
}

/**
 * 包含度：短的那句有多少被长的那句盖住。
 *
 * 冲突检测要用它而不是 Jaccard —— 新记忆常常是旧记忆的**补全**
 * （「喜欢简短回复」→「喜欢简短回复，不要长篇」），
 * 这时候 Jaccard 只有 0.67 看着「不像」，但包含度是 1.0，明显是同一件事。
 */
function containment(a, b) {
  const left = tokens(a)
  const right = tokens(b)
  const smaller = left.size <= right.size ? left : right
  const larger = smaller === left ? right : left
  if (smaller.size === 0) return 0
  return sharedCount(smaller, larger) / smaller.size
}

/**
 * 参与「取代」判定的类型 —— 只有这些类型里，新旧两条才可能是在说同一件事。
 *
 * 事实（fact）/ 临时（temporary）**不在内**：
 *   · fact 是背景信息（类型权重最低），而且模型经 `remember` 写进来的多是它；
 *     2-gram 相似度分不清「第 0 条」和「第 1 条」（数字被当噪声丢掉），
 *     一旦放进来，一批本来互相独立的事实会互相取代 —— 有现成的自检
 *     `02-skills-memory` 盯着「30 条无关事实要能共存」，放进来当场红。
 *   · temporary 本来就靠 `expiresAt` 自然退场，不靠取代。
 */
const CONFLICT_TYPES = ['preference', 'decision', 'project_rule', 'constraint', 'habit']

/**
 * 找和新记忆冲突的旧条目。
 *
 * **只在「同一类型 + 同一 scope + 高度相似」时才算冲突**。
 * 判得太宽会把不相关的两条互相取代掉，那比不处理更糟。
 *
 * ★ 括号不是摆设：以前这里写成
 *     `(active && 同类型 && 同 scope && similarity >= 0.7) || containment >= 0.85`
 *   —— `||` 的右半边**逃出了**前面三个约束（`&&` 比 `||` 紧），
 *   于是一条「包含度 ≥ 0.85」的新记忆会把**不同类型、不同 scope、甚至已经
 *   退场**的旧记忆标成 superseded（不再注入）。这是靠优先级踩出来的静默丢数据，
 *   现在由自检 `133-memory-conflict-expire` 钉住「跨类型 / 跨范围不许互相取代」。
 */
function findConflicts(items, candidate) {
  if (!CONFLICT_TYPES.includes(candidate.type)) return []
  return items.filter(
    (item) =>
      item.status === 'active' &&
      item.type === candidate.type &&
      item.scope === candidate.scope &&
      /* 相似或包含 —— 两条都不满足才算「不冲突」 */
      (similarity(item.content, candidate.content) >= 0.7 ||
        containment(item.content, candidate.content) >= 0.85),
  )
}

module.exports = { tokens, similarity, containment, findConflicts, CONFLICT_TYPES }
