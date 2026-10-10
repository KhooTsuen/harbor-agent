/**
 * 浏览器下载接管：网页里点「下载」→ 进内置下载队列
 *
 * 背景：内置浏览器是渲染层一个 `<webview>`，跑在独立分区
 * `persist:agent-browser`（见 `core/webview-permissions.cjs` 的 PARTITION）。
 * 那个分区有自己的 `session`，主进程能给它挂 `will-download` —— 网页一触发
 * 下载就拦下来，转手交给下载管理器（`core/download-queue.cjs`），于是
 * 「网页下载」和「手动加的任务」进同一个队列、同一个面板、同一套限速。
 *
 * ── 三条刻意的边界 ──
 *
 * ① **只接管 http/https**。`blob:` / `data:` 这类没有可重放的地址，内置引擎
 *    （Node fetch）拿不到；需要登录（cookie）的下载同理。这些一律**放行**给
 *    Chromium 自己的下载（它带着网页的 cookie）—— 只给个保存路径、不弹
 *    「另存为」对话框。拦下来反而会「点了没反应」。
 * ② **不 require electron**：`session` 与几个依赖都由调用方注入，自检能拿一个
 *    假的 session / event / item 真跑一遍（不起 Electron）。
 * ③ **落盘路径在这里定死**：同名文件自动让位（`name(1).ext`）；`isTaken`
 *    同时看磁盘与台账（同路径已有未完成任务时 store 会拒）。
 */

const path = require('node:path')

/** Windows 非法文件名字符（跨平台都先换掉，省得再判平台） */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/** 只接管这两个协议；其余放行给 Chromium（口径与 handlers/downloads.cjs 同源） */
function isHttpUrl(raw) {
  try {
    const protocol = new URL(String(raw)).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 把服务器给的名字洗成能落盘的文件名（去路径、去非法字符、限长） */
function safeName(raw) {
  const base = path
    .basename(String(raw ?? '').trim())
    .replace(ILLEGAL, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base || 'download'
}

/** 同目录下挑一个还没被占的名字：a.zip → a(1).zip → a(2).zip … */
function uniqueTarget(dir, name, isTaken) {
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = path.join(dir, name)
  for (let i = 1; i < 1000 && isTaken(candidate); i += 1) {
    candidate = path.join(dir, `${stem}(${i})${ext}`)
  }
  return candidate
}

/**
 * 挂到分区 session 上。
 *
 * @param {{ on?: Function }} ses  网页标签那个分区的 session
 * @param {{
 *   dir: () => string,
 *   isTaken: (file: string) => boolean,
 *   add: (input: object) => { ok: boolean, error?: string },
 *   log?: { info?: Function, warn?: Function },
 * }} deps
 * @returns {boolean} 装上了没有；false = 拿到的不是个 session
 */
function install(ses, deps) {
  if (!ses || typeof ses.on !== 'function') return false
  const log = deps?.log

  ses.on('will-download', (event, item) => {
    let url = ''
    let name = ''
    try {
      url = String(item.getURL() || '')
      name = safeName(item.getFilename())
    } catch {
      /* 拿不到就别接管，交给 Chromium 默认处理 */
    }

    if (!isHttpUrl(url)) {
      /* 放行给原生下载：给个保存路径，免得弹「另存为」挡住用户 */
      try {
        item.setSavePath(path.join(deps.dir(), name || 'download'))
      } catch {
        /* 设不上就让 Chromium 自己弹对话框，不是我们能管的 */
      }
      return
    }

    /* 拦下来：这一条改由内置引擎下（并行分段 / 续传 / 进队列面板） */
    event.preventDefault()
    const file = uniqueTarget(deps.dir(), name, deps.isTaken)
    const result = deps.add({ url, file, origin: 'browser' })
    if (result?.ok) log?.info?.(`网页下载已接入内置队列：${path.basename(file)}`)
    else log?.warn?.(`网页下载接入失败（${name}）：${result?.error ?? '未知原因'}`)
  })

  return true
}

module.exports = { install, isHttpUrl, safeName, uniqueTarget }
