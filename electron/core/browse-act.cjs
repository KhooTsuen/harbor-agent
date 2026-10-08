/**
 * 浏览动作的**主进程实现**（经 CDP 直连 webview 的 webContents）
 *
 * B5（2026-10-09，浏览器 CDP 化收尾）：读元素 / 点 / 打字 / 换历史 / 取 wcid
 * 这些动作不再往返渲染层 —— 主进程手里有那个 webview 的 `webContentsId`
 * （渲染层推 `browser:active` 缓存下来的，见 `handlers/browser.cjs`），
 * 直接经 `core/cdp.cjs` 做。本模块就是这些动作的落点。
 *
 * 从 `handlers/browser.cjs` 拆出来（那边过 300 行了，硬约束 #2）——
 * 拆的时候把「读正文」「落点/聚焦」「换历史」三摊各自的原委留在了它们各自的模块里：
 *   · 读正文脚本 —— `core/browse-read.cjs`
 *   · 元素/落点/聚焦脚本 —— `core/browse-ops.cjs`
 *   · 换历史 —— `core/browse-history.cjs`
 * 这里只负责**编排**（选哪个、套超时、把结果打包成工具要的形状）。
 */

const { extractText, pickSource } = require('./browser-text.cjs')
const browseRead = require('./browse-read.cjs')
const browseOps = require('./browse-ops.cjs')
const browseHistory = require('./browse-history.cjs')

/**
 * 读正文 / 换页的上限（B2/B4，2026-10-09）。
 *
 * 这两步改由主进程经 CDP 做之后，**不再受** handler 那条 `REQUEST_TIMEOUT_MS`
 * （45 秒，等界面用）约束 —— 页面 JS 若卡死，`Runtime.evaluate` 会**永不返回**，
 * 工具就挂到天荒地老。所以给它们单独一条上限。
 */
const READ_TIMEOUT_MS = 15_000

/** 给一个 promise 套超时：超时后 reject（原 promise 仍在跑，但没人认领了） */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 读一页正文并打包成工具要的形状（navigate / nav 共用） */
async function readBody(wcid, nav) {
  const page = await withTimeout(
    browseRead.readPageText(wcid),
    READ_TIMEOUT_MS,
    '读网页超时（页面卡住了或一直没响应）',
  )
  const picked = pickSource(page)
  return {
    ok: true,
    text: extractText(picked.raw, { maxChars: 12_000 }),
    title: page.title,
    url: page.url,
    nav,
    truncated: picked.raw.length > 12_000,
  }
}

/** 按索引算落点（真点击由工具再调 `real-input` 派发） */
async function clickOp(wcid, payload) {
  const point = await browseOps.runClickPoint(wcid, payload.index, payload.force)
  if (!point?.ok) return { ok: false, error: String(point?.error ?? '点击失败') }
  return {
    ok: true,
    click: point.label ?? '',
    obstructed: point.obstructed === true,
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
    webContentsId: wcid,
  }
}

/** 聚焦 + 校验输入框（真文字由工具再调 `real-input` 插入） */
async function typeOp(wcid, payload) {
  const focus = await browseOps.runFocus(wcid, payload.index, payload.authorized)
  if (focus?.ok) {
    return { ok: true, into: focus.into ?? '', password: focus.password === true, webContentsId: wcid }
  }
  /* 密码框：先不填，回去让工具问用户 */
  if (focus?.needsConfirm) return { ok: false, needsConfirm: true, error: '需要用户确认' }
  return { ok: false, error: String(focus?.error ?? '输入失败') }
}

/** 换历史（后退 / 前进），成了就把新页正文一起读回来 */
async function navOp(wcid, payload) {
  const step = payload.direction === 'forward' ? 'forward' : 'back'
  const outcome = await withTimeout(
    browseHistory.stepHistory(wcid, step),
    READ_TIMEOUT_MS,
    '换页超时（页面卡住了或一直没响应）',
  )
  if (!outcome.moved) {
    return { ok: false, error: browseHistory.navBlockedText(step, outcome, outcome.before) }
  }
  return readBody(wcid, step)
}

/**
 * 跑一个动作，返回工具要的结果形状。
 *
 * @param {string} action 'snapshot' | 'click' | 'type' | 'nav' | 'wcid'
 * @param {number} wcid
 * @param {object} payload
 */
async function runOp(action, wcid, payload) {
  if (action === 'snapshot') return { ok: true, snapshot: await browseOps.runSnapshot(wcid) }
  if (action === 'click') return clickOp(wcid, payload)
  if (action === 'type') return typeOp(wcid, payload)
  if (action === 'nav') return navOp(wcid, payload)
  if (action === 'wcid') return { ok: true, webContentsId: wcid }
  return { ok: false, error: `不认识的动作：${action}` }
}

module.exports = { READ_TIMEOUT_MS, withTimeout, readBody, runOp }
