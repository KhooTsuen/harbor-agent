/**
 * 自检 / 上下文压缩：**分块（map-reduce）** —— 修「压缩请求本身超限」
 *
 * ── 用户报的原话（2026-10-20）────────────────────────────────
 *
 *   手动压缩一条会话，上游回 400：
 *   maximum context length is 1048576 tokens, however you requested 1506437
 *   (1505237 in the messages, 1200 in the completion)
 *
 * ── 这一组钉什么 ──────────────────────────────────────────────
 *
 *   ① **动机**：老实现把整段历史一次发出去 → 必定超限（这里真跑一遍复现它）
 *   ② **修法**：给了窗口就必须分块，且**每次请求都远低于窗口**
 *   ③ **费用刹车**：块数与调用次数有硬上限（用户拍板 24 块 + 1 合并）
 *   ④ **兼容**：不传窗口的老调用方仍走单次路径
 *   ⑤ **接线**：handler 真的把模型窗口算出来传下去了（少了它等于没修）
 *   ⑥ **口径唯一**：token 估算系数只有一份（不在这两个文件里各写一遍）
 */

import { join, require, ROOT } from '../env.mjs'
import { check, group } from '../harness.mjs'

const R = (p) => require('node:fs').readFileSync(join(ROOT, p), 'utf8')

