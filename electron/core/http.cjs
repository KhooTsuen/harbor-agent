/**
 * 统一的 HTTP 客户端
 *
 * ── 为什么不用全局 fetch ──
 *
 * Electron 主进程里的全局 `fetch` 是 **Node 的 undici** —— 它**不读系统代理**。
 * 用户挂着代理访问中转站（APIMart 之类）时就会变成：
 *
 *   浏览器：能正常打开 apimart.ai
 *   Agent ：fetch failed（cause: UND_ERR_CONNECT_TIMEOUT）
 *
 * Chromium 的 `net.fetch` 走的是**浏览器网络栈**，会跟随系统代理设置。
 * 实测同一个网址（2026-09-17，用户机器）：
 *
 *   undici     → ERR fetch failed | cause: UND_ERR_CONNECT_TIMEOUT
 *   net.fetch  → HTTP 401（连上了，只是没带 Key）
 *
 * ── 超时 ──
 *
 * 这里**不设默认超时**：流式对话可能跑几分钟，一刀切会把正常请求掐掉。
 * 该设上限的地方（拉模型清单、测连接）各自传 `signal`。
 *
 * 纯 Node 环境（跑 `npm test` 时没有 Electron）退回全局 fetch —— 自检够用。
 */

/*
 * 每次都重新挑，**不缓存**。
 *
 * 缓存看起来很自然，但会让「测试里替换 globalThis.fetch 打桩」直接失效 ——
 * 模块加载时就把原始 fetch 钉死了，之后怎么改都没用（真机上也一样：
 * 换代理、换网络栈都得不重启才生效）。这里每次只是一次 require 缓存查找，
 * 相对于一次网络请求可以忽略。
 */
function impl() {
  try {
    /* 纯 Node 下 require('electron') 返回的是一个路径字符串，解构出来是 undefined */
    const { net } = require('electron')
    if (net && typeof net.fetch === 'function') return net.fetch
  } catch {
    /* 没有 Electron，走下面的兜底 */
  }
  return globalThis.fetch
}

/** 和全局 fetch 同签名；换的是底层网络栈 */
function fetch(input, init) {
  return impl()(input, init)
}

/**
 * 流式对话专用：走 Node 的 undici（全局 fetch）。
 *
 * 为什么不用 net.fetch：2026-09-25 真机验收发现 —— net.fetch 的响应体在流**卡住**时
 * 会把主线程一起拖死（`reader.read()` 同步阻塞，45 秒的空闲看门狗 `setTimeout`
 * 根本没机会响，整个主进程几分钟零日志、任务永远「运行中」）。undici 的 `read()`
 * 是真的异步：流卡住时事件循环照跑，看门狗能按时把挂住的请求报成可重试的 timeout。
 *
 * 代价：undici 不读系统代理（见上面 net.fetch 的说明）——挂代理的用户若要保留代理，
 * 请自己配 undici dispatcher，或把这里换回 net.fetch。探活类短请求（ping / listModels）
 * 仍走 net.fetch，不受影响。
 */
function fetchStream(input, init) {
  return globalThis.fetch(input, init)
}

/** 读响应体的默认上限（1 MB）：错误体 / 探活回包都是几百字节量级 */
const DEFAULT_BODY_MAX = 1024 * 1024

function abortError() {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/**
 * 读响应体，**边读边卡上限**（第 11 项，2026-11-10）。
 *
 * ── 为什么不能直接 `response.text()` / `arrayBuffer()` ────────
 * 那会先把**整个 body 读进内存**，读完了才有机会判断「超限」—— 上游真返回
 * 1 GB 时进程的内存已经被吃掉，再抛错也晚了。同样不能只看 `Content-Length`：
 * 它可以缺失（未知长度），也可以比实际小（撒谎），更可能压根没有这条头。
 *
 * 所以这里一律**流式读、累计字节、到上限立刻停**，并把 `truncated` 如实交出去
 * —— 调用方据此可以说「只读到前 N 字节」，而不是假装读全了。
 *
 * ★ 这是「限长读响应体」的**唯一实现**：图片、模型错误体、搜索回包都问它，
 *   别在各自模块里再写一份「读完了再看大小」（同一判据两处 = 一定漂）。
 *
 * @param {Response} response
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ buffer: Buffer, bytes: number, truncated: boolean }>}
 */
async function readBufferLimited(response, opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_BODY_MAX
  const signal = opts.signal
  if (signal?.aborted) throw abortError()

  /* 声明值可信时**先拒**：省掉一次白读（不可信时下面还会按实读字节卡） */
  const declared = Number(response?.headers?.get?.('content-length') ?? 0)
  if (declared > maxBytes) {
    throw new Error(`响应体太大（声明 ${declared} 字节，上限 ${maxBytes}）`)
  }

  const body = response?.body
  if (!body || typeof body.getReader !== 'function') {
    /* 没有流（老运行时 / 已消费 / 自检的假响应）→ 退回整读，如实不标截断 */
    if (typeof response?.arrayBuffer === 'function') {
      const buffer = Buffer.from(await response.arrayBuffer())
      return { buffer, bytes: buffer.length, truncated: false }
    }
    const text = typeof response?.text === 'function' ? String(await response.text()) : ''
    return { buffer: Buffer.from(text), bytes: Buffer.byteLength(text), truncated: false }
  }

  const reader = body.getReader()
  const chunks = []
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      if (signal?.aborted) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (bytes + chunk.length > maxBytes) {
        /* 只留到上限为止 —— 多出来的那截当场丢掉，不进内存 */
        chunks.push(chunk.subarray(0, maxBytes - bytes))
        bytes = maxBytes
        truncated = true
        break
      }
      bytes += chunk.length
      chunks.push(chunk)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 已经结束 / 已取消：收尾而已，别盖掉真正的错误 */
    }
  }
  return { buffer: Buffer.concat(chunks), bytes, truncated }
}

/**
 * 同上的文本形态。截断可能切在多字节字符中间 → 末尾出现替换符，
 * 这对「错误体摘要」无妨（本来只取前 500 字给人看）。
 *
 * @param {Response} response
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string, bytes: number, truncated: boolean }>}
 */
async function readTextLimited(response, opts = {}) {
  const { buffer, bytes, truncated } = await readBufferLimited(response, opts)
  return { text: buffer.toString('utf8'), bytes, truncated }
}

/**
 * 给用户填的地址补协议头（只补这个，别的一律不动）。
 *
 * 真机踩过（2026-10-15，用户报 search_web 一直失败）：设置里填 `www.bing.com` —— 从地址栏
 * 粘下来时浏览器把 `https://` 藏了，拼出来的字符串不是合法 URL，`fetch` 直接
 * `Failed to parse URL`；界面上只看到这句，根本猜不到是少了协议头。本机服务
 * （localhost / 127.0.0.1 / [::1]）补 `http`，其余补 `https`。
 */
function withScheme(template) {
  const t = String(template ?? '').trim()
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)
  return `${local ? 'http' : 'https'}://${t}`
}

module.exports = {
  fetch,
  fetchStream,
  withScheme,
  readBufferLimited,
  readTextLimited,
  DEFAULT_BODY_MAX,
}
