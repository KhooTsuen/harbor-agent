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

/** 非流式，用来测连接 */
async function ping({ baseUrl, apiKey, chatPath, model, signal }) {
  const url = buildUrl(baseUrl, chatPath)
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
      stream: false,
    }),
    signal,
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

  const response = await fetch(url, { headers, signal })
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
 * 图像生成（/images/generations）。
 *
 * 和聊天是两套 API —— 所以「图像生成」那个场景必须单独挑模型，
 * 拿聊天模型去调只会 404。
 *
 * 返回格式各家不同，两种都兼容：
 *   · { data: [{ b64_json }] }  —— 要求 response_format: 'b64_json'
 *   · { data: [{ url }] }       —— 有些中转站忽略 response_format，只给 URL
 */
async function generateImage({ baseUrl, apiKey, model, prompt, size = '1024x1024', signal }) {
  const url = buildUrl(baseUrl, '/images/generations')
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'b64_json' }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${response.status}：${detail.slice(0, 300)}` }
  }

  const data = await response.json().catch(() => null)
  const first = Array.isArray(data?.data) ? data.data[0] : null
  if (!first) return { ok: false, error: '服务没有返回图片' }

  if (typeof first.b64_json === 'string' && first.b64_json) {
    return { ok: true, image: `data:image/png;base64,${first.b64_json}`, model }
  }
  if (typeof first.url === 'string' && first.url) {
    return { ok: true, image: first.url, model }
  }
  return { ok: false, error: '返回里既没有 b64_json 也没有 url' }
}

module.exports = { ping, listModels, parseModelList, generateImage }
