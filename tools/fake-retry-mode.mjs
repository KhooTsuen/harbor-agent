/**
 * 假上游的 `retry` 模式：**第一次发半截正文后报一个可重试的错，第二次给完整正文**。
 *
 * 从 `tools/fake-upstream.mjs` 拆出来的（那边加了这块就贴 300 行红线；模式一多还会涨，
 * 所以从这一种开始就分开住）。
 *
 * ── 它验的是什么 ────────────────────────────────────────────────
 *
 * 2026-10-21 用户真机报的「同一条回答显示两遍」：上游报可重试的错时，内核会**从头重新
 * 请求整段**（`loop-model.cjs:148-152`），如果渲染层只把新分片往后追加，屏幕上就是
 * 「上次的半截 + 这次的整段」。判据在界面：屏幕上只该有**一份**完整正文。
 *
 * ── 两条造数据的讲究（都是踩出来的）──────────────────────────────
 *
 * ① **半截必须是完整正文的真前缀** —— 这样「半截 + 整段」叠在一起时一眼看得出来。
 * ② **错要在流里报 429，不能直接撕连接**：撕连接那条错消息是 `terminated`，
 *    `error-kinds.cjs` 的分类表里没有它 → 落到 `unknown`（**不可重试**），
 *    第一版就这么写错，界面上只剩半截 + terminated，压根到不了「重试」这一步。
 *    流内 429 走的是 `llm.cjs` 的「上游在流里返回错误（code 429）」→ rate_limit → 可重试。
 */

/** 半截（第一次）：故意断在完整版中间 */
export const RETRY_PARTIAL = '先看一眼界面：过程区现在收成一行入口了'

/** 完整正文（第二次）：以半截为前缀，后面再补一句 */
export const RETRY_FULL = '先看一眼界面：过程区现在收成一行入口了，点开能看到全部过程。'

/** 进程内计数（一次假上游生命周期里累加；`reset()` 供自检用） */
let rounds = 0

export function reset() {
  rounds = 0
}

/**
 * 处理一次 `retry` 模式请求。
 *
 * @param {object} res node 的 ServerResponse
 * @param {(delta: object) => string} sseChunk 把增量包成 SSE 帧（由 fake-upstream 提供，
 *        保持只有一处 SSE 编码）
 * @param {string} prefix 日志前缀
 */
export function handleRetryMode(res, sseChunk, prefix = '[fake-upstream]') {
  rounds += 1
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  if (rounds === 1) {
    res.write(sseChunk({ content: RETRY_PARTIAL }))
    res.write(
      `data: ${JSON.stringify({ error: { message: 'rate limit exceeded', code: 429 } })}\n\n`,
    )
    console.log(`${prefix} retry 第 1 次：发半截（${RETRY_PARTIAL.length} 字）后报 429`)
    res.end()
    return
  }

  console.log(`${prefix} retry 第 ${rounds} 次：完整正文`)
  res.write(sseChunk({ content: RETRY_FULL }))
  res.write('data: [DONE]\n\n')
  res.end()
}
