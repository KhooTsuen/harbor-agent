/**
 * 请求的构造与适配（URL + 请求体，纯函数，不联网就能测）
 *
 * 从 llm.cjs 拆出来的理由有两个：
 *   ① 这一段的正确性靠「不同供应商/模型 → 断言最终请求体」来保证，
 *      是纯字符串和对象的活儿，**不该需要联网才能测**
 *   ② 中转站（OpenRouter、硅基流动…）的差异基本都堆在这里，
 *      混在 300 行的流式解析里没法看
 */

/** 把 baseUrl 和 chatPath 拼起来（别重复斜杠） */
function buildUrl(baseUrl, chatPath) {
  const base = String(baseUrl).replace(/\/+$/, '')
  const suffix = String(chatPath || '/chat/completions')
  return base + (suffix.startsWith('/') ? suffix : `/${suffix}`)
}

/**
 * 新推理模型家族。
 *
 * 这些模型在**官方端点**上：
 *   · 不接受 `max_tokens`（要用 `max_completion_tokens`）
 *   · 不接受 `temperature` / `top_p`（非默认值直接 400）
 *
 * ⚠️ 正则必须兼容 `vendor/` 前缀 —— OpenRouter 和硅基流动都用命名空间模型名
 * （`openai/o3-mini`、`deepseek-ai/DeepSeek-R1`）。
 * 写成 `/^(o1|o3|...)/` 的话，这些端点上的 o 系模型照样会 400。
 */
const REASONING_MODEL = /(^|\/)(o1|o3|o4|gpt-5)(?=[-.]|$)/i

function isReasoningModel(model) {
  return REASONING_MODEL.test(String(model ?? ''))
}

/**
 * 按模型家族改参数写法。
 *
 * 只处理「不改就报错」的：改名 + 丢参数。
 * 中转站大多是宽松转发，多几个字段不管 —— 但不代表官方端点也不管。
 */
function adaptForModel(body, model) {
  if (!isReasoningModel(model)) return body

  const next = { ...body }
  if (next.max_tokens !== undefined) {
    next.max_completion_tokens = next.max_tokens
    delete next.max_tokens
  }
  /* 丢而不是设成默认值 —— 官方端点连「传了」都不允许 */
  delete next.temperature
  delete next.top_p
  return next
}

/**
 * 用供应商级的配置覆盖请求体。
 *
 * 顺序很重要：
 *   `omitParams`（明确不要发的）→ `extraBody`（明确要发的，优先级最高）
 *
 * `extraBody` 放最后是刻意的：用户在设置里手写的东西，就该赢过我们的默认值。
 * 这样遇到怪站点不用等我们改代码 —— OpenRouter 的后端选择
 * （`{"provider":{"order":[...]}}`）、硅基流动 Qwen3 的
 * `{"enable_thinking":false}`，都属于这一类。
 */
function applyProviderBody(body, provider = {}) {
  const next = { ...body }

  const omit = Array.isArray(provider.omitParams) ? provider.omitParams : []
  for (const key of omit) {
    if (typeof key === 'string' && key) delete next[key]
  }

  const extra = provider.extraBody
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    Object.assign(next, extra)
  }

  return next
}

/**
 * 拼出一次对话请求的请求体。
 *
 * @param {{ model: string, messages: Array, tools?: Array,
 *           temperature?: number, topP?: number, maxTokens?: number,
 *           stream?: boolean, streamUsage?: boolean, provider?: object }} input
 */
function buildChatBody(input) {
  const { model, messages, tools, temperature, topP, maxTokens, stream = true } = input
  const provider = input.provider ?? {}

  const body = { model, messages, stream }
  if (typeof temperature === 'number') body.temperature = temperature
  if (typeof topP === 'number') body.top_p = topP
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  /*
   * 让上游回用量。
   *
   * 不加这个，OpenAI 兼容端点默认**不回 usage** —— 「用量统计」就一直是空的。
   * 但有些站点对不认识的字段直接 400，所以要能关（provider.streamUsage = false）。
   */
  const wantUsage = (input.streamUsage ?? provider.streamUsage) !== false
  if (stream && wantUsage) body.stream_options = { include_usage: true }

  return applyProviderBody(adaptForModel(body, model), provider)
}

module.exports = {
  buildUrl,
  REASONING_MODEL,
  isReasoningModel,
  adaptForModel,
  applyProviderBody,
  buildChatBody,
}
