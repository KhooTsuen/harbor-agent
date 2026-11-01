/**
 * 打开**真侧边栏**并认出它 —— 全仓库唯一一处（2026-10-20 建立）
 *
 * ── 为什么要这个模块 ──────────────────────────────────────────
 *
 * 用户逮到一个真错误：在此之前 **14 个 accept 脚本都在用「新开一个
 * `chrome-extension://<id>/index.html` 标签」冒充侧边栏** —— 那不是用户
 * 看到的东西（真侧栏是右侧 400px 面板，不占标签位、不在 `chrome.tabs` 里）。
 *
 * 而 `accept-m02a.cjs` 里写着「点工具栏图标那条路走不通」—— 那句**是猜的**，
 * 调研报告里没有这条结论。实测证明可行：
 *   `Runtime.evaluate({userGesture:true})` 骗不过它（会抛 may only be called
 *   in response to a user gesture）；但用 CDP 的 **Input.dispatchMouseEvent**
 *   派发**真实鼠标事件**（产生 transient user activation）点注入的按钮就成功。
 *
 * ── 为什么不能靠 URL 认侧栏 ────────────────────────────────────
 *
 * 真侧栏是独立 `page` target，但 URL 与触发页**完全相同**。所以判据是：
 * 触发页打 marker（`window.__harborTrigger`）→ 有 marker 的是触发页，
 * 没 marker 的才是真侧栏；宽度（≈382）只作日志辅助，不单独用。
 *
 * ⚠️ 打开后**触发页会抢前台** → 调用方要 `closeTriggerPages()` +
 *   `bringToFront()`，否则侧栏里 `chrome.tabs.query({active})` 会拿到扩展页自己。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 触发页上的标记名（认「这页是我拿来点的」用） */
const MARK = '__harborTrigger'

/** 建一条极简 CDP 连接（能发任意命令 + 求值） */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((ok, no) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => no(new Error('CDP ws 连不上')))
  })
  let seq = 0
  const call = (method, params = {}) =>
    new Promise((ok, no) => {
      const myId = (seq += 1)
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== myId) return
        ws.removeEventListener('message', onMsg)
        if (m.error) no(new Error(JSON.stringify(m.error)))
        else ok(m.result)
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evalIn = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r && r.result ? r.result.value : undefined
  }
  return { call, evalIn, close: () => ws.close() }
}

/** 列 /json/list 里属于这个扩展的 page target */
async function extensionPages(port, extId) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return list
    .filter((t) => t.type === 'page' && String(t.url || '').includes(extId) && t.webSocketDebuggerUrl)
    .map((t) => ({ url: String(t.url || ''), ws: t.webSocketDebuggerUrl }))
}

/**
 * 开一个**只用来产生真实点击**的扩展页，打上标记后返回它的句柄。
 * 调用方负责在这个页面上派发真实鼠标事件（见 `clickOpenPanel`）。
 */
async function openTriggerPage(port, extId) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extId}/index.html`)}`, {
    method: 'PUT',
  })
  const target = await res.json()
  const conn = await connect(target.webSocketDebuggerUrl)
  /* 标记必须在**任何点击之前**打上：之后靠它把这一页排除掉 */
  await conn.evalIn(`(function(){ window.${MARK} = true; return true })()`)
  /*
   * 轮询等扩展 API 就绪（别拿固定毫秒当判据 —— README 那条硬规则）。
   * 实测另一坑：复用旧 profile 时这一页会**没有扩展接管**，`chrome.*` 恒
   * undefined（见 accept 脚本里 removeProfile 那段注释）。
   */
  let ready = false
  let lastProbe = null
  for (let i = 0; i < 40; i += 1) {
    const probe = await conn.evalIn(
      `JSON.stringify({ sp: typeof chrome !== 'undefined' && typeof chrome.sidePanel, win: typeof chrome !== 'undefined' && typeof chrome.windows, rs: document.readyState })`,
    )
    lastProbe = probe
    try {
      const info = JSON.parse(String(probe || '{}'))
      if (info.sp === 'object' && info.win === 'object' && info.rs !== 'loading') {
        ready = true
        break
      }
    } catch {
      /* 还没就绪 */
    }
    await sleep(250)
  }
  return { conn, ready, targetId: target.id, lastProbe }
}

/**
 * 在触发页上派发一次**真实鼠标点击**，点一个调 `sidePanel.open()` 的按钮。
 *
 * @returns {Promise<{ ok: boolean, error?: string, windowId?: number }>}
 */
