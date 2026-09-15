/**
 * 导航策略
 *
 * 设置里的 `general.browserNavigation`（ask / allow / block）早就有这个字段了，
 * 但一直**没接线** —— 典型的「有配置没生效」。这个模块负责接上，
 * 并且把 webview 的加固一起做了。
 *
 * ⚠️ 一个容易搞错的地方：**`<webview>` 有自己的 webContents**。
 * 只给主窗口挂 `will-navigate` 是管不到 webview 里的跳转的 ——
 * 网页里点个链接照样跳。webview 要通过 `will-attach-webview`（挂载时加固）
 * 和 `app.on('web-contents-created')`（创建后挂事件）两处一起来。
 */

const log = require('./core/log.cjs')

/**
 * 这个跳转该不该放行。
 *
 * @param {string} targetUrl 要去哪
 * @param {string} currentUrl 从哪来
 * @param {'ask' | 'allow' | 'block'} mode
 * @returns {{ action: 'allow' | 'block' | 'ask', host?: string }}
 */
function decide(targetUrl, currentUrl, mode = 'ask') {
  let target = null
  try {
    target = new URL(String(targetUrl))
  } catch {
    return { action: 'block' }
  }

  /*
   * ⚠️ 协议检查必须在 `mode === 'allow'` **之前**。
   *
   * 踩过：一开始把 `allow` 的短路放在最前面，于是 `file://`、`javascript:`、
   * `data:` 这些在 allow 模式下**全都放行**了 —— 「随便跳」变成了「连本地文件
   * 都能被网页打开」。这是测试里「file:// 一律拦」那条抓出来的。
   *
   * 换句话说：**模式管的是「跳到哪个网站」，管不了「用哪种协议」**。
   */
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return { action: 'block' }

  if (mode === 'allow') return { action: 'allow' }

  let sameSite = false
  try {
    sameSite = new URL(String(currentUrl)).hostname === target.hostname
  } catch {
    sameSite = false
  }
  /* 同站点内跳转永远放行 —— 站内导航要是也拦，网页就没法用了 */
  if (sameSite) return { action: 'allow' }

  if (mode === 'block') return { action: 'block' }
  return { action: 'ask', host: target.hostname }
}

/** 把一个 webContents 的跳转接到策略上 */
function wireNavigationGuard(contents, getMode, label) {
  contents.on('will-navigate', (event, targetUrl) => {
    const verdict = decide(targetUrl, contents.getURL(), getMode())
    if (verdict.action === 'allow') return
    /* 一律拦下：即使是 ask 模式也不自动跳 —— 让用户自己在地址栏输。
       自动跳出去再问，等于已经跳了。 */
    event.preventDefault()
    log.info(
      `已拦下${label}跳转（策略 ${getMode()}）：${targetUrl}` +
        (verdict.host ? ` [${verdict.host}]` : ''),
    )
  })
}

/**
 * webview 挂载时加固。
 *
 * 这些是**兜底**（BrowserTab 里也写了 `webpreferences`），
 * 但页面里能通过 `<webview>` 属性覆盖，所以在主进程再强制一次 ——
 * 网页里塞一个 webview 标签给自己开后门是真实存在的玩法。
 */
function hardenWebview(webPreferences) {
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  return webPreferences
}

/**
 * 一次装好：主窗口 + 所有 webview。
 *
 * 收在这里而不是写在 main.cjs 里，是因为那几个事件的**正确挂法很容易搞错**
 * （webview 有独立 webContents，只挂主窗口是拦不住网页里点链接的）。
 * 放一处，改的时候只用看这一处。
 *
 * @param {{ app: object, win: object, getMode: () => string }} input
 */
function install({ app, win, getMode }) {
  wireNavigationGuard(win.webContents, getMode, '主窗口')

  /* webview 挂载时强制加固 —— 页面里的属性覆盖不了这一层 */
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    hardenWebview(webPreferences)
  })

  /*
   * ★ webview 有自己的 webContents —— 上面那个 will-navigate 管不到它。
   * 这里在所有 webContents 创建时统一挂，按类型区分。
   */
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    wireNavigationGuard(contents, getMode, '网页')
    /* 网页想弹新窗口一律拦掉：不弹，也不交给系统浏览器 */
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

module.exports = { decide, wireNavigationGuard, hardenWebview, install }
