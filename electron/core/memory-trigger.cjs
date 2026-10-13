/**
 * 「这句话像是在回忆之前的事吗」—— **纯函数**判断（不调 LLM、不联网）
 *
 * 为什么要有它：
 *   `memory_search` 的触发权原先完全在模型手里 —— 只在用户**明确**问「我之前说过
 *   什么」时才调用。很多时候它本应检索，却选择凭印象回答（记忆里那条其实记着，
 *   它只是没去查）。
 *
 *   这个函数给 `memory-recall` 一个**信号**：这一轮像是在回溯 → 就在 relevantMemory
 *   层尾部补一句「先搜一下确认，别凭印象答」。**不替模型决定**，只是把「要不要查」
 *   这件事从「它得自己想起来」变成「提示里正好写着一句」。
 *
 * 三条自我约束：
 *   · **纯词表 / 纯正则**：绝不调 LLM（不联网、不花钱、可单测、零延迟）；
 *   · **保守优先**：宁可漏判（当成新问题，模型照常答）也不要误判（每轮都注入，
 *     把易变区撑长、还稀释注意力）；
 *   · 只吃**最后一条用户消息**（`loop-prompt.cjs` 传进来的 query），不看整段历史。
 *
 * 命中条件（三条都要满足）：
 *   ① 含一个**回溯词**：之前 / 上次 / 记得 / 说过 / 约定 / 以前 / 早先 / 你还记得；
 *   ② 是「在问 / 在确认」的语气（问号、吗 / 呢 / 是不是 / 有没有 / 记不记得）
 *      **或** 是**短句**（≤ SHORT_LEN 字）—— 短句多半就是在指涉刚才/以前的事；
 *   ③ 整条不超过 MAX_LEN 字（防把一整篇粘贴进来的文档误判成「回忆」）。
 *
 * ⚠️ 注入位置由调用方（`memory-recall.cjs`）决定：**必须落在易变区**
 * （relevantMemory 层）。放进稳定区会打掉提示前缀缓存（见 prompt-stack.cjs 的 ORDER）。
 */

/** 回溯词 —— 用户「往回指」时几乎一定会带一个 */
const RECALL_WORDS = ['之前', '上次', '记得', '说过', '约定', '以前', '早先', '你还记得']

/** 疑问 / 求证语气 */
const QUESTION_RE = /[?？]|吗|呢|是不是|有没有|记不记得|还算不算/

/** 短到什么程度算「在指涉旧事」（不用疑问句也算命中） */
const SHORT_LEN = 20

/** 超过这么长就不是一句「回忆」了（多半是粘贴进来的正文） */
const MAX_LEN = 200

/**
 * 这一轮要不要提示模型「先搜记忆」。
 *
 * @param {unknown} text 最后一条用户消息（非字符串一律判不中）
 * @returns {boolean}
 */
function shouldPromptRecall(text) {
  if (typeof text !== 'string') return false
  const t = text.trim()
  if (!t || t.length > MAX_LEN) return false
  if (!RECALL_WORDS.some((word) => t.includes(word))) return false
  return QUESTION_RE.test(t) || t.length <= SHORT_LEN
}

module.exports = { shouldPromptRecall, RECALL_WORDS, SHORT_LEN, MAX_LEN }
