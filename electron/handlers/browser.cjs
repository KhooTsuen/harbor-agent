/**
 * IPC：让主进程能驱动渲染层那个内嵌浏览器
 *
 * ⚠️ 为什么要有这一层：
 * `<webview>` 是**渲染进程里的 DOM 元素**，主进程碰不到它。
 * 所以「Agent 用浏览器」必须是：
 *
 *     工具（主进程）→ 发请求 → 渲染层操作 webview → 回话 → 工具拿到结果
 *
 * 这和「写操作确认」是**同一套往返**（`chat.cjs` 的 askUser），
 * 所以这里照抄那个模式，不另造一套。
 *
 * 界面那边如果没人应答（比如用户把浏览器标签关了），会在超时后返回失败 ——
 * 不能让工具永久挂着。
 */

const { ipcMain, BrowserWindow, app, session } = require('electron')
const log = require('../core/log.cjs')
const { createSettler, onAbort } = require('../core/abort.cjs')
const { extractText, pickSource } = require('../core/browser-text.cjs')
const browseRead = require('../core/browse-read.cjs')
const webviewPermissions = require('../core/webview-permissions.cjs')

/** 等界面的上限。读一个页面比「用户点确认」快得多，不需要五分钟 */
const REQUEST_TIMEOUT_MS = 45_000

/**
 * 主进程读正文的上限（B2，2026-10-09）。
 *
 * 正文改由主进程经 CDP 读之后，读这一步**不再受 `REQUEST_TIMEOUT_MS` 约束** ——
 * 那条计时器在渲染层回话（`browser:result`）当场就停了，读发生在它之后。
 * 页面 JS 若卡死，`Runtime.evaluate` 会**永不返回**，工具就挂到天荒地老（比旧版更糟：
 * 旧版读在渲染层，45 秒那条还能兜住）。所以给读单独一条上限。
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

/** id -> { resolve, timer } */
const pending = new Map()

