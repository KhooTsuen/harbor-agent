/*
 * 实测：这个供应商 + 这个模型**实际**会什么。
 *
 * 为什么要有它：`provider-capabilities.cjs` 那一套是**声明与预设**（界面上那句原话
 * 就是「声明，不是实测」）。用户挑了一个「以为支持工具调用」的模型、实际不支持时，
 * 现在的表现是「模型怪怪的」而不是「这不对」—— 最伤信任的失败就是这种。
 *
 * ── 四条硬口径（写死，别改）──
 * ① **只影响提示，不改请求形状**：探测结果**不**参与 `buildChatBody`，也不参与路由。
 *    探测失败 / 未知 → 一切照旧（fail-open）。
 * ② **只提示，不做硬门**：实测说「不支持」也只提示，绝不拒绝执行 —— 决定权在用户。
 * ③ **不自动改配置、不自动换模型**。
 * ④ 探测请求要**尽量小**：能一个请求问清楚就不发第二个，且都可被 signal 中断。
 *
 * 探什么（都用一个最小请求）：
 *   connection  能回话（HTTP 200 且流里有内容）
 *   streaming   回的是 SSE（而不是一次性 JSON）
 *   tool_call   认不认 tools（给一个假工具，只看它会不会调）
 *   vision      收不收图片（塞一张 1×1 PNG）
 *   usage       回不回 usage（token 账能不能不靠估）
 *   listed      模型名在 `/models` 清单里（名字打错时这条最有用）
 *
 * 解析部分都是**纯函数**（`parseSse` / `firstDelta` / `hasToolCall`），
 * 所以自检不需要联网、不需要 Electron：喂一段假 SSE 就能断言。
 */

/** 1×1 透明 PNG —— 「收不收图片」用它，够小又不占带宽 */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * 把 SSE 文本切成 `data:` 载荷（**纯函数**）。
 *
 * 只认 `data:` 开头的行：`:` 开头的注释（OpenRouter 会发 `: OPENROUTER PROCESSING`）
 * 与空行都要跳过 —— 这条和 `llm.cjs` 的 reader 是同一个口径。
 */
function parseSse(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* 半行 JSON 就当没有：探测不追求把流读全 */
    }
  }
  return out
}

/** 第一个带正文的 delta（纯函数）—— 有它就算「能回话」 */
function firstDelta(chunks) {
  for (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta
    const text = delta?.content ?? delta?.reasoning_content ?? ''
    if (typeof text === 'string' && text.length > 0) return text
  }
  return ''
}

/** 流里有没有工具调用（纯函数）—— 只看有没有 `tool_calls`，不看它调得对不对 */
function hasToolCall(chunks) {
  return chunks.some((chunk) => {
    const calls = chunk?.choices?.[0]?.delta?.tool_calls
    return Array.isArray(calls) && calls.length > 0
  })
}

/** 流里有没有 usage（纯函数） */
function hasUsage(chunks) {
  return chunks.some((chunk) => chunk?.usage && typeof chunk.usage === 'object')
}

/** 流里的错误（纯函数）—— OpenRouter 会在 HTTP 200 的流里发 `{"error":…}` */
function streamError(chunks) {
  const hit = chunks.find((chunk) => chunk?.error)
  if (!hit) return ''
  const error = hit.error ?? {}
  return String(error.message ?? error.code ?? '流里报了错')
}

/** 一次最小请求；返回 `{ status, ok, text, sse }`，**永不抛** */
async function post(fetchImpl, url, headers, body, signal) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    return { status: response.status, ok: response.ok, text, sse: /^data:/m.test(text) }
  } catch (error) {
    return { status: 0, ok: false, text: error instanceof Error ? error.message : String(error), sse: false }
  }
}

/** 把 baseUrl + chatPath 拼成完整地址（与 `llm.cjs` 同口径：chatPath 缺省走 OpenAI 兼容） */
function chatUrl(baseUrl, chatPath) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  const path = String(chatPath ?? '/chat/completions')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 实测一个模型。
 *
 * @param {{ provider: object, model: string, apiKey: string, fetchImpl?: Function, signal?: AbortSignal }} input
 *   `fetchImpl` 只是为了自检能注入假 fetch —— 生产路径传默认的 `fetch`。
 * @returns {Promise<{ ok: boolean, at: number, providerId: string, model: string, results: object, notes: object }>}
 *   `results` 里每项是 `true` / `false` / `null`（**null = 没测出来，不等于不支持**）
 */
