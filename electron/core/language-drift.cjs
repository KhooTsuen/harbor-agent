/**
 * 「上一轮工具返回是不是主要是英文」与「这段文本中文占比多少」—— **纯函数**（只做字符统计，不解析语义）
 *
 * 为什么要有它（CE-015 · 防语言漂移 / CE-016 · 收尾观察）：
 *   CE-014 已经在稳定区要求「内部思考用中文」。但模型读到**英文工具结果**
 *   （报错、网页、英文文档）时，思考语言容易跟着漂回英文。这个模块给 `loop.cjs`
 *   一个信号：上一批工具返回主要是英文 → 下一轮补一句「注意保持中文思考」。
 *   CE-016 又用 `chineseRatio` 在**收尾**时看一眼推理语言有没有整体跑偏（只记 warning）。
 *   **不解析语义**，只数英文字母 / 中文字符的占比 —— 两处共用同一个 `charStats`。
 *
 * 三条自我约束：
 *   · **纯函数**：不联网、不调 LLM、可单测、零延迟；
 *   · **保守优先**：宁可漏判（不提醒）也不要每轮都提醒（撑长上下文、制造噪音）；
 *   · 只看**上一批工具返回的最后一条非空输出**，不追溯更早的历史。
 *
 * ⚠️ 注入位置：调用方（`loop.cjs`）把它作为一条 `user` 消息推给模型 ——
 *   它**不进系统提示的稳定前缀**（稳定区变了会打掉前缀缓存）。
 */

/** 英文字母占比高于它 → 倾向「英文」 */
const LATIN_RATIO = 0.6
/** 中文字符占比低于它才算「几乎没中文」 */
const CJK_RATIO = 0.1

const LATIN_RE = /[A-Za-z]/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** 命中时给模型看的那一句（极短，一行） */
const REMINDER = '（上一轮工具返回了英文内容，注意保持中文思考。）'

/**
 * 字符统计（**唯一实现**：isMostlyEnglish 与 chineseRatio 共用它，别再各数一遍）。
 * 分母是**总字符数**（含空格 / 标点 / 数字）。
 * 空串 / 非字符串 → null（「统计不出来」和「统计出来是 0」是两回事，调用方要能分清）。
 *
 * @param {unknown} text
 * @returns {{ total: number, latin: number, cjk: number }|null}
 */
function charStats(text) {
  if (typeof text !== 'string') return null
  const total = [...text].length
  if (total === 0) return null
  return {
    total,
    latin: (text.match(LATIN_RE) ?? []).length,
    cjk: (text.match(CJK_RE) ?? []).length,
  }
}

/**
 * 这段文本是不是「主要是英文」。
 * 判据（两条都要满足）：英文字母占比 > 60% **且** 中文字符占比 < 10%。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function isMostlyEnglish(text) {
  const s = charStats(text)
  if (!s) return false
  return s.latin / s.total > LATIN_RATIO && s.cjk / s.total < CJK_RATIO
}

/**
 * 中文字符占比 = 中文字符数 / 总字符数（CE-016 收尾观察项用）。
 * 与 isMostlyEnglish 同一套口径（同一个 `charStats`），不另写一份数法。
 * 统计不出来（空串 / 非字符串）→ **null**（调用方据此跳过检查，而不是当成 0）。
 *
 * @param {unknown} text
 * @returns {number|null}
 */
function chineseRatio(text) {
  const s = charStats(text)
  if (!s) return null
  return s.cjk / s.total
}

/**
 * 要不要在**这一轮**提醒。
 *
 * @param {Array<{output?: unknown}>} runs 工具运行台账（`toolRuns`）—— 只看**最后一条非空输出**
 * @param {boolean} seen 这条「英文流」里是否已经提醒过
 * @returns {{ seen: boolean, text: string }} 新的 `seen` 与要推的文本（空串＝不推）
 */
function decide(runs, seen) {
  const last = [...(runs ?? [])].reverse().find((r) => String(r?.output ?? '').trim())
  const english = last ? isMostlyEnglish(last.output) : false
  if (!english) return { seen: false, text: '' }
  if (seen) return { seen: true, text: '' }
  return { seen: true, text: REMINDER }
}

module.exports = { isMostlyEnglish, chineseRatio, charStats, decide, REMINDER, LATIN_RATIO, CJK_RATIO }
