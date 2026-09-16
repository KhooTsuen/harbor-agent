/**
 * 图像生成任务的解析与轮询
 *
 * 中转站的图像接口大多**不是「一次调用就出图」**：
 *
 *   ① 提交 prompt  →  拿到 task_id
 *   ② 每隔几秒去查询接口问一次  →  直到 completed，拿到图片 URL
 *
 * APIMart 全家（GPT-Image、Seedream、Nano Banana、Flux、Midjourney）都是这个模式。
 * 但也有站点是同步返回的（直接给 b64_json 或 url），所以两条路都要认。
 *
 * 文档依据（2026-09-17 查 APIMart 官方文档）：
 *   · 提交：POST /v1/images/generations
 *     返回 { code: 200, data: [{ status: 'submitted', task_id: 'task_...' }] }
 *   · 查询：GET /v1/tasks/{task_id}       ← 官方推荐轮询这个「统一任务接口」
 *     状态 pending / processing / completed / failed
 *     成功结果在 result.images[].url
 *   · 查询不单独计费，官方建议 **3–5 秒轮询一次**
 *
 * 解析一律**宽松**：各家包裹层数不一样（有的包 data，有的直接顶层），
 * 所以这里按名字递归找，找不到才报错 —— 宁可多认几种，也别因为
 * 少一层包装就判定「服务没返回图片」。
 */

/** 官方建议 3–5 秒，取中间 */
const http = require('./http.cjs')
const POLL_INTERVAL_MS = 3500
/**
 * 轮询上限。
 *
 * ★ 这数字是**实测**定的，不是拍的。用户在 APIMart 后台看到：
 *
 *     提交 02:51:32 ── 我们轮询 304 秒 ── 02:56:36 超时
 *     APIMart 任务 02:56:35 创建 ── 12 秒 ── 02:56:47 完成
 *                                   ↑ 只差 11 秒
 *
 * 也就是说 **APIMart 光排队就要 5 分钟左右**，真正出图只要 12–15 秒。
 * 而当时的上限正好也是 5 分钟 —— 每次都差十几秒，图其实早就画好了，
 * 我们提前放弃了（用户以为「没画出来」）。
 *
 * 所以给到 10 分钟：把「排队 + 出图」整段覆盖掉。
 * 仍然超时的话把 task_id 带回去，可以只查不提交地接着等（不重复扣费）。
 */
const POLL_TIMEOUT_MS = 600_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 解析：同步响应 ───────────────────────────────────────── */

/**
 * 同步返回的图片：`{ data: [{ b64_json }] }` 或 `{ data: [{ url }] }`。
 * @returns {string} 可直接当 <img src> 用的字符串；没有则空串
 */
function pickSyncImage(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null
  if (!first) return ''
  if (typeof first.b64_json === 'string' && first.b64_json) {
    return `data:image/png;base64,${first.b64_json}`
  }
  if (typeof first.url === 'string' && first.url) return first.url
  return ''
}

