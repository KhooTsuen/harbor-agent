/**
 * 经验匹配：**跨领域**的混合打分 + 「为什么命中」
 *
 * ── 为什么不按 `domain + category` 硬过滤（蓝图 §5.2）──
 *
 * 硬过滤的后果不是「筛得干净」，而是**永远学不到跨领域的经验**：
 *   · 网页上「点不到那个按钮」和文件上「改不到那一行」，本质是同一件事
 *     （目标在预期位置找不到 → 先重新确认现场，再换目标），
 *     但它们一个在 `web`、一个在 `file`，硬过滤之后互相看不见。
 *   · 用户说「不对」那条（`user_correction`）压根没有领域 —— 硬过滤会让它永远不命中。
 *
 * 所以：**几个结构字段加权，领域只加权不设门**。分数不够就不注入，
 * 而不是「领域不对就别看」。每一次命中都要能说清理由（`reasons`），
 * 因为用户会问「它凭什么觉得这条相关」。
 *
 * 打分表**只有这一份** —— 注入（`experience-loop`）与设置页解释都读它。
 */
const { tokens, similarity } = require('./memory-similarity.cjs')
const schema = require('./experience-schema.cjs')

/**
 * 各项权重。加起来 = 1，方便读：分数本身就是「像不像同一件事」的百分比。
 *
 * 为什么 `reasonCode` 最重：它是**系统写的事实**（EXIT_CODE / TIMEOUT / TOOL_ERROR…），
 * 不是谁猜的；同一个原因码 + 同一个工具，基本就是同一类坑。
 * 为什么 `text` 不是最高：归一化文本里数字和 id 都被抹平了，长文本容易「假像」。
 */
const WEIGHTS = {
  tool: 0.26,
  reasonCode: 0.24,
  category: 0.14,
  domain: 0.06,
  text: 0.3,
}

/**
 * 两个特征「像不像同一件事」。
 *
 * @param {{ tool?: string, domain?: string, category?: string, reasonCode?: string, text?: string }} a 当前情形
 * @param {object} b 库里那条经验（同名字段 + tokens）
 * @returns {{ score: number, reasons: string[] }}
 */
function score(a, b) {
  const facts = a ?? {}
  const reasons = []
  let total = 0

  if (facts.tool && String(facts.tool) === String(b.tool ?? '')) {
    total += WEIGHTS.tool
    reasons.push('同一工具')
  }
  /*
   * 原因码相同时给满分；**都为空**时不给分 —— 两个「不知道」不算「相同」，
   * 那会把所有原因不明的条目互相拉近（正是「猜」）。
   */
  const code = String(facts.reasonCode ?? '')
  if (code && code === String(b.reasonCode ?? '')) {
    total += WEIGHTS.reasonCode
    reasons.push('同一原因码')
  }
  const category = String(facts.category ?? '')
  if (category && category === String(b.category ?? '')) {
    total += WEIGHTS.category
    reasons.push('同一类别')
  }
  const domain = String(facts.domain ?? '')
  if (domain && domain === String(b.domain ?? '')) {
    total += WEIGHTS.domain
    reasons.push('同一领域')
  }

  /* 文本相似度：复用记忆那套 2-gram 分词（中文没有空格），不在这里再造一份 */
  const text = String(facts.text ?? '')
  const sim = text && b.triggerText ? similarity(text, b.triggerText) : 0
  if (sim > 0.2) {
    total += WEIGHTS.text * Math.min(1, sim)
    reasons.push(`情形描述接近（${Math.round(sim * 100)}%）`)
  }

  /*
   * 「只有一句话」的情形（用户描述症状 / 复述报错）：结构字段一个都没有，
   * 上面那些权重全都加不上 —— 这时**直接用文本相似度当分数**，否则
   * 「按需召回」永远发生不了（0.3 的权重乘什么都不够门槛）。
   * 这不是放宽判据，是承认「只有描述时，描述就是唯一的证据」。
   */
  const structural = Boolean(facts.tool || facts.reasonCode || facts.category)
  if (!structural && sim > 0) {
    total = sim
    reasons.length = 0
    reasons.push(`描述接近（${Math.round(sim * 100)}%）`)
  }

  /* 跨域提示：**另加，不改分** —— 分数决定要不要用，理由只解释「像在哪」 */
  if (domain && b.domain && domain !== b.domain) {
    reasons.push(`跨领域参考（${b.domain} → ${domain}）`)
  }

  /*
   * 一句话高度重合 = 就是同一件事（用户在复述同一个毛病：「又是那个 xxx 报错」）。
   *
   * 为什么单独给一条下限而不是调高 text 权重：结构字段（工具 / 原因码）在
   * 「用户主动描述」这种情形里通常**一个都没有**（他还没让工具跑），
   * 光靠 0.3 的权重永远过不了门槛 —— 于是「按需召回」永远不会发生。
   * 0.5 是 2-gram Jaccard 上「明显同一句话」的界线，宁严不松。
   */
  const TEXT_STRONG = 0.5
  if (sim >= TEXT_STRONG) {
    total = Math.max(total, TEXT_STRONG)
    reasons.push('描述高度重合（像是同一件事）')
  }

  return { score: Math.round(total * 100) / 100, reasons }
}

