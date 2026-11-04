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
 * 「这两句话说的是同一件事吗」——**唯一一处判据**。
 *
 * 冲突取代（`findConflicts`）和「整段写回时哪一行被改了字」（`pairEdits`）用的
 * 都必须这一条：以前是两处各自写 `>= 0.7 || >= 0.85`，改一处忘一处的后果是
 * 一边更容易互相取代、一边更容易把两行当成同一行 —— 而且没有任何测试会红。
 *
 * 两个阈值分工：相似（Jaccard）看「整体像不像」，包含度看「短的那句是不是被
 * 长的那句完整盖住」（补全型的修改：喜欢简短回复 → 喜欢简短回复，不要长篇）。
 */
function sameThing(a, b) {
  return similarity(a, b) >= 0.7 || containment(a, b) >= 0.85
}

/**
 * 找出和新记忆冲突的旧条目。
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
      sameThing(item.content, candidate.content),
  )
}

/**
 * 最长公共子序列长度（字符级）。
 *
 * 为什么不用 2-gram / 编辑距离当配对判据 —— 都是实测出来的（分数表见
 * `tmp/p1-pair-lcs.mjs`）：
 *   · 2-gram 在短句上完全失效：「偏好短回答」→「偏好很短的回答」只有 0.20；
 *   · 编辑距离对「共享模板前缀」太宽容：库里那些「自检 207：…」式的条目，
 *     两条内容毫无关系，编辑距离也有 0.50 —— 按它配就会把一条无关的新行
 *     接到旧条目的作用域上（用户新加的那条会莫名看不见）。
 * LCS 同时看「重合了多少」和「多出来多少」，模板前缀那 8 个字撑不起分数。
 */
function lcsLength(a, b) {
  const s = [...a]
  const t = [...b]
  if (s.length === 0 || t.length === 0) return 0
  let prev = new Array(t.length + 1).fill(0)
  for (let i = 1; i <= s.length; i += 1) {
    const curr = [0]
    for (let j = 1; j <= t.length; j += 1) {
      curr[j] = s[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    prev = curr
  }
  return prev[t.length]
}

/** LCS 相似度：`2·LCS / (|a|+|b|)`，1 = 同一串，0 = 一个字都不重合 */
function lcsRatio(a, b) {
  const lenA = [...a].length
  const lenB = [...b].length
  if (lenA === 0 || lenB === 0) return 0
  const longer = Math.max(lenA, lenB)
  /* 长度差三倍以上不可能高相似 —— 先剪掉，省一次 O(n·m) */
  if (Math.min(lenA, lenB) / longer < 0.3) return 0
  return (2 * lcsLength(a, b)) / (lenA + lenB)
}

/**
 * 「这是不是**同一行被改了字**」—— 整段写回时的配对判据（P1，2026-11-05）。
 *
 * 命中两条之一就算：
 *   ① 短的那条是长的**子串** —— 补全 / 截断型改动（「不要用 any」→
 *      「不要用 any 和 @ts-ignore」）。这条无歧义，不看分数。
 *   ② LCS 相似度 ≥ 0.75 —— 改几个字、加个括号、换个词。
 *
 * ⚠ 这是**启发式**，且有两头已知的边界（都实测过）：
 *   · 漏配：句子中间插一长段（「不要派子代理做大任务」→ 补一句「（预算只有
 *     8 轮）」，0.645）。这时退回老口径（停用 + fact/global 新增）——
 *     内容可能因此从 session 变成全局，这是**修复前就有的行为**，没变差。
 *   · 配上的那一行内容可能被整句换掉（用户就是想把这条换成别的说法）。
 *     这时继承原作用域是**用户预期**（他编辑的是这一条），不是串用。
 *
 * 阈值为什么卡 0.75 而不是更高：实测「自检 207：用户偏好短回答」与
 * 「自检 207：这是新加的一行」这类**共享模板前缀的无关两行**是 0.50，
 * 真改字最低的一档（去掉模板前缀后）在 0.80。「用户偏好短回答」→
 * 「用户偏好长回答」是 0.857 —— 那是**该配**的：同一行改了内容，类型仍是
 * preference。0.75 把这两类分开，且不去追那些本来就分不开的极端。
 */
function looksLikeRevision(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  if (!left || !right || left === right) return false
  const shorter = [...left].length <= [...right].length ? left : right
  const longer = shorter === left ? right : left
  if ([...shorter].length >= 4 && longer.includes(shorter)) return true
  return lcsRatio(left, right) >= 0.75
}

/**
 * 整段写回时的「这一行被改了字」配对（P1，2026-11-05）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 *
 * `memory.write(text)` 只有**内容视图**（`read()` 也只输出内容行）—— 用户在一行
 * 里改掉几个字，落到这里就是「消失了一条 + 新出现了一条」，两件事长得一模一样。
 *
 * 不配对、直接把「消失的停用、新出现的按 fact/global 新增」的后果是实测出来的：
 * 一条 `session`/`project` 作用域的记忆，改一个字之后就变成 `fact`/`global` ——
 * **可见范围被悄悄放大了**（该藏的藏不住了，SEC-065），偏好也降级成事实。
 *
 * 配上对之后，`memory.cjs` 就按「原地改内容」处理：id / type / scope /
 * sessionId / projectId 一个字节都不动，只有 content 和 updatedAt 变。
 *
 * ⚠ 配对只影响**能配上**的那些；配不上的仍走老口径。所以这一层只会**减少**
 *   元数据丢失，不会把「原本全局可见的内容」变成受限的（方向不会反过来）。
 *
 * 一对一（贪心按分数高低认领），同一条原条目不会被两行同时认领。
 *
 * @param {Array<{ id: string, content: string }>} removed 文本里消失的现有条目
 * @param {string[]} added 文本里新出现的行
 * @returns {Array<{ item: object, content: string }>} 配上的对（原条目 + 新内容）
 */
function pairEdits(removed, added) {
  /* 组合爆炸的保护：整段替换几百行时不做配对（宁可退回老口径，也不卡住界面） */
  if (removed.length * added.length > 40000) return []

  const candidates = []
  removed.forEach((item, ri) => {
    added.forEach((line, ai) => {
      if (!looksLikeRevision(item.content, line)) return
      const score = lcsRatio(item.content, line) + containment(item.content, line) / 100
      candidates.push({ ri, ai, score })
    })
  })
  candidates.sort(
    (a, b) =>
      /* 分数分不出高下时（典型：库里本来就有两条**内容完全一样**的条目，
         它们与每个新行的分数必然相等）按「位置对应」定 —— 用户是在自己看到的
         那份顺序上改字的，位置比浮点尾数可信。否则可能把原本 project 那条
         配给「全局」那行，内容就从受限变成公开了（实测过这个格子）。 */
      b.score - a.score || Math.abs(a.ri - a.ai) - Math.abs(b.ri - b.ai) || a.ri - b.ri || a.ai - b.ai,
  )

  const usedRemoved = new Set()
  const usedAdded = new Set()
  const pairs = []
  for (const candidate of candidates) {
    if (usedRemoved.has(candidate.ri) || usedAdded.has(candidate.ai)) continue
    usedRemoved.add(candidate.ri)
    usedAdded.add(candidate.ai)
    pairs.push({ item: removed[candidate.ri], content: added[candidate.ai] })
  }
  return pairs
}

module.exports = {
  tokens,
  similarity,
  containment,
  sameThing,
  lcsRatio,
  looksLikeRevision,
  findConflicts,
  pairEdits,
  CONFLICT_TYPES,
}



