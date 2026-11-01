/**
 * 分块压缩（map-reduce）—— 2026-10-20 修「压缩请求本身超限」
 *
 * ── 用户报的原话 ──────────────────────────────────────────────
 *
 * 手动压缩一条会话，上游回：
 *   400 maximum context length is 1048576 tokens, however you requested
 *   1506437 tokens (1505237 in the messages, 1200 in the completion)
 *
 * ── 根因 ──────────────────────────────────────────────────────
 *
 * `compact.cjs` 的 `summarize()` 把**整段历史**拼成一条 user 消息发出去，
 * 全程没有长度控制。于是「压缩」这个动作**本身**就会超限 ——
 * **越需要压的会话越压不了**。而自动压缩走的是同一个 runCompact，一样必失败。
 *
 * ── 修法 ──────────────────────────────────────────────────────
 *
 * 按窗口切块 → 每块单独摘要（map）→ 各块摘要合并成一份（reduce）。
 * 块大小与块数**都有上界** → 调用次数有硬上限（最多 24 + 1 = 25 次），
 * 不会因为会话更长就无限烧钱。用户 2026-10-20 拍板的就是这个边界。
 *
 * ── 为什么单列一个文件 ────────────────────────────────────────
 *
 * `compact.cjs` 加满就破 300 行红线（那份文件还要管 rebuild / shouldCompact）。
 * 这里只管**怎么切、怎么迭代**，与「什么时候压」无关 —— 职责本来就分得开。
 */

const llm = require('./llm.cjs')
const log = require('./log.cjs')

/** 目标块大小（token）：用户选的「每块约 6 万，摘要质量最好」 */
const CHUNK_TOKENS = 60_000

/** 块数硬上限（费用刹车）：最多这么多次 map，再 +1 次 reduce = 25 次调用 */
const MAX_CHUNKS = 24

/** 每块最多占窗口的比例（剩下的留给提示词与输出） */
const WINDOW_SHARE = 0.7

/** 估算系数（与 `compact.cjs` 同一套：chars / 3，偏保守） */
function estimateTokens(text) {
  return Math.ceil(String(text).length / 3)
}

/**
 * 一段的摘要提示词：明确「只处理这一段」，避免模型以为要看全局而编造背景。
 */
const CHUNK_SYSTEM = `你正在分段压缩一段较长的编程对话，这次**只处理其中一段**。
按下面结构写这一段的摘要，没有的栏写「无」，绝不编造没出现过的东西：
## Goal
## Decisions
## Constraints
## Files Changed
## Tests
## Unresolved Problems
要求：简体中文、条目式、控制在 400 字以内；不要写「用户说/助手说」，直接写结论。`

/** 合并提示词：把各段摘要揉成一份，**保留所有决定与改过的文件** */
const MERGE_SYSTEM = `下面是一段长对话被分成若干段后各自的摘要，请把它们**合并成一份**完整摘要。
仍按下面结构输出，没有的栏写「无」，绝不编造：
## Goal
## Decisions
## Constraints
## Files Changed
## Tests
## Unresolved Problems
## Next Step
要求：简体中文、条目式、400 字以内；去掉重复，但**保留所有做过的决定和改过的文件**。`

/**
 * 摘要请求的输出预算（token）。
 *
 * ★ 2026-10-20 真机逮到（第二个坑）：原来写死 **1200**，而 `deepseek-flash` 是
 *   **推理模型** —— 1200 全被 reasoning 吃满（`token-metrics.jsonl` 里
 *   `completion=1200 · reasoning=1200`），`content` 回空串，于是每一段都判
 *   「模型没有返回摘要」，整次压缩一串失败。
 *   预算必须给「思考 + 400 字摘要」都留出空间；仍按 token 计费，不无限放开。
 */
const SUMMARIZE_MAX_TOKENS = 4000

/** reasoning 兜底时的最大长度（字符）：思考过程可能上万字，不能整段塞进 merge */
const REASONING_FALLBACK_CHARS = 1500

/**
 * 发一次摘要请求。单次路径 / map / reduce **共用这一处** ——
 * 三份各写一遍必然漂（参数、maxTokens、错误处理都会各走各的）。
 *
 * @returns {Promise<string>} 摘要正文（空则抛错）
 */
async function askModel(options, system, messages) {
  const budget = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : SUMMARIZE_MAX_TOKENS
  const result = await llm.chatStream({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    chatPath: options.chatPath,
    model: options.model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.3,
    maxTokens: budget,
    signal: options.signal,
  })
  const text = String(result?.content ?? '').trim()
  if (text) return text
  /*
   * content 空但 reasoning 非空 —— 推理模型把预算花在思考上、没来得及写正文。
   * 拿思考当兜底**并如实标注**：质量会比正常摘要差，但比整次压缩白跑好得多。
   * 故意截断：24 段 × 上万字会把 merge 那一次撑爆（那正是这次要修的病）。
   */
  const thought = String(result?.reasoning ?? '').trim()
  if (thought) {
    log.warn(`摘要只回了思考过程（content 空 · reasoning ${thought.length} 字）—— 用思考兜底，质量会差`)
    return `（以下是模型的思考过程，**未形成结构化摘要**，仅供参考）\n${thought.slice(0, REASONING_FALLBACK_CHARS)}`
  }
  throw new Error(`模型没有返回摘要（输出预算 ${budget} token 用完了，可能还在推理）`)
}

