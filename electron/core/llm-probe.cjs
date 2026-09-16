/**
 * 供应商的非对话接口：测连接 / 拉模型清单 / 生成图片
 *
 * 从 llm.cjs 拆出来的（那边接了模型族适配和流内错误检查之后过 300 行了）。
 *
 * 这几个和 `chatStream` 是两回事：不流式、不解析 SSE、不需要工具调用。
 * 放一起的好处是「哪些东西要跟着鉴权/参数一起改」一眼能看出来 ——
 * 比如将来支持自定义鉴权头，这四个地方都得同步。
 */

const { buildUrl } = require('./llm-body.cjs')
const task = require('./image-task.cjs')
const http = require('./http.cjs')

/**
 * 测连接 / 拉模型清单 / 提交生图都不是流式请求，给个上限。
 * 不加的话，遇到连不上的域名会挂到系统 TCP 超时（大约两分钟），
 * 用户点一下「刷新」就得干等 —— 而且当时根本看不出是网络问题。
 */
const PROBE_TIMEOUT_MS = 30_000

/** 调用方传了 signal 就用它的，没传才兜底 */
function withTimeout(signal, ms = PROBE_TIMEOUT_MS) {
  return signal ?? AbortSignal.timeout(ms)
}

/** 非流式，用来测连接 */
async function ping({ baseUrl, apiKey, chatPath, model, signal }) {
  const url = buildUrl(baseUrl, chatPath)
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await http.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
      stream: false,
    }),
    signal: withTimeout(signal),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 200)}` }
  }
  const data = await response.json().catch(() => null)
  return { ok: true, model: data?.model ?? model }
}

/**
 * 拉取供应商的模型清单（OpenAI 兼容的 GET /models）。
 *
 * 为什么需要：中转站动辄上百个模型，让人一个个手打进「模型列表」不现实。
 *
 * 返回格式各家不完全一样，这里兼容两种：
 *   · OpenAI 标准：{ data: [{ id: 'gpt-4o' }] }
 *   · 少数中转站：直接给数组，元素是对象或裸字符串
 */
async function listModels({ baseUrl, apiKey, signal }) {
  const url = buildUrl(baseUrl, '/models')
  const headers = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await http.fetch(url, { headers, signal: withTimeout(signal) })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 200)}` }
  }

  const data = await response.json().catch(() => null)
  const models = parseModelList(data)
  if (models.length === 0) return { ok: false, error: '服务返回的模型列表是空的' }

  return { ok: true, models }
}

/**
 * 把 /models 的响应解析成模型名数组。
 *
 * 各家格式不完全一样：
 *   · OpenAI 标准：{ data: [{ id: 'gpt-4o' }] }
 *   · 少数中转站：直接给数组，元素是对象或裸字符串
 * 顺手去重 + 排序（中转站经常重复列，排一下找起来也方便）。
 */
function parseModelList(data) {
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  const ids = raw
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim())
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

/**
 * 图像生成（`/images/generations`）。
 *
 * 和聊天是两套 API —— 所以「图像生成」那个场景必须单独挑模型，
 * 拿聊天模型去调只会 404。
 *
 * 返回两条路都认（文档依据见 image-task.cjs 顶部）：
 *   · 同步站点直接给 b64_json / url           → 直接用
 *   · 异步站点给 task_id（APIMart 全家都是）→ 轮询到出图
 *
 * 传了 `taskId` 就**只查不提交** —— 用来接着等上一次超时的那张图，
 * 不会重复扣费。
 */
async function generateImage({
  baseUrl,
  apiKey,
  model,
  prompt,
  size,
  signal,
  taskId,
  interval,
  timeout,
  once,
  submitOnly,
}) {
  if (taskId) {
    return await task.waitForTask({
      baseUrl,
      apiKey,
      taskId,
      model,
      signal,
      interval,
      timeout,
      once,
    })
  }

  const url = buildUrl(baseUrl, '/images/generations')
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const body = { model, prompt, n: 1, response_format: 'b64_json' }
  /*
   * size 不传就走服务端默认（APIMart 默认 1:1）。
   * 写死 '1024x1024' 会把「16:9」这种比例参数堵死 —— 而中转站基本都支持比例。
   */
  if (size) body.size = size

  const response = await http.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: withTimeout(signal, 60_000),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 300)}` }
  }

  const data = await response.json().catch(() => null)

  const direct = task.pickSyncImage(data)
  if (direct) return { ok: true, image: direct, model }

  const id = task.pickTaskId(data)
  if (!id) {
    return {
      ok: false,
      error: `返回里既没有图片也没有 task_id：${JSON.stringify(data ?? {}).slice(0, 200)}`,
    }
  }

  if (submitOnly) return { ok: true, submitOnly: true, taskId: id, model }

  return await task.waitForTask({ baseUrl, apiKey, taskId: id, model, signal, interval, timeout })
}

module.exports = { ping, listModels, parseModelList, generateImage }
