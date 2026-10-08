/**
 * 在**同一个标签**里后退 / 前进一格（主进程侧，经 CDP）
 *
 * 从渲染层 `navStep.ts` 搬过来（B4，2026-10-09，浏览器 CDP 化）。
 * 原来这一步是渲染层做的：调 webview 的 `goBack()`、再在页面里 `history.back()`
 * 兜底，同时监听 webview 的导航事件核实「真的动了没有」。现在改由主进程经 CDP
 * `Page.getNavigationHistory` / `Page.navigateToHistoryEntry` 做 ——
 * 渲染层只保证「webview 就绪 + 报 webContentsId」。
 *
 * ★ 2026-10-06 那个真机 bug 的教训照搬，别弄丢：
 *   **不许拿「能不能后退」的自报当结论。**
 *   真机上页面自报 `history.length = 2`（确实有上一页，页面里 `history.back()`
 *   一次就退回列表、连筛选词都恢复了），而 webview 的 `canGoBack()` 回 **false** ——
 *   于是我们对一条本来能成的路说了「到头了」。错报的方向最难收拾：
 *   它看起来像个提示，实际上把路堵死了（用户以为这功能就是残的）。
 *
 *   现在的口径还是「**动手 + 核实**」：
 *     ① 先问 CDP 的历史（`Page.getNavigationHistory`，就是 DevTools 看的那一份，
 *        比 `canGoBack()` 可靠），有上一条就 `Page.navigateToHistoryEntry` 跳过去
 *     ② 没动静再用**页面自己的** history 兜一次（真机证明那条路是通的 ——
 *        它和浏览器 API 在这件事上各说各话）
 *     ③ 两次都没动才判「换不了页」，并把诊断值一起带回去
 *
 * ⚠️ 顶层**不 require electron**（cdp 是延迟拿的）—— 纯 Node 自检能直接 import
 *    本模块验纯逻辑（`targetEntryId` / `navBlockedText`）。
 */

const cdp = require('./cdp.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 问 CDP 要当前的历史快照。
 *
 * @param {number} webContentsId
 * @returns {Promise<{ index: number, entries: any[], back: boolean, forward: boolean }>}
 */
async function readHistory(webContentsId) {
  const h = await cdp.send(webContentsId, 'Page.getNavigationHistory')
  const entries = Array.isArray(h?.entries) ? h.entries : []
  const raw = Number(h?.currentIndex)
  const index = Number.isInteger(raw) && raw >= 0 ? raw : 0
  return { index, entries, back: index > 0, forward: index < entries.length - 1 }
}

/**
 * 从一次历史快照里挑出「往 step 方向那一格」的 entry id。
 *
 * @param {{ index: number, entries: any[] }} state
 * @param {'back'|'forward'} step
 * @returns {number|null} 没有可去的格子就 null（调用方据此走兜底）
 */
function targetEntryId(state, step) {
  const index = step === 'forward' ? state.index + 1 : state.index - 1
  const entry = state.entries[index]
  return entry && Number.isInteger(entry.id) ? entry.id : null
}

/** 读当前地址（页面里 `location.href`；读不到就当空串，由调用方按「没变」处理） */
async function currentUrl(webContentsId) {
  try {
    return String((await cdp.evaluate(webContentsId, 'location.href')) ?? '')
  } catch {
    return ''
  }
}

/**
 * 等「地址真的变了没有」。
 *
 * ★ 不动用 webview 的导航事件（那是渲染层的东西，主进程这边没有）—— 直接轮询地址。
 *   原来渲染层是「事件 + 轮询地址」双保险（有些站点的页内导航不发事件）；
 *   主进程只有轮询这条路，够用：`navigateToHistoryEntry` 之后地址一定会变。
 *
 * @returns {Promise<boolean>} 变了就是 true
 */
async function waitForMove(webContentsId, before, waitMs, pollMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const now = await currentUrl(webContentsId)
    if (now && now !== before) return true
    await sleep(pollMs)
  }
  return false
}

/**
 * 依次试两步（CDP 历史 → 页面自己的 history），哪一步动了就停。
 *
 * @param {number} webContentsId
 * @param {'back'|'forward'} step
 * @param {{ waitMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ moved: boolean, before: string, back: boolean, forward: boolean }>}
 */
async function stepHistory(webContentsId, step, { waitMs = 2500, pollMs = 100 } = {}) {
  const before = await currentUrl(webContentsId)

  let state
  try {
    state = await readHistory(webContentsId)
  } catch {
    /* 拿不到历史（刚 attach / 页面还没起）：当空历史，靠兜底那一步 */
    state = { index: 0, entries: [], back: false, forward: false }
  }

  /** @type {Array<() => Promise<any>>} */
  const attempts = []
  const viaCdp = targetEntryId(state, step)
  if (viaCdp !== null) {
    attempts.push(() => cdp.send(webContentsId, 'Page.navigateToHistoryEntry', { entryId: viaCdp }))
  }
  /* 兜底：页面自己的 history（真机证明它和浏览器 API 各说各话） */
  attempts.push(() => cdp.evaluate(webContentsId, `history.${step}()`))

  let moved = false
  for (const attempt of attempts) {
    try {
      await attempt()
    } catch {
      /* 这一步没成 —— 试下一条 */
    }
    moved = await waitForMove(webContentsId, before, waitMs, pollMs)
    if (moved) break
  }

  return { moved, before, back: state.back === true, forward: state.forward === true }
}

/**
 * 「换不了页」时回给模型的话。
 *
 * 带诊断值是刻意的：模型把这句原样贴出来，就能定性到底是「真的到头」还是
 * 「又是自报的历史在撒谎」—— 不用再靠猜。
 *
 * @param {'back'|'forward'} step
 * @param {{ back: boolean, forward: boolean, before: string }} outcome
 * @param {string} active 标签当前的地址
 */
function navBlockedText(step, outcome, active) {
  const target = step === 'back' ? '上一页' : '下一页'
  return (
    `这个标签换不了页：浏览器的历史、页面里的 history.${step}() 都没能把它挪动一格。` +
    `诊断：CDP 报 canGoBack=${outcome.back} / canGoForward=${outcome.forward}，` +
    `当前地址 ${outcome.before || '未知'}，标签地址 ${active || '未知'}。` +
    `如果确实有${target}，请把这句原样告诉用户。`
  )
}

module.exports = { stepHistory, targetEntryId, navBlockedText, readHistory }
