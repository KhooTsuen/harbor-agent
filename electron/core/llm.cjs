/**
 * 模型接入（OpenAI 兼容）
 *
 * 只做流式。理由：这个 UI 处处依赖「边生成边显示」——
 * 折叠的思考、打字机、可中断，全都建立在流上。
 *
 * 支持：SSE 解析（跨 chunk 半行）/ 流式 reasoning / 工具调用 / AbortSignal 中断。
 */

const http = require('./http.cjs')
const log = require('./log.cjs')
const { onAbort } = require('./abort.cjs')
const { createIdleGuard } = require('./llm-idle.cjs')
const { buildUrl, buildChatBody } = require('./llm-body.cjs')
const plugins = require('./plugins.cjs')

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
 * `traceId` 与 `taskId` 是**两个东西**：前者是这一轮运行实例的 key（生产里 `req_*`），
 * 后者是任务台账 id（`task_*`）。每请求指标两个都记，谁也不替代谁。
 *
 * @param {{ baseUrl: string, apiKey: string, model: string, messages: Array,
 *   chatPath?: string, tools?: Array, provider?: object, label?: string,
 *   temperature?: number, topP?: number, maxTokens?: number, reasoningEffort?: string,
 *   signal?: AbortSignal, idleTimeoutMs?: number, onContent?: Function, onReasoning?: Function,
 *   onToolCalls?: Function, onUsage?: Function, traceId?: string, taskId?: string,
 *   retryIndex?: number }} options
 */
async function chatStreamImpl(options) {
  const {
    label,
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
  const startedAt = Date.now()
  /* 首字节时间（TTFT）：第一个有内容的 delta 到达的耗时（token 优化指标） */
  let ttftMs = null
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

  /* ★ 带用途标签：没有它，「对话轮次」和「起标题/建议」在日志里长得一模一样 */
  log.info(`请求模型${label ? `[${label}]` : ''} ${model} → ${url}`)

  /*
   * 空闲看门狗：上游「一个字节都不回来」时别无限等下去（见 llm-idle.cjs）。
   * 它同时管两个阶段：等响应头（中止 fetch）与读流（掐掉 read）。
   */
  const idle = createIdleGuard(options.idleTimeoutMs)
  let reader = null
  idle.onFire(() => {
    log.warn(`空闲看门狗触发：${idle.message}`)
    void reader?.cancel().catch(() => {})
  })
  const guardedSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal

  idle.arm()
  let response
  try {
    /* 与看门狗赛跑：响应头不回来也能掐掉（不依赖底层 abort 是否生效） */
    response = await idle.race(
      http.fetchStream(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: guardedSignal,
      }),
    )
  } catch (error) {
    idle.stop()
    if (idle.timedOut() && !signal?.aborted) throw new Error(idle.message)
    throw error
  }
  idle.stop()

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const short = detail.slice(0, 500)
    /* ★ 状态码要挂在错误对象上：`errors.classify` 判 server / rate_limit / auth 读的是
       `error.status`，只写进文本的后果是 500 被归成 unknown（不重试、直接报失败）。 */
    const error = Object.assign(new Error(`上游返回 ${response.status}：${short || response.statusText}`), {
      status: response.status,
    })
    throw error
  }
  if (!response.body) throw new Error('上游没有返回流式响应体')

  reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')

  /* AG-010：fetch 的 signal 打断不了已在等的 read()（实测拖过 8 秒）—— 中断时主动撤流 */
  const offAbort = onAbort(signal, () => {
    void reader.cancel().catch(() => {})
  })

  let buffer = ''
  let content = ''
  let reasoning = ''
  /** index -> { id, name, arguments } */
  const toolCallMap = new Map()
  let usage = null
  let finishReason = null

  for (;;) {
    /* 快路径：上一个 chunk 处理完就已经断了，不必再等 reader */
    if (signal?.aborted) {
      offAbort()
      throw new DOMException('aborted', 'AbortError')
    }
    idle.arm()
    let step
    try {
      step = await idle.race(reader.read())
    } catch (error) {
      idle.stop()
      if (idle.timedOut() && !signal?.aborted) throw new Error(idle.message)
      throw error
    }
    idle.stop()
    const { done, value } = step
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
       * ★ 上游可能在**正常流里发错误**（HTTP 200，data 却是 error）：OpenRouter
       * 额度不够就发 {"error":{...}} —— 以前静默跳过，症状是回答空白且不报错。
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
      if (ttftMs === null) ttftMs = Date.now() - startedAt

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

  offAbort()
  /*
   * `reader.cancel()` 会让上面那个 `read()` 立刻 done —— 那**不能当成正常收流结束**，
   * 否则中断会被当成「上游返回了空内容」报出去。再查一次 signal，把真话抛出来。
   */
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  /* 看门狗掐掉的流同样是「被取消的 read」—— 这里把真正的原因报出来 */
  if (idle.timedOut()) throw new Error(idle.message)

  const toolCalls = [...toolCallMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter((call) => call.name)

  /* 收完流还是空的 —— 也得给出个说得通的错，不然界面上就是一条空气泡 */
  if (!content && !reasoning && toolCalls.length === 0 && !finishReason) {
    throw new Error(
      `上游没有返回任何内容（模型 ${model}）。常见原因：模型名不对、供应商额度不足、或被中转站拒绝。`,
    )
  }

  if (toolCalls.length > 0) onToolCalls?.(toolCalls)
  if (usage) onUsage?.(usage)

  return { content, reasoning, toolCalls, usage, finishReason, ttftMs, latencyMs: Date.now() - startedAt }
}

/**
 * 对外出口：**记账兜底**（判据在 `token-metrics.autoLog`，这里只管包）。
 *
 * 主对话自己记（`loop-model` 的重试循环知道第几次、发给谁，会传 `accounted: true`）；
 * 压缩 / 场景 / 协作这三条路直接调这里、不经过那个循环 —— 由这层补上，
 * 否则它们烧掉的 token 在账本上根本不存在。成功与失败都记：失败那次**也是真发出去过**。
 */
async function chatStream(options) {
  try {
    const result = await chatStreamImpl(options)
    require('./token-metrics.cjs').autoLog(options ?? {}, result, null)
    return result
  } catch (error) {
    require('./token-metrics.cjs').autoLog(options ?? {}, null, error)
    throw error
  }
}

const probe = require('./llm-probe.cjs')

module.exports = {
  chatStream,
  /* 非对话类接口在 llm-probe.cjs，这里透出去让调用方不用改 */
  ping: probe.ping,
  listModels: probe.listModels,
  parseModelList: probe.parseModelList,
  /* DeepSeek 账户余额（provider:balance 用）—— 同样只在这里转发一次 */
  getBalance: probe.getBalance,
  generateImage: probe.generateImage,
  buildUrl,
}