async function probeModel({ provider, model, apiKey, fetchImpl, signal }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const url = chatUrl(provider?.baseUrl, provider?.chatPath)
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const results = { connection: null, streaming: null, tool_call: null, vision: null, usage: null, listed: null }
  const notes = {}
  const base = { model: String(model ?? ''), stream: true, max_tokens: 16 }

  /* ① 连通 + 流式 + usage：一个请求能同时看出三件事 */
  const ping = await post(doFetch, url, headers, { ...base, messages: [{ role: 'user', content: 'hi' }] }, signal)
  if (!ping.ok) {
    notes.connection = `请求失败（HTTP ${ping.status || '无'}）：${ping.text.slice(0, 200)}`
    return { ok: false, at: Date.now(), providerId: String(provider?.id ?? ''), model: String(model ?? ''), results, notes }
  }
  const chunks = parseSse(ping.text)
  results.streaming = ping.sse
  /*
   * ★ 流里的错误要**当场结束**：OpenRouter 会在 HTTP 200 的正常流里发 `{"error":…}`
   *   （2026-09-16 修过一次同类问题：那次是被静默吞掉，症状是「回答空白、不报错」）。
   *   带着这个错再往下探工具 / 视觉没意义 —— 早点把原话交给用户。
   */
  const streamed = streamError(chunks)
  if (streamed) {
    notes.connection = `上游在流里报了错：${streamed}`
    return {
      ok: false,
      at: Date.now(),
      providerId: String(provider?.id ?? ''),
      model: String(model ?? ''),
      results,
      notes,
    }
  }
  results.connection = Boolean(firstDelta(chunks))
  results.usage = hasUsage(chunks)
  if (!ping.sse) notes.streaming = '回的是一次性 JSON，不是 SSE —— 界面会等整段才出字'
  if (results.usage === false) notes.usage = '上游没回 usage，token 账只能靠估算'

  /* ② 工具调用：给一个假工具，只看它会不会调 */
  const tools = [
    {
      type: 'function',
      function: {
        name: 'probe_echo',
        description: '原样回显一段文字。这是能力探测用的，请直接调用它。',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    },
  ]
  const toolTry = await post(
    doFetch,
    url,
    headers,
    { ...base, messages: [{ role: 'user', content: '调用 probe_echo，text 填 ok' }], tools },
    signal,
  )
  if (toolTry.ok) {
    const toolChunks = parseSse(toolTry.text)
    results.tool_call = hasToolCall(toolChunks)
    if (results.tool_call === false) {
      notes.tool_call = '给它一个工具它没用 —— 这个模型可能不支持工具调用（Agent 会退化成一问一答）'
    }
  } else if (toolTry.status) {
    /* 4xx 往往就是「不认 tools」—— 这条比「没调」更有说服力 */
    results.tool_call = false
    notes.tool_call = `带上 tools 就被拒了（HTTP ${toolTry.status}）：${toolTry.text.slice(0, 160)}`
  }

  /* ③ 视觉：塞一张 1×1 PNG */
  const visionTry = await post(
    doFetch,
    url,
    headers,
    {
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么颜色？' },
            { type: 'image_url', image_url: { url: TINY_PNG } },
          ],
        },
      ],
    },
    signal,
  )
  if (visionTry.ok) {
    results.vision = Boolean(firstDelta(parseSse(visionTry.text)))
    if (results.vision === false) notes.vision = '收了图片但没回内容 —— 图片可能被忽略了'
  } else if (visionTry.status) {
    results.vision = false
    notes.vision = `带图片被拒了（HTTP ${visionTry.status}）—— 这个模型不收图`
  }

  /* ④ 模型名在不在清单里（名字打错时这条最有用；拉不到清单就留 null） */
  try {
    const modelsUrl = `${String(provider?.baseUrl ?? '').replace(/\/+$/, '')}/models`
    const listed = await doFetch(modelsUrl, { headers: { Authorization: headers.Authorization ?? '' }, signal })
    if (listed.ok) {
      const payload = await listed.json()
      const ids = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id ?? '')) : []
      results.listed = ids.length > 0 ? ids.includes(String(model ?? '')) : null
      if (results.listed === false) notes.listed = `清单里没有「${model}」这个名字（共 ${ids.length} 个模型）`
    }
  } catch {
    /* 拉不到清单不影响其它结论 */
  }

  return {
    ok: true,
    at: Date.now(),
    providerId: String(provider?.id ?? ''),
    model: String(model ?? ''),
    results,
    notes,
  }
}

module.exports = { probeModel, parseSse, firstDelta, hasToolCall, hasUsage, streamError, chatUrl, TINY_PNG }