/** 造一条 nTokens 量级的 transcript */
function build(nTokens) {
  const perMsg = 3000
  const count = Math.ceil((nTokens * 3) / perMsg)
  const body = '这是一段用于验证分块压缩的正文。'.repeat(Math.ceil(perMsg / 17))
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第${i}条\n${body}` })
  }
  return out
}

export async function run() {
  const compact = require(join(ROOT, 'electron/core/compact.cjs'))
  const chunked = require(join(ROOT, 'electron/core/compact-chunked.cjs'))
  const llm = require(join(ROOT, 'electron/core/llm.cjs'))

  /* 每次调用记账；替掉真上游（自检不联网） */
  const calls = []
  const realChat = llm.chatStream
  llm.chatStream = async (opt) => {
    const chars = opt.messages.reduce((s, m) => s + String(m.content ?? '').length, 0)
    calls.push({ tokens: Math.ceil(chars / 3), maxTokens: opt.maxTokens })
    return { content: '## Goal\n自检摘要\n## Decisions\n无\n' }
  }

  try {
    group('上下文压缩 · 分块（超长会话压得动，且不超窗口）')

    const WINDOW = 1_000_000
    const messages = build(1_500_000)
    const allTokens = messages.reduce((s, m) => s + Math.ceil(m.content.length / 3), 0)

    calls.length = 0
    const summary = await compact.summarize({
      baseUrl: 'mock',
      apiKey: 'mock',
      model: 'deepseek-flash',
      messages,
      maxInputTokens: WINDOW,
    })
    const biggest = Math.max(...calls.map((c) => c.tokens))
    const used = calls.length

    /*
     * ★★★ 这三条就是这次 bug 的回归闸门。
     *   第 2 条最关键：它排除「又把全部历史一次发出去」这个原始缺陷。
     */
    check('★★★ 每次请求都远低于模型窗口', biggest < WINDOW, `最大 ${biggest} < ${WINDOW}`)
    check(
      '★★★ 没有任何一次请求带上全部历史（原始缺陷的回归判据）',
      biggest < allTokens / 2,
      `最大 ${biggest} vs 全部 ≈${allTokens}`,
    )
    check('★★★ 调用次数有硬上限（24 块 + 1 合并 = 25）', used <= chunked.MAX_CHUNKS + 1, `${used} 次`)
    check('★★ 真的产出了摘要', typeof summary === 'string' && summary.length > 0, `${String(summary).length} 字`)
    /*
     * ★ 2026-10-20 改口径：原来是 `=== 1200`。那个值本身就是 bug 的一部分
     *   （推理模型把 1200 全用来思考，正文永远是空）—— 判据钉「写死的旧值」
     *   会把 bug 当成正确行为。现在钉的是**有界**：等于当前预算常量，且没无限放开。
     */
    const budget = chunked.SUMMARIZE_MAX_TOKENS
    check(
      '★★ 输出有界（每次 maxTokens 都是当前预算，且没无限放开）',
      calls.every((c) => c.maxTokens === budget) && budget > 1200 && budget <= 16_000,
      `预算 ${budget}`,
    )

    /* 块大小：用户选的「每块约 6 万」 */
    check('★★★ 目标块大小是 6 万 token（用户拍板）', chunked.CHUNK_TOKENS === 60_000, String(chunked.CHUNK_TOKENS))
    check('★★★ 块数硬上限是 24（费用刹车）', chunked.MAX_CHUNKS === 24, String(chunked.MAX_CHUNKS))

    /* 远超 24 块：仍然停在 25 次调用 */
    calls.length = 0
    const huge = build(6_000_000)
    const s2 = await compact.summarize({
      baseUrl: 'mock',
      apiKey: 'mock',
      model: 'deepseek-flash',
      messages: huge,
      maxInputTokens: WINDOW,
    })
    check(
      '★★★ 6 倍超长会话也停在 25 次（不会因为更长就无限烧钱）',
      calls.length <= 25,
      `${calls.length} 次`,
    )
    check('★★ 超长仍然产出摘要（丢了早期也照常给结论）', typeof s2 === 'string' && s2.length > 0)

    /* ★★ 兼容：不传窗口 → 单次路径（老调用方一行都不用改） */
    calls.length = 0
    await compact.summarize({
      baseUrl: 'mock',
      apiKey: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: '短内容' }],
    })
    check('★★ 不给窗口时走单次路径（老调用方不受影响）', calls.length === 1, `${calls.length} 次`)

    /* 窗口小的模型：块要跟着变小，不能还按 6 万切（否则照样超限） */
    calls.length = 0
    await compact.summarize({
      baseUrl: 'mock',
      apiKey: 'mock',
      model: 'tiny',
      messages: build(300_000),
      maxInputTokens: 50_000,
    })
    const biggest2 = Math.max(...calls.map((c) => c.tokens))
    check(
      '★★★ 窗口小的模型：每块跟着缩小，请求仍远低于窗口',
      biggest2 < 50_000 && biggest2 > 0,
      `最大 ${biggest2} < 50000`,
    )

    /* ══════════════════════════════════════════════════════════
       接线与口径
       ══════════════════════════════════════════════════════════ */
    group('上下文压缩 · 接线与口径（少了任一环等于没修）')

    const handlerSrc = R('electron/handlers/compact.cjs')
    check(
      '★★★ handler 把模型窗口算出来传下去了（不传 = 仍是整段发）',
      /*
       * ★ 必须是「**在调用参数里**出现」。第一版写成 /maxInputTokens/ 全文匹配，
       *   结果把传参那行删掉、只留 `const maxInputTokens = …` 也照样绿 ——
       *   反向验证当场转不红，说明它测的是「有没有这个词」，不是「有没有真传」。
       */
      /compact\.summarize\(\{[\s\S]{0,500}?\bmaxInputTokens\b/.test(handlerSrc) && /compact\.windowOf\(/.test(handlerSrc),
    )
    check(
      '★★ handler 用 windowOf 取窗口（不再自己算一份）',
      !/provider-capabilities/.test(handlerSrc),
    )
    check('★★ 传的是**这次真正要用的模型**的窗口', /const model = payload\?\.model \|\| picked\.model/.test(handlerSrc))

    /*
     * ★★★ 2026-10-20 真机逮到：压缩有**两条入口**，第一次只修了手动那条，
     *   自动压缩（loop-model 的 compactMessages）仍在整段发 → 超长会话照样 400。
     */
    const loopSrc = R('electron/core/loop-model.cjs')
    check(
      '★★★ 自动压缩那条入口也传了窗口（只修手动 = 还会 400）',
      /maxInputTokens:\s*compact\.windowOf\(/.test(loopSrc),
    )
    check(
      '★★★ 窗口解析只有一处（compact.windowOf，两条入口共用）',
      /function windowOf\(/.test(R('electron/core/compact.cjs')) && /windowOf,/.test(R('electron/core/compact.cjs')),
    )
    check(
      '★★ windowOf 查不到时返回 0（退回老路径，不把调用弄坏）',
      /return n > 0 \? n : 0/.test(R('electron/core/compact.cjs')),
    )

    const compactSrc = R('electron/core/compact.cjs')
    check('★★★ summarize 接受 maxInputTokens', /maxInputTokens/.test(compactSrc))
    check(
      '★★★ token 估算只有一份（compact.cjs 不再自己写 chars/3）',
      !/Math\.ceil\(String\(text\)\.length \/ 3\)/.test(compactSrc) && /chunked\.estimateTokens/.test(compactSrc),
    )
    check('★★ 发请求也只有一处（单次/分块共用 askModel）', !/llm\.chatStream/.test(compactSrc))

    const chunkSrc = R('electron/core/compact-chunked.cjs')
    check('★★★ 每段摘要失败不毁掉整次压缩（单段 try/catch）', /catch[\s\S]{0,200}return ''/.test(chunkSrc))
    check('★★ 丢早期内容时**如实告知**模型与日志（不装作完整）', /未参与摘要|超上限未摘要/.test(chunkSrc))
    check('★★ 切块优先在消息边界（找不到才硬切）', /lastIndexOf\('\\n\\n【'/.test(chunkSrc))

    /*
     * ══════════════════════════════════════════════════════════════
     * ⑥ 推理模型（2026-10-20 真机逮到**第二个**坑，比 400 更隐蔽）
     *
     * 分块生效后不再 400，但每一段都判「模型没有返回摘要」——
     * `token-metrics.jsonl` 里 `completion=1200 · reasoning=1200`：
     * 输出预算全被思考吃满，`content` 回空串。1200 是写死的，正好卡在这里。
     *
     * 判据必须钉三件事：预算够、空正文有兜底、真空了仍要报错。
     * ══════════════════════════════════════════════════════════════
     */
    group('上下文压缩 · 推理模型把输出预算吃满时不能整次白跑')

    check('★★★ 输出预算不再写死 1200（推理模型要留出写正文的空间）', /SUMMARIZE_MAX_TOKENS\s*=\s*4000/.test(chunkSrc))
    check('★★★ 预算不是 1200（回归闸门：那个值让 content 恒空）', !/maxTokens:\s*1200/.test(chunkSrc))

    /* 改成「只回思考、不回正文」的假上游 */
    llm.chatStream = async () => ({ content: '', reasoning: '思考'.repeat(2000) })
    /*
     * ★ 包 try/catch：没有兜底时这里会直接抛，整个自检就**崩**了 ——
     *   崩溃在 CI 里虽然也是红，但指不出是哪条判据坏了。让它自己报 ❌ 更清楚。
     */
    let fallback = ''
    let fallbackErr = ''
    try {
      fallback = await chunked.askModel({}, 'sys', [{ role: 'user', content: 'x' }])
    } catch (error) {
      fallbackErr = String((error && error.message) || error)
    }
    check('★★★ content 空但 reasoning 有 → 拿思考兜底（不整段失败）', fallback.length > 0, fallbackErr || `长度 ${fallback.length}`)
    check('★★★ 兜底内容如实标注「不是结构化摘要」', fallback.includes('未形成结构化摘要'))
    check(
      '★★★ 兜底被截断（24 段 × 上万字会把 merge 撑爆）',
      fallback.length <= chunked.REASONING_FALLBACK_CHARS + 80,
      `${fallback.length} ≤ ${chunked.REASONING_FALLBACK_CHARS}+标注`,
    )

    /* 连思考都没有 → 必须抛，不许返回空串冒充摘要 */
    llm.chatStream = async () => ({ content: '', reasoning: '' })
    let emptyErr = ''
    try {
      await chunked.askModel({}, 'sys', [{ role: 'user', content: 'x' }])
    } catch (error) {
      emptyErr = String((error && error.message) || error)
    }
    check('★★★ 正文和思考都空 → 仍然报错（不拿空串冒充摘要）', emptyErr.includes('没有返回摘要'), emptyErr)

    /* 预算可被调用方覆盖，不是又写死一处 */
    const seen = []
    llm.chatStream = async (opt) => {
      seen.push(opt.maxTokens)
      return { content: 'ok', reasoning: '' }
    }
    await chunked.askModel({ maxTokens: 8000 }, 'sys', [{ role: 'user', content: 'x' }])
    check('★★ 调用方能覆盖输出预算（不被写死）', seen[0] === 8000, `实际 ${seen[0]}`)
  } finally {
    llm.chatStream = realChat
  }
}
