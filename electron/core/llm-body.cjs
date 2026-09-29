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
 * 「不限」（0 / 没填）时到底发什么 —— **不发**。
 *
 * ★ 2026-09-29 改。上一版正好写反了，代价是用户报的「长回复说到一半就没了」：
 *   上一版在「不限」时不省略，而是补上**模型声明的最大输出**
 *   （`provider-capabilities` 的 `max_output`）。听着合理，实际是**自己砌墙** ——
 *   `deepseek-flash` 声明 8192，于是每次请求都带 `max_tokens: 8192`，
 *   上游规规矩矩写到 8192 就停；而全项目没人处理 `finish_reason === 'length'`，
 *   所以用户看到的是「话说到一半没了」，还不知道为什么。
 *
 *   真机实测（打包版，同一条「写 1500 行」的请求）：
 *     · 带 `max_tokens: 20000` → 计费 out=**9341**，写完
 *     · **不带**这个参数      → 计费 out=**8033**，写完
 *   两个都**超过** 8192：证明那堵墙是我们发出去的，不是上游的极限；
 *   也推翻了老注释里「不发会退到很小的默认值 4096」的说法（实测不成立）。
 *
 *   口径：想砍就砍 —— 用户填了值就照发；没填就是**不设限**。
 *
 * @param {string} model 保留形参：调用方按模型传；将来若某家必须显式给上限，判断仍在这里
 * @param {number} maxTokens 设置里的输出上限，0 = 不限
 * @returns {number} > 0 才发；0 = 这次请求不带 `max_tokens`
 */
function resolveMaxTokens(model, maxTokens) {
  const wanted = Number(maxTokens)
  if (Number.isFinite(wanted) && wanted > 0) return Math.round(wanted)
  return 0
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
 * DeepSeek strict 模式（Beta）：只给**插件**的 function 加 `strict: true`。
 *
 * 为什么只给插件：strict 硬规定 object 的所有属性必须 required —— 而内置工具
 * 有 8 个可选参数（offset/limit/depth/cwd…），给它们开 strict 会 400。
 * 插件的 schema 已经过 toStrictSchema（全 required + additionalProperties:false），
 * 是唯一确定合规的一类。
 *
 * 只在 DeepSeek 官方 `/beta` 端点有效；中转站不认，所以是供应商级开关、默认关。
 */
function withStrict(tool, strictNames) {
  if (tool?.type === 'function' && strictNames?.includes(tool.function?.name)) {
    return { ...tool, function: { ...tool.function, strict: true } }
  }
  return tool
}

/**
 * 拼出一次对话请求的请求体。
 *
 * @param {{ model: string, messages: Array, tools?: Array,
 *           temperature?: number, topP?: number, maxTokens?: number,
 *           stream?: boolean, streamUsage?: boolean, strictToolNames?: Array<string>,
 *           reasoningEffort?: string, provider?: object }} input
 *          `maxTokens: 0` = 不限（见 `resolveMaxTokens`）
 */
function buildChatBody(input) {
  const {
    model,
    messages,
    tools,
    temperature,
    topP,
    stream = true,
    strictToolNames,
    reasoningEffort,
  } = input
  const provider = input.provider ?? {}

  const body = { model, messages, stream }
  if (typeof temperature === 'number') body.temperature = temperature
  if (typeof topP === 'number') body.top_p = topP
  const maxTokens = resolveMaxTokens(model, input.maxTokens)
  if (maxTokens > 0) body.max_tokens = maxTokens
  /*
   * 思考强度（DeepSeek `reasoning_effort`）：none | low | high | max。
   * ⚠️ 这个档位曾经是「假功能」—— UI 有选择器、前端有状态，但从没发给模型。
   * DeepSeek 默认 high；传 none 关闭思考。
   */
  if (typeof reasoningEffort === 'string' && reasoningEffort) {
    body.reasoning_effort = reasoningEffort
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools =
      Array.isArray(strictToolNames) && strictToolNames.length > 0
        ? tools.map((t) => withStrict(t, strictToolNames))
        : tools
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
  resolveMaxTokens,
  adaptForModel,
  applyProviderBody,
  withStrict,
  buildChatBody,
}
