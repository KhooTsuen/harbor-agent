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

module.exports = { fetch }
