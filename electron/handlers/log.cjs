/**
 * 兜底日志通道
 *
 * 渲染层主动报上来的两件事：
 *   · `log:action` —— 界面点了什么 / 调了哪个功能（见 preload 的唯一 `call()`）
 *   · `log:error`  —— 渲染层没被捕获的异常（window.onerror / unhandledrejection /
 *                     React ErrorBoundary）
 *
 * ★ 「没预料到的事件」只能靠兜底抓：手工埋点永远只覆盖写代码时想到的那几个。
 *   所以这里不做任何过滤，来什么记什么（体积上限在 core/log-actions.cjs 里管）。
 */

const log = require('../core/log.cjs')
const actions = require('../core/log-actions.cjs')

function register({ ipcMain }) {
  /* 用 send/on（不等回执）—— 记日志不能给界面添延迟，更不能因为失败把功能弄挂 */
  ipcMain.on('log:action', (_event, entry) => {
    if (!entry || typeof entry !== 'object') return
    actions.record({
      kind: typeof entry.kind === 'string' ? entry.kind : 'action',
      name: typeof entry.name === 'string' ? entry.name : '',
      ...(entry.ok === undefined ? {} : { ok: entry.ok === true }),
      ...(typeof entry.ms === 'number' ? { ms: entry.ms } : {}),
      ...(entry.detail ? { detail: String(entry.detail) } : {}),
    })
  })

  ipcMain.on('log:error', (_event, entry) => {
    const where = entry?.where ? `（${String(entry.where).slice(0, 40)}）` : ''
    const message = String(entry?.message ?? '未知错误').slice(0, 500)
    log.error(`渲染层未捕获${where}：${message}`)
    /* 也进动作流水：这样"崩过"和"点了什么"是同一条时间线上能对上的 */
    actions.record({ kind: 'error', name: 'renderer', ok: false, detail: message })
  })
}

module.exports = { register }
