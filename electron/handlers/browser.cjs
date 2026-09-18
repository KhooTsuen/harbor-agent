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

const { ipcMain, BrowserWindow } = require('electron')
const log = require('../core/log.cjs')
const { createSettler, onAbort } = require('../core/abort.cjs')
const { extractText, pickSource } = require('../core/browser-text.cjs')

/** 等界面的上限。读一个页面比「用户点确认」快得多，不需要五分钟 */
const REQUEST_TIMEOUT_MS = 45_000

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

    for (const win of windows) {
      win.webContents.send('browser:request', { id, action, ...payload })
    }
  })
}

function register() {
  /* ── 渲染层回话 ── */
  ipcMain.handle('browser:result', (_event, payload) => {
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

    /* snapshot：可交互元素列表，直接透传（不用正文清洗） */
    if (result.snapshot) {
      entry.resolve({ ok: true, snapshot: result.snapshot })
      return { ok: true }
    }

    /* click：点击结果，直接透传 */
    if (result.click !== undefined) {
      entry.resolve({ ok: true, click: result.click })
      return { ok: true }
    }

    /* type：输入结果，直接透传 */
    if (result.type !== undefined) {
      entry.resolve({
        ok: true,
        type: result.type,
        into: result.into,
        password: result.password === true,
      })
      return { ok: true }
    }

    /*
     * ★ 正文在这里清洗 + 截断，不在渲染层做。
     *
     * 两个理由：渲染层传原始 HTML 过来会白占一次 IPC 序列化；
     * 更重要的是**清洗逻辑要在能被单测的地方**（browser-text.cjs）。
     */
    /* 挑来源用 pickSource，不能写 `html ?? text` —— 见那里的注释（空字符串的坑） */
    const picked = pickSource(result)
    const text = extractText(picked.raw, { maxChars: 12_000 })

    entry.resolve({
      ok: true,
      text,
      title: String(result.title ?? ''),
      url: String(result.url ?? ''),
      truncated: picked.raw.length > 12_000,
    })
    return { ok: true }
  })

  return { request }
}

module.exports = { register, request, REQUEST_TIMEOUT_MS }
