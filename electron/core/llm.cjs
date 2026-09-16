/**
 * 模型接入（OpenAI 兼容）
 *
 * 只做流式。理由：这个 UI 处处依赖「边生成边显示」——
 * 折叠的思考、打字机、可中断，全都建立在流上。
 *
 * 支持：
 *   - SSE 解析（正确处理跨 chunk 的半行）
 *   - 流式 reasoning（DeepSeek 的 reasoning_content / OpenAI 的 reasoning）
 *   - 工具调用（流式拼 arguments）
 *   - AbortSignal 中断
 */

const http = require('./http.cjs')
const log = require('./log.cjs')
const { buildUrl, buildChatBody } = require('./llm-body.cjs')
const plugins = require('./plugins.cjs')

/**
 * 把 baseUrl 和 chatPath 拼成完整地址。
 * 两边的斜杠都要处理，否则会出现 //chat 或 /v1chat 这类问题。
 */

/** 从 SSE 的一行里取出 data 段 */
function parseSseLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':')) return null
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') return { done: true }
  try {
    return { json: JSON.parse(payload) }
  } catch {
    /* 不完整的一行，交给缓冲区继续拼 */
    return null
  }
}

/**
 * 发起一次流式对话。
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} [options.chatPath]
 * @param {string} options.model
 * @param {Array} options.messages
 * @param {Array} [options.tools]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} [options.onContent]
 * @param {(text: string) => void} [options.onReasoning]
 * @param {(calls: Array) => void} [options.onToolCalls]
 * @param {(usage: object) => void} [options.onUsage]
 */
async function chatStream(options) {
  const {
    baseUrl,
    apiKey,
    chatPath,
    model,
    messages,
    tools,
    temperature,
    topP,
    maxTokens,
    signal,
    provider,
    onContent,
    onReasoning,
    onToolCalls,
    onUsage,
  } = options

  const url = buildUrl(baseUrl, chatPath)
  /* 请求体的构造（含模型族适配、供应商级覆盖）见 llm-body.cjs */
  const body = buildChatBody({
    model,
    messages,
    tools,
    temperature,
    topP,
    maxTokens,
    /*
     * strict 只给插件：内置工具有可选参数，开 strict 会 400。
     * 插件 schema 已过 toStrictSchema，是唯一确定合规的一类。
     */
    strictToolNames:
      options.provider?.strictTools === true ? plugins.list().map((p) => p.name) : undefined,
    /* 思考强度：none / low / high / max（deepseek 的 reasoning_effort） */
    reasoningEffort: options.reasoningEffort,
    provider: options.provider,
  })

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  log.info(`请求模型 ${model} → ${url}`)

  const response = await http.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const short = detail.slice(0, 500)
    throw new Error(`上游返回 ${response.status}：${short || response.statusText}`)
  }
  if (!response.body) throw new Error('上游没有返回流式响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')

  let buffer = ''
  let content = ''
  let reasoning = ''
  /** index -> { id, name, arguments } */
  const toolCallMap = new Map()
  let usage = null
  let finishReason = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    /* SSE 以空行分隔事件；这里按行处理，最后一行可能不完整，留在 buffer 里 */
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const parsed = parseSseLine(line)
      if (!parsed) continue
      if (parsed.done) {
        buffer = ''
        break
      }

      const chunk = parsed.json

      /*
       * ★ 上游可能**在正常流里发错误**（HTTP 200，data 里却是 error）。
       *
       * OpenRouter 就是这样：额度不够时发
       *   data: {"error":{"code":402,"message":"Insufficient credits..."}}
       * 这行没有 choices，原来的代码走 `if (!delta) continue` 静默跳过 ——
       * 症状是**回答空白、不报任何错**，比 500 难查得多。
       *
       * 这条是被真实踩中之后加的（用户报「OpenRouter 点了没反应」）。
       */
      if (chunk?.error) {
        const info = chunk.error
        const message =
          typeof info === 'string' ? info : String(info?.message ?? JSON.stringify(info))
        const code = info?.code !== undefined ? `（code ${info.code}）` : ''
        throw new Error(`上游在流里返回错误${code}：${message}`)
      }

      const choice = chunk?.choices?.[0]
      if (chunk?.usage) usage = chunk.usage
      if (choice?.finish_reason) finishReason = choice.finish_reason

      const delta = choice?.delta
      if (!delta) continue

      /* 思考内容：不同厂商字段名不一样 */
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        reasoning += reasoningDelta
        onReasoning?.(reasoningDelta)
      }

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        onContent?.(delta.content)
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === 'number' ? call.index : 0
          const existing = toolCallMap.get(index) ?? { id: '', name: '', arguments: '' }
          if (call.id) existing.id = call.id
          if (call.function?.name) existing.name = call.function.name
          if (call.function?.arguments) existing.arguments += call.function.arguments
          toolCallMap.set(index, existing)
        }
      }
    }
  }

  const toolCalls = [...toolCallMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter((call) => call.name)

  /*
   * 收完流还是空的 —— 也得给出个说得通的错。
   * 不然界面上就是一条空气泡，用户不知道发生了什么。
   * 常见原因：模型名不存在、供应商没额度、被中转站拦了。
   */
  if (!content && !reasoning && toolCalls.length === 0 && !finishReason) {
    throw new Error(
      `上游没有返回任何内容（模型 ${model}）。常见原因：模型名不对、供应商额度不足、或被中转站拒绝。`,
    )
  }

  if (toolCalls.length > 0) onToolCalls?.(toolCalls)
  if (usage) onUsage?.(usage)

  return { content, reasoning, toolCalls, usage, finishReason }
}

const probe = require('./llm-probe.cjs')

module.exports = {
  chatStream,
  /* 非对话类接口在 llm-probe.cjs，这里透出去让调用方不用改 */
  ping: probe.ping,
  listModels: probe.listModels,
  parseModelList: probe.parseModelList,
  generateImage: probe.generateImage,
  buildUrl,
}