/**
 * 按**字符**预算切 transcript（token 估算系数是 chars/3）。
 *
 * 优先在**消息边界**切（`\n\n【`），其次换行，最后硬切 ——
 * 一条几十万字的工具输出没有消息边界可切，只能硬来。
 */
function splitTranscript(transcript, budgetChars) {
  const budget = Math.max(3000, Math.floor(budgetChars))
  const out = []
  let rest = String(transcript)
  while (rest.length > budget) {
    let cut = rest.lastIndexOf('\n\n【', budget)
    if (cut < budget * 0.5) cut = rest.lastIndexOf('\n', budget)
    if (cut < budget * 0.5) cut = budget
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/**
 * 一段的摘要。**单段失败不抛** —— 少一段摘要，好过整次压缩白跑
 * （大会话里常见某一段是超长工具输出，单独失败不该毁掉全部工作）。
 *
 * @returns {Promise<string>} 失败给空串
 */
async function summarizeOneChunk(text, index, total, dropped, options) {
  const note =
    dropped > 0
      ? `（说明：更早的 ${dropped} 段因总量超过上限未参与摘要，这一段开头可能缺上下文，只按你看到的总结。）\n\n`
      : ''
  try {
    return await askModel(options, CHUNK_SYSTEM, [
      { role: 'user', content: `${note}这是第 ${index}/${total} 段，请只总结这一段：\n\n${text}` },
    ])
  } catch (error) {
    log.warn(`第 ${index}/${total} 段摘要失败：${(error && error.message) || error}`)
    return ''
  }
}

/** 把各段摘要合并成一份（reduce） */
async function mergeParts(parts, dropped, options) {
  const body = parts.map((p, i) => `【第 ${i + 1} 段摘要】\n${p}`).join('\n\n')
  const note =
    dropped > 0 ? `（注意：更早的 ${dropped} 段因总量超过上限未参与，摘要可能缺开场背景。）\n\n` : ''
  return askModel(options, MERGE_SYSTEM, [
    { role: 'user', content: `${note}请合并这些分段摘要：\n\n${body}` },
  ])
}

/**
 * 分块摘要一段超长 transcript。
 *
 * @param {object} options 与 `compact.summarize` 同一份（baseUrl / apiKey / model / signal…）
 * @param {string} options.transcript 已经拼好的整段文本
 * @param {number} options.windowTokens 模型窗口（>0；调用方保证）
 * @returns {Promise<string>} 合并后的摘要
 */
async function summarizeChunked(options) {
  const transcript = String(options.transcript ?? '')
  const windowTokens = Number(options.windowTokens) > 0 ? Number(options.windowTokens) : CHUNK_TOKENS
  const total = estimateTokens(transcript)

  /* 每块大小：既受「目标 6 万」约束，也受窗口约束（窗口小的模型必须切更小） */
  const chunkTokens = Math.max(2000, Math.floor(Math.min(CHUNK_TOKENS, windowTokens * WINDOW_SHARE)))

  const chunks = splitTranscript(transcript, chunkTokens * 3)
  let dropped = 0
  let use = chunks
  if (chunks.length > MAX_CHUNKS) {
    /* 只保留**最新**的 MAX_CHUNKS 段，更早的丢弃并如实告知。
       这是硬上限：绝不因为会话更长就多烧调用（用户定的费用边界）。 */
    dropped = chunks.length - MAX_CHUNKS
    use = chunks.slice(-MAX_CHUNKS)
  }

  const parts = []
  for (let i = 0; i < use.length; i += 1) {
    const one = await summarizeOneChunk(use[i], i + 1, use.length, dropped, options)
    if (one) parts.push(one)
  }
  if (parts.length === 0) throw new Error('所有分段都没能生成摘要（模型都没有返回内容）')

  /* 只有一段且没丢东西 → 它本身就是完整摘要，不必再花一次合并 */
  if (parts.length === 1 && dropped === 0) {
    log.info(`生成摘要 ${parts[0].length} 字（${total} token，单段完成）`)
    return parts[0]
  }

  const merged = await mergeParts(parts, dropped, options)
  const tail = dropped > 0 ? `，更早 ${dropped} 段超上限未摘要` : ''
  log.info(`生成摘要 ${merged.length} 字（${total} token，${use.length} 段${tail}）`)
  return merged
}

module.exports = {
  CHUNK_TOKENS,
  MAX_CHUNKS,
  WINDOW_SHARE,
  SUMMARIZE_MAX_TOKENS,
  REASONING_FALLBACK_CHARS,
  estimateTokens,
  splitTranscript,
  askModel,
  summarizeChunked,
}