async function clickOpenPanel(trigger) {
  const conn = trigger && trigger.conn ? trigger.conn : trigger
  if (trigger && trigger.ready === false) {
    return {
      ok: false,
      error: `触发页的扩展 API 没就绪（最后一次探测=${String(trigger.lastProbe)})`,
    }
  }
  /* 注入按钮：位置固定在左上角，坐标必须与下面派发的坐标一致 */
  const BTN = `(function(){
    if (document.getElementById('__harbor_open')) return 'already'
    const b = document.createElement('button')
    b.id = '__harbor_open'
    b.textContent = 'open'
    b.style.cssText = 'position:fixed;left:0;top:0;width:140px;height:44px;z-index:2147483647'
    b.addEventListener('click', async () => {
      window.__harborOpenResult = { called: true }
      try {
        const w = await chrome.windows.getLastFocused()
        window.__harborOpenResult.windowId = w.id
        await chrome.sidePanel.open({ windowId: w.id })
        window.__harborOpenResult.ok = true
      } catch (e) {
        window.__harborOpenResult.ok = false
        window.__harborOpenResult.error = String((e && e.message) || e)
      }
    })
    document.body.appendChild(b)
    return 'injected'
  })()`
  await conn.evalIn(BTN)
  /* ★ 真实鼠标事件才会产生 transient user activation —— Runtime.evaluate
     的 userGesture:true **骗不过** sidePanel.open()（2026-10-20 实测） */
  await conn.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 20, button: 'left', clickCount: 1 })
  await conn.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 20, button: 'left', clickCount: 1 })
  let last = {}
  for (let i = 0; i < 20; i += 1) {
    await sleep(300)
    const raw = await conn.evalIn(`JSON.stringify(window.__harborOpenResult || {})`)
    try {
      last = JSON.parse(String(raw || '{}'))
    } catch {
      last = {}
    }
    if (last && (last.ok === true || last.ok === false)) break
  }
  return last
}

/**
 * 开**真侧边栏**并返回它的句柄。
 *
 * @param {{ port: number, extId: string, settleMs?: number }} opts
 * @returns {Promise<{ ok: boolean, error?: string, evalIn?: Function, call?: Function, close?: Function,
 *   innerWidth?: number, triggerPid?: string }>}
 */
async function openRealSidePanel(opts) {
  const port = Number(opts.port)
  const extId = String(opts.extId || '')
  if (!port || !extId) return { ok: false, error: '缺 port 或 extId' }

  const before = new Set((await extensionPages(port, extId)).map((t) => t.ws))
  const trigger = await openTriggerPage(port, extId)
  const triggerConn = trigger && trigger.conn ? trigger.conn : trigger
  const opened = await clickOpenPanel(trigger)
  if (!opened || opened.ok !== true) {
    try {
      triggerConn.close()
    } catch {
      /* 已关 */
    }
    return { ok: false, error: `sidePanel.open() 没成功：${(opened && opened.error) || '没有任何回执'}` }
  }

  const settle = Number(opts.settleMs) > 0 ? Number(opts.settleMs) : 2500
  await sleep(settle)

  /* 找出新出现的那个扩展页 —— 它有可能是真侧栏 */
  const after = await extensionPages(port, extId)
  const fresh = after.filter((t) => !before.has(t.ws))
  /* ★ 主判据：逐页问 marker。有 marker = 触发页；没有 = 真侧栏 */
  let real = null
  let widths = []
  for (const t of fresh) {
    let conn
    try {
      conn = await connect(t.ws)
      const probe = await conn.evalIn(
        `JSON.stringify({ mark: window.${MARK} === true, w: window.innerWidth, h: window.innerHeight })`,
      )
      const info = JSON.parse(String(probe || '{}'))
      widths.push(info)
      if (info.mark !== true) {
        real = { conn, w: info.w }
        break
      }
      conn.close()
    } catch {
      /* 读不到就跳过（可能是正在加载） */
    }
  }
  if (!real) {
    triggerConn.close()
    return { ok: false, error: `没认出真侧栏（新 target ${fresh.length} 个，宽度样本 ${JSON.stringify(widths)}）` }
  }

  return {
    ok: true,
    evalIn: real.conn.evalIn,
    call: real.conn.call,
    close: () => {
      real.conn.close()
      triggerConn.close()
    },
    innerWidth: real.w,
    triggerConn,
  }
}

/**
 * 把一个 page target 切回前台。
 *
 * ★ 必须调（`accept-m04a.cjs` 早就记过这个坑，这里收敛成一处）：对侧栏 target
 *   做 `Runtime.evaluate` **会把它激活** —— 于是「触发页」或「侧栏」顶掉了用户
 *   页面，`chrome.tabs.query({active:true})` 返回的就不再是用户那一页。
 *   真实场景是「页面在前台、侧栏在右」，所以每次操作页面前都要切回来。
 */
async function bringToFront(port, targetId) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`)
  } catch {
    /* 老版本没有这个端点 —— 退化成「不切」，判据一旦红就能看出来 */
  }
  await sleep(250)
}

/**
 * 关掉用来触发的那一页 —— 让环境回到「用户真实场景：页面在前台、侧栏不占标签位」。
 * 侧栏是独立面板，关掉触发页**不会**把它一起关掉（2026-10-20 实测）。
 */
async function closeTrigger(port, targetId) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`)
  } catch {
    /* 关不掉不影响判据 */
  }
  await sleep(300)
}

module.exports = {
  openRealSidePanel,
  openTriggerPage,
  clickOpenPanel,
  connect,
  extensionPages,
  bringToFront,
  closeTrigger,
  MARK,
}