/**
 * 挑出要注入的经验：**只有 verified**、可见性走 `memory-scope` 那条判据、
 * 分数过门槛、按分数排序、最多 N 条、总字数封顶。
 *
 * @param {{ facts?: object, projectId?: string, sessionId?: string,
 *           limit?: number, threshold?: number }} input
 * @returns {Array<{ item: object, score: number, reasons: string[] }>}
 */
function pick(input = {}) {
  const store = require('./experience-store.cjs')
  const facts = input.facts ?? {}
  const limit = Number.isInteger(input.limit) ? input.limit : schema.INJECT_LIMIT
  const threshold = Number.isFinite(input.threshold) ? input.threshold : schema.MATCH_THRESHOLD

  const pool = store
    .list({
      status: schema.STATUS.VERIFIED,
      projectId: String(input.projectId ?? ''),
      sessionId: String(input.sessionId ?? ''),
    })
    /* 验证器版本变了的旧批准不算（蓝图 §8）—— 这一步不能只在「升级时」判一次；
       人批准（`approval.by==='user'`）不看验证器版本，判据见 schema.injectable */
    .filter((item) => schema.injectable(item))

  const scored = pool
    .map((item) => ({ item, ...score(facts, item) }))
    .filter((entry) => entry.score >= threshold)
    .sort((left, right) => right.score - left.score)

  const picked = []
  let chars = 0
  for (const entry of scored) {
    if (picked.length >= limit) break
    const cost = String(entry.item.triggerText ?? '').length + 80
    if (chars + cost > schema.INJECT_MAX_CHARS) continue
    chars += cost
    picked.push(entry)
  }
  return picked
}

/**
 * 从一次**失败**里造出「当前情形」的特征（注入时用）。
 * 与 `experience-schema.featureOf` 同一个形状 —— 那边建候选，这边找候选，不能各写一套。
 *
 * `args` 必须透传（虽然召回不按 `target` 过滤）：少传它，这里造出来的特征就比
 * 建候选时少一个字段，两边形状一旦分叉，「同一条经验」在写入侧和召回侧就是两件事。
 */
function factsOfFailure({ tool = '', failure = null, text = '', category = '', args = null } = {}) {
  const feature = schema.featureOf({ tool, failure, text, category, args })
  return {
    tool: feature.tool,
    domain: feature.domain,
    category: feature.category,
    reasonCode: feature.reasonCode,
    text: feature.text,
  }
}

/** 从一段**用户输入**造特征（用户纠正 / 日常任务没有失败事实） */
function factsOfText(text) {
  /*
   * 结构字段**全部留空**：用户是用话描述症状的，没有工具名 / 原因码。
   * 留空之后 `score()` 会走「纯文本相似度」那条分支 —— 那才是这种情形唯一
   * 诚实的判据。填一个 `category: 'user_correction'` 进去反而会误导：
   * 它让一条 tool_failure 经验永远拿不到「同类别」那 0.14 分。
   */
  return { tool: '', domain: '', category: '', reasonCode: '', text: schema.normalizeText(text) }
}

module.exports = { WEIGHTS, score, pick, factsOfFailure, factsOfText, tokens }