/** 从提交响应里找 task_id（不同站点包裹层数不一样，挨个试） */
function pickTaskId(data) {
  const candidates = [
    data?.data?.[0]?.task_id,
    data?.data?.task_id,
    data?.task_id,
    data?.data?.[0]?.id,
    data?.id,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/* ── 解析：任务查询响应 ───────────────────────────────────── */

/** 状态字符串，统一小写（有的站点给 SUBMITTED，有的给 pending） */
function pickStatus(data) {
  const raw = data?.data?.status ?? data?.status ?? ''
  return String(raw).trim().toLowerCase()
}

/** 失败原因 */
function pickFailReason(data) {
  const raw =
    data?.data?.fail_reason ??
    data?.fail_reason ??
    data?.data?.error?.message ??
    data?.error?.message ??
    ''
  return String(raw).trim()
}

/**
 * 完成后的图片地址。按优先级试几种常见形态：
 *   · result.images[].url   ← APIMart 统一任务接口的形态
 *   · image_urls[0]         ← MJ 风格
 *   · data[0].url / url     ← 少数站点
 */
function pickTaskImage(data) {
  const node = data?.data ?? data
  const fromResult = node?.result?.images
  if (Array.isArray(fromResult)) {
    for (const item of fromResult) {
      if (typeof item === 'string' && item) return item
      if (typeof item?.url === 'string' && item.url) return item.url
    }
  }
  const fromUrls = node?.image_urls ?? node?.images
  if (Array.isArray(fromUrls)) {
    for (const item of fromUrls) {
      if (typeof item === 'string' && item) return item
      if (typeof item?.url === 'string' && item.url) return item.url
    }
  }
  if (typeof node?.url === 'string' && node.url) return node.url
  return ''
}

/* ── 轮询 ─────────────────────────────────────────────────── */

/**
 * 等一个图像任务出结果。
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} [input.apiKey]
 * @param {string} input.taskId
 * @param {string} [input.model]      回执里带上，方便界面显示是谁画的
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.interval]
 * @param {number} [input.timeout]
 * @param {boolean} [input.once]  只看一眼就走（不等待）—— 用来当场问「现在什么状态」
 * @param {(elapsedMs: number) => void} [input.onTick]  给上层记日志用
 * @returns {Promise<{ok:boolean, image?:string, model?:string, taskId?:string, error?:string, pending?:boolean, status?:string}>}
 */
async function waitForTask({
  baseUrl,
  apiKey,
  taskId,
  model,
  signal,
  interval = POLL_INTERVAL_MS,
  timeout = POLL_TIMEOUT_MS,
  once = false,
  onTick,
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/tasks/${encodeURIComponent(taskId)}`
  const headers = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const deadline = Date.now() + timeout
  const startedAt = Date.now()
  /*
   * 最后一次看到的原始响应。
   * 超时时把它带回去 —— 否则「等了 5 分钟没出图」这句话什么都说明不了：
   * 到底是上游真的慢，还是我们根本没认出它的状态字段？留个现场。
   */
  let lastSeen = ''
  let lastStatus = ''

  while (Date.now() < deadline) {
    /* once 模式不等待，立刻查一次 */
    if (!once) await sleep(interval)
    if (signal?.aborted) return { ok: false, error: '已取消', taskId }

    let response
    try {
      response = await http.fetch(url, { headers, signal })
    } catch (error) {
      /* 网络抖一下不算失败，继续等下一轮 */
      if (signal?.aborted) return { ok: false, error: '已取消', taskId }
      onTick?.(Date.now() - startedAt)
      continue
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      /* 404 = 任务不存在（查错人 / 过期被清），继续轮没意义 */
      return {
        ok: false,
        taskId,
        error: `查询任务失败 HTTP ${response.status}：${detail.slice(0, 200)}`,
      }
    }

    const data = await response.json().catch(() => null)
    const status = pickStatus(data)
    lastSeen = JSON.stringify(data ?? {}).slice(0, 400)
    lastStatus = status

    if (status === 'failed' || status === 'failure') {
      return { ok: false, taskId, error: `生成失败：${pickFailReason(data) || '上游没给原因'}` }
    }

    if (status === 'completed' || status === 'success' || status === 'succeeded') {
      const image = pickTaskImage(data)
      if (image) return { ok: true, image, model, taskId }
      /* 说完成了却没图 —— 再等一轮，可能是状态先到、结果后到 */
    }

    if (once) {
      return {
        ok: false,
        pending: true,
        taskId,
        status,
        error: `上游状态：${status || '(没读到状态字段)'}`,
      }
    }

    onTick?.(Date.now() - startedAt)
  }

  /* 超时不算失败：任务还在跑，让上层拿着 task_id 稍后再查 */
  return {
    ok: false,
    pending: true,
    taskId,
    status: lastStatus,
    error:
      `等了 ${Math.round(timeout / 1000)} 秒还没出图` +
      `（最后读到状态 ${lastStatus || '?'}；原始响应 ${lastSeen || '(空)'}）`,
  }
}

module.exports = {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  pickSyncImage,
  pickTaskId,
  pickStatus,
  pickTaskImage,
  pickFailReason,
  waitForTask,
}
