/**
 * IPC：让主进程能驱动渲染层那个内嵌浏览器
 *
 * ⚠️ 为什么要有这一层：
 * `<webview>` 是**渲染进程里的 DOM 元素**，主进程碰不到它。
 * 所以「Agent 用浏览器」是：**开标签**这一步走渲染层，其余全在主进程。
 *
 * ★ 两条路（B5，2026-10-09，浏览器 CDP 化收尾）：
 *
 *   · **navigate（开 / 复用标签）** —— 只有这一步必须请渲染层做（webview 是它的
 *     DOM 元素）。走 `browser:request`（主→渲染）→ 渲染层开好标签、等就绪 →
 *     推 `browser:active`（渲染→主）→ 这里读正文、resolve。
 *
 *   · **其余动作（读元素 / 点 / 打字 / 换历史 / 取 wcid）** —— 目标页面**已经开着**，
 *     主进程只要知道那个 webview 的 `webContentsId` 就能经 CDP 直连做，**不必等回话**。
 *     wcid 由渲染层在标签就绪 / 切换时推 `browser:active` 缓存到这里（`activeTabs`）。
 *     所以这条路是：`browser:request`（只用于点亮界面角标 / 选中 agent 标签，**不等回话**）
 *     + 直接开干（动作实现在 `core/browse-act.cjs`）。
 *
 * 界面那边如果没人应答（用户把浏览器标签关了），navigate 超时后返回失败 ——
 * 不能让工具永久挂着。
 */

const { ipcMain, BrowserWindow, app, session } = require('electron')
const log = require('../core/log.cjs')
const { createSettler, onAbort } = require('../core/abort.cjs')
const cdp = require('../core/cdp.cjs')
const browseAct = require('../core/browse-act.cjs')
const webviewPermissions = require('../core/webview-permissions.cjs')

/** 等界面的上限（navigate 那条往返用）。读一个页面比「用户点确认」快得多 */
const REQUEST_TIMEOUT_MS = 45_000

/** id -> { resolve, timer }（只给 navigate 那条往返用） */
const pending = new Map()

/**
 * sessionId -> webContentsId。
 *
 * 渲染层在「标签就绪 / 切换」时推 `browser:active` 写进来（B5）。主进程靠它
 * 直连那个 webview，不必每次都问渲染层。取用时校验 webContents 还活着，
 * 死了就删掉（页面关了）。
 */
const activeTabs = new Map()

