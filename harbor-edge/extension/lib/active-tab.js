/**
 * 拿「当前活动标签」并判它能不能读 —— M03 从 `service-worker.js` 抽出来
 *
 * ── 为什么抽 ─────────────────────────────────────────────────
 *
 * M03 要给 SW 加「观察页面」（注入 `collectPageContext`），而 SW 已经贴 300 行红线。
 * 而「拿前台标签 + 判受限页」这段逻辑，**读正文**（Phase 2）与**观察页面**（M03）
 * 都要用 —— 两份各写一遍必定漂（硬约束 #9），所以抽成这一处。
 *
 * ── ★ 三条不能变的行为（Phase 2 定的，验收脚本钉着）────────────
 *
 *   ① 只读**前台当前标签**：`chrome.tabs.query({active:true,currentWindow:true})`
 *      —— 不遍历后台、不碰别的标签。
 *   ② url 为空要**分两种情况**给人话（合并成一句会**误导**用户反复点图标）：
 *      (a) 这个标签没被 invoke 过（换过标签）→ 「先点一下工具栏的 Harbor 图标再试」
 *      (b) 本就是受限页（edge:// / about:）→ 「该页面不支持读取（浏览器内部页读不了）」
 *      判据是 bindAction 留下的 `harborInvoke`：同一 tabId 且当时也看不到 url → (b)。
 *   ③ 这两句文案**一个字都别改** —— `accept-phase2` 的判据按它们断言。
 */

/* global chrome */

/** 读不了的页面（浏览器内部页）：显式判为了给人话错误，且让「哪些读不了」看得见。 */
const BLOCKED_PROTOCOL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|chrome-untrusted):/i

/** 读 `harborInvoke`（bindAction 留下的那笔，用来区分 url 为空的两种原因） */
function readInvoke() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('harborInvoke', (o) => resolve(o && o.harborInvoke))
    } catch {
      resolve(null)
    }
  })
}

/**
 * 解析当前活动标签。
 *
 * @returns {Promise<{ ok: true, tab: object, url: string } | { ok: false, error: string }>}
 *   失败时 `error` 是**已经写好的人话**（调用方直接展示，不再自己编）。
 */
export async function resolveActiveTab() {
  let tab
  try {
    const list = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = list && list[0]
  } catch (error) {
    return { ok: false, error: `拿不到当前标签页：${(error && error.message) || error}` }
  }
  if (!tab || tab.id == null) return { ok: false, error: '找不到当前标签页' }

  const url = String(tab.url || '')
  if (!url) {
    const inv = await readInvoke()
    if (inv && inv.tabId === tab.id && inv.hasUrl === false) {
      return { ok: false, error: '该页面不支持读取（浏览器内部页读不了）' }
    }
    return { ok: false, error: '读不到当前页地址 —— 先点一下工具栏的 Harbor 图标再试' }
  }
  if (BLOCKED_PROTOCOL.test(url)) return { ok: false, error: '该页面不支持读取' }

  return { ok: true, tab, url }
}

export { BLOCKED_PROTOCOL }
