import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   流式解析 / 流内错误 / 空闲看门狗

   从 07-llm-body.mjs 拆出来的（那边加完新场景就过了 300 行）。
   分工：07 只管**请求体的构造**（纯函数）；这里管**回来的流** ——
   SSE 解析、流内错误、空流，以及「一个字节都不回来」时的空闲看门狗。

   全部打桩（替换 globalThis.fetch），不联网。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  /* ══════════════════════════════════════════════════════════
     流内错误 —— 这一组是**用户报的故障**补来的

     OpenRouter 会在 HTTP 200 的正常流里发错误：
       data: {"error":{"code":402,"message":"Insufficient credits"}}
     原来的代码走 `if (!delta) continue` 把它静默吃掉了，
     症状是「回答空白、不报任何错」。
     ══════════════════════════════════════════════════════════ */

  group('流内错误 / OpenRouter')

  const llm = require(join(ROOT, 'electron/core/llm.cjs'))
  const originalFetch = globalThis.fetch

  /** 造一个假的 SSE 响应（把若干 data 行当一个流吐出来） */
  function fakeStream(lines) {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`))
          controller.close()
        },
      }),
    }
  }

  try {
    /* ① 正常流仍然能解析（别把好的搞坏了） */
    globalThis.fetch = async () =>
      fakeStream([
        ': OPENROUTER PROCESSING',
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ])
    const ok = await llm.chatStream({ baseUrl: 'https://x/y', model: 'm', messages: [] })
    check('常规流照旧能解析出内容', ok.content === '你', ok.content)
    check('保活注释 `: OPENROUTER PROCESSING` 被忽略（不报错）', true)
    check('硅基流动的 reasoning_content 能读出来', ok.reasoning === '想', ok.reasoning)

    /* ② ★ 流里的错误必须抛出来 */
    globalThis.fetch = async () =>
      fakeStream([
        ': OPENROUTER PROCESSING',
        'data: {"error":{"code":402,"message":"Insufficient credits. Add more using..."}}',
      ])
    let thrown = null
    try {
      await llm.chatStream({ baseUrl: 'https://x/y', model: 'm', messages: [] })
    } catch (error) {
      thrown = error
    }
    check('★ 流内错误会被抛出（以前是静默空白）', thrown !== null)
    check(
      '★ 错误里带上上游原文',
      String(thrown?.message ?? '').includes('Insufficient credits'),
      String(thrown?.message),
    )
    check(
      '★ 错误里带上 code',
      String(thrown?.message ?? '').includes('402'),
      String(thrown?.message),
    )

    /* ③ 收完流什么都没有 → 也要给出说得通的错 */
    globalThis.fetch = async () => fakeStream(['data: [DONE]'])
    let empty = null
    try {
      await llm.chatStream({ baseUrl: 'https://x/y', model: 'm', messages: [] })
    } catch (error) {
      empty = error
    }
    check('★ 上游什么都没返回时也会报错（不是空气泡）', empty !== null)
    check(
      '错误里带上了模型名，方便排查',
      String(empty?.message ?? '').includes('m'),
      String(empty?.message),
    )

    /* ④ 上游 HTTP 错误照旧 */
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limited',
    })
    let httpErr = null
    try {
      await llm.chatStream({ baseUrl: 'https://x/y', model: 'm', messages: [] })
    } catch (error) {
      httpErr = error
    }
    check(
      'HTTP 错误照旧抛出来（含状态码和原文）',
      String(httpErr?.message ?? '').includes('429') &&
        String(httpErr?.message ?? '').includes('rate limited'),
    )

    /* ══════════════════════════════════════════════════════════
       ⑤ 空闲看门狗 —— 上游「挂住」不许无限等
       （2026-09-25 真机验收实测：24 次运行里 3 次撞上挂住，
        每次都烧满外部判超时的 3 分钟；没有这道阀门会永远停在「运行中」）
       ══════════════════════════════════════════════════════════ */
    const errors = require(join(ROOT, 'electron/core/errors.cjs'))
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      /* 吐一块内容之后**不关流**（模拟连接挂住） */
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'),
          )
        },
      }),
    })
    let stalled = null
    const got = []
    const at = Date.now()
    try {
      await llm.chatStream({
        baseUrl: 'https://x/y',
        model: 'm',
        messages: [],
        idleTimeoutMs: 150,
        onContent: (text) => got.push(text),
      })
    } catch (error) {
      stalled = error
    }
    const waited = Date.now() - at
    check('★ 挂住的流会被看门狗掐掉（不是无限等）', stalled !== null)
    check(
      '★ 报成可重试的 timeout（errors.classify 认这个字样，交给重试/降级）',
      stalled instanceof Error && errors.classify(stalled).kind === 'timeout',
      String(stalled?.message),
    )
    check('挂住之前收到的内容没丢', got.join('') === '你', got.join(''))
    check(`看门狗按时动手（等了 ${waited}ms）`, waited < 2000, `${waited}ms`)

    /* ⑥ ★ 响应头都不回来、且底层压根不理 abort ——
         第一版看门狗就是这么在打包版上翻车的：只挂 AbortController，
         45 秒到点什么都没发生（2026-09-25 真机实测）。现在必须靠「赛跑」兜住。 */
    globalThis.fetch = () => new Promise(() => {})
    let never = null
    const at6 = Date.now()
    try {
      await llm.chatStream({ baseUrl: 'https://x/y', model: 'm', messages: [], idleTimeoutMs: 150 })
    } catch (error) {
      never = error
    }
    const waited6 = Date.now() - at6
    check('★ 响应头都不回来也能被掐掉（不依赖底层 abort）', never !== null)
    check(
      '★ 同样报成可重试的 timeout',
      never instanceof Error && errors.classify(never).kind === 'timeout',
      String(never?.message),
    )
    check(`这一条也按时动手（等了 ${waited6}ms）`, waited6 < 2000, `${waited6}ms`)
  } finally {
    globalThis.fetch = originalFetch
  }
}
