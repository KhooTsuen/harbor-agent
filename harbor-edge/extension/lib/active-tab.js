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
 *      (a) 这个标签没被 invoke 过（换过标签）→ 见 `NO_INVOKE_HINT`（2026-10-21 改写着：
 *          用户反馈原句「先点一下工具栏的 Harbor 图标再试」太模糊，不知道图标在哪）
 *      (b) 本就是受限页（edge:// / about:）→ 「该页面不支持读取（浏览器内部页读不了）」
 *      判据是 bindAction 留下的 `harborInvoke`：同一 tabId 且当时也看不到 url → (b)。
 *   ③ 这两句文案**一个字都别改** —— `accept-phase2` 的判据按它们断言。
 */

/* global chrome */

/** 读不了的页面（浏览器内部页）：显式判为了给人话错误，且让「哪些读不了」看得见。 */
const BLOCKED_PROTOCOL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|moz-extension|chrome-untrusted):/i

/**
 * 「这个标签没被授权」时给用户的话（2026-10-21 改写）。
 *
 * 原句是「读不到当前页地址 —— 先点一下工具栏的 Harbor 图标再试」，用户反馈
 * **看不懂**：不知道「工具栏」指哪、不知道图标长什么样、不知道 Edge 还会把它
 * 收进拼图菜单里。所以这句必须同时说清三件事：
 *
 *   ① **为什么** —— 不是坏了，是 Edge 的规矩：图标点在哪一个标签，就只授权那一个。
 *   ② **在哪** —— 地址栏右侧；没固定出来时在 🧩 拼图图标里（这是最常卡住的一步）。
 *   ③ **还能怎么代替** —— `Alt+Shift+H` 快捷键（同类用户手势，同样授予 activeTab）。
 *
 * ⚠️ 开头必须保留「先点一下工具栏的 Harbor 图标」这几个字：
 *   `accept-phase2.cjs` 按 `/先点一下工具栏/` 断言，删了就红。
 */
const NO_INVOKE_HINT =
  '读不到当前页地址 —— Edge 只在你点图标时授权「当前这一个标签」。' +
  '请点一下工具栏的 Harbor 图标（在地址栏右侧；如果没固定出来，点 🧩 拼图图标能找到它），' +
  '或者按 Alt+Shift+H，然后回来再点「读当前页」'

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
    return { ok: false, error: NO_INVOKE_HINT }
  }
  if (BLOCKED_PROTOCOL.test(url)) return { ok: false, error: '该页面不支持读取' }

  return { ok: true, tab, url }
}

/** 采集完成后再核对一次，防止等待站点策略或注入期间切到了另一页。 */
export async function stillActiveTab(tabId, url) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs?.[0]?.id === tabId && String(tabs[0].url || '') === String(url || '')
  } catch {
    return false
  }
}

export { BLOCKED_PROTOCOL }
