import { check, group } from '../harness.mjs'
import { ROOT, join, require } from '../env.mjs'

/* ══════════════════════════════════════════════════════════════
   请求体适配（中转站兼容）

   这一组盯的都是「配置改了没反应」或者「上游直接 400」的事，
   **全都不需要联网** —— 构造请求体是纯函数，断言最终对象即可。

   为什么要有这一组：用户要接 OpenRouter 和硅基流动，
   两家的模型名都带 `vendor/` 前缀（`openai/o3-mini`、
   `deepseek-ai/DeepSeek-R1`），参数写法又和官方端点不一样。
   ══════════════════════════════════════════════════════════════ */

export async function run() {
  const bodyCore = require(join(ROOT, 'electron/core/llm-body.cjs'))
  const { buildChatBody, isReasoningModel, buildUrl } = bodyCore

  group('请求体 / 模型族适配')

  /* ── 推理模型家族：官方端点不接受 max_tokens / temperature ── */

  check('o1 被认出来', isReasoningModel('o1'))
  check('o3-mini 被认出来', isReasoningModel('o3-mini'))
  check('gpt-5 被认出来', isReasoningModel('gpt-5-turbo'))
  check('普通模型不误判', !isReasoningModel('gpt-4o') && !isReasoningModel('deepseek-chat'))

  /*
   * ★ 这条是中转站的真坑：模型名带 vendor 前缀。
   * 只写 /^(o1|o3)/ 的话，`openai/o3-mini` 认不出来 → 照样 400。
   */
  check('★ 带前缀的 openai/o3-mini 也认得出', isReasoningModel('openai/o3-mini'))
  check('★ 带前缀的 openai/gpt-5 也认得出', isReasoningModel('openai/gpt-5'))
  /* 边界：名字里恰好含 o1/gpt-5 但其实是别的模型，不能被误判 */
  check('o1x 不误判', !isReasoningModel('x/o1x'))
  check('★ gpt-50 不误判成 gpt-5', !isReasoningModel('gpt-50'))
  check('gpt-4o 不误判', !isReasoningModel('gpt-4o'))

  const reasoning = buildChatBody({
    model: 'openai/o3-mini',
    messages: [],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 512,
  })
  check('★ max_tokens 改名为 max_completion_tokens', reasoning.max_completion_tokens === 512)
  check('★ 不再带 max_tokens（官方端点会 400）', reasoning.max_tokens === undefined)
  check('★ 丢掉 temperature', reasoning.temperature === undefined)
  check('★ 丢掉 top_p', reasoning.top_p === undefined)

  const normal = buildChatBody({ model: 'gpt-4o', messages: [], temperature: 0.7, maxTokens: 512 })
  check('普通模型照旧带 temperature', normal.temperature === 0.7)
  check('普通模型照旧带 max_tokens', normal.max_tokens === 512)

  /* ── include_usage ── */

  check(
    '默认带上 stream_options.include_usage',
    buildChatBody({ model: 'm', messages: [] }).stream_options?.include_usage === true,
  )
  check(
    '供应商关掉时不带（有些站点不认这个字段）',
    buildChatBody({ model: 'm', messages: [], provider: { streamUsage: false } }).stream_options ===
      undefined,
  )
  check(
    '非流式请求不带 stream_options',
    buildChatBody({ model: 'm', messages: [], stream: false }).stream_options === undefined,
  )

  /* ── extraBody / omitParams ── */

  const extra = buildChatBody({
    model: 'm',
    messages: [],
    provider: { extraBody: { provider: { order: ['DeepInfra'], allow_fallbacks: true } } },
  })
  check('★ extraBody 原样 merge 进请求体', extra.provider?.order?.[0] === 'DeepInfra')

  const omitted = buildChatBody({
    model: 'm',
    messages: [],
    temperature: 1,
    maxTokens: 10,
    provider: { omitParams: ['temperature', 'max_tokens'] },
  })
  check(
    '★ omitParams 能删掉字段',
    omitted.temperature === undefined && omitted.max_tokens === undefined,
  )

  const override = buildChatBody({
    model: 'm',
    messages: [],
    maxTokens: 10,
    provider: { extraBody: { max_tokens: 999 } },
  })
  check('★ extraBody 优先级最高（用户手写的赢）', override.max_tokens === 999)

  check(
    'extraBody 不是对象时忽略（别把请求体搞坏）',
    buildChatBody({ model: 'm', messages: [], provider: { extraBody: 'nope' } }).model === 'm',
  )
  check(
    'omitParams 里有非字符串时忽略',
    buildChatBody({
      model: 'm',
      messages: [],
      temperature: 1,
      provider: { omitParams: [1, null, 'x'] },
    }).temperature === 1,
  )

  /* ── 工具与基础字段没被搞坏 ── */

  const withTools = buildChatBody({ model: 'm', messages: [], tools: [{ type: 'function' }] })
  check(
    '带工具时仍然设 tool_choice=auto',
    withTools.tool_choice === 'auto' && withTools.tools.length === 1,
  )
  check(
    '没有工具时不发 tools 字段',
    buildChatBody({ model: 'm', messages: [] }).tools === undefined,
  )

  /* ── strict 模式：只给插件（名单里的）加 strict:true ── */
  const strictOn = buildChatBody({
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'a', parameters: {} } },
      { type: 'function', function: { name: 'b', parameters: {} } },
      { type: 'function', function: { name: 'c', parameters: {} } },
    ],
    strictToolNames: ['a', 'b'],
  })
  check(
    'strictToolNames 只给名单里的 function 加 strict:true',
    strictOn.tools[0].function.strict === true &&
      strictOn.tools[1].function.strict === true &&
      strictOn.tools[2].function.strict === undefined,
  )
  check(
    '不传 strictToolNames 时 function 没有 strict 字段',
    buildChatBody({
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'a' } }],
    }).tools[0].function.strict === undefined,
  )
  check(
    'strictToolNames 空数组也不加 strict',
    buildChatBody({
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'a' } }],
      strictToolNames: [],
    }).tools[0].function.strict === undefined,
  )

  group('请求体 / URL 拼接')

  check(
    'baseUrl 末尾有斜杠不会拼成双斜杠',
    buildUrl('https://a.b/v1/', '/chat/completions') === 'https://a.b/v1/chat/completions',
  )
  check(
    'chatPath 不带前导斜杠也能拼',
    buildUrl('https://a.b/v1', 'chat/completions') === 'https://a.b/v1/chat/completions',
  )
  check('不传 chatPath 时用默认', buildUrl('https://a.b/v1').endsWith('/chat/completions'))

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
  } finally {
    globalThis.fetch = originalFetch
  }
}