function newId() {
  return `brw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 取某个会话当前那个 webview 的 webContents id；没有 / 已关就 0 */
function wcidFor(sessionId) {
  const key = String(sessionId ?? '')
  const id = activeTabs.get(key)
  if (!id) return 0
  try {
    cdp.resolve(id)
  } catch {
    activeTabs.delete(key)
    return 0
  }
  return id
}

/**
 * 只点亮界面（角标 / 选中 agent 标签 / 面板切到浏览器）—— **不等回话**。
 *
 * 其余动作的正文/元素/历史都由主进程直连做，所以这条 `browser:request` 只是
 * 给界面一个「Agent 在动网页」的信号（用户得看见）。渲染层收到后只做界面动作。
 */
function notify(action, payload) {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  for (const win of windows) {
    win.webContents.send('browser:request', { id: newId(), action, ...payload })
  }
  require('./browse-notify.cjs').tellUser({
    sessionId: String(payload?.sessionId ?? ''),
    action,
    url: String(payload?.url ?? ''),
  })
}

/**
 * navigate：请渲染层开 / 复用标签，等它推 `browser:active` 回话。
 *
 * @returns {Promise<{ ok: boolean, error?: string, text?: string, title?: string, url?: string }>}
 */
function navigateRequest(payload, signal) {
  return new Promise((resolve) => {
    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (windows.length === 0) {
      resolve({ ok: false, error: '没有可用的窗口，打不开浏览器' })
      return
    }

    const id = newId()
    const finish = createSettler(resolve)
    /* 提前声明：onAbort 在 signal 已断时会立刻触发，那时 off 还没赋值 */
    let off = () => {}
    /* 结算 + 清理 —— 正常回话 / 超时 / 中断，三条路都必须走这里 */
    const settle = (value) => {
      const entry = pending.get(id)
      if (entry) clearTimeout(entry.timer)
      pending.delete(id)
      off()
      return finish(value)
    }

    /* AG-011：点停止时把这条请求也撤掉（不再等它） */
    off = onAbort(signal, () => settle({ ok: false, error: '已被用户中断' }))

    const timer = setTimeout(() => {
      settle({ ok: false, error: '界面没有在 45 秒内回应（浏览器标签可能被关了）' })
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { resolve: settle, timer, action: 'navigate', payload: payload ?? {} })

    require('./browse-notify.cjs').tellUser({
      sessionId: String(payload?.sessionId ?? ''),
      action: 'navigate',
      url: String(payload?.url ?? ''),
    })

    for (const win of windows) {
      win.webContents.send('browser:request', { id, action: 'navigate', ...payload })
    }
  })
}

/** 把「动作还没回来那段」和「用户点停止」赛跑（照抄 navigateRequest 的口径） */
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    let off = () => {}
    off = onAbort(signal, () => {
      off()
      resolve({ ok: false, error: '已被用户中断' })
    })
    promise.then(
      (value) => {
        off()
        resolve(value)
      },
      (error) => {
        off()
        reject(error)
      },
    )
  })
}

/**
 * 其余动作：给界面一个信号，然后**直接用缓存的 wcid 经 CDP 做**（不等渲染层回话）。
 *
 * @param {string} action 'snapshot' | 'click' | 'type' | 'nav' | 'wcid'
 */
async function act(action, payload, signal) {
  notify(action, payload)

  const wcid = wcidFor(payload?.sessionId)
  if (!wcid) return { ok: false, error: '浏览器里还没有打开的页面，先 browse 打开一个网页' }

  try {
    return await raceAbort(browseAct.runOp(action, wcid, payload), signal)
  } catch (error) {
    return {
      ok: false,
      error: `操作网页失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 工具入口（`browse*` 工具都走它）。
 *
 * @param {string} action  'navigate' | 'snapshot' | 'click' | 'type' | 'nav' | 'wcid'
 * @param {object} payload
 * @param {AbortSignal} [signal]  用户点停止时用它把这条请求撤掉
 */
function request(action, payload, signal) {
  return action === 'navigate' ? navigateRequest(payload, signal) : act(action, payload, signal)
}

function register() {
  /*
   * 网页标签的权限闸：默认全拒（审计问题 21）—— 理由见 core/webview-permissions.cjs。
   * 挂 `whenReady` 而不是就地装：`register()` 是**启动早期**跑的
   * （`main.cjs` 在模块顶层就调它），那时候 `session` 模块还不能用。
   *
   * 那个 `typeof` 判断是给自检留的：自检在**纯 Node** 里跑，假 electron 只有
   * 它 stub 出来的那几个方法（没有 whenReady）。
   */
  if (typeof app.whenReady === 'function') {
    app.whenReady().then(() => {
      webviewPermissions.install(session.fromPartition(webviewPermissions.PARTITION), log)
    })
  }

  /*
   * ── 渲染层推「当前标签的 webContents id」（B5，取代旧的 browser:result）──
   *
   * 两种用途：
   *   · 纯缓存更新（无 `requestId`）：标签就绪 / 切换时推一下，主进程记下来直连用。
   *   · 回 navigate 的话（带 `requestId`）：主进程读正文、resolve 那条请求。
   */
  ipcMain.handle('browser:active', async (_event, payload) => {
    const sessionId = String(payload?.sessionId ?? '')
    const wcid = Number(payload?.webContentsId) || 0
    if (wcid) activeTabs.set(sessionId, wcid)
    else activeTabs.delete(sessionId)

    const id = String(payload?.requestId ?? '')
    if (!id) return { ok: true } // 只是缓存更新，没人在等
    const entry = pending.get(id)
    if (!entry) return { ok: true }

    clearTimeout(entry.timer)
    pending.delete(id)

    if (payload?.ok !== true) {
      entry.resolve({
        ok: false,
        error: String(payload?.error ?? '读取失败'),
        /* 密码框会走这条：先不填，让工具回去问用户 */
        needsConfirm: payload?.needsConfirm === true,
      })
      return { ok: true }
    }

    try {
      entry.resolve(await browseAct.readBody(wcid, undefined))
    } catch (error) {
      entry.resolve({
        ok: false,
        error: `操作网页失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return { ok: true }
  })

  return { request }
}

module.exports = { register, request, REQUEST_TIMEOUT_MS, wcidFor }
