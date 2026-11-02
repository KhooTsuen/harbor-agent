/**
 * 经验的**注入**：每轮提示里那一段 · 本轮刚失败时那一句
 *
 * 从 `experience-loop.cjs` 拆出来（那边贴 300 行红线）。拆的边界很清楚：
 * **观察**（知道发生了什么、要不要记账）留在 loop，**注入**（要不要说给模型听）在这里。
 *
 * 两条铁律写在最前面，改代码前先读：
 *
 *   ① **只注入 verified**（`match.pick` 里只查 `STATUS.VERIFIED`）。
 *      candidate 一个都不进 —— 这就是「失败不会直接变成规则」。
 *   ② **没有命中就返回空串**，不注入空标题；总条数与总字数都有上限
 *      （`INJECT_LIMIT` / `INJECT_MAX_CHARS`，每轮都要付这个 token）。
 */

const store = require('./experience-store.cjs')
const match = require('./experience-match.cjs')

/** 一条经验的注入行（做法不明就如实说不明 —— 不许编） */
function lineOf(entry) {
  const item = entry.item ?? entry
  const why = String(item.causeHypothesis ?? '').slice(0, 80)
  const how = String(item.recommendedAction ?? '').slice(0, 100)
  const parts = [`- 【${item.domain || 'other'}】遇到过：${item.triggerText}`]
  if (why) parts.push(`原因：${why}`)
  parts.push(how ? `上次这样做成功了：${how}` : '已验证过能绕开，但具体哪一步起的作用没记下来')
  if (entry.reasons?.length) parts.push(`（命中依据：${entry.reasons.join('、')}）`)
  return parts.join(' · ')
}

/**
 * 每轮提示里的那一段。**没有命中就返回空串**（不注入一个空标题）。
 *
 * @param {{ userText?: string, projectId?: string, sessionId?: string }} input
 */
function buildSection({ userText = '', projectId = '', sessionId = '' } = {}) {
  const facts = match.factsOfText(userText)
  const picked = match.pick({ facts, projectId, sessionId })
  if (picked.length === 0) return ''
  try {
    store.touchInjected(picked.map((entry) => entry.item.id))
  } catch {
    /* 记不上不影响这一轮注入 */
  }
  const lines = picked.map((entry) => lineOf(entry))
  return [
    '### 已验证的经验（同类情形这样做成功过，只作建议）',
    ...lines,
    '这些是**系统在真跑里验证过**的做法，不是用户本轮的要求；与用户这次说的冲突时，以用户为准。',
  ].join('\n')
}

/**
 * 本轮刚失败时给模型的那一句。只挑**已验证**的、和这次情形相近的经验。
 *
 * 判据和「反例」故意不同（这两件事混了就会自相矛盾）：
 *   · **反例**（`experience-loop.observeRun`）要求**同一个工具 + 同一个目标**再失败 ——
 *     那是「我按你这条建议做过，还是不行」的硬证据，够格把经验打停。
 *   · **召回**（这里）只要求情形相近（同工具 / 同原因码 / 描述接近），
 *     换个文件、换个页面也算 —— 否则「上次这么绕开的」永远帮不到下一次。
 *   所以这里**不**再做 `sameTarget` 过滤。
 *
 * @param {{ toolName?: string, args?: object|null, failure?: object|null, text?: string,
 *           projectId?: string, sessionId?: string }} input
 */
function noteForFailure({ toolName = '', args = null, failure = null, text = '', projectId = '', sessionId = '' } = {}) {
  const picked = match.pick({
    facts: match.factsOfFailure({ tool: toolName, failure, text, args }),
    projectId,
    sessionId,
    threshold: 0.5,
  })
  if (picked.length === 0) return ''
  try {
    store.touchInjected(picked.map((entry) => entry.item.id))
  } catch {
    /* 同上 */
  }
  return ['[以前遇到过同类情况]', ...picked.map((entry) => lineOf(entry))].join('\n')
}

module.exports = { lineOf, buildSection, noteForFailure }
