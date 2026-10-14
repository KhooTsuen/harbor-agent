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
const redact = require('./redact.cjs')

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

/* ══════════════════════════════════════════════════════════════
   账户余额（DeepSeek 专有）
   ══════════════════════════════════════════════════════════════
   文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance/
   端点：GET /user/balance，鉴权照旧 `Authorization: Bearer <key>`

   ⚠️ 这个端点**不在 `/v1` 下**。供应商的 baseUrl 是
      `https://api.deepseek.com/v1`，用 `buildUrl(baseUrl, '/user/balance')`
      会拼成 `.../v1/user/balance` → 404。所以这里取 baseUrl 的 **origin** 再拼路径。

   ⚠️ 余额在官方 schema 里是 **string**（`"total_balance": "110.00"`）——
      这里**不要** Number()：`undefined + 数字 = NaN` 是同类事故，
      显示层会变成「余额 NaN」。原样字符串带出去，格式化在界面做。
*/

/** 余额端点路径（官方文档：不在 /v1 之下） */
const BALANCE_PATH = '/user/balance'

/** 只有 DeepSeek 系有这个端点；别家发了也是 404，不如当场说清楚 */
const BALANCE_HOST = /(^|\.)deepseek\.com$/i

/**
 * 把余额响应收成界面要的形状。**认不出来就返回 null**（调用方据此报「格式无法识别」），
 * 不硬凑一个全是 null 的对象 —— 那会让界面显示一排「-」却看不出是接口变了。
 */
function parseBalance(data) {
  if (!data || typeof data !== 'object') return null
  const list = Array.isArray(data.balance_infos) ? data.balance_infos : null
  if (!list) return null
  const infos = list
    .map((item) => ({
      currency: String(item?.currency ?? ''),
      total: String(item?.total_balance ?? ''),
      granted: String(item?.granted_balance ?? ''),
      toppedUp: String(item?.topped_up_balance ?? ''),
    }))
    .filter((item) => item.currency)
  return { available: data.is_available === true, infos }
}

/**
 * 查账户余额。**只由用户点击触发**（调用方在界面层；这里不做任何定时/轮询）。
 *
 * 失败一律返回 `{ ok: false, error }`，**不抛** —— 查询失败是预期结果之一
 * （网络不通 / key 无效 / 接口变更），不该把异常捅到渲染层去崩界面。
 *
 * (JSDoc 里把 signal 标成可选是必须的：`checkJs` 下不写的话，调用方
 *  少传一个 signal 就是 TS2345 —— ping / listModels 当年就是这么欠下的。)
 *
 * @param {{ baseUrl: string, apiKey: string, signal?: AbortSignal }} options
 */
async function getBalance({ baseUrl, apiKey, signal }) {
  if (!baseUrl) return { ok: false, error: '这个供应商还没填接口地址' }
  if (!apiKey) return { ok: false, error: '这个供应商还没填 API Key' }

  let origin = ''
  try {
    const parsed = new URL(baseUrl)
    if (!BALANCE_HOST.test(parsed.hostname)) {
      return { ok: false, error: '这个供应商没有余额查询接口（目前只支持 DeepSeek）' }
    }
    origin = parsed.origin
  } catch {
    return { ok: false, error: `接口地址不是合法 URL：${baseUrl}` }
  }

  const response = await http.fetch(`${origin}${BALANCE_PATH}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: withTimeout(signal, 10_000),
  })

  if (!response.ok) {
    /* 三类失败分开说 —— 用户据此知道该改 Key、换供应商、还是等我们适配 */
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `API Key 无效或无权限（HTTP ${response.status}）` }
    }
    if (response.status === 404) {
      return { ok: false, error: '余额接口不存在（HTTP 404）—— 该供应商可能不支持，或接口已变更' }
    }
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${redact.redact(detail.slice(0, 200))}` }
  }

  const data = await response.json().catch(() => null)
  const balance = parseBalance(data)
  if (!balance) return { ok: false, error: '余额接口返回的格式无法识别（接口可能已变更）' }

  return { ok: true, ...balance }
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

module.exports = { ping, listModels, parseModelList, getBalance, parseBalance, generateImage }
