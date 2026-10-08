/**
 * 读网页正文（主进程侧，经 CDP 在页面里执行）
 *
 * 背景（B2，2026-10-09）：原来「读正文」是**渲染层**用 `webview.executeJavaScript`
 * 跑一段脚本（`src/.../browser/scripts.ts` 的 `READ_SCRIPT`），再把 text/html/title/url
 * 回给主进程。B2 起改成：渲染层只负责**导航 + 等就绪 + 回 webContents id**，
 * 正文由**主进程**经 `core/cdp.cjs` 的 `Runtime.evaluate` 直接读。
 *
 * ★ 脚本只有这一处（`READ_SCRIPT`）—— 渲染层的同名导出已随 B2 删掉，不留两份
 *   （跨模块约定只允许一处真相源，见 AGENT.md 硬约束 #9）。
 *
 * 空正文要再读几次：有些站点（SPA）`did-finish-load` 之后才开始填内容，
 * 第一次读是空 —— 空不等于「页面没有正文」。这一条是从原渲染层 `readPage`
 * 原样搬过来的（那边删了，钉子在自检组 136-browse-read）。
 */

const cdp = require('./cdp.cjs')

/** 读正文的脚本。优先 `innerText`（渲染后的可见文本），HTML 只兜底。 */
const READ_SCRIPT = `
  (function () {
    try {
      var body = document.body ? document.body.innerText : ''
      return {
        text: body || '',
        html: document.documentElement ? document.documentElement.outerHTML : '',
        title: document.title || '',
        url: location.href || ''
      }
    } catch (e) {
      return { text: '', html: '', title: '', url: '', error: String(e) }
    }
  })()
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 读当前页面正文。
 *
 * @param {number} webContentsId 目标 webview 的 webContents id
 * @param {{ tries?: number, sleepMs?: number, evaluate?: Function }} [options]
 *   `evaluate` 只给自检替换（默认走 CDP）；`tries`/`sleepMs` 控制空正文的重试。
 * @returns {Promise<{ text: string, html: string, title: string, url: string }>}
 */
async function readPageText(webContentsId, { tries = 3, sleepMs = 900, evaluate = cdp.evaluate } = {}) {
  let last = { text: '', html: '', title: '', url: '' }
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let value
    try {
      value = await evaluate(webContentsId, READ_SCRIPT)
    } catch (error) {
      /* 页面还没就绪（guest 没挂上）这类偶发失败：等一下再试；最后一次还失败就抛 */
      if (attempt === tries) throw error
      await sleep(sleepMs)
      continue
    }
    last = {
      text: String(value?.text ?? ''),
      html: String(value?.html ?? ''),
      title: String(value?.title ?? ''),
      url: String(value?.url ?? ''),
    }
    /* 有正文就交付；只剩没几次机会了也别再等（宁可早点回话） */
    if (last.text.length > 0 || last.html.length > 0 || attempt === tries) break
    await sleep(sleepMs)
  }
  return last
}

module.exports = { READ_SCRIPT, readPageText }