function newId() {
  return `brw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 请求渲染层做一件事。
 *
 * @param {string} action  'navigate'（打开并读正文）
 * @param {object} payload
 * @param {AbortSignal} [signal]  用户点停止时用它把这条请求撤掉
 * @returns {Promise<{ ok: boolean, error?: string, text?: string, title?: string, url?: string }>}
 */
function request(action, payload, signal) {
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

    /*
     * AG-011：点停止时把这条请求也撤掉。
     *
     * 渲染层那边的 `executeJavaScript` 是**中断不了的**（浏览器就没给这个能力），
     * 所以这里只能做到「不再等它」—— 但这就够了：Agent 循环不必陪着卡 45 秒，
     * 结果回来了也没人认领（pending 里已经没有了）。
     */
    off = onAbort(signal, () => {
      settle({ ok: false, error: '已被用户中断' })
    })

    const timer = setTimeout(() => {
      settle({ ok: false, error: '界面没有在 45 秒内回应（浏览器标签可能被关了）' })
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { resolve: settle, timer })

    /*
     * 「Agent 在动网页，而你没在看」→ 一条系统通知（收尾第一步）。
     *
     * 放在这里是因为这是**所有浏览请求的唯一入口**（navigate / snapshot /
     * click / type 四路都过它）—— 挂在四个工具里迟早漏一个。
     * 能不能发（不在前台 / 这条对话发过没有）由通知器判断，这里只管把上下文告诉它。
     */
    require('./browse-notify.cjs').tellUser({
      sessionId: String(payload?.sessionId ?? ''),
      action,
      url: String(payload?.url ?? ''),
    })

    for (const win of windows) {
      win.webContents.send('browser:request', { id, action, ...payload })
    }
  })
}

function register() {
  /*
   * 网页标签的权限闸：默认全拒（审计问题 21）—— 理由见 core/webview-permissions.cjs。
   * 挂 `whenReady` 而不是就地装：`register()` 是**启动早期**跑的
   * （`main.cjs` 在模块顶层就调它），那时候 `session` 模块还不能用。
   * 反正网页标签要等用户点开才加载，装得再晚也来得及。
   *
   * 那个 `typeof` 判断是给自检留的：自检在**纯 Node** 里跑，假 electron 只有
   * 它 stub 出来的那几个方法（没有 whenReady）。
   */
  if (typeof app.whenReady === 'function') {
    app.whenReady().then(() => {
      webviewPermissions.install(session.fromPartition(webviewPermissions.PARTITION), log)
    })
  }

  /* ── 渲染层回话 ── */
  ipcMain.handle('browser:result', async (_event, payload) => {
    const id = String(payload?.id ?? '')
    const entry = pending.get(id)
    if (!entry) return { ok: false, error: '这个请求已经过期' }

    clearTimeout(entry.timer)
    pending.delete(id)

    const result = payload?.result ?? {}
    if (result.ok !== true) {
      entry.resolve({
        ok: false,
        error: String(result.error ?? '读取失败'),
        /* 密码框会走这条：先不填，让工具回去问用户 */
        needsConfirm: result.needsConfirm === true,
      })
      return { ok: true }
    }

    /*
     * ★ B2（2026-10-09）：渲染层只报「页面已就绪 + 它的 webContents id」，
     * 正文由**主进程**经 CDP 读（`core/browse-read.cjs`）—— 不再让渲染层跑
     * `executeJavaScript` 读、再把正文回传。渲染层的活儿缩到「导航 + 等就绪」。
     * 这一条必须排在 click / type / snapshot / wcid **之前**：那三种回复里也会带
     * `webContentsId`，抢在后面就把 ready 当成别的了。
     */
    if (result.ready === true) {
      const wcid = Number(result.webContentsId) || 0
      try {
        const page = await withTimeout(
          browseRead.readPageText(wcid),
          READ_TIMEOUT_MS,
          '读网页超时（页面卡住了或一直没响应）',
        )
        const picked = pickSource(page)
        const text = extractText(picked.raw, { maxChars: 12_000 })
        entry.resolve({
          ok: true,
          text,
          title: page.title,
          url: page.url,
          /* browse_nav 多一个「往哪个方向走的」：工具要拿它写人话 */
          nav: result.nav === undefined ? undefined : String(result.nav),
          truncated: picked.raw.length > 12_000,
        })
      } catch (error) {
        entry.resolve({
          ok: false,
          error: `读网页失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
      return { ok: true }
    }

    /* click：算好的落点，透传给工具（工具再让主进程 sendInputEvent 派发真鼠标事件） */
    if (result.click !== undefined) {
      entry.resolve({
        ok: true,
        click: result.click,
        obstructed: result.obstructed === true,
        x: Number(result.x) || 0,
        y: Number(result.y) || 0,
        webContentsId: Number(result.webContentsId) || 0,
      })
      return { ok: true }
    }

    /* type：聚焦 + 校验结果，透传（工具再让主进程 insertText 插入真文字） */
    if (result.into !== undefined) {
      entry.resolve({
        ok: true,
        into: result.into,
        password: result.password === true,
        webContentsId: Number(result.webContentsId) || 0,
      })
      return { ok: true }
    }

    /* snapshot：可交互元素列表，直接透传（不用正文清洗） */
    if (result.snapshot) {
      entry.resolve({ ok: true, snapshot: result.snapshot })
      return { ok: true }
    }

    /*
     * wcid：单问「当前 webview 的 webContents id」（browse_ax 读无障碍树要用）。
     * ⚠️ 必须排在 click / type / snapshot **之后** —— 那三种回复里现在也带
     * webContentsId 字段，抢在前面会把它们当成 wcid 回掉（只回一个 id）。
     */
    if (result.webContentsId !== undefined) {
      entry.resolve({ ok: true, webContentsId: Number(result.webContentsId) || 0 })
      return { ok: true }
    }

    /*
     * 走到这里 = 渲染层回了个**认不出来**的形状。直接判失败，别让工具干等到超时。
     * 正常路径都有分支：navigate / nav → `ready`；click / type / snapshot / wcid 各一条。
     * （正文清洗 `pickSource` / `extractText` 现在在 `ready` 分支里做。）
     */
    entry.resolve({ ok: false, error: '渲染层回了个无法识别的结果' })
    return { ok: true }
  })

  return { request }
}

module.exports = { register, request, REQUEST_TIMEOUT_MS }
